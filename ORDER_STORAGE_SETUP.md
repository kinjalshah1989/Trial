# Global Rani secure order storage setup

The website now calls `/api/create-order` only after PayPal reports a successful capture. The Netlify function verifies the order directly with PayPal, saves the order in the Firestore `orders` collection, and sends an order email through Resend.

## 1. Netlify environment variables

Open **Netlify → Site configuration → Environment variables** and add:

- `PAYPAL_CLIENT_ID` — the same PayPal app client ID used by checkout
- `PAYPAL_CLIENT_SECRET` — PayPal app secret (never put this in HTML)
- `PAYPAL_ENV` — `live` for real payments or `sandbox` for testing
- `FIREBASE_PROJECT_ID` — `the-global-rani-website`
- `FIREBASE_CLIENT_EMAIL` — service-account email from Firebase/Google Cloud
- `FIREBASE_PRIVATE_KEY` — service-account private key, including `-----BEGIN PRIVATE KEY-----`; Netlify may store it with `\n` line breaks
- `RESEND_API_KEY` — Resend server API key
- `ORDER_NOTIFICATION_EMAIL` — the email address that should receive new-order notices
- `ORDER_FROM_EMAIL` — a verified Resend sender, for example `orders@yourdomain.com`

After adding variables, trigger a fresh Netlify deploy.

## 2. Firebase service account

In Firebase Console, open **Project settings → Service accounts → Generate new private key**. Use only the `client_email` and `private_key` values as Netlify environment variables. Do not upload the JSON key file to GitHub or place it in this website folder.

Create a Firestore database if one does not exist. Orders will appear in:

`Firestore Database → Data → orders`

## 3. Resend

Verify your sending domain in Resend. Set `ORDER_FROM_EMAIL` to an address on that verified domain. During testing, use a recipient allowed by your Resend account.

## 4. Security behavior

- Payment card information is never stored by this website.
- The server verifies that PayPal shows the order and capture as `COMPLETED`.
- Orders are saved server-side; the browser cannot directly write to the `orders` collection through this flow.
- If Firestore fails but email succeeds, checkout still receives an order number and the email is your backup.
- If email fails but Firestore succeeds, the order remains available in Firestore.
- If both fail after payment, the cart stays on the device and the customer sees the PayPal order ID to provide to support.

## 5. Recommended Firestore rules

The order-writing Netlify function uses a service account and bypasses client rules. Unless you later build a customer order-history feature, keep direct browser access to orders blocked:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{orderId} {
      allow read, write: if false;
    }
  }
}
```

## Live PayPal client configuration

The checkout page now loads the PayPal browser Client ID from `/api/paypal-config`, which reads the same Netlify `PAYPAL_CLIENT_ID` used by the server verification function. This prevents a browser/server credential mismatch.

Set these Netlify variables from the same PayPal Live app:

- `PAYPAL_ENV=live`
- `PAYPAL_CLIENT_ID=<Live Client ID>`
- `PAYPAL_CLIENT_SECRET=<matching Live Secret>`

After changing them, trigger a fresh Netlify deploy and place a new order.


## Member order history
The included `member-orders.mjs` Netlify Function lets a signed-in Firebase member securely view only orders saved with their Firebase user ID. It uses the existing Firebase server credentials. Optional: add `FIREBASE_WEB_API_KEY` in Netlify; otherwise the website's public Firebase web API key is used by the function.
