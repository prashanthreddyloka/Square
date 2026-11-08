# Square

**Personal AI agents that settle up between friends, on PayPal.**

You and your friends each have an agent. Your agent keeps track of what you pay for. When it's time to settle, your agent and your friend's agent talk to each other: they show each other credentials tied to their humans' PayPal allowances, check every line of the bill against what they know about their humans, dispute what's unfair, agree on a number, and move the money through PayPal. You only get asked when one of your own rules says so.

Nobody has to send the "hey, you still owe me for the Airbnb" text again.

Square works across all your groups. The demo has four friends in three groups: a **Lisbon trip** (all four), **Apartment 4B** (Maya and Priya are roommates) and **Friday lunches** (Alex and Sam from work). Every settle-up is between two people's agents, directly, on PayPal, and it covers **every group those two share in one payment**: Priya pays Maya once for the trip and the apartment bills, instead of once per group.

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

0. The home screen shows each friend's position and every pair that still owes money, across **All groups** or inside one group (tabs at the top). Combined rows show what each group contributes, e.g. Alex owes Sam $60 for surfing but Sam owes Alex $23 for lunches, so Alex pays $37 once. Tap a person to see their balance with each friend, then tap **Alex owes Maya** to open their two phones. (Deep link: `/?pair=alex,maya`. **Whole group** takes you back.)
1. Optional: on **Alex's phone**, open **Rules** and tap **Connect PayPal** to approve a standing agent allowance (PayPal Vault). Without it, everything still works: Alex approves each payment in PayPal instead (step 4).
2. Tap **Let our agents settle up** in the middle column.
3. Watch the agents' conversation print on the receipt tape:
   - **Handshake:** each agent presents a Square-issued credential, linked to the PayPal allowance its human approved and to a hash of its human's rules.
   - **Statement:** Maya's agent sends an itemized bill: Alex owes $253.
   - **Dispute:** Alex's agent knows Alex doesn't drink and left the fado show early, so it disputes the wine and the tickets.
   - **Ruling:** Maya's agent follows Maya's rules: drop things he didn't have (wine), keep shared bookings (tickets).
   - **Agreement:** $241, recomputed by Square, never by the model.
   - **Needs approval:** $241 is above Alex's $150 auto-approve limit, so his agent asks him.
4. Tap **Approve and pay** on Alex's phone. Square charges Alex's vaulted PayPal allowance with Maya as the payee, so PayPal moves the money straight from Alex to Maya and Square never holds it. Maya's agent then checks the order on PayPal itself, through the PayPal Agent Toolkit: completed, for the agreed amount, paid to Maya. Only then is the trip marked settled, with a signed receipt.
5. Tell Maya's agent "I paid $30 for tapas" and settle again: $15 is under Alex's limit, so the agents finish without asking anyone.
6. Without a saved allowance, the approval card shows **Pay with PayPal**: Alex approves that one payment in PayPal checkout, and when he returns Square captures it once, pays Maya, verifies and settles. (Set `SQUARE_UNLINKED=invoice` to send an itemized **PayPal invoice** instead; those lines stay on hold until PayPal reports it paid.)

Try another pair too: **Priya owes Maya** $99: $28 from the Lisbon trip and $71 in apartment bills. The statement lists both groups. Priya's agent knows she doesn't drink and disputes her share of the trip's sangria and of the housewarming wine; Maya's agent accepts, so Priya pays $71 in one PayPal payment. Only Priya's shares are waived: Sam still owes his share of the sangria, and settling one pair never touches what someone owes anyone else.

New expenses go in the right group: "I paid $90 for the water bill" between Maya and Priya is filed under Apartment 4B; if you're looking at a group when you add it, that group is used when it fits.

Presenting live or recording? Open `/?present=1&pair=alex,maya`: the tape then advances one message per press of the → key.

