/**
 * End-to-end checks of the settlement logic in demo mode (simulated PayPal and rule-based agents).
 *   npm test
 * For the real PayPal sandbox and an AI model, run `npm run test:live` instead.
 */
import { captureExpense, decide, negotiate, onInvoicePaid, retrySettlement, Conflict, startCheckout, finishCheckout, cancelCheckout } from "../lib/agents";
import { scriptModel } from "../lib/ai";
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

/** Alex and Maya's open shares with each other. */
const am = (e: { paidBy: string }) => e.paidBy === "alex" || e.paidBy === "maya";
const owedBy = (e: { paidBy: string }) => (e.paidBy === "alex" ? "maya" : "alex");
const open = () => getDB().expenses.filter((e) => am(e) && !e.settledIn?.[owedBy(e)] && !e.invoicedIn?.[owedBy(e)] && e.items.some((i) => i.sharedBy.includes(owedBy(e)))).length;
const amOnly = () => getDB().expenses.filter((e) => am(e) && e.items.some((i) => i.sharedBy.includes(owedBy(e))));
const pairTotal = (a: string, b: string) => publicState(getDB()).pairs.find((p) => p.key === [a, b].sort().join("|"))!;
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

  console.log("\nOne-time PayPal checkout (no saved allowance)");
  resetDB(false);
  demoHooks().charges.clear();
  const co = await negotiate("alex", "maya");
  assert(co.status === "awaiting_approval" && co.approval?.mode === "checkout", "without an allowance the payer is asked to approve in PayPal");
  let refused = false;
  try {
    await decide(co.id, "approved");
  } catch (e) {
    refused = e instanceof Conflict;
  }
  assert(refused, "Approve-and-pay can't bypass PayPal approval in checkout mode");
  const url = await startCheckout(co.id, "http://localhost:3000");
  const orderId = new URL(url).searchParams.get("token")!;
  assert(charges() === 0 && getDB().negotiations[0].status === "awaiting_payer", "starting checkout charges nothing");
  cancelCheckout(co.id);
  assert(getDB().negotiations[0].status === "awaiting_approval" && amOnly().every((e) => e.reservedBy?.[owedBy(e)] === co.id), "cancelling in PayPal returns to approval, expenses stay reserved");
  const url2 = await startCheckout(co.id, "http://localhost:3000");
  assert(new URL(url2).searchParams.get("token") === orderId, "retrying checkout reuses the same PayPal order");
  let wrong = false;
  try {
    await finishCheckout(co.id, "SOMEONE-ELSES-ORDER");
  } catch {
    wrong = true;
  }
  assert(wrong && charges() === 0, "a return with a different order ID is rejected");
  const paid = await finishCheckout(co.id, orderId);
  assert(paid.status === "settled" && paid.agreedAmount === 241 && charges() === 1, "approved in PayPal: captured once, paid out, verified, settled");
  let again = false;
  try {
    await finishCheckout(co.id, orderId);
  } catch (e) {
    again = e instanceof Conflict;
  }
  assert(again && charges() === 1, "returning from PayPal twice doesn't capture twice");

  console.log("\nInvoice path (SQUARE_UNLINKED=invoice)");
  process.env.SQUARE_UNLINKED = "invoice";
  resetDB(false);
  const inv = await negotiate("alex", "maya");
  delete process.env.SQUARE_UNLINKED;
  assert(inv.status === "invoiced", "debtor without an allowance gets an itemized PayPal invoice");
  assert(inv.agreedAmount === 241, `wine removed, tickets kept: agreed $${inv.agreedAmount}`);
  assert(amOnly().every((e) => e.invoicedIn?.[owedBy(e)] && !e.settledIn?.[owedBy(e)]), "invoiced lines are held, not marked settled");
  const invoiceId = String(inv.messages.find((m) => m.type === "INVOICE")?.data?.invoiceId);
  onInvoicePaid(invoiceId);
  assert(getDB().negotiations[0].status === "settled" && amOnly().every((e) => e.settledIn?.[owedBy(e)]), "lines settle only when PayPal reports the invoice paid");

  console.log("\nHappy path with approval");
  await fresh();
  const n = await negotiate("alex", "maya");
  assert(n.initialTotal === 253 && n.status === "awaiting_approval", "$253 opening, $241 agreed, escalates over the $150 limit");
  assert(n.messages.every(verifyMessage), "every agent message carries a valid signature");
  let blocked = false;
  try {
    await negotiate("alex", "maya");
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
  await captureExpense("maya", "alex", "I paid $30 for tapas"); // ledger now 253 + 15
  mutate((d) => (d.users.alex.policy.autoApproveMax = 500));
  const f = await negotiate("alex", "maya");
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
  const pnd = await negotiate("alex", "maya");
  assert(pnd.status === "payout_pending" && open() > 0, "an unclaimed payout leaves the ledger open");
  const r1 = await retrySettlement(pnd.id);
  assert(r1.status === "payout_pending" && r1.payment!.payouts.length === 1, "checking again doesn't send a second payout while one is pending");
  demoHooks().payouts.set(r1.payment!.payouts[0].batchId, "SUCCESS");
  const r2 = await retrySettlement(pnd.id);
  assert(r2.status === "settled" && charges() === 1 && r2.payment!.payouts.length === 1, "settles once PayPal confirms the same payout");

  console.log("\nData exposure");
  await fresh();
  const tok = getDB().users.alex.paypal.paymentTokenId!;
  await negotiate("alex", "maya");
  const view = JSON.stringify(publicState(getDB()));
  assert(!view.includes(tok), "client state never contains the vault token");
  assert(!view.includes(getDB().users.alex.paypal.payerId!), "client state never contains a full payer ID");

  assert(!JSON.stringify(publicUser(getDB().users.alex)).includes(tok), "the policy endpoint's user view has no vault token");

  console.log("\nSimultaneous settle-ups");
  await fresh();
  const pair = await Promise.allSettled([negotiate("alex", "maya"), negotiate("alex", "maya")]);
  const won = pair.filter((x) => x.status === "fulfilled");
  assert(won.length === 1 && pair.some((x) => x.status === "rejected" && x.reason instanceof Conflict), "two simultaneous settle-ups: one runs, the other is refused");
  const only = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof negotiate>>>).value;
  await decide(only.id, "approved");
  assert(charges() === 1, "the expenses were charged once");

  console.log("\nExpense added while approval is pending");
  await fresh();
  const pend = await negotiate("alex", "maya");
  const tapas = (await captureExpense("maya", "alex", "I paid $30 for tapas")).expense;
  await decide(pend.id, "approved");
  const settledN = getDB().negotiations.find((x) => x.id === pend.id)!;
  assert(settledN.status === "settled" && settledN.agreedAmount === 241, "the pending settle-up pays exactly what was agreed ($241)");
  const t = getDB().expenses.find((e) => e.id === tapas.id)!;
  assert(!t.settledIn?.alex && !t.reservedBy?.alex, "the expense added during approval is still open, not marked paid");
  assert(pairTotal("alex", "maya").total === 15, "the new $15 is what's owed now");

  console.log("\nPayout status lookup fails right after sending");
  await fresh();
  mutate((d) => (d.users.alex.policy.autoApproveMax = 500));
  demoHooks().failStatusLookups = 1;
  const lost = await negotiate("alex", "maya");
  const rec = lost.payment!.payouts[0];
  assert(lost.status === "payout_pending" && rec.batchId.length > 0, "the payout batch ID was saved before the lookup failed");
  const rr = await retrySettlement(lost.id);
  assert(rr.status === "settled" && rr.payment!.payouts.length === 1 && charges() === 1, "recovery re-checks the same payout: no second payout, no second charge");

  console.log("\nAuto-settle under the limit");
  await fresh();
  mutate((d) => {
    for (const e of d.expenses) if (am(e)) e.settledIn = { [owedBy(e)]: "seed" };
  });
  await captureExpense("maya", "alex", "I paid $30 for tapas");
  const small = await negotiate("alex", "maya");
  assert(small.status === "settled" && small.agreedAmount === 15, "$15 settles without asking");

  console.log("\nGroups: pairwise settle-ups");
  await fresh();
  const st = publicState(getDB());
  const want: [string, string, string, number][] = [
    ["alex", "maya", "alex", 253],
    ["alex", "sam", "alex", 37],
    ["alex", "priya", "alex", 12],
    ["maya", "sam", "sam", 40],
    ["maya", "priya", "priya", 99],
    ["priya", "sam", "priya", 48],
  ];
  for (const [a, b, debtor, total] of want) {
    const p = pairTotal(a, b);
    assert(p.debtor === debtor && p.total === total, `${debtor} owes ${total} in ${a}/${b} (got ${p.debtor} ${p.total})`);
  }
  assert(st.members.alex.owes === 302 && st.members.maya.owed === 392, "member totals add up across pairs and groups");
  const lisbon = st.groups.find((g) => g.id === "lisbon")!;
  const apt = st.groups.find((g) => g.id === "apt4b")!;
  const lunch = st.groups.find((g) => g.id === "lunch")!;
  assert(lisbon.pairs.find((p) => p.key === "maya|priya")!.total === 28 && apt.pairs[0].total === 71, "per group: Priya owes Maya $28 for Lisbon and $71 for the apartment");
  const ls = lunch.pairs[0];
  assert(ls.debtor === "sam" && ls.total === 23 && lisbon.pairs.find((p) => p.key === "alex|sam")!.total === 60, "lunches go the other way: Sam owes Alex $23, Alex owes Sam $60 for surf");
  assert(st.pairs.find((p) => p.key === "alex|sam")!.byGroup.map((x) => x.amount).join() === "60,-23", "the combined Alex and Sam balance shows both groups");

  const am1 = await negotiate("alex", "maya");
  const mp = await negotiate("maya", "priya");
  assert(am1.status === "awaiting_approval" && mp.status !== "error", "two different pairs can settle at the same time");
  assert(mp.initialTotal === 99 && mp.agreedAmount === 71, `one settle-up covers Lisbon and the apartment; Priya's agent disputes the sangria and the housewarming wine: $99 to $${mp.agreedAmount}`);
  const propose = mp.messages.find((m) => m.type === "PROPOSE")!.data as { lines: { group?: string }[] };
  assert(new Set(propose.lines.map((l) => l.group)).size === 2, "the statement lists lines from both groups");
  let samePair = false;
  try {
    await negotiate("maya", "alex");
  } catch (e) {
    samePair = e instanceof Conflict;
  }
  assert(samePair, "the same pair can't start a second settle-up, in either order");
  await decide(am1.id, "approved");
  const sintra = getDB().expenses.find((e) => e.id === "exp_sintra")!;
  assert(!sintra.settledIn?.alex && pairTotal("alex", "priya").total === 12, "settling Alex and Maya leaves Alex's Sintra share with Priya open");
  const surf = getDB().expenses.find((e) => e.id === "exp_surf")!;
  assert(!surf.settledIn?.alex && pairTotal("alex", "sam").total === 37, "and what he owes Sam");
  // Priya hasn't saved a PayPal allowance, so she approves this one payment in PayPal checkout.
  const pu = await startCheckout(mp.id, "http://localhost:3000");
  const mpDone = await finishCheckout(mp.id, new URL(pu).searchParams.get("token")!);
  assert(mpDone.status === "settled" && mpDone.agreedAmount === 71, "Priya pays Maya $71 in one PayPal checkout");
  assert(getDB().expenses.filter((e) => e.group === "apt4b").every((e) => e.settledIn?.[e.paidBy === "maya" ? "priya" : "maya"]), "every apartment expense between them is closed");
  const market = getDB().expenses.find((e) => e.id === "exp_market")!;
  assert(market.settledIn?.priya && !market.settledIn?.sam, "Priya's share of the market dinner is settled; Sam's is still open");
  assert(market.items.find((i) => i.id === "i_sangria")!.waived?.includes("priya"), "the accepted sangria dispute waives only Priya's share");
  assert(pairTotal("maya", "sam").total === 40, "Sam still owes Maya $40, including his sangria");

  console.log("\nGroups: chat expenses name other members");
  const roomie = await captureExpense("priya", "maya", "I paid $90 for the water bill");
  assert(roomie.expense.group === "apt4b", "two roommates' bill is filed under their apartment");
  const hinted = await captureExpense("priya", "maya", "I paid $20 for postcards", undefined, "lisbon");
  assert(hinted.expense.group === "lisbon", "the group you're looking at wins when it fits");
  const g = await captureExpense("sam", "alex", "I paid $60 for dinner for everyone");
  assert(g.expense.items[0].sharedBy.length === 4 && g.expense.paidBy === "sam" && g.expense.group === "lisbon", "“for everyone” splits four ways, in the group that has everyone");
  const g2 = await captureExpense("alex", "sam", "Priya paid $30 for the tuk-tuk with me and Sam");
  assert(g2.expense.paidBy === "priya" && g2.expense.items[0].sharedBy.sort().join() === "alex,priya,sam", "another member can be the payer");
  let bad = false;
  try {
    await negotiate("alex", "alex");
  } catch {
    bad = true;
  }
  assert(bad, "a member can't settle with themselves");

  console.log("\nAI output that contradicts itself (scripted model)");
  type Turn = { decision?: string; accept?: unknown; reason: string };
  /** A fake model: the debtor's agent disputes the wine and the fado tickets; rulings come from `rounds`. */
  function fakeModel(rounds: Record<string, Turn>[], words: { propose?: string; agree?: string } = {}) {
    let round = 0;
    scriptModel((_system, user) => {
      if (user.includes("is being charged for")) {
        return JSON.stringify({ disputes: [{ itemId: "i_wine", reason: "Alex doesn't drink." }, { itemId: "i_fado", reason: "Alex left at intermission." }], message: "Two lines don't look right." });
      }
      if (user.includes("disputes these lines")) {
        const r = rounds[Math.min(round++, rounds.length - 1)];
        return JSON.stringify({ rulings: Object.entries(r).map(([itemId, t]) => ({ itemId, ...t })), message: "All fair, I've taken those off." });
      }
      if (user.includes("Does the explanation say")) {
        const text = /Explanation: "([^"]*)"/.exec(user)?.[1].toLowerCase() ?? "";
        return JSON.stringify({ says: /taken|off the bill|remove|drop/.test(text) ? "remove" : /stay|kept|keep/.test(text) ? "keep" : "unclear" });
      }
      if (user.includes("Open the settle-up")) return words.propose ?? "Alex owes $253.00 across the trip, take a look.";
      if (user.includes("Agree to settle")) return words.agree ?? "Deal, that works.";
      return "OK.";
    });
    return () => round;
  }
  const tape = (n: { messages: { text: string }[] }) => n.messages.map((m) => m.text).join("\n");
  const contradictory = {
    i_wine: { decision: "keep", reason: "Fair enough, Alex didn't drink it, so I've taken it off." },
    i_fado: { decision: "keep", reason: "Those tickets were booked for both of you, so they stay." },
  };
  const consistent = {
    i_wine: { decision: "remove", reason: "Fair enough, Alex didn't drink it, so I've taken it off." },
    i_fado: { decision: "keep", reason: "Those tickets were booked for both of you, so they stay." },
  };

  // 1. The ruling's decision and its explanation disagree once: Square asks again and gets a consistent answer.
  await fresh();
  let rounds = fakeModel([contradictory, consistent]);
  const c1 = await negotiate("alex", "maya");
  const wine1 = c1.disputes.find((d) => d.itemId === "i_wine")!;
  assert(rounds() === 2, "a contradictory ruling is sent back once");
  assert(c1.agreedAmount === 241 && wine1.accepted && wine1.rulingCheck === "matched" && !c1.reviewFlag, "the retry agrees with itself: $241, explanation shown as written");

  // 2. It stays contradictory: the amount follows the decision, the words are rewritten to match, a human must approve.
  await fresh();
  mutate((d) => (d.users.alex.policy.autoApproveMax = 1000));
  rounds = fakeModel([contradictory]);
  const c2 = await negotiate("alex", "maya");
  const wine2 = c2.disputes.find((d) => d.itemId === "i_wine")!;
  assert(c2.agreedAmount === 253 && !wine2.accepted, "the amount follows the structured decision (wine kept: $253)");
  assert(wine2.rulingCheck === "replaced" && !/taken|off/i.test(wine2.ruling!), "the explanation that said “taken it off” is not shown");
  assert(!/taken .*off|all fair/i.test(tape(c2)), "nothing on the agents' tape says the wine came off");
  assert(c2.status === "awaiting_approval" && c2.approval?.reason === c2.reviewFlag && charges() === 0, "under the auto-approve limit, it still waits for Alex instead of paying");

  // 3. Free-text messages with numbers Square didn't compute are not shown.
  await fresh();
  fakeModel([consistent], { propose: "Alex owes $229 for the trip.", agree: "Deal, $199 it is." });
  const c3 = await negotiate("alex", "maya");
  assert(!tape(c3).includes("$229") && !tape(c3).includes("$199") && c3.agreedAmount === 241, "messages quoting amounts Square didn't compute are replaced");
  const agree3 = c3.messages.find((m) => m.type === "AGREE")!;
  assert(agree3.text.includes("$241.00"), "the agreement message states the computed amount");

  // 4. A ruling with no usable decision keeps the line and asks the human.
  await fresh();
  fakeModel([{ i_wine: { accept: "yes", reason: "Sure, removed." }, i_fado: { decision: "keep", reason: "Booked for both, it stays." } }]);
  const c4 = await negotiate("alex", "maya");
  assert(c4.agreedAmount === 253 && c4.reviewFlag && c4.status === "awaiting_approval", "an unreadable decision changes nothing and goes to the human");
  scriptModel(null);

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
