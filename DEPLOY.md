# Deploying Square

Square is one Next.js app (UI and API together), so it deploys as a single web service. These steps use Render, which has a free tier. Total time: about 20 minutes.

## 1. Put the code on GitHub

1. Create a new **public** repository on GitHub (for example `square-paypal-agents`). Don't add a README or license there; the repo already has them.
2. In the unzipped `square` folder, run:
   ```bash
   git init
   git add -A
   git commit -m "Square: agents that settle up on PayPal"
   git branch -M main
   git remote add origin https://github.com/<you>/square-paypal-agents.git
   git push -u origin main
   ```
   Or use GitHub Desktop: add the folder as a repository and publish it as public.
3. On the repo page, click the gear next to **About** and make sure the MIT license shows. Add a one-line description and the Render URL later.

Never commit `.env`; it's already in `.gitignore`.

## 2. Get your keys

- **PayPal sandbox app:** developer.paypal.com, then Apps & Credentials, Sandbox, Create App. Copy the Client ID and Secret. In the app's features, make sure **Vault** and **Payouts** are on.
- **Sandbox accounts:** developer.paypal.com, then Testing Tools, Sandbox Accounts. Note one personal account for Alex and one for Maya (email + password; you'll need Alex's to log in once).
- **Anthropic API key:** console.anthropic.com.

## 3. Create the service on Render

1. render.com, then **New > Blueprint**, and pick your GitHub repo. Render reads `render.yaml`.
2. Fill in the secret values it asks for:

   | Variable | Value |
   |---|---|
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | from your sandbox app |
   | `ANTHROPIC_API_KEY` | your Anthropic key |
   | `ALEX_SANDBOX_EMAIL`, `MAYA_SANDBOX_EMAIL` | the two sandbox personal accounts |
   | `PAYPAL_MERCHANT_EMAIL` | your sandbox business account email (optional) |
   | `SQUARE_ACCESS_CODE` | a code you'll share only with people who should use the demo |
   | `APP_URL` | leave blank for now |
   | `ALEX_VAULT_TOKEN`, `ALEX_PAYER_ID` | leave blank for now |

3. Click **Apply**. The first build takes a few minutes. You get a URL like `https://square-agents.onrender.com`.
4. Set `APP_URL` to that URL (no trailing slash) in the service's **Environment** tab and save. Render redeploys.

## 4. Connect Alex's PayPal once, then pin it

1. Open your URL and enter your access code. The header should say **PayPal sandbox connected** and **Agents run on Claude**.
2. On Alex's phone: **Rules > Connect PayPal**, log in with Alex's sandbox account, approve.
3. In Render, open the service's **Logs**. You'll see a line like `[square] alex PayPal allowance approved: ALEX_VAULT_TOKEN=... ALEX_PAYER_ID=...`. (These identifiers are never sent to the browser.)
4. Put those two values in `ALEX_VAULT_TOKEN` and `ALEX_PAYER_ID` on Render and save.

Why: Render's free disk is wiped when the service restarts, and visitors don't have Alex's sandbox password. With the token pinned, Alex's agent is always connected and anyone with the access code can run the full flow without logging into PayPal. That's also why the access code matters: it's what keeps strangers from approving payments on your sandbox allowance.

## 5. Optional: webhooks

In your sandbox app, add a webhook to `https://<your-url>/api/webhooks/paypal` for `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `PAYMENT.PAYOUTS-ITEM.FAILED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED` and `INVOICING.INVOICE.PAID`. Put its ID in `PAYPAL_WEBHOOK_ID`. With it, a payout that was still pending finishes by itself, and a paid invoice settles its lines. Without it, use **Check PayPal again** in the app.

## 6. Check it like a visitor would

Open the URL in a private window, enter the code, and run: **Reset the trip > Let our agents settle up > Approve and pay**. Then log into sandbox.paypal.com as Maya and confirm the $241 arrived.

Locally, `npm run test:live` does the same against the sandbox and Claude, plus a run with Maya's rules changed, and writes `data/live-check.md`.

## Things to know

- **Free tier sleeps** after 15 minutes without traffic; the next visit takes up to a minute to wake. Open the URL yourself before you record or share it. A paid instance ($7/month) stays awake.
- **Everyone shares one trip.** If someone opens it mid-negotiation, **Reset the trip** starts clean.
- **If something fails in live mode,** the error prints on the agent tape and in Render's **Logs** tab.

## Other hosts

Any Node 18+ host works: `npm ci && npm run build`, then `npm start` with the same environment variables. Vercel works too, but its filesystem is read-only, so state lives in memory per instance; Render is the better fit for this demo.
