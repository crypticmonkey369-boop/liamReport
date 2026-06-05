const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

function getGoogleAuthClient() {
  // Check if we have Google OAuth credentials in tokens.json
  const TOKENS_PATH = path.join(__dirname, '../tokens.json');
  if (fs.existsSync(TOKENS_PATH)) {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
    if (tokens.google && tokens.google.refresh_token) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
      oauth2Client.setCredentials({
        refresh_token: tokens.google.refresh_token,
        access_token: tokens.google.access_token
      });

      // Register event listener for automatic Google token refreshes
      oauth2Client.on('tokens', (refreshedTokens) => {
        try {
          const currentTokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));
          currentTokens.google = {
            ...currentTokens.google,
            ...refreshedTokens
          };
          fs.writeFileSync(TOKENS_PATH, JSON.stringify(currentTokens, null, 2), 'utf8');
          console.log('[SYNC] Google OAuth token refreshed and saved to local tokens.json');

          // Sync refreshed tokens directly to Google Sheet sys_tokens tab (asynchronous)
          const spreadsheetId = process.env.GOOGLE_SHEET_ID;
          if (spreadsheetId && spreadsheetId !== 'mock_google_sheet_id') {
            const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
            sheets.spreadsheets.values.update({
              spreadsheetId,
              range: 'sys_tokens!A1:B1',
              valueInputOption: 'USER_ENTERED',
              requestBody: {
                values: [['token_data', JSON.stringify(currentTokens)]]
              }
            }).then(() => {
              console.log('[SYNC] Refreshed Google tokens synced to Google Sheet sys_tokens tab.');
            }).catch(err => {
              console.error('[SYNC ERROR] Failed to sync refreshed tokens to Google Sheet:', err.message);
            });
          }
        } catch (err) {
          console.error('[SYNC ERROR] Failed to handle Google OAuth token refresh event:', err.message);
        }
      });

      return oauth2Client;
    }
  }

  let credentials;
  
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch (e) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env variable is not a valid JSON string.');
    }
  } else {
    const keyPath = path.join(__dirname, '../service-account-key.json');
    if (fs.existsSync(keyPath)) {
      credentials = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    }
  }
  
  if (!credentials || !credentials.client_email || !credentials.private_key) {
    throw new Error('Google Sheets credentials are missing. Connect your Google Account on the dashboard or set GOOGLE_SERVICE_ACCOUNT_JSON in your env.');
  }

  // Format private key to handle escaped newlines
  const privateKey = credentials.private_key.replace(/\\n/g, '\n');

  return new google.auth.JWT(
    credentials.client_email,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
}

// Fetch variables from "Config" tab
async function fetchConfig(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Config!A1:B50',
  });
  
  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    throw new Error('Config tab is empty or could not be read.');
  }
  
  const config = {};
  for (const row of rows) {
    if (row.length >= 2) {
      const key = row[0].trim();
      const val = row[1].trim();
      config[key] = val;
    }
  }
  
  // Verify required keys
  const requiredKeys = ['Avg COGS per Order', 'Avg Shipping Cost', 'Payment Fee Percent', 'Per-Order Fee', 'Report Email'];
  for (const key of requiredKeys) {
    if (config[key] === undefined || config[key] === '') {
      throw new Error(`Config key "${key}" is missing or unreadable in the Google Sheet.`);
    }
  }
  
  return {
    current_cogs_multiplier: parseFloat(config['Avg COGS per Order']),
    current_free_shipping_cost: parseFloat(config['Avg Shipping Cost']),
    current_gate_percent: parseFloat(config['Payment Fee Percent']) / 100.0, // e.g., 2.9 becomes 0.029
    current_per_order_flat_fee: parseFloat(config['Per-Order Fee']),
    report_email: config['Report Email'],
    meta_system_user_token: config['Meta System User Token'] || config['Meta Access Token'] || null,
    meta_ad_account_id: config['Meta Ad Account ID'] || null,
    shopify_store_url: config['Shopify Store URL'] || config['Shopify Shop Domain'] || null,
    shopify_api_token: config['Shopify API Token'] || config['Shopify Access Token'] || null
  };
}

