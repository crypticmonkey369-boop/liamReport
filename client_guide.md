# Client Guide: Profit Reporter Portal & Google Sheets Management

Welcome to your automated **Daily Profit Reporter**! This document explains how the system works, how to use it, how to update your Google Sheet settings, and what to do if you encounter any issues.

---

## 1. What is this System & How does it work?

The Profit Reporter is an automated assistant that calculates your actual net profits and margins every single day.

```
+------------------+     +--------------------+     +-------------------+
|  Shopify Sales   |     |  Meta Ads Spend    |     |  Klaviyo Metrics  |
+--------+---------+     +---------+----------+     +---------+---------+
         |                         |                          |
         +-------------------------+--------------------------+
                                   |
                                   v
                      +------------+------------+
                      |   Profit Reporter Portal|
                      +------------+------------+
                                   | (Applies config fees & overheads)
                                   v
                      +------------+------------+
                      |       Google Sheet      | (Updates logs)
                      +------------+------------+
                                   |
                                   v
                      +------------+------------+
                      |    Daily Email Report   | (Sent to your inbox)
                      +-------------------------+
```

### Every night at 11:55 PM (Melbourne time), the system will:
1. Fetch your **Shopify** sales, refunds, and shipping details.
2. Fetch your **Meta Ads** marketing spend.
3. Read your **Google Sheet** configuration parameters (like COGS, shipping costs, and fixed overheads).
4. Calculate your net adjusted revenue, total costs, estimated profit, and profit margins.
5. Append a new row to your **Google Sheet (`Daily Log` tab)**.
6. Email the final report directly to your inbox (`servermdfw@gmail.com`).

---

## 2. Your Daily & Monthly Reports

### Daily Reports (Sent at 11:55 PM daily)
You will receive an email containing a summary of the current calendar day, structured like this:
* **Net Sales**: Total sales amount excluding GST.
* **Refunds**: Total refund lines issued on that calendar day (excluding GST).
* **Adjusted Revenue**: Net Sales minus Refunds.
* **Cost of Goods (COGS)**: Calculated based on your average COGS per order.
* **Shipping Cost**: Applied to orders where the customer paid $0 shipping.
* **Payment Fees**: Credit card and gate transaction fees.
* **Ad Spend**: Live campaign marketing spend from Meta Ads.
* **Amortized Overheads**: Your business expenses (software, contractors, etc.) broken down into a daily cost.
* **Estimated Net Profit & Margin**: Your actual cash profit and percentage margin.

### Monthly Reports (Sent at 6:00 AM on the 1st of every month)
Summarizes the entire previous calendar month, aggregating all sales, refunds, ad spend, and fixed costs to give you an overview of monthly performance.

---

## 3. How to Use the Connection Portal

Your connection portal is located at: **`https://<your-deployed-domain>.onrender.com`** *(or `http://localhost:3000` during testing)*.

This portal is a secure bridge. If Shopify, Meta, or Klaviyo disconnects or requires re-authentication, you can reconnect them in seconds:

1. Open the portal link in your browser.
2. Log in using your password: **`admin`**
3. Locate the platform card that needs updating:
   * **Shopify**: Enter your Shopify domain name (e.g. `yourstore.myshopify.com`) and click **Connect**.
   * **Meta Ads**: Click **Connect Meta Ads** and log in to authorize your Facebook ad account.
   * **Klaviyo**: Click **Connect Klaviyo** and log in to authorize.
4. **Manual Runs**: If you ever miss a report or want to verify data immediately, scroll down to the **Operations Console** on the page. Click **Run Report (Yesterday)** to trigger calculations manually and view the live logs on your screen.

---

## 4. How & When to Update Your Google Sheet

The system reads your spreadsheet live to run calculations. You can modify these values at any time during the day, and the system will automatically use the updated values during the 11:55 PM run.

Open your Google Sheet and manage these tabs:

### Tab A: `Config`
This sheet tells the program how to calculate variable fees. Update these numbers whenever your supplier pricing or postal rates change:
* **`Avg COGS per Order`**: The average cost of product inventory per order (e.g. `15.00` if an order costs you $15 on average to source).
* **`Avg Shipping Cost`**: What you pay the postal service on average to deliver orders that you offered "Free Shipping" on (e.g. `8.50`).
* **`Payment Fee Percent`**: Your credit card gateway fee percentage (e.g. `2.9` represents 2.9%).
* **`Per-Order Fee`**: The flat fee charged per credit card transaction (e.g. `0.30` representing 30 cents).
* **`Report Email`**: The email address where daily reports are sent (currently set to `servermdfw@gmail.com`).

### Tab B: `Expenses`
Add your regular business expenses here. The system will automatically calculate the daily rate and add it to the report:
* **Headers**: `Name`, `Amount ($)`, `Frequency`, `Start Date`, `End Date`
* **Supported Frequencies**:
  * `daily`: Applied exactly as entered every day.
  * `weekly`: Divided by 7 and applied daily (e.g., a $700 weekly contract is applied as $100 per day).
  * `monthly`: Divided by the number of days in that specific month (e.g., $3000 monthly rent is applied as $100/day in November, or $96.77/day in October). Handles leap years automatically!
  * `one-off`: Deducted *only* on the exact day entered in `Start Date`.
* **Dates**: Always format dates as `YYYY-MM-DD` (e.g., `2026-06-01`). If an expense is recurring, you can leave the `End Date` blank. Once a service is cancelled, fill in the `End Date` so the system stops counting it.

### Tab C: `Daily Log`
* This tab holds your historical data logs. Do not edit this tab manually unless you need to correct a past logging error. The server appends a new row to this tab automatically every night.

---

## 5. Troubleshooting & FAQ

### Q1: The Daily Report email didn't arrive tonight. What happened?
If you don't receive your email by 12:05 AM, a platform token has likely expired or disconnected. 
1. Log into your **Connection Portal**.
2. Look at the status badges on the cards (Google, Shopify, Meta, Klaviyo).
3. If any card says **Disconnected**, click the **Connect** button on that card to re-verify your account access.
4. Go to the Operations Console at the bottom and click **Run Report (Yesterday)** to backfill the missing report and verify everything is working.

### Q2: I received an "Emergency Connection Failure" email. What do I do?
This means one of the APIs (Shopify, Meta, or Google) returned a credential error. 
1. Open the email body to see the error details.
2. Log into the portal and re-authenticate the platform mentioned in the error.

### Q3: How do I change the recipient email for reports?
Simply type the new email address in the cell next to **`Report Email`** in the `Config` tab of your Google Sheet. The server will pick it up on the next execution run.

### Q4: I added a new monthly subscription to the Expenses sheet, but the total daily cost is slightly different. Why?
The system calculates monthly costs dynamically based on the exact calendar month being processed. For instance, a $300/month tool costs $10.00/day in a 30-day month (like November) but $9.67/day in a 31-day month (like December). This ensures your monthly financial aggregates remain 100% accurate at the end of the year.