Tip: with an AI model enabled, edit either person's rules or memory in the **Rules** tab and watch the agents negotiate differently. For example, set Maya's rule to "split everything 50/50, drinks included" and the wine dispute is declined. (Built-in rules mode only follows the default rules.)

---

## How it uses PayPal

| PayPal capability | Where Square uses it |
|---|---|
| **Vault v3: setup tokens + payment tokens** (save without purchase) | Each human approves an "agent allowance" once. The resulting payment token is what lets their agent pay later without them present. PayPal returns the payer ID with it, which Square puts (masked) on the agent's credential. |
| **Orders v2 with `vault_id`** | The debtor's agent charges its human's allowance for exactly the agreed amount. |
| **Orders v2 checkout** | When there's no saved allowance, the human approves the agreed amount in PayPal; Square captures it once on return (idempotent create and capture). |
| **Payouts v1** | Optional route (`SQUARE_PAYMENT=payouts`): Square's account receives the charge and forwards it to the friend. Used automatically if PayPal refuses to name the friend as payee. |
| **PayPal Agent Toolkit** (`@paypal/agent-toolkit`) | Exposed to the AI model as tools. The creditor's agent calls `get_order` itself to verify the payment instead of trusting the other agent. When the friend has no allowance, the agent uses `create_invoice` and `send_invoice` to send an itemized PayPal invoice. |
| **Invoicing v2** (through the toolkit) | Fallback settlement path, itemized line by line with the agreed adjustments. |
| **Webhooks** (`/api/webhooks/paypal`) | Signature-verified payout and invoice events finish settlements that were waiting on PayPal. Unverified events are logged and ignored. |

All in the free PayPal **sandbox**.

## How it uses AI

Agents are powered by **OpenAI** (Chat Completions, `gpt-4.1-mini` by default) or **Claude** (Anthropic Messages API, `claude-sonnet-5-5`). Square uses whichever key you set: `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (Claude wins if both are set). Override the model with `OPENAI_MODEL` or `ANTHROPIC_MODEL`.

- **Expense capture:** "Maya paid $40 for the museum", "I paid $60 for dinner for everyone" or a **receipt photo** (read by the model's vision) becomes itemized ledger lines, each tagged as consumable or a shared booking, so lines can be disputed individually.
- **Negotiation:** each agent gets a persona built from its own human's instructions and memory. The debtor's agent reviews the statement line by line and raises disputes with reasons. The creditor's agent rules on each one under its human's rules. Both write their own messages.
- **Words match money.** Each ruling returns a structured decision per line ("remove" or "keep") and the amount is computed only from those decisions. Before anything is shown, a separate model call reads each explanation and reports what it says; if it contradicts the decision, the agent is asked once more. If it still contradicts, Square replaces the explanation with wording generated from the decision, marks it on the tape, and the payment waits for the human even under the auto-approve limit. Agent messages that quote an amount Square didn't compute are replaced with Square's own wording. `npm test` covers this with a scripted model that contradicts itself.
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
    checkout, paypal/checkout-return|cancel   one-time PayPal approval when there's no allowance
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

Money flow in sandbox: by default the friend is the **payee** on the PayPal order, so the money goes straight from one personal sandbox account to the other. With `SQUARE_PAYMENT=payouts`, the app's sandbox business account receives it and forwards it with Payouts (that needs Payouts enabled, and a business account in a country allowed to send them).

## Set up the PayPal sandbox

1. At [developer.paypal.com](https://developer.paypal.com), create a sandbox app. Under its features, make sure **Vault** is enabled (and **Payouts**, if you use `SQUARE_PAYMENT=payouts`).
2. Under **Sandbox accounts**, note two personal accounts (one for Alex, one for Maya). Add `SAM_SANDBOX_EMAIL` and `PRIYA_SANDBOX_EMAIL` too if you want payouts to Sam and Priya to reach real sandbox accounts. You'll log in as Alex's account when you click **Connect PayPal**.
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
