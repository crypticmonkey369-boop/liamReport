require('dotenv').config();
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { DateTime } = require('luxon');

const {
  getGoogleAuthClient,
  fetchConfig,
  calculateExpensesForDate,
  writeDailyLog,
  saveTokensToSheet
} = require('./config-sheet');

const { calculateProfitReport } = require('./financials');

const TOKENS_PATH = path.join(__dirname, '../tokens.json');

// Nodemailer SMTP Email Client or Gmail API Email Client
async function sendEmail({ toEmail, subject, textBody, authClient }) {
  if (authClient && authClient.credentials && authClient.credentials.refresh_token) {
    try {
      console.log('[EMAIL] Sending email via Gmail API...');
      const gmail = google.gmail({ version: 'v1', auth: authClient });
      
      const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
      const emailLines = [
        `To: ${toEmail}`,
        'Content-Type: text/plain; charset=utf-8',
        'MIME-Version: 1.0',
        `Subject: ${utf8Subject}`,
        '',
        textBody
      ];
      const email = emailLines.join('\r\n');
      const base64EncodedEmail = Buffer.from(email)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: base64EncodedEmail
        }
      });
      console.log('[EMAIL] Email sent successfully via Gmail API.');
      return;
    } catch (err) {
      console.error('[EMAIL ERROR] Failed to send email via Gmail API, trying SMTP/mock fallback...', err.message);
    }
  }

  const tokens = fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) : {};
  const hasRealGoogleOAuth = tokens.google && tokens.google.refresh_token && !tokens.google.refresh_token.startsWith('mock_');
  const hasRealGoogleSA = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON.includes('mock')) ||
                          (fs.existsSync(path.join(__dirname, '../service-account-key.json')));
  const isMock = !hasRealGoogleOAuth && !hasRealGoogleSA;

  if (isMock) {
    console.log(`\n--- [MOCK EMAIL DISPATCH via SMTP] ---`);
    console.log(`To: ${toEmail}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${textBody}`);
    console.log(`--------------------------------------\n`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: subject,
    text: textBody
  });
}

// Active Token Rotation for Klaviyo
async function getActiveKlaviyoToken() {
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error('tokens.json vault does not exist.');
  }

  const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
  if (!tokens.klaviyo || !tokens.klaviyo.refresh_token) {
    throw new Error('Klaviyo connection is missing or unauthenticated.');
  }

  const isMock = !process.env.KLAVIYO_CLIENT_ID || process.env.KLAVIYO_CLIENT_ID.startsWith('mock_');
  if (isMock) {
    console.log('[MOCK KLAVIYO ROTATION] Bypassed real token rotation, returned mock_klaviyo_access_token.');
    return 'mock_klaviyo_access_token';
  }

  console.log('[KLAVIYO ROTATION] Atomically rotating Klaviyo access token...');
  
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', tokens.klaviyo.refresh_token);
  params.append('client_id', process.env.KLAVIYO_CLIENT_ID);
  params.append('client_secret', process.env.KLAVIYO_CLIENT_SECRET);

  try {
    const response = await axios.post('https://a.klaviyo.com/oauth/token', params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const { access_token, refresh_token, expires_in } = response.data;

    tokens.klaviyo = {
      access_token,
      refresh_token,
      expires_at: DateTime.now().plus({ seconds: expires_in }).toISO()
    };
    
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
    console.log('[KLAVIYO ROTATION] Klaviyo token refreshed and saved successfully.');
    
    // Sync refreshed Klaviyo token back to the Google Sheet sys_tokens tab
    await saveTokensToSheet(tokens);

    return access_token;
  } catch (err) {
    console.error('[KLAVIYO ROTATION ERROR] Failed to rotate Klaviyo token:', err.response ? err.response.data : err.message);
    throw new Error(`Klaviyo Token Rotation Failure: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }
}

// Scrape Klaviyo Metrics
async function scrapeKlaviyoMetrics(accessToken) {
  const isMock = accessToken.startsWith('mock_');
  if (isMock) {
    console.log('[MOCK KLAVIYO SCRAPE] Bypassed API fetch, returned mock metrics dataset.');
    return [{ id: 'mock_metric', name: 'Mock Active Subscribers' }];
  }

  const url = 'https://a.klaviyo.com/api/metrics';
  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'revision': '2024-02-15',
        'Accept': 'application/json'
      }
    });
    const metrics = response.data.data || [];
    console.log(`[KLAVIYO SCRAPE] Successfully scraped ${metrics.length} metrics from Klaviyo API.`);
    return metrics;
  } catch (err) {
    console.error('[KLAVIYO SCRAPE ERROR] Failed querying Klaviyo API:', err.response ? err.response.data : err.message);
    throw new Error(`Klaviyo API Scrape Failure: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }
}

// Paginated Shopify order retrieval
async function fetchAllShopifyOrders({ shopDomain, accessToken, startISO, endISO }) {
  let orders = [];
  let url = `https://${shopDomain}/admin/api/2024-04/orders.json`;
  let params = {
    updated_at_min: startISO,
    updated_at_max: endISO,
    status: 'any',
    limit: 250
  };

  while (url) {
    const config = {
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json'
      }
    };
    
    if (params) {
      config.params = params;
    }

    const response = await axios.get(url, config);
    orders = orders.concat(response.data.orders || []);

    const linkHeader = response.headers.link;
    url = null;
    params = null;

    if (linkHeader) {
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      if (nextMatch) {
        url = nextMatch[1];
      }
    }
  }

  return orders;
}

