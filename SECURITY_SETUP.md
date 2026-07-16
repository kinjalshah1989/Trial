# Global Rani security setup

This build prevents the browser from deciding the amount charged. The Netlify server now reads the official product price, creates the PayPal order, signs the checkout, and rejects a completed payment if its amount or currency does not match.

## Required Netlify environment variables
- `PAYPAL_CLIENT_ID`
- `PAYPAL_CLIENT_SECRET`
- `PAYPAL_ENV` = `live` (or `sandbox` while testing)
- `CHECKOUT_SIGNING_SECRET` = a long random secret of at least 32 characters
- `IMAGEKIT_PRIVATE_KEY` (server only; never place it in HTML)
- Existing Firebase and order-email variables described in `ORDER_STORAGE_SETUP.md`

## Protect code and images
1. Keep the GitHub repository private.
2. In GitHub branch protection, require pull requests and restrict who can push to the production branch.
3. In Netlify, allow production deploys only from the protected branch and enable two-factor authentication for every team member.
4. In ImageKit, give upload/delete access only to the owner account. Do not expose the private key or an unsigned upload endpoint.
5. Rotate any private key that was ever pasted into HTML, committed to GitHub, or shared publicly.

Visitors can always inspect or locally alter front-end HTML in their own browser, but those changes cannot alter the official server price or modify the deployed website. Only authorized GitHub, Netlify, and ImageKit accounts can change production content.
