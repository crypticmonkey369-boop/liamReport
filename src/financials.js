/**
 * Runs the daily pipeline math logic based on live metrics and Google Sheet settings.
 * 
 * Input variables:
 * - netSales: Shopify Net Sales excluding GST
 * - refunds: Shopify Refunds issued on this calendar day, excluding GST
 * - ordersCount: Total Shopify Orders count
 * - freeShipOrdersCount: Count of Shopify Orders where customer paid $0 shipping
 * - adSpend: Meta Ads Spend
 * - dailyOtherExpenses: Calculated amortized expenses [Daily_Other_Expenses]
 * - config: Object with keys:
 *   - current_cogs_multiplier
 *   - current_free_shipping_cost
 *   - current_gate_percent
 *   - current_per_order_flat_fee
 */
function calculateProfitReport({
  netSales,
  refunds,
  ordersCount,
  freeShipOrdersCount,
  adSpend,
  dailyOtherExpenses,
  config
}) {
  const {
    current_cogs_multiplier,
    current_free_shipping_cost,
    current_gate_percent,
    current_per_order_flat_fee
  } = config;

  // 1. Adjusted Revenue = Shopify Net Sales (ex GST) - Shopify Refunds (issued on day, ex GST)
  const adjustedRevenue = netSales - refunds;

  // 2. COGS Total = Total Shopify Orders x [current_cogs_multiplier]
  const cogs = ordersCount * current_cogs_multiplier;

  // 3. Shipping Total = (Count of orders where shipping paid == $0) x [current_free_shipping_cost]
  const shipping = freeShipOrdersCount * current_free_shipping_cost;

  // 4. Payment Fees = (Adjusted Revenue x [current_gate_percent]) + (Total Shopify Orders x [current_per_order_flat_fee])
  // Ensure we don't have negative payment fees if adjustedRevenue is negative
  const paymentFeesBase = adjustedRevenue > 0 ? adjustedRevenue : 0;
  const paymentFees = (paymentFeesBase * current_gate_percent) + (ordersCount * current_per_order_flat_fee);

  // 5. Total Costs = COGS Total + Shipping Total + Payment Fees + Meta Ad Spend + [Daily_Other_Expenses]
  const totalCosts = cogs + shipping + paymentFees + adSpend + dailyOtherExpenses;

  // 6. Est. Profit = Adjusted Revenue - Total Costs
  const estProfit = adjustedRevenue - totalCosts;

  // 7. Margin % = (Est. Profit / Adjusted Revenue) * 100
  const marginPercent = adjustedRevenue !== 0 ? (estProfit / adjustedRevenue) * 100 : 0;

  // Paid Ship Orders Count
  const paidShipOrders = ordersCount - freeShipOrdersCount;

  return {
    netSales,
    refunds,
    adjustedRevenue,
    orders: ordersCount,
    freeShipOrders: freeShipOrdersCount,
    paidShipOrders,
    cogs,
    shipping,
    paymentFees,
    adSpend,
    fixedCosts: dailyOtherExpenses,
    totalCosts,
    estProfit,
    marginPercent
  };
}

module.exports = {
  calculateProfitReport
};