// Fetch and calculate amortized expenses for a target date
async function calculateExpensesForDate(sheets, spreadsheetId, targetDateStr) {
  // targetDateStr must be YYYY-MM-DD
  const targetDate = DateTime.fromISO(targetDateStr);
  if (!targetDate.isValid) {
    throw new Error(`Invalid target date: ${targetDateStr}`);
  }
  
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'Expenses!A1:E200',
  });
  
  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    console.log('Expenses sheet is empty, returning 0 fixed expenses.');
    return 0;
  }
  
  // Columns: [Name], [Amount ($)], [Frequency], [Start Date], [End Date]
  const headers = rows[0].map(h => h.trim().toLowerCase());
  
  const colIndex = {
    name: headers.indexOf('name'),
    amount: headers.findIndex(h => h.includes('amount')),
    frequency: headers.indexOf('frequency'),
    startDate: headers.findIndex(h => h.includes('start date') || h.includes('startdate')),
    endDate: headers.findIndex(h => h.includes('end date') || h.includes('enddate'))
  };
  
  // Fallbacks if header names are slightly different
  if (colIndex.name === -1) colIndex.name = 0;
  if (colIndex.amount === -1) colIndex.amount = 1;
  if (colIndex.frequency === -1) colIndex.frequency = 2;
  if (colIndex.startDate === -1) colIndex.startDate = 3;
  if (colIndex.endDate === -1) colIndex.endDate = 4;
  
  let totalExpenses = 0;
  
  // Parse rows (skip header)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0 || !row[colIndex.name]) continue;
    
    const name = row[colIndex.name]?.trim() || '';
    const amountStr = row[colIndex.amount]?.replace(/[^0-9.-]/g, '') || '0';
    const amount = parseFloat(amountStr);
    const frequency = row[colIndex.frequency]?.trim().toLowerCase() || '';
    const startStr = row[colIndex.startDate]?.trim() || '';
    const endStr = row[colIndex.endDate]?.trim() || '';
    
    if (isNaN(amount) || amount === 0) continue;
    
    // Date validity checks
    const startDate = DateTime.fromISO(startStr);
    if (!startDate.isValid) {
      // If start date is invalid or missing, we skip this row as we can't assert active state
      continue;
    }
    
    const endDate = endStr ? DateTime.fromISO(endStr) : null;
    if (endDate && !endDate.isValid) {
      continue; // End Date is malformed
    }
    
    // Check if targetDate falls within [StartDate, EndDate]
    const startsAfter = targetDate >= startDate.startOf('day');
    const endsBefore = endDate ? (targetDate <= endDate.endOf('day')) : true;
    
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
          // total number of days in the specific month being processed
          const daysInMonth = targetDate.daysInMonth;
          allocation = amount / daysInMonth;
          break;
        case 'one-off':
        case 'oneoff':
          // Allocation matches amount ONLY if report date matches Start Date exactly
          if (targetDate.hasSame(startDate, 'day')) {
            allocation = amount;
          }
          break;
        default:
          console.warn(`Unknown frequency "${frequency}" for expense: ${name}`);
      }
      
      totalExpenses += allocation;
    }
  }
  
  return totalExpenses;
}

// Append report results to "Daily Log"
async function writeDailyLog(sheets, spreadsheetId, data) {
  // Data matches: [Date], [Net Sales], [Refunds], [Adjusted Revenue], [Orders], [Free Ship Orders], [Paid Ship Orders], [COGS], [Shipping], [Payment Fees], [Ad Spend], [Fixed Costs], [Total Costs], [Est. Profit], [Margin %]
  const rowValue = [
    data.date,
    Number(data.netSales.toFixed(2)),
    Number(data.refunds.toFixed(2)),
    Number(data.adjustedRevenue.toFixed(2)),
    data.orders,
    data.freeShipOrders,
    data.paidShipOrders,
    Number(data.cogs.toFixed(2)),
    Number(data.shipping.toFixed(2)),
    Number(data.paymentFees.toFixed(2)),
    Number(data.adSpend.toFixed(2)),
    Number(data.fixedCosts.toFixed(2)),
    Number(data.totalCosts.toFixed(2)),
    Number(data.estProfit.toFixed(2)),
    Number(data.marginPercent.toFixed(2))
  ];
  
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Daily Log!A:O',
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [rowValue]
    }
  });
  
  return rowValue;
}

async function saveTokensToSheet(tokens) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId || spreadsheetId === 'mock_google_sheet_id') {
    return;
  }
  
  try {
    const authClient = getGoogleAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    
    try {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: 'sys_tokens!A1:B1',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['token_data', JSON.stringify(tokens)]]
        }
      });
      console.log('[SYNC] Saved tokens to Google Sheet sys_tokens tab.');
    } catch (err) {
      if (err.message.includes('NOT_FOUND')) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: 'sys_tokens'
                  }
                }
              }
            ]
          }
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: 'sys_tokens!A1:B1',
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [['token_data', JSON.stringify(tokens)]]
          }
        });
        console.log('[SYNC] Created sys_tokens sheet and saved tokens.');
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.error('[SYNC ERROR] saveTokensToSheet failed:', err.message);
  }
}

module.exports = {
  getGoogleAuthClient,
  fetchConfig,
  calculateExpensesForDate,
  writeDailyLog,
  saveTokensToSheet
};