// Fetch Shopify data for target date/range
async function fetchShopifyData({ shopDomain, accessToken, startISO, endISO, targetStartDt, targetEndDt }) {
  const isMock = accessToken.startsWith('mock_');
  if (isMock) {
    console.log('[MOCK SHOPIFY FETCH] Bypassed API query, returned mock daily order metrics.');
    return {
      netSales: 1540.50,
      refunds: 120.00,
      ordersCount: 22,
      freeShipOrdersCount: 14
    };
  }

  const orders = await fetchAllShopifyOrders({ shopDomain, accessToken, startISO, endISO });
  
  let netSales = 0;
  let refundsAmount = 0;
  let ordersCount = 0;
  let freeShipOrdersCount = 0;

  for (const order of orders) {
    const orderCreatedDt = DateTime.fromISO(order.created_at, { zone: 'Australia/Melbourne' });
    const isCreatedInRange = orderCreatedDt >= targetStartDt.startOf('day') && orderCreatedDt <= targetEndDt.endOf('day');
    
    const gstRate = (order.tax_lines || []).reduce((rate, tax) => {
      if (tax.title.toUpperCase().includes('GST')) {
        return tax.rate;
      }
      return rate;
    }, 0.10);

    if (isCreatedInRange) {
      ordersCount++;
      
      const subtotal = parseFloat(order.total_line_items_price || '0');
      const discounts = parseFloat(order.total_discounts || '0');
      let orderNet = subtotal - discounts;
      
      if (order.taxes_included) {
        orderNet = orderNet / (1 + gstRate);
      }
      netSales += orderNet;

      const shippingPaid = (order.shipping_lines || []).reduce((sum, line) => {
        return sum + parseFloat(line.price || '0');
      }, 0);

      if (shippingPaid === 0) {
        freeShipOrdersCount++;
      }
    }

    for (const refund of order.refunds || []) {
      const refundCreatedDt = DateTime.fromISO(refund.created_at, { zone: 'Australia/Melbourne' });
      const isRefundedInRange = refundCreatedDt >= targetStartDt.startOf('day') && refundCreatedDt <= targetEndDt.endOf('day');
      
      if (isRefundedInRange) {
        let refundSubtotal = 0;
        for (const item of refund.refund_line_items || []) {
          refundSubtotal += parseFloat(item.subtotal || '0');
        }
        
        if (order.taxes_included) {
          refundSubtotal = refundSubtotal / (1 + gstRate);
        }
        refundsAmount += refundSubtotal;
      }
    }
  }

  return {
    netSales,
    refunds: refundsAmount,
    ordersCount,
    freeShipOrdersCount
  };
}

// Fetch Meta Ads spend
async function fetchMetaSpend({ adAccountId, accessToken, sinceStr, untilStr }) {
  if (!adAccountId || !accessToken) {
    return 0;
  }
  
  const isMock = accessToken.startsWith('mock_');
  if (isMock) {
    console.log('[MOCK META FETCH] Bypassed API query, returned mock ad spend value.');
    return 350.00;
  }

  const cleanId = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const url = `https://graph.facebook.com/v19.0/${cleanId}/insights`;
  
  try {
    const response = await axios.get(url, {
      params: {
        level: 'account',
        time_range: JSON.stringify({ since: sinceStr, until: untilStr }),
        fields: 'spend',
        access_token: accessToken
      }
    });

    const data = response.data.data || [];
    return data.reduce((sum, row) => sum + parseFloat(row.spend || '0'), 0);
  } catch (err) {
    console.error('Error fetching Meta Ads spend:', err.response ? err.response.data : err.message);
    throw new Error(`Meta Ads API Error: ${err.response ? JSON.stringify(err.response.data) : err.message}`);
  }
}

