/**
 * Live integration check: real PayPal sandbox + real Claude.
 *   npm run test:live
 *
 * Needs in .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, ANTHROPIC_API_KEY,
 * ALEX_VAULT_TOKEN (+ ALEX_PAYER_ID) from connecting Alex once in the app, and MAYA_SANDBOX_EMAIL.
 *
 * It runs two negotiations on the Lisbon trip:
 *   1. Default rules: Claude agents negotiate and Square really charges and pays out in the sandbox.
 *   2. Maya's rules changed to "split everything, drinks included": the agents negotiate again,
 *      and the outcome should change. This run stops at approval, so nothing is charged twice.
 * It writes a summary to data/live-check.md you can quote or screenshot.
 */
import fs from "node:fs";
import { decide, negotiate } from "../lib/agents";
import { aiMode } from "../lib/ai";
import { accessToken, paypalMode } from "../lib/paypal";
import { getDB, mutate, resetDB } from "../lib/store";
import type { Negotiation } from "../lib/types";

function need(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`Can't run the live check: ${msg}`);
    process.exit(1);
  }
}

const describe = (n: Negotiation) =>
  [
    `- Opening statement: $${n.initialTotal.toFixed(2)}`,
    ...n.disputes.map((d) => `- Dispute "${d.itemLabel}": ${d.accepted ? "accepted" : "declined"} (${d.ruling})`),
    `- Agreed: $${n.agreedAmount.toFixed(2)}`,
    `- Status: ${n.status}`,
  ].join("\n");

async function main() {
  need(paypalMode() === "live", "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.");
  need(aiMode() === "claude", "ANTHROPIC_API_KEY is not set.");
  need(process.env.ALEX_VAULT_TOKEN, "ALEX_VAULT_TOKEN is not set. Connect Alex's PayPal in the app once and copy it from the server log.");
  need(process.env.MAYA_SANDBOX_EMAIL, "MAYA_SANDBOX_EMAIL is not set.");
  await accessToken();
  console.log("PayPal sandbox: authenticated");

  // Run 1: default rules, real settlement.
  resetDB(false);
  mutate((d) => (d.users.alex.policy.autoApproveMax = 500));
  console.log("\nRun 1: default rules (Claude negotiates, PayPal settles)");
  let first = await negotiate();
  if (first.status === "awaiting_approval") first = await decide(first.id, "approved");
  console.log(describe(first));
  const s = first.settlement;
  const p = first.payment;
  console.log(`- PayPal order: ${p?.orderId ?? "none"}; payout batch: ${p?.payouts.at(-1)?.batchId ?? "none"} (${p?.payouts.at(-1)?.status ?? "-"})`);
  for (const m of first.messages) console.log(`  [${m.from} ${m.type}] ${m.text}`);

  // Run 2: same trip, Maya's preference changed. Stop at approval.
  resetDB(false);
  mutate((d) => {
    d.users.alex.policy.autoApproveMax = 0;
    d.users.maya.policy.instructions =
      "We agreed to split everything on this trip 50/50, drinks and tickets included, no exceptions. Politely hold firm on every line.";
  });
  console.log("\nRun 2: Maya's rules changed to split everything");
  const second = await negotiate();
  console.log(describe(second));
  if (second.status === "awaiting_approval") await decide(second.id, "declined");

  const changed = second.agreedAmount !== first.agreedAmount;
  const report = `# Square live check (${new Date().toISOString()})

PayPal sandbox and Claude (${process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5"}).

## Run 1: default rules, settled on PayPal
${describe(first)}
- PayPal order: ${p?.orderId ?? "none"}
- Payout batch: ${p?.payouts.at(-1)?.batchId ?? "none"} (${p?.payouts.at(-1)?.status ?? "-"})
- Receipt: ${s?.receipt.id ?? "not issued (not settled)"}

## Run 2: Maya's preference changed to "split everything"
${describe(second)}

Outcome ${changed ? "changed" : "did NOT change"} with the preference: $${first.agreedAmount.toFixed(2)} vs $${second.agreedAmount.toFixed(2)}.
`;
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/live-check.md", report);
  resetDB(false);
  console.log(`\n${changed ? "Preference change altered the outcome." : "Warning: the outcome didn't change."} Report written to data/live-check.md`);
  process.exit(first.status === "settled" ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
