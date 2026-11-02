/**
 * End-to-end checks of the settlement logic in demo mode (simulated PayPal and rule-based agents).
 *   npm test
 * For the real PayPal sandbox and an AI model, run `npm run test:live` instead.
 */
import { captureExpense, decide, negotiate, onInvoicePaid, retrySettlement, Conflict } from "../lib/agents";
import { createPaymentToken, createSetupToken, demoHooks, paypalMode } from "../lib/paypal";
import { getDB, mutate, resetDB } from "../lib/store";
import { verifyMessage } from "../lib/trust";
import { publicState, publicUser } from "../lib/view";
import type { UserId } from "../lib/types";

let failures = 0;
function assert(cond: unknown, what: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${what}`);
  } else console.log(`ok   ${what}`);
}

async function link(user: UserId) {
  const t = await createSetupToken({ human: user, returnUrl: "http://localhost/r", cancelUrl: "http://localhost/c" });
  const p = await createPaymentToken(t.id, getDB().users[user].sandboxEmail);
  mutate((d) => {
    d.users[user].paypal = { status: "linked", paymentTokenId: p.id, payerId: p.payerId, payerEmail: p.email, mode: "demo" };
  });
}

const open = () => getDB().expenses.filter((e) => !e.settledIn && !e.invoicedIn).length;
const charges = () => demoHooks().charges.size;

async function fresh() {
  resetDB(false);
  demoHooks().charges.clear();
  demoHooks().payouts.clear();
  demoHooks().payoutOutcomes.length = 0;
  demoHooks().failStatusLookups = 0;
  await link("alex");
  await link("maya");
}

async function main() {
  if (paypalMode() !== "demo") {
    console.log("PayPal credentials are set; this suite is for demo mode. Use `npm run test:live`.");
    return;
  }

  console.log("\nInvoice path");
  resetDB(false);
  const inv = await negotiate();
  assert(inv.status === "invoiced", "debtor without an allowance gets an itemized PayPal invoice");
  assert(inv.agreedAmount === 241, `wine removed, tickets kept: agreed $${inv.agreedAmount}`);
  assert(getDB().expenses.every((e) => e.invoicedIn && !e.settledIn), "invoiced lines are held, not marked settled");
  const invoiceId = String(inv.messages.find((m) => m.type === "INVOICE")?.data?.invoiceId);
  onInvoicePaid(invoiceId);
  assert(getDB().negotiations[0].status === "settled" && getDB().expenses.every((e) => e.settledIn), "lines settle only when PayPal reports the invoice paid");

  console.log("\nHappy path with approval");
  await fresh();
  const n = await negotiate();
  assert(n.initialTotal === 253 && n.status === "awaiting_approval", "$253 opening, $241 agreed, escalates over the $150 limit");
  assert(n.messages.every(verifyMessage), "every agent message carries a valid signature");
  let blocked = false;
  try {
    await negotiate();
  } catch (e) {
    blocked = e instanceof Conflict;
  }
  assert(blocked, "a second settle-up can't start while one awaits approval");
  const both = await Promise.allSettled([decide(n.id, "approved"), decide(n.id, "approved")]);
  assert(both.filter((r) => r.status === "fulfilled").length === 1, "double-tapping Approve runs the settlement once");
  assert(charges() === 1, "debtor charged exactly once");
  const done = getDB().negotiations.find((x) => x.id === n.id)!;
  assert(done.status === "settled" && open() === 0, "settled and ledger closed after charge, payout and verification");

  console.log("\nFailed payout");
  await fresh();
  demoHooks().payoutOutcomes.push("FAILED");
  await captureExpense("maya", "I paid $30 for tapas"); // ledger now 253 + 15
  mutate((d) => (d.users.alex.policy.autoApproveMax = 500));
  const f = await negotiate();
  assert(f.status === "payout_failed", "a failed payout is reported as failed, not settled");
  assert(open() > 0, "ledger stays open after a failed payout");
  assert(charges() === 1, "charged once");
  const r = await retrySettlement(f.id);
  assert(r.status === "settled", "retry finishes the settlement");
  assert(charges() === 1, "retry did not charge again");
  assert(r.payment!.payouts.length === 2, "retry sent one new payout after the failed one");
  assert(open() === 0, "ledger closed only after the successful payout");

  console.log("\nPending payout");
  await fresh();
  demoHooks().payoutOutcomes.push("UNCLAIMED");
  mutate((d) => (d.users.alex.policy.autoApproveMax = 500));
  const pnd = await negotiate();
  assert(pnd.status === "payout_pending" && open() > 0, "an unclaimed payout leaves the ledger open");
  const r1 = await retrySettlement(pnd.id);
  assert(r1.status === "payout_pending" && r1.payment!.payouts.length === 1, "checking again doesn't send a second payout while one is pending");
  demoHooks().payouts.set(r1.payment!.payouts[0].batchId, "SUCCESS");
  const r2 = await retrySettlement(pnd.id);
  assert(r2.status === "settled" && charges() === 1 && r2.payment!.payouts.length === 1, "settles once PayPal confirms the same payout");

  console.log("\nData exposure");
  await fresh();
  const tok = getDB().users.alex.paypal.paymentTokenId!;
  await negotiate();
  const view = JSON.stringify(publicState(getDB()));
  assert(!view.includes(tok), "client state never contains the vault token");
  assert(!view.includes(getDB().users.alex.paypal.payerId!), "client state never contains a full payer ID");

  assert(!JSON.stringify(publicUser(getDB().users.alex)).includes(tok), "the policy endpoint's user view has no vault token");

  console.log("\nSimultaneous settle-ups");
  await fresh();
  const pair = await Promise.allSettled([negotiate(), negotiate()]);
  const won = pair.filter((x) => x.status === "fulfilled");
  assert(won.length === 1 && pair.some((x) => x.status === "rejected" && x.reason instanceof Conflict), "two simultaneous settle-ups: one runs, the other is refused");
  const only = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof negotiate>>>).value;
  await decide(only.id, "approved");
  assert(charges() === 1, "the expenses were charged once");

  console.log("\nExpense added while approval is pending");
  await fresh();
  const pend = await negotiate();
  const tapas = (await captureExpense("maya", "I paid $30 for tapas")).expense;
  await decide(pend.id, "approved");
  const settledN = getDB().negotiations.find((x) => x.id === pend.id)!;
  assert(settledN.status === "settled" && settledN.agreedAmount === 241, "the pending settle-up pays exactly what was agreed ($241)");
  const t = getDB().expenses.find((e) => e.id === tapas.id)!;
  assert(!t.settledIn && !t.reservedBy, "the expense added during approval is still open, not marked paid");
  assert(publicState(getDB()).statement.total === 15, "the new $15 is what's owed now");

  console.log("\nPayout status lookup fails right after sending");
  await fresh();
  mutate((d) => (d.users.alex.policy.autoApproveMax = 500));
  demoHooks().failStatusLookups = 1;
  const lost = await negotiate();
  const rec = lost.payment!.payouts[0];
  assert(lost.status === "payout_pending" && rec.batchId.length > 0, "the payout batch ID was saved before the lookup failed");
  const rr = await retrySettlement(lost.id);
  assert(rr.status === "settled" && rr.payment!.payouts.length === 1 && charges() === 1, "recovery re-checks the same payout: no second payout, no second charge");

  console.log("\nAuto-settle under the limit");
  await fresh();
  mutate((d) => {
    for (const e of d.expenses) e.settledIn = "seed";
  });
  await captureExpense("maya", "I paid $30 for tapas");
  const small = await negotiate();
  assert(small.status === "settled" && small.agreedAmount === 15, "$15 settles without asking");

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