// Core Orchestrator to run report for a target date
async function runReportForDate(targetDateStr) {
  console.log(`[REPORT RUN] Starting profit report run for date: ${targetDateStr}`);
  
  let googleAuthClient;
  let clientEmail = process.env.REPORT_EMAIL || 'client@example.com';
  const tokens = fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) : {};
  const hasRealGoogleOAuth = tokens.google && tokens.google.refresh_token && !tokens.google.refresh_token.startsWith('mock_');
  const hasRealGoogleSA = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON.includes('mock')) ||
                          (fs.existsSync(path.join(__dirname, '../service-account-key.json')));
  const isMockGoogle = !hasRealGoogleOAuth && !hasRealGoogleSA;
  
  try {
    let configValues;
    let dailyOtherExpenses;

    if (isMockGoogle) {
      console.log('[MOCK REPORT RUN] Simulating Google Sheets configuration loads...');
      configValues = {
        current_cogs_multiplier: 12.50,
        current_free_shipping_cost: 8.00,
        current_gate_percent: 0.029, // 2.9%
        current_per_order_flat_fee: 0.30,
        report_email: 'mock-client@example.com',
        meta_system_user_token: 'mock_meta_system_token',
        meta_ad_account_id: 'act_mock_ad_account_id'
      };
      clientEmail = configValues.report_email;
      dailyOtherExpenses = 85.00;
    } else {
      googleAuthClient = getGoogleAuthClient();
      const sheets = google.sheets({ version: 'v4', auth: googleAuthClient });
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      
      if (!spreadsheetId || spreadsheetId === 'mock_google_sheet_id') {
        throw new Error('GOOGLE_SHEET_ID is not configured.');
      }

      console.log('[REPORT RUN] Fetching Config tab parameters...');
      configValues = await fetchConfig(sheets, spreadsheetId);
      clientEmail = configValues.report_email;
      
      console.log('[REPORT RUN] Parsing overhead expenses...');
      dailyOtherExpenses = await calculateExpensesForDate(sheets, spreadsheetId, targetDateStr);
    }
    
    // Resolve Meta Credentials
    let metaToken = configValues.meta_system_user_token;
    if (!metaToken) {
      if (fs.existsSync(TOKENS_PATH)) {
        const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
        metaToken = tokens.meta ? tokens.meta.access_token : null;
      }
    }
    const adAccountId = configValues.meta_ad_account_id || process.env.META_AD_ACCOUNT_ID || configValues['Meta Ad Account ID'];

    // Resolve Shopify Credentials
    let shopDomain = configValues.shopify_store_url || 'mock-store.myshopify.com';
    let shopifyToken = configValues.shopify_api_token || 'mock_shopify_token';
    
    if (fs.existsSync(TOKENS_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
      if (tokens.shopify && tokens.shopify.shop) shopDomain = tokens.shopify.shop;
      if (tokens.shopify && tokens.shopify.access_token) shopifyToken = tokens.shopify.access_token;
    }

    if (!isMockGoogle && (!shopDomain || shopifyToken.startsWith('mock_'))) {
      throw new Error('Shopify credentials missing or still set to mock in production.');
    }

    // Resolve Klaviyo & Scrape Validation
    console.log('[REPORT RUN] Resolving Klaviyo OAuth credentials & rotating tokens...');
    let klaviyoToken = '';
    try {
      klaviyoToken = await getActiveKlaviyoToken();
      await scrapeKlaviyoMetrics(klaviyoToken);
    } catch (klaviyoErr) {
      console.warn(`[REPORT RUN WARNING] Klaviyo Integration bypassed or failed: ${klaviyoErr.message}`);
      // Klaviyo is non-blocking as it does not contribute to financials or sheet logging
    }

    // Fetch Shopify transactions
    const targetDt = DateTime.fromISO(targetDateStr, { zone: 'Australia/Melbourne' });
    const shopifyMetrics = await fetchShopifyData({
      shopDomain,
      accessToken: shopifyToken,
      startISO: targetDt.startOf('day').toISO(),
      endISO: targetDt.endOf('day').toISO(),
      targetStartDt: targetDt,
      targetEndDt: targetDt
    });

    // Fetch Meta Ads spend
    const adSpend = await fetchMetaSpend({
      adAccountId,
      accessToken: metaToken,
      sinceStr: targetDateStr,
      untilStr: targetDateStr
    });

    // Execute calculations
    const reportResults = calculateProfitReport({
      netSales: shopifyMetrics.netSales,
      refunds: shopifyMetrics.refunds,
      ordersCount: shopifyMetrics.ordersCount,
      freeShipOrdersCount: shopifyMetrics.freeShipOrdersCount,
      adSpend,
      dailyOtherExpenses,
      config: configValues
    });

    reportResults.date = targetDateStr;

    // Write back to sheet if not in mock mode
    if (isMockGoogle) {
      console.log('[MOCK REPORT RUN] Bypassed Sheet write-back. Results calculated:', reportResults);
    } else {
      const sheets = google.sheets({ version: 'v4', auth: googleAuthClient });
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      await writeDailyLog(sheets, spreadsheetId, reportResults);
    }

    // Email Report via Nodemailer SMTP
    const emailSubject = `Daily Profit Report - ${targetDateStr}`;
    const emailBody = `DAILY PROFIT REPORT FOR ${targetDateStr}
--------------------------------------------------
Net Sales (ex GST):        $${reportResults.netSales.toFixed(2)}
Refunds Issued Today:      $${reportResults.refunds.toFixed(2)}
Adjusted Revenue:          $${reportResults.adjustedRevenue.toFixed(2)}

Total Orders:              ${reportResults.orders}
  - Free Ship Orders:      ${reportResults.freeShipOrders}
  - Paid Ship Orders:      ${reportResults.paidShipOrders}

Calculated Costs:
  - Cost of Goods (COGS):  $${reportResults.cogs.toFixed(2)}
  - Shipping Cost:         $${reportResults.shipping.toFixed(2)}
  - Payment Gate Fees:     $${reportResults.paymentFees.toFixed(2)}
  - Meta Ad Spend:         $${reportResults.adSpend.toFixed(2)}
  - Amortized Fixed Costs: $${reportResults.fixedCosts.toFixed(2)}
--------------------------------------------------
TOTAL COSTS:               $${reportResults.totalCosts.toFixed(2)}

ESTIMATED NET PROFIT:      $${reportResults.estProfit.toFixed(2)}
PROFIT MARGIN:             ${reportResults.marginPercent.toFixed(2)}%
--------------------------------------------------
Report generated automatically by Profit Reporter.`;

    await sendEmail({
      toEmail: clientEmail,
      subject: emailSubject,
      textBody: emailBody,
      authClient: googleAuthClient
    });

    console.log(`[REPORT RUN] Report sent successfully to ${clientEmail}`);
    return { success: true, data: reportResults };

  } catch (err) {
    console.error('[REPORT RUN ERROR] Failed executing profit reporter run:', err);
    
    // Dispatch emergency email alert
    try {
      console.log('[EMERGENCY ALERT] Sending failure email alert...');
      const alertSubject = `[ALERT] Profit Reporter Connection Interrupted - ${targetDateStr}`;
      const alertBody = `ATTENTION: The Daily Profit Reporter halted due to a connection error.

Error Details:
${err.message}

RECOMMENDED ACTION:
1. Log into your Profit Reporter Web Panel.
2. Re-authenticate any disconnected platforms (Shopify, Meta Ads, Klaviyo).`;

      await sendEmail({
        toEmail: clientEmail,
        subject: alertSubject,
        textBody: alertBody,
        authClient: googleAuthClient
      });
      console.log('[EMERGENCY ALERT] Failure alert dispatched successfully.');
    } catch (emailErr) {
      console.error('[EMERGENCY ALERT FAILED] Could not dispatch alert email:', emailErr);
    }
    
    return {
      success: false,
      error: err.message,
      details: err.stack
    };
  }
}

