/**
 * OAuth Account Manager & Dynamic Daily Profit Reporter
 * Google Apps Script Native Code
 * 
 * INSTRUCTIONS FOR DEPLOYMENT:
 * 1. Open your Google Sheet.
 * 2. Click "Extensions" > "Apps Script".
 * 3. Delete any default code and paste this script.
 * 4. Save the project (click the floppy disk icon).
 * 5. Set up daily trigger: Click the clock icon on the left (Triggers) > "Add Trigger".
 *    - Choose function to run: "triggerDailyReport"
 *    - Event source: "Time-driven"
 *    - Type of time based trigger: "Day timer"
 *    - Time of day: "5am to 6am"
 * 6. Set up monthly trigger: Click "Add Trigger".
 *    - Choose function to run: "triggerMonthlyReport"
 *    - Event source: "Time-driven"
 *    - Type of time based trigger: "Month timer"
 *    - Day of month: "1st"
 *    - Time of day: "5am to 6am"
 */

// Main Trigger for Daily Run
function triggerDailyReport() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const targetDateStr = formatDate(yesterday);
  
  runReportForDate(targetDateStr);
}

// Main Trigger for Monthly Run
function triggerMonthlyReport() {
  const date = new Date();
  date.setMonth(date.getMonth() - 1); // Previous month
  const year = date.getFullYear();
  const month = ('0' + (date.getMonth() + 1)).slice(-2);
  const targetMonthStr = `${year}-${month}`;
  
  runMonthlyReport(targetMonthStr);
}

// Formats a Date object to YYYY-MM-DD
function formatDate(date) {
  const y = date.getFullYear();
  const m = ('0' + (date.getMonth() + 1)).slice(-2);
  const d = ('0' + date.getDate()).slice(-2);
  return `${y}-${m}-${d}`;
}

// Helper to load Config values from sheet
function loadConfig() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Config");
  if (!sheet) {
    throw new Error('Could not find tab named "Config". Please create it.');
  }
  
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(1, 1, lastRow, 2).getValues();
  const config = {};
  
  for (let i = 0; i < values.length; i++) {
    const key = values[i][0] ? values[i][0].toString().trim() : "";
    const val = values[i][1] ? values[i][1].toString().trim() : "";
    if (key) {
      config[key] = val;
    }
  }
  
  // Validation
  const required = [
    'Avg COGS per Order', 
    'Avg Shipping Cost', 
    'Payment Fee Percent', 
    'Per-Order Fee', 
    'Report Email',
    'Shopify Shop Domain',
    'Shopify Access Token'
  ];
  
  for (let key of required) {
    if (config[key] === undefined || config[key] === "") {
      throw new Error(`Config key "${key}" is missing in your sheet Config tab.`);
    }
  }
  
  return {
    cogsMultiplier: parseFloat(config['Avg COGS per Order']),
    freeShippingCost: parseFloat(config['Avg Shipping Cost']),
    gatePercent: parseFloat(config['Payment Fee Percent']) / 100.0,
    perOrderFlatFee: parseFloat(config['Per-Order Fee']),
    reportEmail: config['Report Email'],
    shopifyShop: config['Shopify Shop Domain'].replace(/^https?:\/\//, '').replace(/\/$/, ''),
    shopifyToken: config['Shopify Access Token'],
    metaAdAccountId: config['Meta Ad Account ID'] || '',
    metaToken: config['Meta System User Token'] || ''
  };
}

// Fetch and calculate amortized expenses for a target date
function calculateExpensesForDate(targetDateStr) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Expenses");
  if (!sheet) return 0;
  
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return 0; // Header only
  
  const headers = values[0].map(h => h.toString().trim().toLowerCase());
  const colIndex = {
    name: headers.indexOf('name'),
    amount: headers.findIndex(h => h.includes('amount')),
    frequency: headers.indexOf('frequency'),
    startDate: headers.findIndex(h => h.includes('start date') || h.includes('startdate')),
    endDate: headers.findIndex(h => h.includes('end date') || h.includes('enddate'))
  };
  
  // Fallbacks
  if (colIndex.name === -1) colIndex.name = 0;
  if (colIndex.amount === -1) colIndex.amount = 1;
  if (colIndex.frequency === -1) colIndex.frequency = 2;
  if (colIndex.startDate === -1) colIndex.startDate = 3;
  if (colIndex.endDate === -1) colIndex.endDate = 4;
  
  const targetDate = parseDate(targetDateStr);
  let totalExpenses = 0;
  
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row || row.length === 0 || !row[colIndex.name]) continue;
    
    const amountStr = row[colIndex.amount].toString().replace(/[^0-9.-]/g, '') || '0';
    const amount = parseFloat(amountStr);
    const frequency = row[colIndex.frequency].toString().trim().toLowerCase();
    const startVal = row[colIndex.startDate];
    const endVal = row[colIndex.endDate];
    
    if (isNaN(amount) || amount === 0) continue;
    
    const startDate = startVal instanceof Date ? startVal : parseDate(startVal);
    if (!startDate) continue; // Invalid start date
    
    const endDate = endVal ? (endVal instanceof Date ? endVal : parseDate(endVal)) : null;
    
    // Check if targetDate falls in [startDate, endDate]
    const startsAfter = targetDate.getTime() >= startOfDay(startDate).getTime();
    const endsBefore = endDate ? (targetDate.getTime() <= endOfDay(endDate).getTime()) : true;
    
    if (startsAfter && endsBefore) {
      let allocation = 0;
      switch (frequency) {
        case 'daily':
          allocation = amount;
          break;
        case 'weekly':
          allocation = amount / 7.0;
          break;
        case 'monthly':
          const daysInMonth = getDaysInMonth(targetDate);
          allocation = amount / daysInMonth;
          break;
        case 'one-off':
        case 'oneoff':
          if (isSameDay(targetDate, startDate)) {
            allocation = amount;
          }
          break;
      }
      totalExpenses += allocation;
    }
  }
  
  return totalExpenses;
}

