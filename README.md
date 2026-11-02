# Square

**Personal AI agents that settle up between friends, on PayPal.**

You and your friends each have an agent. Your agent keeps track of what you pay for. When it's time to settle, your agent and your friend's agent talk to each other: they show each other credentials tied to their humans' PayPal allowances, check every line of the bill against what they know about their humans, dispute what's unfair, agree on a number, and move the money through PayPal. You only get asked when one of your own rules says so.

Nobody has to send the "hey, you still owe me for the Airbnb" text again.

> PayPal has said it expects agentic commerce to extend from shopping to peer-to-peer transfers. Square is a prototype of that: agent-to-agent P2P settlement, with PayPal moving the money and Square holding the agents to their humans' rules.

---

## Try it

**Hosted demo:** [square-gink.onrender.com](https://square-gink.onrender.com)

**Run locally (2 minutes, no keys needed):**

```bash
git clone <this repo> && cd square
npm install
npm run dev        # open http://localhost:3000
```

With no credentials, Square runs in **demo mode**: the full flow works and PayPal and AI responses are simulated. The header shows which mode each side is in. Add keys (below) to run against the real PayPal sandbox and Claude.

### The 60-second walkthrough

1. On **Alex's phone**, open **Rules** and tap **Connect PayPal**. Approve the one-time agent allowance in PayPal (sandbox login).
2. Tap **Let our agents settle up** in the middle column.
3. Watch the agents' conversation print on the receipt tape:
   - **Handshake:** each agent presents a Square-issued credential, linked to the PayPal allowance its human approved and to a hash of its human's rules.
   - **Statement:** Maya's agent sends an itemized bill: Alex owes $253.
   - **Dispute:** Alex's agent knows Alex doesn't drink and left the fado show early, so it disputes the wine and the tickets.
   - **Ruling:** Maya's agent follows Maya's rules: drop things he didn't have (wine), keep shared bookings (tickets).
   - **Agreement:** $241, recomputed by Square, never by the model.
   - **Needs approval:** $241 is above Alex's $150 auto-approve limit, so his agent asks him.
4. Tap **Approve and pay** on Alex's phone. Square charges Alex's vaulted PayPal allowance, pays Maya with PayPal Payouts, and checks the order on PayPal itself; Maya's agent looks it up through the PayPal Agent Toolkit. Only when the charge, the payout and the check all succeed is the trip marked settled, with a signed receipt.
5. Tell Maya's agent "I paid $30 for tapas" and settle again: $15 is under Alex's limit, so the agents finish without asking anyone.
6. Reset, skip step 1, and settle: Alex has no allowance, so Maya's agent sends him an itemized **PayPal invoice** instead. Those lines stay on hold until PayPal reports the invoice paid.

Presenting live or recording? Open `/?present=1`: the tape then advances one message per press of the → key.

Tip: with an AI model enabled, edit either person's rules or memory in the **Rules** tab and watch the agents negotiate differently. For example, set Maya's rule to "split everything 50/50, drinks included" and the wine dispute is declined. (Built-in rules mode only follows the default rules.)

---

## How it uses PayPal

| PayPal capability | Where Square uses it |
|---|---|
| **Vault v3: setup tokens + payment tokens** (save without purchase) | Each human approves an "agent allowance" once. The resulting payment token is what lets their agent pay later without them present. PayPal returns the payer ID with it, which Square puts (masked) on the agent's credential. |
| **Orders v2 with `vault_id`** | The debtor's agent charges its human's allowance for exactly the agreed amount. |
| **Payouts v1** | Square forwards the money to the friend's PayPal account. |
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) | Exposed to the AI model as tools. The creditor's agent calls `get_order` itself to verify the payment instead of trusting the other agent. When the friend has no allowance, the agent uses `create_invoice` and `send_invoice` to send an itemized PayPal invoice. |
| **Invoicing v2** (through the toolkit) | Fallback settlement path, itemized line by line with the agreed adjustments. |
| **Webhooks** (`/api/webhooks/paypal`) | Signature-verified payout and invoice events finish settlements that were waiting on PayPal. Unverified events are logged and ignored. |