// Core Orchestrator to run monthly report
async function runMonthlyReportForMonth(yearMonthStr) {
  console.log(`[MONTHLY REPORT] Starting profit report run for month: ${yearMonthStr}`);
  
  let googleAuthClient;
  let clientEmail = process.env.REPORT_EMAIL || 'client@example.com';
  const tokens = fs.existsSync(TOKENS_PATH) ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) : {};
  const hasRealGoogleOAuth = tokens.google && tokens.google.refresh_token && !tokens.google.refresh_token.startsWith('mock_');
  const hasRealGoogleSA = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON.includes('mock')) ||
                          (fs.existsSync(path.join(__dirname, '../service-account-key.json')));
  const isMockGoogle = !hasRealGoogleOAuth && !hasRealGoogleSA;
  
  try {
    const startOfMonth = DateTime.fromFormat(yearMonthStr, 'yyyy-MM', { zone: 'Australia/Melbourne' }).startOf('month');
    const endOfMonth = startOfMonth.endOf('month');
    
    const startStr = startOfMonth.toFormat('yyyy-MM-dd');
    const endStr = endOfMonth.toFormat('yyyy-MM-dd');

    let configValues;
    let totalFixedCosts = 0;

    if (isMockGoogle) {
      configValues = {
        current_cogs_multiplier: 12.50,
        current_free_shipping_cost: 8.00,
        current_gate_percent: 0.029,
        current_per_order_flat_fee: 0.30,
        report_email: 'mock-client@example.com',
        meta_system_user_token: 'mock_meta_system_token',
        meta_ad_account_id: 'act_mock_ad_account_id'
      };
      clientEmail = configValues.report_email;
      totalFixedCosts = 85.00 * startOfMonth.daysInMonth;
    } else {
      googleAuthClient = getGoogleAuthClient();
      const sheets = google.sheets({ version: 'v4', auth: googleAuthClient });
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      
      if (!spreadsheetId || spreadsheetId === 'mock_google_sheet_id') {
        throw new Error('GOOGLE_SHEET_ID is not configured.');
      }

      configValues = await fetchConfig(sheets, spreadsheetId);
      clientEmail = configValues.report_email;
      
      const daysInMonth = startOfMonth.daysInMonth;
      for (let day = 1; day <= daysInMonth; day++) {
        const currentDay = startOfMonth.set({ day });
        const currentDayStr = currentDay.toFormat('yyyy-MM-dd');
        const dayExpenses = await calculateExpensesForDate(sheets, spreadsheetId, currentDayStr);
        totalFixedCosts += dayExpenses;
      }
    }
    
    // Resolve Meta Credentials
    let metaToken = configValues.meta_system_user_token;
    if (!metaToken) {
      if (fs.existsSync(TOKENS_PATH)) {
        const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
        metaToken = tokens.meta ? tokens.meta.access_token : null;
      }
    }
    const adAccountId = configValues.meta_ad_account_id || process.env.META_AD_ACCOUNT_ID || configValues['Meta Ad Account ID'];

    // Resolve Shopify Credentials
    let shopDomain = configValues.shopify_store_url || 'mock-store.myshopify.com';
    let shopifyToken = configValues.shopify_api_token || 'mock_shopify_token';
    if (fs.existsSync(TOKENS_PATH)) {
      const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
      if (tokens.shopify && tokens.shopify.shop) shopDomain = tokens.shopify.shop;
      if (tokens.shopify && tokens.shopify.access_token) shopifyToken = tokens.shopify.access_token;
    }

    if (!isMockGoogle && (!shopDomain || shopifyToken.startsWith('mock_'))) {
      throw new Error('Shopify credentials missing or still set to mock in production.');
    }

    // Resolve Klaviyo
    console.log('[MONTHLY REPORT] Resolving Klaviyo OAuth credentials & rotating tokens...');
    let klaviyoToken = '';
    try {
      klaviyoToken = await getActiveKlaviyoToken();
      await scrapeKlaviyoMetrics(klaviyoToken);
    } catch (klaviyoErr) {
      console.warn(`[MONTHLY REPORT WARNING] Klaviyo Integration failed: ${klaviyoErr.message}`);
      // Klaviyo is non-blocking as it does not contribute to financials or sheet logging
    }

    // Fetch Shopify details
    const shopifyMetrics = await fetchShopifyData({
      shopDomain,
      accessToken: shopifyToken,
      startISO: startOfMonth.toISO(),
      endISO: endOfMonth.toISO(),
      targetStartDt: startOfMonth,
      targetEndDt: endOfMonth
    });

    // Fetch Meta Ads spend
    const adSpend = await fetchMetaSpend({
      adAccountId,
      accessToken: metaToken,
      sinceStr: startStr,
      untilStr: endStr
    });

    // Calculations
    const reportResults = calculateProfitReport({
      netSales: shopifyMetrics.netSales,
      refunds: shopifyMetrics.refunds,
      ordersCount: shopifyMetrics.ordersCount,
      freeShipOrdersCount: shopifyMetrics.freeShipOrdersCount,
      adSpend,
      dailyOtherExpenses: totalFixedCosts,
      config: configValues
    });

    reportResults.date = `${yearMonthStr} (Monthly Agg)`;

    // Write back
    if (!isMockGoogle) {
      const sheets = google.sheets({ version: 'v4', auth: googleAuthClient });
      const spreadsheetId = process.env.GOOGLE_SHEET_ID;
      await writeDailyLog(sheets, spreadsheetId, reportResults);
    }

    // Email Report
    const emailSubject = `Monthly Profit Report - ${yearMonthStr}`;
    const emailBody = `MONTHLY PROFIT REPORT FOR ${yearMonthStr}
--------------------------------------------------
Net Sales (ex GST):        $${reportResults.netSales.toFixed(2)}
Refunds Issued This Month: $${reportResults.refunds.toFixed(2)}
Adjusted Revenue:          $${reportResults.adjustedRevenue.toFixed(2)}

Total Orders:              ${reportResults.orders}
  - Free Ship Orders:      ${reportResults.freeShipOrders}
  - Paid Ship Orders:      ${reportResults.paidShipOrders}

Calculated Costs:
  - Cost of Goods (COGS):  $${reportResults.cogs.toFixed(2)}
  - Shipping Cost:         $${reportResults.shipping.toFixed(2)}
  - Payment Gate Fees:     $${reportResults.paymentFees.toFixed(2)}
  - Meta Ad Spend:         $${reportResults.adSpend.toFixed(2)}
  - Amortized Fixed Costs: $${reportResults.fixedCosts.toFixed(2)}
--------------------------------------------------
TOTAL COSTS:               $${reportResults.totalCosts.toFixed(2)}

ESTIMATED NET PROFIT:      $${reportResults.estProfit.toFixed(2)}
PROFIT MARGIN:             ${reportResults.marginPercent.toFixed(2)}%
--------------------------------------------------
Report generated automatically by Profit Reporter.`;

    await sendEmail({
      toEmail: clientEmail,
      subject: emailSubject,
      textBody: emailBody,
      authClient: googleAuthClient
    });

    return { success: true, data: reportResults };

  } catch (err) {
    console.error('[MONTHLY REPORT ERROR] Failed executing monthly profit reporter run:', err);
    
    try {
      const alertSubject = `[ALERT] Monthly Profit Reporter Connection Interrupted - ${yearMonthStr}`;
      const alertBody = `ATTENTION: The Monthly Profit Reporter execution failed for month ${yearMonthStr}.

Error Details:
${err.message}`;

      await sendEmail({
        toEmail: clientEmail,
        subject: alertSubject,
        textBody: alertBody,
        authClient: googleAuthClient
      });
    } catch (emailErr) {
      console.error('[MONTHLY EMERGENCY ALERT FAILED] Could not dispatch alert email:', emailErr);
    }
    
    return {
      success: false,
      error: err.message,
      details: err.stack
    };
  }
}

