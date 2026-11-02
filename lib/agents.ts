import { aiMode, ask, askJSON, askWithTools, imageBlock } from "./ai";
import { buildStatement, money, other, round2 } from "./ledger";
import { chargeAllowance, createPayout, payoutStatus, paypalMode, verifyOrder } from "./paypal";
import { getDB, mutate, uid } from "./store";
import { claudeTools, runTool, sendFriendInvoice } from "./toolkit";
import { checkTrustCard, issueTrustCard, sha256, sign, signMessage } from "./trust";
import { maskEmail } from "./view";
import type { AgentMessage, Dispute, Expense, LineItem, MessageType, Negotiation, Statement, User, UserId } from "./types";

const now = () => new Date().toISOString();

function msg(from: UserId | "square", type: MessageType, text: string, data?: Record<string, unknown>): AgentMessage {
  return signMessage({ id: uid("m"), from, type, text, data, ts: now() });
}

function persona(u: User, counterparty: User) {
  return [
    `You are ${u.name}'s personal agent inside Square, an app where friends' AI agents settle shared expenses on PayPal.`,
    `You represent ${u.name} only. You are talking to ${counterparty.name}'s agent, not to ${counterparty.name}.`,
    `${u.name}'s instructions: ${u.policy.instructions}`,
    `What you know about ${u.name}: ${u.policy.memory.join(" ") || "nothing yet."}`,
    `Square computes every amount. Never invent or recalculate money; only refer to amounts you are given.`,
    `Write like a friendly, concise person texting: one to three short sentences, no lists, no emoji.`,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Expense capture: chat text or a receipt photo becomes ledger lines  */
/* ------------------------------------------------------------------ */

type ParsedExpense = {
  description: string;
  paidBy: UserId;
  items: { label: string; amount: number; kind: "consumable" | "shared-fixed"; sharedBy: UserId[] }[];
  reply: string;
};

export async function captureExpense(author: UserId, text: string, image?: string): Promise<{ expense: Expense; reply: string }> {
  const db = getDB();
  const me = db.users[author];
  const friend = db.users[other(author)];
  let parsed: ParsedExpense;

  if (aiMode() !== "demo") {
    const system = [
      `You turn a message from ${me.name} (and optionally a receipt photo) into a shared expense between ${me.name} (id "${me.id}") and ${friend.name} (id "${friend.id}").`,
      `Return {"description": string, "paidBy": "alex"|"maya", "items": [{"label": string, "amount": number, "kind": "consumable"|"shared-fixed", "sharedBy": ["alex"|"maya", ...]}], "reply": string}.`,
      `Itemize receipts line by line when you can read them, so items can later be disputed individually. Use "consumable" for food, drinks and personal goods, "shared-fixed" for rent, tickets, rides and bookings.`,
      `Default sharedBy to both people unless the message says otherwise. Assume ${me.name} paid unless the message says ${friend.name} paid.`,
      `Amounts are in USD and must add up to the receipt total. "reply" is a one-sentence confirmation to ${me.name}.`,
    ].join("\n");
    const content = image
      ? [imageBlock(image), { type: "text" as const, text: text || "Here's the receipt." }]
      : text;
    parsed = await askJSON<ParsedExpense>(system, content);
  } else {
    if (image) throw new Error("Reading receipt photos needs an AI model. Add ANTHROPIC_API_KEY or OPENAI_API_KEY, or type the amount instead.");
    parsed = ruleBasedParse(author, friend.id, text);
  }

  const items: LineItem[] = (parsed.items || [])
    .filter((i) => Number(i.amount) > 0)
    .map((i) => ({
      id: uid("i"),
      label: String(i.label).slice(0, 80),
      amount: round2(Number(i.amount)),
      kind: i.kind === "shared-fixed" ? "shared-fixed" : "consumable",
      sharedBy: (i.sharedBy?.length ? i.sharedBy : ["alex", "maya"]).filter((u): u is UserId => u === "alex" || u === "maya"),
    }));
  if (items.length === 0) throw new Error("I couldn't find an amount in that. Try something like “I paid $42 for groceries”.");

  const expense: Expense = {
    id: uid("exp"),
    description: String(parsed.description || items[0].label).slice(0, 80),
    paidBy: parsed.paidBy === "alex" || parsed.paidBy === "maya" ? parsed.paidBy : author,
    date: now().slice(0, 10),
    source: image ? "receipt" : "chat",
    items,
  };
  mutate((d) => d.expenses.push(expense));
  return { expense, reply: parsed.reply || `Added ${expense.description} for ${money(items.reduce((s, i) => s + i.amount, 0))}, split with ${friend.name}.` };
}

function ruleBasedParse(author: UserId, friend: UserId, text: string): ParsedExpense {
  const amounts = [...text.matchAll(/\$?\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  const amount = amounts[0] ?? 0;
  const lower = text.toLowerCase();
  const friendName = friend === "alex" ? "alex" : "maya";
  const paidBy: UserId = new RegExp(`${friendName} paid`).test(lower) ? friend : author;
  const forMatch = /for (.+?)(?:[,.]|$)/i.exec(text);
  const label = forMatch ? forMatch[1].trim() : "Shared expense";
  const fixed = /(rent|airbnb|hotel|ticket|uber|taxi|ride|flight|train|parking)/i.test(text);
  return {
    description: label.charAt(0).toUpperCase() + label.slice(1),
    paidBy,
    items: [{ label: label.charAt(0).toUpperCase() + label.slice(1), amount, kind: fixed ? "shared-fixed" : "consumable", sharedBy: ["alex", "maya"] }],
    reply: `Got it: ${label} for ${money(amount)}, split evenly.`,
  };
}

/* ------------------------------------------------------------------ */
/* Agent-to-agent negotiation                                          */
/* ------------------------------------------------------------------ */

type Review = { disputes: { itemId: string; reason: string }[]; message: string };
type Ruling = { rulings: { itemId: string; accept: boolean; reason: string }[]; message: string };

function statementText(s: Statement, db = getDB()) {
  return s.lines
    .map((l) => `- [${l.itemId}] ${l.label} (${l.expense}, paid by ${db.users[l.paidBy].name}): ${l.signed >= 0 ? "" : "credit "}${money(Math.abs(l.signed))}`)
    .join("\n");
}

async function debtorReview(debtor: User, creditor: User, s: Statement): Promise<Review> {
  const db = getDB();
  const owedLines = s.lines.filter((l) => l.signed > 0);
  if (aiMode() !== "demo") {
    const items = owedLines.map((l) => {
      const exp = db.expenses.find((e) => e.id === l.expenseId)!;
      const it = exp.items.find((i) => i.id === l.itemId)!;
      return `- itemId "${l.itemId}": ${l.label} (${l.expense}), kind ${it.kind}, ${debtor.name}'s share ${money(l.share)}`;
    });
    return askJSON<Review>(
      persona(debtor, creditor),
      [
        `${creditor.name}'s agent sent this statement. ${debtor.name} owes ${money(s.total)} net.`,
        `Lines ${debtor.name} is being charged for:\n${items.join("\n")}`,
        `Dispute only lines that conflict with what you know about ${debtor.name} or their instructions. Do not dispute lines just to save money.`,
        `Return {"disputes":[{"itemId": string, "reason": string}], "message": string}. "message" is what you say to ${creditor.name}'s agent.`,
      ].join("\n\n"),
    );
  }
  // Rule-based reviewer: match what the agent knows about its human against line items.
  const memory = debtor.policy.memory.join(" ").toLowerCase();
  const disputes: Review["disputes"] = [];
  for (const l of owedLines) {
    const label = `${l.label} ${l.expense}`.toLowerCase();
    if (/(wine|vinho|beer|cocktail|sangria|bar|drinks?)/.test(label) && /(doesn't|does not|don't) drink/.test(memory)) {
      disputes.push({ itemId: l.itemId, reason: `${debtor.name} doesn't drink, so the ${l.label.toLowerCase()} shouldn't be split with them.` });
    }
    if (/(fado|show|concert|ticket)/.test(label) && /(left|leave).*(early|intermission)/.test(memory)) {
      disputes.push({ itemId: l.itemId, reason: `${debtor.name} left the show at intermission, so they'd rather not pay a full share.` });
    }
  }
  return {
    disputes,
    message: disputes.length
      ? `Thanks for pulling this together. Before ${debtor.name} pays, I'd like to raise ${disputes.length === 1 ? "one line" : `${disputes.length} lines`}.`
      : `Everything checks out on ${debtor.name}'s side.`,
  };
}

async function creditorRuling(creditor: User, debtor: User, disputes: Dispute[]): Promise<Ruling> {
  const db = getDB();
  if (aiMode() !== "demo") {
    const lines = disputes.map((d) => {
      const it = db.expenses.find((e) => e.id === d.expenseId)!.items.find((i) => i.id === d.itemId)!;
      return `- itemId "${d.itemId}": ${d.itemLabel}, kind ${it.kind}. Their reason: ${d.reason}`;
    });
    return askJSON<Ruling>(
      persona(creditor, debtor),
      [
        `${debtor.name}'s agent disputes these lines:\n${lines.join("\n")}`,
        `Decide each one by following ${creditor.name}'s instructions exactly. Be fair, not stubborn.`,
        `Return {"rulings":[{"itemId": string, "accept": boolean, "reason": string}], "message": string}.`,
      ].join("\n\n"),
    );
  }
  const rulings = disputes.map((d) => {
    const it = db.expenses.find((e) => e.id === d.expenseId)!.items.find((i) => i.id === d.itemId)!;
    return it.kind === "consumable"
      ? { itemId: d.itemId, accept: true, reason: `Fair enough, ${debtor.name} didn't have it.` }
      : { itemId: d.itemId, accept: false, reason: `That was booked for both of you, so it stays split even though ${debtor.name} left early.` };
  });
  const accepted = rulings.filter((r) => r.accept).length;
  return {
    rulings,
    message:
      accepted === rulings.length
        ? "All fair, I've taken those off."
        : accepted === 0
          ? `I hear you, but ${creditor.name}'s rule is that shared bookings stay shared.`
          : `I'll take one off, but ${creditor.name}'s rule is that shared bookings stay shared.`,
  };
}

async function say(u: User, counterparty: User, prompt: string, fallback: string) {
  if (aiMode() === "demo") return fallback;
  try {
    return (await ask(persona(u, counterparty), prompt, 200)) || fallback;
  } catch {
    return fallback;
  }
}

function sentThisWeek(user: UserId) {
  const weekAgo = Date.now() - 7 * 864e5;
  return getDB()
    .negotiations.filter((n) => n.debtor === user && n.status === "settled" && n.settlement && Date.parse(n.settlement.settledAt) > weekAgo)
    .reduce((s, n) => s + n.agreedAmount, 0);
}

export async function negotiate(): Promise<Negotiation> {
  // Everything up to the first `await` runs synchronously, so checking for an active settle-up
  // and reserving the expenses happen atomically: a second simultaneous request sees the
  // reservation and gets a Conflict instead of negotiating (and later charging) the same expenses.
  const { n, open } = mutate((db) => {
    const busy = db.negotiations.find((x) => ACTIVE.includes(x.status));
    if (busy) throw new Conflict(`Finish the current settle-up first (it's ${busy.status.replace("_", " ")}).`);
    const open = db.expenses.filter((e) => !e.settledIn && !e.invoicedIn && !e.reservedBy);
    const s = buildStatement(open);
    const n: Negotiation = {
      id: uid("neg"),
      status: s.total === 0 ? "nothing_owed" : "negotiating",
      debtor: s.debtor,
      creditor: s.creditor,
      startedAt: now(),
      messages: [],
      disputes: [],
      initialTotal: s.total,
      agreedAmount: s.total,
      expenseIds: open.map((e) => e.id),
      aiMode: aiMode(),
    };
    if (s.total > 0) for (const e of open) e.reservedBy = n.id;
    db.negotiations.unshift(n);
    return { n, open };
  });
  const db = getDB();
  const s0 = buildStatement(open);
  const debtor = db.users[n.debtor];
  const creditor = db.users[n.creditor];
  const push = (m: AgentMessage) => n.messages.push(m);

  try {
    if (s0.total === 0) {
      push(msg("square", "AGREE", "Nothing to settle. You two are all square."));
      return save(n);
    }

    // 1. Handshake: each agent presents a Square-issued credential linked to its human's PayPal account info.
    const cCard = issueTrustCard(creditor);
    const dCard = issueTrustCard(debtor);
    push(msg(creditor.id, "HELLO", `Hi, I'm ${creditor.name}'s agent. Here's my Square credential.`, { trustCard: cCard }));
    push(msg(debtor.id, "HELLO", `Hey, ${debtor.name}'s agent here. Here's mine.`, { trustCard: dCard }));
    const checks = {
      creditorCardValid: checkTrustCard(cCard),
      debtorCardValid: checkTrustCard(dCard),
      creditorPayPalLinked: cCard.paypalLinked,
      debtorPayPalLinked: dCard.paypalLinked,
      debtorCanPay: dCard.canPay,
    };
    push(
      msg(
        "square",
        "VERIFY",
        [
          checks.creditorCardValid && checks.debtorCardValid ? "Both credentials carry valid Square signatures." : "A credential failed Square's signature check.",
          checks.debtorPayPalLinked
            ? `${debtor.name} approved an agent allowance through PayPal, so ${debtor.name}'s agent can pay within ${debtor.name}'s limits.`
            : `${debtor.name} hasn't approved a PayPal allowance yet, so ${debtor.name}'s agent can negotiate but can't pay. If you agree, ${creditor.name}'s agent will send a PayPal invoice instead.`,
          `${creditor.name} will be paid at ${maskEmail(creditor.paypal.payerEmail || creditor.sandboxEmail)}.`,
        ].join(" "),
        checks,
      ),
    );
    if (!checks.creditorCardValid || !checks.debtorCardValid) {
      n.status = "error";
      release(n);
      return save(n);
    }

    // 2. Proposal: creditor's agent sends the itemized statement Square computed.
    const proposeText = await say(
      creditor,
      debtor,
      `Open the settle-up with ${debtor.name}'s agent. Net, ${debtor.name} owes ${money(s0.total)} across ${s0.lines.length} lines from the shared trip. Mention the total and invite them to check the lines.`,
      `Across your shared expenses, ${debtor.name} owes ${creditor.name} ${money(s0.total)} net. Itemized lines attached, take a look.`,
    );
    push(msg(creditor.id, "PROPOSE", proposeText, { total: s0.total, lines: s0.lines, ledgerHash: sha256(open).slice(0, 16) }));

    // 3. Review: debtor's agent checks each line against what it knows about its human.
    const review = await debtorReview(debtor, creditor, s0);
    const valid = review.disputes
      .map((d) => {
        const line = s0.lines.find((l) => l.itemId === d.itemId && l.signed > 0);
        if (!line) return null;
        return { expenseId: line.expenseId, itemId: line.itemId, itemLabel: line.label, reason: d.reason, remove: debtor.id } as Dispute;
      })
      .filter((d): d is Dispute => Boolean(d));
    n.disputes = valid;

    if (valid.length) {
      push(msg(debtor.id, "DISPUTE", review.message, { disputes: valid.map(({ itemId, itemLabel, reason }) => ({ itemId, itemLabel, reason })) }));

      // 4. Ruling: creditor's agent decides each dispute under its human's rules.
      const ruling = await creditorRuling(creditor, debtor, valid);
      for (const d of n.disputes) {
        const r = ruling.rulings.find((x) => x.itemId === d.itemId);
        d.accepted = Boolean(r?.accept);
        d.ruling = r?.reason || (d.accepted ? "Accepted." : "Declined.");
      }
      push(msg(creditor.id, "RULING", ruling.message, { rulings: n.disputes.map(({ itemId, itemLabel, accepted, ruling: why }) => ({ itemId, itemLabel, accepted, why })) }));
    }

    // 5. Agreement on a number Square recomputes from the accepted adjustments.
    const s1 = buildStatement(open, n.disputes);
    n.agreedAmount = s1.total;
    const changed = round2(s0.total - s1.total);
    const agreeText = await say(
      debtor,
      creditor,
      `Agree to settle. The final amount is ${money(s1.total)}${changed ? ` (down ${money(changed)} from the opening ${money(s0.total)})` : ""}. ${
        n.disputes.some((d) => !d.accepted) ? "Accept the declined dispute gracefully." : ""
      }`,
      `Deal. ${money(s1.total)} it is${changed ? `, thanks for taking ${money(changed)} off` : ""}.`,
    );
    push(msg(debtor.id, "AGREE", agreeText, { amount: s1.total, agreementHash: sha256({ lines: s1.lines, total: s1.total }).slice(0, 16) }));

    // 6. Guardrails: deterministic rules, not the model, decide whether money can move.
    if (!debtor.paypal.paymentTokenId) {
      return save(await invoiceInstead(n, debtor, creditor, s1));
    }
    const weekTotal = sentThisWeek(debtor.id);
    if (weekTotal + s1.total > debtor.policy.weeklyCap) {
      n.status = "awaiting_approval";
      n.approval = { userId: debtor.id, reason: `This would take ${debtor.name} past their ${money(debtor.policy.weeklyCap)} weekly cap (${money(weekTotal)} already sent this week).` };
      push(msg(debtor.id, "ESCALATE", `This is over ${debtor.name}'s weekly cap, so I'm checking with ${debtor.name} first.`, { amount: s1.total, rule: "weeklyCap" }));
      return save(n);
    }
    if (s1.total > debtor.policy.autoApproveMax) {
      n.status = "awaiting_approval";
      n.approval = { userId: debtor.id, reason: `${money(s1.total)} is above ${debtor.name}'s auto-approve limit of ${money(debtor.policy.autoApproveMax)}.` };
      push(
        msg(
          debtor.id,
          "ESCALATE",
          `That's above the ${money(debtor.policy.autoApproveMax)} I can send on my own, so I've asked ${debtor.name} to approve it. One tap on their phone.`,
          { amount: s1.total, rule: "autoApproveMax" },
        ),
      );
      return save(n);
    }
    save(n);
    return await settleClaimed(claim(n.id, ["negotiating"]), "auto");
  } catch (e) {
    n.status = "error";
    release(n);
    push(msg("square", "ERROR", `Something went wrong before any payment, so nothing was charged: ${(e as Error).message}`));
    return save(n);
  }
}

/** Free a settle-up's expenses (it ended without payment), so a new settle-up can include them. */
function release(n: Negotiation) {
  mutate((db) => {
    for (const e of db.expenses) if (e.reservedBy === n.id) e.reservedBy = undefined;
  });
}

/** Mark exactly this settle-up's expenses closed, applying its accepted adjustments. */
function closeExpenses(n: Negotiation, as: "settledIn" | "invoicedIn") {
  mutate((db) => {
    for (const e of db.expenses) {
      if (!n.expenseIds.includes(e.id) || e.reservedBy !== n.id) continue;
      if (as === "settledIn") {
        for (const it of e.items) {
          const disp = n.disputes.find((x) => x.itemId === it.id && x.accepted);
          if (disp) it.sharedBy = it.sharedBy.filter((u) => u !== disp.remove);
        }
      }
      e[as] = n.id;
      if (as === "settledIn") {
        e.reservedBy = undefined;
        e.invoicedIn = undefined;
      }
    }
  });
}

function save(n: Negotiation): Negotiation {
  mutate((db) => {
    const i = db.negotiations.findIndex((x) => x.id === n.id);
    if (i >= 0) db.negotiations[i] = n;
    else db.negotiations.unshift(n);
  });
  return n;
}

async function invoiceInstead(n: Negotiation, debtor: User, creditor: User, s: Statement) {
  const db = getDB();
  const lines = s.lines
    .filter((l) => l.signed > 0)
    .map((l) => ({ name: l.label, description: `${l.expense}, your share`, amount: l.share }));
  const credits = s.lines.filter((l) => l.signed < 0);
  if (credits.length) {
    lines.push({
      name: "Already covered by you",
      description: credits.map((c) => c.label).join(", "),
      amount: -round2(credits.reduce((sum, c) => sum + Math.abs(c.signed), 0)),
    });
  }
  const inv = await sendFriendInvoice({
    fromName: creditor.name,
    fromEmail: creditor.sandboxEmail,
    toName: debtor.name,
    toEmail: db.users[debtor.id].sandboxEmail,
    lines,
    note: `Itemized and agreed by your Square agents. Total ${money(s.total)}.`,
  });
  n.status = "invoiced";
  // The invoice now carries these lines. They aren't settled until PayPal reports the invoice paid,
  // but they stay reserved by this settle-up so the same expenses can't be billed twice.
  closeExpenses(n, "invoicedIn");
  n.messages.push(
    msg(
      creditor.id,
      "INVOICE",
      `${debtor.name} hasn't connected an allowance yet, so I've sent ${debtor.name} an itemized PayPal invoice for ${money(s.total)} instead.`,
      { invoiceId: inv.id, url: inv.url, viaAgentToolkit: true },
    ),
  );
  return n;
}

/* ------------------------------------------------------------------ */
/* Human approval and settlement on PayPal                             */
/* ------------------------------------------------------------------ */

/** Statuses that hold the ledger: no new settle-up may start while one of these exists. */
export const ACTIVE: Negotiation["status"][] = ["negotiating", "awaiting_approval", "settling", "payout_pending", "payout_failed", "unverified", "failed"];
/** Statuses a retry may resume from. */
const RESUMABLE: Negotiation["status"][] = ["payout_pending", "payout_failed", "unverified", "failed"];
const STALE_LOCK_MS = 2 * 60_000;

export class Conflict extends Error {}

/**
 * Atomically move a negotiation into "settling". Node runs this synchronously, so two
 * simultaneous requests can't both claim it; the loser gets a Conflict.
 */
function claim(id: string, from: Negotiation["status"][]): Negotiation {
  return mutate((db) => {
    const n = db.negotiations.find((x) => x.id === id);
    if (!n) throw new Error("Unknown settle-up.");
    const stale = n.status === "settling" && n.payment?.settlingSince && Date.now() - Date.parse(n.payment.settlingSince) > STALE_LOCK_MS;
    if (!from.includes(n.status) && !stale) {
      throw new Conflict(n.status === "settling" ? "This settle-up is already being processed." : `This settle-up is ${n.status.replace("_", " ")}, so it can't be processed now.`);
    }
    n.payment ??= { requestId: `${n.id}-charge`, payouts: [] };
    n.payment.settlingSince = now();
    n.status = "settling";
    return n;
  });
}

export async function decide(negotiationId: string, decision: "approved" | "declined") {
  const n = claim(negotiationId, ["awaiting_approval"]);
  const human = getDB().users[n.approval!.userId];
  n.approval!.decision = decision;
  n.approval!.decidedAt = now();
  if (decision === "declined") {
    n.status = "declined";
    release(n);
    n.messages.push(msg(human.id, "DECLINED", `${human.name} declined for now. Nothing was sent.`));
    return save(n);
  }
  n.messages.push(msg(human.id, "APPROVED", `${human.name} approved ${money(n.agreedAmount)}. Sending it now.`, { approvedBy: human.id }));
  save(n);
  return settleClaimed(n, "human");
}

/** Retry a settlement that didn't finish. Never charges twice; never pays twice. */
export async function retrySettlement(negotiationId: string) {
  return settleClaimed(claim(negotiationId, RESUMABLE), "retry");
}

/** Called by the PayPal webhook when an invoice is paid: only then are invoiced lines settled. */
export function onInvoicePaid(invoiceId: string) {
  const n = getDB().negotiations.find((x) => x.status === "invoiced" && x.messages.some((m) => m.type === "INVOICE" && m.data?.invoiceId === invoiceId));
  if (!n) return null;
  n.status = "settled";
  n.messages.push(msg("square", "CONFIRM", `PayPal reports invoice ${invoiceId} as paid. Settled.`, { invoiceId, verified: true }));
  closeExpenses(n, "settledIn");
  return save(n);
}

/** Called by the PayPal webhook when a payout's status changes. */
export async function onPayoutEvent(batchId: string) {
  const n = getDB().negotiations.find((x) => x.status === "payout_pending" && x.payment?.payouts.some((p) => p.batchId === batchId));
  if (!n) return null;
  try {
    return await settleClaimed(claim(n.id, ["payout_pending"]), "webhook");
  } catch (e) {
    if (e instanceof Conflict) return null;
    throw e;
  }
}

/**
 * The settlement state machine. Each step is persisted before the next runs:
 *   charge (idempotent) -> payout (one live attempt at a time) -> independent verification -> close ledger.
 * The ledger closes only when PayPal confirms both the capture and the payout.
 */
async function settleClaimed(n: Negotiation, via: "auto" | "human" | "retry" | "webhook"): Promise<Negotiation> {
  const db = getDB();
  const debtor = db.users[n.debtor];
  const creditor = db.users[n.creditor];
  const p = n.payment!;
  const reference = n.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30);

  // 1. Charge the debtor's allowance once.
  if (!p.captureId) {
    try {
      if (!debtor.paypal.paymentTokenId) throw new Error(`${debtor.name} has no approved PayPal allowance.`);
      const order = await chargeAllowance({
        vaultId: debtor.paypal.paymentTokenId,
        amount: n.agreedAmount,
        description: `Square: ${debtor.name} settling up with ${creditor.name}`,
        reference,
        requestId: p.requestId,
      });
      p.orderId = order.orderId;
      p.captureId = order.captureId || order.orderId;
      p.chargedAt = now();
      p.lastError = undefined;
      n.messages.push(
        msg(debtor.id, "SETTLE", `Charged ${money(n.agreedAmount)} to ${debtor.name}'s PayPal allowance.`, { orderId: order.orderId, captureId: order.captureId, via }),
      );
      save(n);
    } catch (e) {
      p.lastError = (e as Error).message;
      n.status = "failed";
      n.messages.push(msg("square", "ERROR", `PayPal didn't complete the charge, so nothing was taken. ${p.lastError}`, { retryable: true }));
      return save(n);
    }
  }

  // 2. Pay the friend. Every attempt is recorded *before* it is sent, and its batch ID is saved the
  //    moment PayPal returns it, so a crash or a failed status lookup never loses the reference.
  //    A new attempt starts only after the previous one is confirmed failed.
  const note = `${debtor.name}'s agent settled up with you on Square.${n.disputes.length ? ` Adjusted: ${n.disputes.map((d) => `${d.itemLabel} (${d.accepted ? "removed" : "kept"})`).join(", ")}.` : ""}`;
  try {
    let last = p.payouts.at(-1);
    if (!last || last.state === "failed") {
      last = { senderBatchId: `${reference}-p${p.payouts.length + 1}`, batchId: "", status: "NOT_SENT", state: "pending", at: now() };
      p.payouts.push(last);
      save(n);
    }
    if (!last.batchId) {
      // Same sender_batch_id on every try: PayPal rejects a duplicate, so this can never pay twice.
      try {
        const created = await createPayout({ senderBatchId: last.senderBatchId, email: creditor.paypal.payerEmail || creditor.sandboxEmail, amount: n.agreedAmount, note });
        Object.assign(last, { batchId: created.batchId, status: "CREATED", at: now() });
        save(n);
      } catch (e) {
        if (/DUPLICATE|sender_batch_id/i.test((e as Error).message)) {
          // PayPal already accepted this exact payout on an earlier try whose response was lost.
          Object.assign(last, { status: "ALREADY_SUBMITTED", at: now() });
          throw new Error(`PayPal already has payout ${last.senderBatchId}; check it in the PayPal activity before doing anything else`);
        }
        throw e;
      }
    }
    const st = await payoutStatus(last.batchId);
    Object.assign(last, { status: st.status, state: st.state, itemId: st.itemId ?? last.itemId, at: now() });
    save(n);
    if (last.state === "pending") {
      n.status = "payout_pending";
      n.messages.push(
        msg("square", "PENDING", `PayPal shows the payout to ${creditor.name} as ${last.status.toLowerCase()}. It isn't settled until PayPal confirms it, so the expenses stay open.`, {
          payoutBatchId: last.batchId,
          payoutStatus: last.status,
        }),
      );
      return save(n);
    }
    if (last.state === "failed") {
      n.status = "payout_failed";
      n.messages.push(
        msg("square", "ERROR", `The payout to ${creditor.name} failed (${last.status}). ${debtor.name}'s payment is held; retrying sends the payout again without charging ${debtor.name} twice.`, {
          payoutBatchId: last.batchId,
          payoutStatus: last.status,
          retryable: true,
        }),
      );
      return save(n);
    }
  } catch (e) {
    p.lastError = (e as Error).message;
    // An attempt whose outcome is unknown stays "pending": a retry re-checks it (or re-sends the same,
    // de-duplicated batch) instead of starting a second payout.
    n.status = p.payouts.at(-1)?.state === "pending" ? "payout_pending" : "payout_failed";
    n.messages.push(
      msg("square", "ERROR", `Couldn't confirm the payout yet: ${p.lastError}. The payout reference is saved; checking again won't charge ${debtor.name} or pay ${creditor.name} twice.`, {
        retryable: true,
        senderBatchId: p.payouts.at(-1)?.senderBatchId,
        payoutBatchId: p.payouts.at(-1)?.batchId || undefined,
      }),
    );
    return save(n);
  }
  const payout = p.payouts.at(-1)!;
  n.messages.push(msg(debtor.id, "SETTLE", `Sent ${money(n.agreedAmount)} to ${creditor.name} with PayPal Payouts.`, { payoutBatchId: payout.batchId, payoutStatus: payout.status }));

  // 3. The creditor's agent checks PayPal itself. Code decides; the agent explains.
  const check = await verifyOrder(p.orderId!, n.agreedAmount).catch((e) => ({ ok: false, status: String((e as Error).message), amount: "" }));
  const confirmation = await confirmOnPayPal(creditor, debtor, p.orderId!, n.agreedAmount, check.ok);
  n.messages.push(msg(creditor.id, "CONFIRM", confirmation.text, { verified: check.ok, orderStatus: check.status, amount: check.amount, toolCalls: confirmation.calls }));
  if (!check.ok) {
    n.status = "unverified";
    return save(n);
  }
  p.verifiedAt = now();

  // 4. Only now: signed receipt, close the ledger, make accepted adjustments permanent.
  const covered = getDB().expenses.filter((e) => n.expenseIds.includes(e.id));
  const ledgerHash = sha256(covered).slice(0, 16);
  const agreementHash = sha256({ id: n.id, amount: n.agreedAmount, disputes: n.disputes }).slice(0, 16);
  const receiptBody = { id: uid("rcpt"), ledgerHash, agreementHash, paymentRef: p.orderId!, issuedAt: now() };
  n.settlement = {
    mode: paypalMode(),
    orderId: p.orderId!,
    orderStatus: check.status,
    captureId: p.captureId,
    payoutBatchId: payout.batchId,
    payoutItemId: payout.itemId,
    payoutStatus: payout.status,
    amount: n.agreedAmount,
    currency: "USD",
    settledAt: now(),
    receipt: { ...receiptBody, sig: sign("square", receiptBody) },
  };
  n.status = "settled";
  p.settlingSince = undefined;
  // Close exactly the expenses this settle-up was negotiated over; anything added since stays open.
  closeExpenses(n, "settledIn");
  return save(n);
}

async function confirmOnPayPal(creditor: User, debtor: User, orderId: string, amount: number, verified: boolean) {
  const fallback = verified
    ? `Checked PayPal myself: order ${orderId} is completed for ${money(amount)}. Thanks, we're square.`
    : `PayPal doesn't show order ${orderId} as completed for ${money(amount)}, so I'm not marking this settled.`;
  if (aiMode() !== "demo") {
    try {
      const r = await askWithTools(
        `${persona(creditor, debtor)}\nYou can call PayPal Agent Toolkit tools. Verify payments yourself; never trust the other agent's claim.`,
        `${debtor.name}'s agent says it paid ${money(amount)} in PayPal order ${orderId}. Look the order up on PayPal, then write one sentence to ${debtor.name}'s agent saying what you found.`,
        claudeTools(["get_order"]),
        runTool,
      );
      return { text: r.text || fallback, calls: r.calls };
    } catch {
      // fall through
    }
  }
  await runTool("get_order", { id: orderId }).catch(() => "");
  return { text: fallback, calls: [{ name: "get_order", input: { id: orderId } }] };
}
