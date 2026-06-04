const { calculateProfitReport } = require('./financials');
const { calculateExpensesForDate } = require('./config-sheet');
const { DateTime } = require('luxon');

// Simple testing library for assertion
let testsPassed = 0;
let testsFailed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`\x1b[32m[PASS]\x1b[0m ${message}`);
    testsPassed++;
  } else {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${message}`);
    testsFailed++;
  }
}

async function runTests() {
  console.log('=== Running Profit Reporter Calculation Validation Suite ===\n');

  testFinancialCalculations();
  await testExpenseAmortizationDaily();
  await testExpenseAmortizationWeekly();
  await testExpenseAmortizationMonthlyLeapYear();
  await testExpenseAmortizationOneOff();
  testZeroRevenueEdgeCase();

  console.log(`\n=== Test Results: ${testsPassed} Passed, ${testsFailed} Failed ===`);
  if (testsFailed > 0) {
    process.exit(1);
  } else {
    console.log('\x1b[32mAll calculations verified successfully!\x1b[0m');
  }
}

// 1. Test standard financial calculations
function testFinancialCalculations() {
  const config = {
    current_cogs_multiplier: 10.0,      // $10 per order
    current_free_shipping_cost: 8.50,   // $8.50 for free shipping
    current_gate_percent: 0.025,        // 2.5% gateway fee
    current_per_order_flat_fee: 0.30,   // $0.30 per order fee
  };

  const inputs = {
    netSales: 1000.0,             // Shopify net sales (ex GST)
    refunds: 100.0,               // refunds issued on this day (ex GST)
    ordersCount: 20,              // 20 total orders
    freeShipOrdersCount: 12,      // 12 of them had free shipping (customer paid $0)
    adSpend: 300.0,               // Meta ad spend
    dailyOtherExpenses: 50.0,     // Daily fixed costs
    config
  };

  const report = calculateProfitReport(inputs);

  // Assert Calculations:
  // Adjusted Revenue = netSales (1000) - refunds (100) = 900
  assert(report.adjustedRevenue === 900.0, `Adjusted Revenue: expected 900.0, got ${report.adjustedRevenue}`);

  // COGS = ordersCount (20) * multiplier (10) = 200
  assert(report.cogs === 200.0, `COGS: expected 200.0, got ${report.cogs}`);

  // Shipping = freeShipOrdersCount (12) * free_shipping_cost (8.50) = 102
  assert(report.shipping === 102.0, `Shipping: expected 102.0, got ${report.shipping}`);

  // Payment Fees = (Adjusted Revenue (900) * gate_percent (0.025)) + (Orders (20) * flat_fee (0.30))
  // Payment Fees = 22.50 + 6.00 = 28.50
  assert(report.paymentFees === 28.50, `Payment Fees: expected 28.50, got ${report.paymentFees}`);

  // Total Costs = COGS (200) + Shipping (102) + Payment Fees (28.50) + adSpend (300) + fixed (50) = 680.50
  assert(report.totalCosts === 680.50, `Total Costs: expected 680.50, got ${report.totalCosts}`);

  // Est. Profit = Adjusted Revenue (900) - Total Costs (680.50) = 219.50
  assert(report.estProfit === 219.50, `Est. Profit: expected 219.50, got ${report.estProfit}`);

  // Margin % = (Est. Profit (219.50) / Adjusted Revenue (900)) * 100 = 24.3888%
  const expectedMargin = (219.50 / 900.0) * 100;
  assert(Math.abs(report.marginPercent - expectedMargin) < 0.0001, `Margin %: expected ${expectedMargin}%, got ${report.marginPercent}%`);
}

// 2. Test expense parser with "Daily" amortization
async function testExpenseAmortizationDaily() {
  // Mock Google sheets client
  const mockSheets = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: {
            values: [
              ['Name', 'Amount ($)', 'Frequency', 'Start Date', 'End Date'],
              ['Daily SaaS', '$10.00', 'Daily', '2026-05-01', '2026-05-31'],
              ['Expired SaaS', '$5.00', 'Daily', '2026-04-01', '2026-04-30'],
              ['Future SaaS', '$15.00', 'Daily', '2026-06-01', '']
            ]
          }
        })
      }
    }
  };

  try {
    const expenses = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2026-05-15');
    // On 2026-05-15, only 'Daily SaaS' is active (expired SaaS is in April, future SaaS starts in June)
    assert(expenses === 10.0, `Daily expense active logic: expected 10.0, got ${expenses}`);
  } catch (err) {
    assert(false, `Daily expense test failed with error: ${err.message}`);
  }
}

// 3. Test expense parser with "Weekly" amortization
async function testExpenseAmortizationWeekly() {
  const mockSheets = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: {
            values: [
              ['Name', 'Amount ($)', 'Frequency', 'Start Date', 'End Date'],
              ['Weekly Contractor', '700', 'Weekly', '2026-05-01', '']
            ]
          }
        })
      }
    }
  };

  try {
    const expenses = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2026-05-10');
    // Weekly = 700 / 7 = 100 per day
    assert(expenses === 100.0, `Weekly expense calculation: expected 100.0, got ${expenses}`);
  } catch (err) {
    assert(false, `Weekly expense test failed with error: ${err.message}`);
  }
}

// 4. Test expense parser with "Monthly" amortization & month day counting (Leap vs Non-Leap)
async function testExpenseAmortizationMonthlyLeapYear() {
  const mockSheets = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: {
            values: [
              ['Name', 'Amount ($)', 'Frequency', 'Start Date', 'End Date'],
              ['Monthly Rent', '3100', 'Monthly', '2024-01-01', '']
            ]
          }
        })
      }
    }
  };

  try {
    // Test Leap Year Feb (2024-02 has 29 days)
    const expensesLeap = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2024-02-15');
    const expectedLeap = 3100 / 29; // Feb 2024 has 29 days
    assert(Math.abs(expensesLeap - expectedLeap) < 0.0001, `Monthly leap year Feb expense (29 days): expected ${expectedLeap}, got ${expensesLeap}`);

    // Test Non-Leap year Feb (2025-02 has 28 days)
    const expensesNonLeap = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2025-02-15');
    const expectedNonLeap = 3100 / 28; // Feb 2025 has 28 days
    assert(Math.abs(expensesNonLeap - expectedNonLeap) < 0.0001, `Monthly non-leap year Feb expense (28 days): expected ${expectedNonLeap}, got ${expensesNonLeap}`);

    // Test standard month (2026-05 has 31 days)
    const expensesStandard = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2026-05-15');
    const expectedStandard = 3100 / 31; // May has 31 days
    assert(Math.abs(expensesStandard - expectedStandard) < 0.0001, `Monthly standard May expense (31 days): expected ${expectedStandard}, got ${expensesStandard}`);
  } catch (err) {
    assert(false, `Monthly expense test failed with error: ${err.message}`);
  }
}

// 5. Test expense parser with "One-off" amortization
async function testExpenseAmortizationOneOff() {
  const mockSheets = {
    spreadsheets: {
      values: {
        get: async () => ({
          data: {
            values: [
              ['Name', 'Amount ($)', 'Frequency', 'Start Date', 'End Date'],
              ['One-off Audit', '500', 'One-off', '2026-05-20', '']
            ]
          }
        })
      }
    }
  };

  try {
    // On matching day
    const expensesMatch = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2026-05-20');
    assert(expensesMatch === 500.0, `One-off expense on matching date: expected 500.0, got ${expensesMatch}`);

    // On non-matching day
    const expensesMismatch = await calculateExpensesForDate(mockSheets, 'spreadsheet_id', '2026-05-21');
    assert(expensesMismatch === 0.0, `One-off expense on non-matching date: expected 0.0, got ${expensesMismatch}`);
  } catch (err) {
    assert(false, `One-off expense test failed with error: ${err.message}`);
  }
}

// 6. Test edge case: Zero Adjusted Revenue
function testZeroRevenueEdgeCase() {
  const config = {
    current_cogs_multiplier: 5.0,
    current_free_shipping_cost: 10.0,
    current_gate_percent: 0.03,
    current_per_order_flat_fee: 0.50,
  };

  const inputs = {
    netSales: 0.0,
    refunds: 0.0,
    ordersCount: 0,
    freeShipOrdersCount: 0,
    adSpend: 0.0,
    dailyOtherExpenses: 0.0,
    config
  };

  const report = calculateProfitReport(inputs);
  assert(report.adjustedRevenue === 0.0, 'Zero inputs: Adjusted Revenue is 0');
  assert(report.totalCosts === 0.0, 'Zero inputs: Total Costs is 0');
  assert(report.estProfit === 0.0, 'Zero inputs: Est. Profit is 0');
  assert(report.marginPercent === 0.0, 'Zero inputs: Margin % is 0 (prevents division by zero)');
}

// Run if called directly
if (require.main === module) {
  runTests();
}