// Standalone CLI Runner Execution Trigger
if (require.main === module) {
  (async () => {
    console.log('[CLI RUNNER] Standalone report executor triggered...');
    const isMonthly = process.argv.includes('--monthly');
    
    if (isMonthly) {
      const targetMonth = DateTime.now()
        .setZone('Australia/Melbourne')
        .minus({ months: 1 })
        .toFormat('yyyy-MM');
      console.log(`[CLI RUNNER] Initiating monthly report run for range: ${targetMonth}`);
      
      const result = await runMonthlyReportForMonth(targetMonth);
      if (result.success) {
        console.log('[CLI RUNNER] Monthly aggregation finished successfully.');
        process.exit(0);
      } else {
        console.error('[CLI RUNNER] Monthly aggregation failed:', result.error);
        process.exit(1);
      }
    } else {
      const targetDate = DateTime.now()
        .setZone('Australia/Melbourne')
        .minus({ days: 1 })
        .toFormat('yyyy-MM-dd');
      console.log(`[CLI RUNNER] Initiating daily report run for date: ${targetDate}`);
      
      const result = await runReportForDate(targetDate);
      if (result.success) {
        console.log('[CLI RUNNER] Daily reporting finished successfully.');
        process.exit(0);
      } else {
        console.error('[CLI RUNNER] Daily reporting failed:', result.error);
        process.exit(1);
      }
    }
  })();
}

module.exports = {
  runReportForDate,
  runMonthlyReportForMonth
};
