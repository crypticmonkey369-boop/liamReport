# Headless Multi-Platform Financial Reporter

A cloud-deployable, zero-maintenance connection portal and 24/7 background reporting worker. This system binds permanently to the developer's pre-authenticated Google credentials behind the scenes, exposes a password-protected connection panel for client channels (Shopify, Meta Ads, Klaviyo), and uses an internal `node-cron` scheduler to automate profit audits.

## Key Architecture

1. **Permanent Google Binding (Backend Only)**: The Google Sheet and Gmail integrations use the developer's persistent `GOOGLE_REFRESH_TOKEN` set in `.env`. The client has no access to Google connection settings.
2. **Three-Button Connection UI**: A master password entry gate (`public/login.html`) leads to a 3-button console (`public/index.html`) managing Shopify, Meta Ads, and Klaviyo connections.
3. **Absolute Identity Separation**: OAuth loops run in isolated browser popups, allowing the client to authorize Shopify, Meta, or Klaviyo using their own accounts (even if they log in via their own personal Google IDs) without affecting the server's master Google Sheets connection.
4. **24/7 Server-side Scheduler**: Background reports run daily at 6:00 AM Melbourne time and monthly on the 1st of every month at 6:00 AM Melbourne time using `node-cron` inside the active server process.

---

## 1. Environment Configurations (`.env`)

Configure these keys inside your server's environment:

```ini
PORT=3000
PORTAL_PASSWORD=admin
COOKIE_SECRET=local-development-cookie-signing-secret-key-12345

# Google Developer-Owned Credentials (silently binds Sheets/Gmail)
GOOGLE_CLIENT_ID=your_real_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_real_google_client_secret
GOOGLE_REFRESH_TOKEN=your_persistent_developer_google_refresh_token
GOOGLE_SHEET_ID=your_target_google_sheet_id
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback/google

# Client Platform Developer Keys
SHOPIFY_CLIENT_ID=your_shopify_app_id
SHOPIFY_CLIENT_SECRET=your_shopify_app_secret
SHOPIFY_REDIRECT_URI=http://localhost:3000/oauth/callback/shopify

META_CLIENT_ID=your_meta_app_id
META_CLIENT_SECRET=your_meta_app_secret
META_REDIRECT_URI=http://localhost:3000/oauth/callback/meta

KLAVIYO_CLIENT_ID=your_klaviyo_app_id
KLAVIYO_CLIENT_SECRET=your_klaviyo_app_secret
KLAVIYO_REDIRECT_URI=http://localhost:3000/oauth/callback/klaviyo
```

---

## 2. Spreadsheet Settings

The bound Google Sheet must contain the three standard tabs:
1. **`Config`**:
   - `Avg COGS per Order`
   - `Avg Shipping Cost`
   - `Payment Fee Percent`
   - `Per-Order Fee`
   - `Report Email`
   - `Meta System User Token` (Optional fallback)
   - `Meta Ad Account ID`
2. **`Expenses`**:
   - Headers: `Name`, `Amount ($)`, `Frequency`, `Start Date`, `End Date`
3. **`Daily Log`**:
   - Log target for reporting outputs.

---

## 3. Docker Deployment (Render / Railway)

This project contains a `Dockerfile` for simple 1-click deployments to cloud hosts.

### Building Container Locally
```bash
docker build -t headless-financial-reporter .
```

### Running Container Locally
```bash
docker run -p 3000:3000 --env-file .env headless-financial-reporter
```

### Deploying to Render
1. Create a new **Web Service** on Render.
2. Link your Git repository.
3. Render will automatically detect the `Dockerfile` and build it.
4. Add your `.env` variables under the **Environment** tab.