// Fetch Shopify metrics (Net Sales, Refunds, orders)
function fetchShopifyMetrics(config, targetStartDt, targetEndDt) {
  // Convert dates to ISO timestamps (Australia/Melbourne offset is usually +10/+11)
  // To avoid time zone issues, we fetch orders using GMT start/end offsets and filter in script
  const startISO = encodeURIComponent(targetStartDt.toISOString());
  const endISO = encodeURIComponent(targetEndDt.toISOString());
  
  const url = `https://${config.shopifyShop}/admin/api/2024-04/orders.json?updated_at_min=${startISO}&updated_at_max=${endISO}&status=any&limit=250`;
  
  const headers = {
    'X-Shopify-Access-Token': config.shopifyToken,
    'Content-Type': 'application/json'
  };
  
  const options = {
    method: 'get',
    headers: headers,
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error(`Shopify API error: ${response.getContentText()}`);
  }
  
  const data = JSON.parse(response.getContentText());
  const orders = data.orders || [];
  
  let netSales = 0;
  let refundsAmount = 0;
  let ordersCount = 0;
  let freeShipOrdersCount = 0;
  
  orders.forEach(order => {
    const orderCreated = new Date(order.created_at);
    const isCreatedInRange = orderCreated.getTime() >= targetStartDt.getTime() && orderCreated.getTime() <= targetEndDt.getTime();
    
    // Calculate GST Rate
    let gstRate = 0.10; // Default
    if (order.tax_lines) {
      order.tax_lines.forEach(tax => {
        if (tax.title.toUpperCase().indexOf('GST') !== -1) {
          gstRate = parseFloat(tax.rate);
        }
      });
    }
    
    if (isCreatedInRange) {
      ordersCount++;
      
      const subtotal = parseFloat(order.total_line_items_price || '0');
      const discounts = parseFloat(order.total_discounts || '0');
      let orderNet = subtotal - discounts;
      
      if (order.taxes_included) {
        orderNet = orderNet / (1 + gstRate);
      }
      netSales += orderNet;
      
      // Shipping Cost paid
      let shippingPaid = 0;
      if (order.shipping_lines) {
        order.shipping_lines.forEach(line => {
          shippingPaid += parseFloat(line.price || '0');
        });
      }
      
      if (shippingPaid === 0) {
        freeShipOrdersCount++;
      }
    }
    
    // Refunds
    if (order.refunds) {
      order.refunds.forEach(refund => {
        const refundCreated = new Date(refund.created_at);
        const isRefundedInRange = refundCreated.getTime() >= targetStartDt.getTime() && refundCreated.getTime() <= targetEndDt.getTime();
        
        if (isRefundedInRange) {
          let refundSubtotal = 0;
          if (refund.refund_line_items) {
            refund.refund_line_items.forEach(item => {
              refundSubtotal += parseFloat(item.subtotal || '0');
            });
          }
          
          if (order.taxes_included) {
            refundSubtotal = refundSubtotal / (1 + gstRate);
          }
          refundsAmount += refundSubtotal;
        }
      });
    }
  });
  
  return {
    netSales: netSales,
    refunds: refundsAmount,
    ordersCount: ordersCount,
    freeShipOrdersCount: freeShipOrdersCount
  };
}