All in the free PayPal **sandbox**.

## How it uses AI

Agents are powered by **OpenAI** (Chat Completions, `gpt-5-mini` by default) or **Claude** (Anthropic Messages API, `claude-sonnet-5-5`). Square uses whichever key you set: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (Claude wins if both are set). Override the model with `OPENAI_MODEL` or `ANTHROPIC_MODEL`.

- **Expense capture:** "Maya paid $40 for the museum" or a **receipt photo** (read by the model's vision) becomes itemized ledger lines, each tagged as consumable or a shared booking, so lines can be disputed individually.
- **Negotiation:** each agent gets a persona built from its own human's instructions and memory. The debtor's agent reviews the statement line by line and raises disputes with reasons. The creditor's agent rules on each one under its human's rules. Both write their own messages.
- **Verification with tools:** the creditor's agent runs a tool-use loop over PayPal Agent Toolkit tools to look up the order and report what it found. Whether the payment counts as verified is decided in code (status, capture and amount), not by the model.

**What the model is not allowed to do:** compute money or decide whether money moves. Amounts are recomputed deterministically from the ledger and the accepted disputes (`lib/ledger.ts`). Spending limits and weekly caps are enforced in code (`lib/agents.ts`), not in the prompt. A prompt-injected agent can argue, but it can't overspend.

Without an AI key, the same protocol runs on built-in rules so the demo always works.

## Trust, by design

- **Agent credentials:** before any money moves, each agent presents a credential issued and signed by Square (not by PayPal). It records whether the human approved a PayPal allowance, the (masked) PayPal payer ID Square received from that approval, and a hash of the human's current rules. The other side checks Square's signature. In production this role would be filled by a standard such as AP2 mandates.
- **Signed messages:** every message on the tape is HMAC-signed with the sending agent's own key (`lib/trust.ts`).
- **Human in the loop where it matters:** per-settlement auto-approve limit and a weekly cap, set by each human and enforced in code.
- **Verify, don't trust:** after paying, Square looks the order up on PayPal and checks status, capture and amount before anything is marked settled.
- **Receipts:** each settlement produces a signed receipt linking the ledger snapshot hash, the agreement hash and the PayPal order ID: an evidence trail for when "no human pressed pay".

## Settlement guarantees

Settlement is a saved, step-by-step state machine (`lib/agents.ts`):

1. **Charge once.** The charge uses a fixed `PayPal-Request-Id` per settle-up, so a retry gets the original order back instead of charging again. The order ID is saved before anything else happens.
2. **Pay out safely.** Each payout attempt has its own `sender_batch_id`, which PayPal refuses to reuse. A new attempt is made only after the previous one is confirmed failed; a pending one is re-checked, never duplicated.
3. **Close only on success.** The expenses are marked settled only when the capture is completed, the payout is `SUCCESS`, and the order check passes. A failed or pending payout leaves the trip open and shows a **Retry settlement** or **Check PayPal again** button; verified PayPal webhooks finish pending ones automatically.
4. **Fixed scope.** When a settle-up starts, it atomically reserves the exact expenses it covers, before any network call. A second simultaneous settle-up is refused, so the same expenses can't be negotiated and charged twice. Expenses added while a settle-up is waiting for approval aren't part of it: they stay open for the next one, and only the reserved expenses are ever marked paid.
5. **One at a time.** Each payment step is claimed atomically, so a double-tapped **Approve** or two open tabs can't run it twice.
6. **No lost references.** Each payout attempt is recorded before it's sent, and PayPal's batch ID is saved the moment it's returned, so a failed status lookup can always be recovered by checking again.

## Security model

- **Payment identifiers stay on the server.** The browser never receives vault tokens, customer IDs or full payer IDs; every endpoint that returns user data goes through the sanitized view in `lib/view.ts`.
- **Access code.** The demo shows both people's phones in one browser, so anyone who can open it can act for both. On a hosted copy with real sandbox keys, set `SQUARE_ACCESS_CODE`: every page and API call then requires the code first. In a real product each person would sign in on their own device and could only approve their own payments.
- **Same-origin writes.** API writes must come from the app itself with a JSON body, so another site can't trigger an approval from a visitor's browser.
- **Webhooks** only change state when PayPal's signature check passes (`PAYPAL_WEBHOOK_ID`).

## Architecture

```
app/
  page.tsx                  two phones + the agent channel
  components/               Phone (chat, ledger, rules, approval), Channel (receipt tape)
  api/
    expenses                text or receipt photo -> ledger lines (AI model)
    negotiate               run the agent-to-agent protocol
    approve                 human approves or declines
    retry                   resume a settlement that didn't finish
    health                  public liveness check (no data)
    paypal/connect|return   Vault setup token -> PayPal approval -> payment token
    webhooks/paypal         verified PayPal events
    policy, state, reset
lib/
  agents.ts                 protocol: handshake, statement, dispute, ruling, agreement, guardrails, settle, confirm
  ledger.ts                 deterministic money math
  paypal.ts                 Vault, Orders, Payouts, webhook verification (+ demo mode)
  toolkit.ts                PayPal Agent Toolkit bridge to model tools
  ai.ts                     OpenAI and Claude clients, JSON + tool-use loop
  trust.ts                  agent credentials, message signatures, receipts
  view.ts                   sanitized client view of the state
middleware.ts               access code and same-origin checks
scripts/e2e.ts              settlement logic tests (demo mode)
scripts/live-check.ts       live check against the PayPal sandbox and the AI model
```

State lives in `data/db.json` (a single file, fine for a demo; swap for a database in production). On the hosted demo everyone shares one trip, so press **Reset the trip** if someone else left it mid-way.

Money flow in sandbox: the debtor's allowance is charged to the app's sandbox **business** account, which then pays the friend with Payouts. Keep some sandbox balance on that business account (new sandbox business accounts start with a balance).

## Set up the PayPal sandbox

1. At [developer.paypal.com](https://developer.paypal.com), create a sandbox app. Under its features, make sure **Vault** and **Payouts** are enabled.
2. Under **Sandbox accounts**, note two personal accounts (one for Alex, one for Maya). You'll log in as Alex's account when you click **Connect PayPal**.
3. Copy `.env.example` to `.env` and fill in `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ALEX_SANDBOX_EMAIL`, `MAYA_SANDBOX_EMAIL`, and optionally `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`).
4. Optional: add a webhook pointing at `https://<your-host>/api/webhooks/paypal` and put its ID in `PAYPAL_WEBHOOK_ID`.
5. `npm run dev`.

## Deploy

Step-by-step instructions for Render (including how to keep Alex's PayPal allowance connected on a hosted demo) are in [DEPLOY.md](DEPLOY.md).

## Tests

```bash
npm test          # demo mode, no keys needed
npm run test:live # real PayPal sandbox + AI model
```

`npm test` runs the settlement logic with simulated PayPal responses: the $253 to $241 negotiation, escalation, double-tapped approval (one charge), a failed payout (trip stays open; retry pays out without charging again), a pending payout (no duplicate payout; settles once PayPal confirms), a status lookup failing right after a payout (recovered without paying twice), two simultaneous settle-ups (one refused, one charge), an expense added while approval is pending (stays open), invoice hold until paid, and that no API response contains payment tokens.

`npm run test:live` needs the keys in `.env` plus `ALEX_VAULT_TOKEN` (see [DEPLOY.md](DEPLOY.md)). It runs a real AI negotiation and settles it in the PayPal sandbox, then changes Maya's rules to "split everything" and negotiates again to show the outcome changes (the second run stops at approval, so nothing is charged twice). It writes a summary to `data/live-check.md`.

## Built with

Next.js 15, TypeScript, OpenAI or Claude, PayPal REST APIs (Vault v3, Orders v2, Payouts, Invoicing, Webhooks), PayPal Agent Toolkit.

## License

MIT, see [LICENSE](LICENSE).
