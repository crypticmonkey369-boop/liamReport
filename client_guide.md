# Operational Guide: Daily Profit Reporter Portal

Welcome to your automated **Daily Profit Reporter**! This guide will walk you through the one-time setup, how to configure your business metrics in Google Sheets, and how to use the portal dashboard.

---

## 1. Quick One-Time Connection Setup

To activate reporting, you need to authorize the portal to securely read sales and marketing data. 

1. **Open the Portal Link**: Go to: **[https://liamreport.onrender.com](https://liamreport.onrender.com)**
2. **Access the Portal**: Enter your portal password: **`admin`**
3. **Connect Your Channels**:
   * 🔑 **Google Sheet**: Already connected automatically. (No action needed!)
   * 🛍️ **Shopify**: Type your Shopify store domain (e.g. `formworkwear.myshopify.com`) and click **Connect Shopify**. Log in to Shopify in the popup and click **Approve/Install**.
   * 🎯 **Meta Ads**: Click **Connect Meta Ads**, log in to Facebook, and authorize reading ad account insights.
   * ✉️ **Klaviyo**: Click **Connect Klaviyo**, log in, and authorize access.
4. **Done!** Once the status badges turn green and show **Connected**, you can close the tab. The reporter will now run in the background.

---

## 2. Managing Your Google Sheet Settings

The system reads your spreadsheet live to run calculations. You can change these numbers at any time, and the reporter will pick them up on the next automatic run.

Open your Google Sheet and manage these tabs:

### Tab A: `Config`
This sheet tells the program how to calculate variable fees and email reports. Update these numbers whenever supplier pricing or shipping rates change:
* **`Avg COGS per Order`**: The average cost of inventory per order (e.g., if an average order costs you $15 to source, enter `15`).
* **`Avg Shipping Cost`**: What you pay the postal service on average to deliver orders that you offered "Free Shipping" on (e.g., `8.50`).
* **`Payment Fee Percent`**: Your credit card gateway fee percentage (e.g., `2.9` for 2.9%).
* **`Per-Order Fee`**: The flat fee charged per transaction (e.g., `0.30` representing 30 cents).
* **`Report Email`**: The email address where daily reports should be sent (currently set to `servermdfw@gmail.com`).

### Tab B: `Expenses`
Add your regular business expenses here (software subscriptions, contractors, etc.). The system will automatically calculate the daily rate and add it to the cost total:
* **Headers**: `Name`, `Amount ($)`, `Frequency`, `Start Date`, `End Date`
* **Frequencies supported**:
  * `daily`: Applied exactly as entered every day.
  * `weekly`: Divided by 7 and applied daily (e.g., a $700 weekly contract is applied as $100 per day).
  * `monthly`: Divided by the number of days in that specific month (e.g., a $3000 monthly rent is applied as $100/day in November, or $96.77/day in December). Handles leap years automatically!
  * `one-off`: Deducted *only* on the exact day entered in `Start Date`.
* **Dates**: Always format dates as `YYYY-MM-DD` (e.g., `2026-06-01`). If an expense is recurring, leave the `End Date` cell blank. Fill in the `End Date` once a service is cancelled.

### Tab C: `Daily Log`
* This tab holds your historical data logs. The server appends a new row to this tab automatically every night. Do not edit this tab manually unless you need to correct a past logging error.

---

## 3. Your Reports

### Daily Reports (Emailed at 11:55 PM Melbourne Time)
You will receive an email containing a summary of the current calendar day, structured like this:
* **Net Sales**: Total sales amount excluding GST.
* **Refunds**: Total refund lines issued on that calendar day (excluding GST).
* **Adjusted Revenue**: Net Sales minus Refunds.
* **Cost of Goods (COGS)**: Calculated based on your average COGS per order.
* **Shipping Cost**: Applied to orders where the customer paid $0 shipping.
* **Payment Fees**: Credit card and gate transaction fees.
* **Ad Spend**: Live campaign marketing spend from Meta Ads.
* **Amortized Overheads**: Your business expenses (from your Expenses sheet) broken down into a daily cost.
* **Estimated Net Profit & Margin**: Your actual cash profit and percentage margin.

### Monthly Reports (Emailed at 6:00 AM on the 1st of every month)
Summarizes the entire previous calendar month, aggregating all sales, refunds, ad spend, and fixed costs to give you an overview of monthly performance.

---

## 4. Manual Runs (Operations Console)

If you ever miss a report or want to verify data immediately, scroll down to the **Operations Console** on the portal page:
* Click **Run Report (Yesterday)** to trigger calculations manually and view the live logs on your screen.
* Select a custom date and click **Run for Date** to backfill missing records.

---

## 5. Troubleshooting & FAQ

#### Q: The Daily Report email didn't arrive tonight. What happened?
If you don't receive your email by 12:05 AM, a platform token has likely expired or disconnected:
1. Log into your **Connection Portal**.
2. Look at the status badges on the cards (Shopify, Meta, Klaviyo).
3. If any card says **Disconnected**, click the **Connect** button on that card to re-verify your account access.
4. Go to the Operations Console at the bottom and click **Run Report (Yesterday)** to backfill the missing report.

#### Q: I received an "Emergency Connection Failure" email. What do I do?
This means one of the APIs (Shopify or Meta) returned an authorization error. Open the email to see which platform failed, log into the portal, and re-authenticate that platform by clicking its **Connect** button.

#### Q: How do I change the recipient email for reports?
Simply type the new email address in the cell next to **`Report Email`** in the `Config` tab of your Google Sheet. The server will pick it up on the next execution run.