// Fetch Meta campaign ad spend
function fetchMetaSpend(config, sinceStr, untilStr) {
  if (!config.metaToken || !config.metaAdAccountId) {
    return 0;
  }
  
  let accountId = config.metaAdAccountId;
  if (accountId.indexOf('act_') === -1) {
    accountId = 'act_' + accountId;
  }
  
  const timeRange = encodeURIComponent(JSON.stringify({ since: sinceStr, until: untilStr }));
  const url = `https://graph.facebook.com/v19.0/${accountId}/insights?level=account&time_range=${timeRange}&fields=spend&access_token=${config.metaToken}`;
  
  const options = {
    method: 'get',
    muteHttpExceptions: true
  };
  
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error(`Meta Ads API error: ${response.getContentText()}`);
  }
  
  const result = JSON.parse(response.getContentText());
  const data = result.data || [];
  
  let totalSpend = 0;
  data.forEach(row => {
    totalSpend += parseFloat(row.spend || '0');
  });
  
  return totalSpend;
}

// core reporting function
function runReportForDate(targetDateStr) {
  let config;
  try {
    config = loadConfig();
    
    // Parse target date boundaries (in local script timezone)
    const targetDate = parseDate(targetDateStr);
    const startDt = startOfDay(targetDate);
    const endDt = endOfDay(targetDate);
    
    Logger.log(`Running report for date: ${targetDateStr}`);
    
    // Fetch metrics
    const shopify = fetchShopifyMetrics(config, startDt, endDt);
    const adSpend = fetchMetaSpend(config, targetDateStr, targetDateStr);
    const dailyOtherExpenses = calculateExpensesForDate(targetDateStr);
    
    // Run Profit Calculations
    const adjustedRevenue = shopify.netSales - shopify.refunds;
    const cogs = shopify.ordersCount * config.cogsMultiplier;
    const shipping = shopify.freeShipOrdersCount * config.freeShippingCost;
    
    const paymentFeesBase = adjustedRevenue > 0 ? adjustedRevenue : 0;
    const paymentFees = (paymentFeesBase * config.gatePercent) + (shopify.ordersCount * config.perOrderFlatFee);
    
    const totalCosts = cogs + shipping + paymentFees + adSpend + dailyOtherExpenses;
    const estProfit = adjustedRevenue - totalCosts;
    const marginPercent = adjustedRevenue !== 0 ? (estProfit / adjustedRevenue) * 100 : 0;
    
    const results = {
      date: targetDateStr,
      netSales: shopify.netSales,
      refunds: shopify.refunds,
      adjustedRevenue: adjustedRevenue,
      orders: shopify.ordersCount,
      freeShipOrders: shopify.freeShipOrdersCount,
      paidShipOrders: shopify.ordersCount - shopify.freeShipOrdersCount,
      cogs: cogs,
      shipping: shipping,
      paymentFees: paymentFees,
      adSpend: adSpend,
      fixedCosts: dailyOtherExpenses,
      totalCosts: totalCosts,
      estProfit: estProfit,
      marginPercent: marginPercent
    };
    
    // Write back to Sheet
    writeRowToDailyLog(results);
    
    // Send Email
    sendReportEmail(config.reportEmail, results, false);
    
  } catch (err) {
    Logger.log(`Execution Failure: ${err.toString()}`);
    if (config && config.reportEmail) {
      sendFailureEmail(config.reportEmail, targetDateStr, err.toString());
    }
  }
}

// Runs Monthly aggregated report
function runMonthlyReport(yearMonthStr) {
  let config;
  try {
    config = loadConfig();
    Logger.log(`Running monthly report for: ${yearMonthStr}`);
    
    // Calculate start and end dates
    const parts = yearMonthStr.split('-');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // 0-indexed
    
    const startOfMonth = new Date(year, month, 1, 0, 0, 0);
    const endOfMonth = new Date(year, month + 1, 0, 23, 59, 59);
    
    const startStr = formatDate(startOfMonth);
    const endStr = formatDate(endOfMonth);
    
    // Calculate aggregated overhead day-by-day
    let totalFixedCosts = 0;
    const totalDays = endOfMonth.getDate();
    for (let day = 1; day <= totalDays; day++) {
      const currentDay = new Date(year, month, day);
      const currentDayStr = formatDate(currentDay);
      totalFixedCosts += calculateExpensesForDate(currentDayStr);
    }
    
    // Fetch aggregated data
    const shopify = fetchShopifyMetrics(config, startOfMonth, endOfMonth);
    const adSpend = fetchMetaSpend(config, startStr, endStr);
    
    // Calculations
    const adjustedRevenue = shopify.netSales - shopify.refunds;
    const cogs = shopify.ordersCount * config.cogsMultiplier;
    const shipping = shopify.freeShipOrdersCount * config.freeShippingCost;
    
    const paymentFeesBase = adjustedRevenue > 0 ? adjustedRevenue : 0;
    const paymentFees = (paymentFeesBase * config.gatePercent) + (shopify.ordersCount * config.perOrderFlatFee);
    
    const totalCosts = cogs + shipping + paymentFees + adSpend + totalFixedCosts;
    const estProfit = adjustedRevenue - totalCosts;
    const marginPercent = adjustedRevenue !== 0 ? (estProfit / adjustedRevenue) * 100 : 0;
    
    const results = {
      date: `${yearMonthStr} (Monthly Agg)`,
      netSales: shopify.netSales,
      refunds: shopify.refunds,
      adjustedRevenue: adjustedRevenue,
      orders: shopify.ordersCount,
      freeShipOrders: shopify.freeShipOrdersCount,
      paidShipOrders: shopify.ordersCount - shopify.freeShipOrdersCount,
      cogs: cogs,
      shipping: shipping,
      paymentFees: paymentFees,
      adSpend: adSpend,
      fixedCosts: totalFixedCosts,
      totalCosts: totalCosts,
      estProfit: estProfit,
      marginPercent: marginPercent
    };
    
    // Write back
    writeRowToDailyLog(results);
    
    // Send Email
    sendReportEmail(config.reportEmail, results, true);
    
  } catch (err) {
    Logger.log(`Monthly Execution Failure: ${err.toString()}`);
    if (config && config.reportEmail) {
      sendFailureEmail(config.reportEmail, yearMonthStr, err.toString());
    }
  }
}

// Append data to "Daily Log"
function writeRowToDailyLog(r) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Daily Log");
  if (!sheet) {
    throw new Error('Could not find tab named "Daily Log". Please create it.');
  }
  
  sheet.appendRow([
    r.date,
    Number(r.netSales.toFixed(2)),
    Number(r.refunds.toFixed(2)),
    Number(r.adjustedRevenue.toFixed(2)),
    r.orders,
    r.freeShipOrders,
    r.paidShipOrders,
    Number(r.cogs.toFixed(2)),
    Number(r.shipping.toFixed(2)),
    Number(r.paymentFees.toFixed(2)),
    Number(r.adSpend.toFixed(2)),
    Number(r.fixedCosts.toFixed(2)),
    Number(r.totalCosts.toFixed(2)),
    Number(r.estProfit.toFixed(2)),
    Number(r.marginPercent.toFixed(2))
  ]);
}

// Send standard email report
function sendReportEmail(email, r, isMonthly) {
  const type = isMonthly ? "Monthly" : "Daily";
  const subject = `${type} Profit Report - ${r.date}`;
  
  const body = `${type.toUpperCase()} PROFIT REPORT FOR ${r.date}
--------------------------------------------------
Net Sales (ex GST):        $${r.netSales.toFixed(2)}
Refunds Issued:            $${r.refunds.toFixed(2)}
Adjusted Revenue:          $${r.adjustedRevenue.toFixed(2)}

Total Orders:              ${r.orders}
  - Free Ship Orders:      ${r.freeShipOrders}
  - Paid Ship Orders:      ${r.paidShipOrders}

Calculated Costs:
  - Cost of Goods (COGS):  $${r.cogs.toFixed(2)}
  - Shipping Cost:         $${r.shipping.toFixed(2)}
  - Payment Gate Fees:     $${r.paymentFees.toFixed(2)}
  - Meta Ad Spend:         $${r.adSpend.toFixed(2)}
  - Amortized Fixed Costs: $${r.fixedCosts.toFixed(2)}
--------------------------------------------------
TOTAL COSTS:               $${r.totalCosts.toFixed(2)}

ESTIMATED NET PROFIT:      $${r.estProfit.toFixed(2)}
PROFIT MARGIN:             ${r.marginPercent.toFixed(2)}%
--------------------------------------------------
Report generated automatically by Google Sheets Apps Script.`;

  MailApp.sendEmail(email, subject, body);
}

// Send error alert email
function sendFailureEmail(email, target, errorMsg) {
  const subject = `[ALERT] Profit Reporter Execution Failure - ${target}`;
  const body = `ATTENTION: The automatic Profit Reporter execution failed for ${target}.

Error Message:
${errorMsg}

Please check:
1. Your "Config" sheet tab settings (especially Shopify domain and Access Tokens).
2. Your Shopify App permissions (ensure "read_orders" is enabled).
3. Your Meta Ads System User Token and Account ID.
4. Sheet tab names ("Config", "Expenses", "Daily Log") are correctly spelled.`;

  MailApp.sendEmail(email, subject, body);
}

/* ==========================================================================
   DATE & MATH HELPERS
   ========================================================================== */
function parseDate(dateStr) {
  const parts = dateStr.toString().split('-');
  return new Date(parts[0], parts[1] - 1, parts[2]);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
}

function getDaysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
         d1.getMonth() === d2.getMonth() &&
         d1.getDate() === d2.getDate();
}
