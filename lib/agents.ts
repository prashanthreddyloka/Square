import { aiMode, ask, askJSON, askWithTools, imageBlock } from "./ai";
import { buildStatement, freeShare, money, pairKey, round2, type ShareFilter } from "./ledger";
import { captureCheckoutOrder, chargeAllowance, createCheckoutOrder, createPayout, isPayeeRefusal, paymentRoute, payoutStatus, paypalMode, verifyOrder } from "./paypal";
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
  group?: string;
  items: { label: string; amount: number; kind: "consumable" | "shared-fixed"; sharedBy: UserId[] }[];
  reply: string;
};

/**
 * Turn a chat message (or receipt photo) into a group expense. `friend` is who the author is
 * chatting about; by default the expense is split between the two of them, but the message
 * can name other group members ("for me, Sam and Priya") or a different payer.
 */
export async function captureExpense(author: UserId, friendId: UserId, text: string, image?: string, groupHint?: string): Promise<{ expense: Expense; reply: string }> {
  const db = getDB();
  const me = db.users[author];
  const friend = db.users[friendId];
  if (!me || !friend || author === friendId) throw new Error("Pick two different people in the group.");
  const ids = Object.keys(db.users);
  const roster = ids.map((id) => `${db.users[id].name} (id "${id}")`).join(", ");
  const groups = db.groups.map((g) => `"${g.id}" = ${g.name} (${g.members.map((m) => db.users[m].name).join(", ")})`).join("; ");
  let parsed: ParsedExpense;

  if (aiMode() !== "demo") {
    const system = [
      `You turn a message from ${me.name} (and optionally a receipt photo) into a shared expense in a group of friends: ${roster}.`,
      `${me.name} is chatting about expenses shared with ${friend.name}.`,
      `Return {"description": string, "paidBy": member id, "items": [{"label": string, "amount": number, "kind": "consumable"|"shared-fixed", "sharedBy": [member ids]}], "reply": string}.`,
      `Itemize receipts line by line when you can read them, so items can later be disputed individually. Use "consumable" for food, drinks and personal goods, "shared-fixed" for rent, tickets, rides and bookings.`,
      `Default sharedBy to ["${me.id}", "${friend.id}"]. If the message names other members or says "everyone" / "all of us", include exactly those members (and ${me.name} unless the message says otherwise).`,
      `Assume ${me.name} paid unless the message says someone else paid. Only use the member ids listed.`,
      `Groups: ${groups}. Set "group" to the id of the group this belongs to, judging by what it was for (rent and bills go with roommates, trip costs with the trip).${groupHint ? ` ${me.name} is looking at "${groupHint}" right now, so prefer it if it fits.` : ""} It must contain everyone in sharedBy and the payer.`,
      `Amounts are in USD and must add up to the receipt total. "reply" is a one-sentence confirmation to ${me.name} that says who it's split with.`,
    ].join("\n");
    const content = image ? [imageBlock(image), { type: "text" as const, text: text || "Here's the receipt." }] : text;
    parsed = await askJSON<ParsedExpense>(system, content);
  } else {
    if (image) throw new Error("Reading receipt photos needs an AI model. Add ANTHROPIC_API_KEY or OPENAI_API_KEY, or type the amount instead.");
    parsed = ruleBasedParse(author, friendId, text);
  }

  const known = (u: unknown): u is UserId => typeof u === "string" && ids.includes(u);
  const items: LineItem[] = (parsed.items || [])
    .filter((i) => Number(i.amount) > 0)
    .map((i) => {
      const sharedBy = [...new Set((i.sharedBy || []).filter(known))];
      return {
        id: uid("i"),
        label: String(i.label).slice(0, 80),
        amount: round2(Number(i.amount)),
        kind: i.kind === "shared-fixed" ? ("shared-fixed" as const) : ("consumable" as const),
        sharedBy: sharedBy.length >= 2 ? sharedBy : [author, friendId],
      };
    });
  if (items.length === 0) throw new Error("I couldn't find an amount in that. Try something like “I paid $42 for groceries”.");

  const paidBy = known(parsed.paidBy) ? parsed.paidBy : author;
  const expense: Expense = {
    id: uid("exp"),
    description: String(parsed.description || items[0].label).slice(0, 80),
    group: pickGroup([paidBy, ...items.flatMap((i) => i.sharedBy)], parsed.group, groupHint),
    paidBy,
    date: now().slice(0, 10),
    source: image ? "receipt" : "chat",
    items,
  };
  mutate((d) => d.expenses.push(expense));
  const others = [...new Set(items.flatMap((i) => i.sharedBy))].filter((u) => u !== author).map((u) => db.users[u].name);
  const where = expense.group ? ` Filed under ${groupName(expense.group)}.` : "";
  return {
    expense,
    reply: (parsed.reply || `Added ${expense.description} for ${money(items.reduce((s, i) => s + i.amount, 0))}, split with ${others.join(", ")}.`) + where,
  };
}

/**
 * Which group an expense goes in: one that contains everyone involved. Prefer the model's choice,
 * then the group the person is looking at, then the group these people used most recently.
 */
function pickGroup(people: UserId[], suggested?: string, hint?: string): string | undefined {
  const db = getDB();
  const fits = db.groups.filter((g) => people.every((p) => g.members.includes(p)));
  if (!fits.length) return undefined;
  for (const id of [suggested, hint]) if (id && fits.some((g) => g.id === id)) return id;
  const recent = [...db.expenses]
    .filter((e) => fits.some((g) => g.id === e.group))
    .sort((x, y) => (x.date < y.date ? 1 : -1))[0];
  // Smallest group wins ties: two roommates' groceries belong with the roommates, not the trip.
  return recent?.group ?? [...fits].sort((x, y) => x.members.length - y.members.length)[0].id;
}

function ruleBasedParse(author: UserId, friendId: UserId, text: string): ParsedExpense {
  const db = getDB();
  const amounts = [...text.matchAll(/\$?\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  const amount = amounts[0] ?? 0;
  const lower = text.toLowerCase();
  const ids = Object.keys(db.users);
  const payer = ids.find((id) => id !== author && new RegExp(`\\b${db.users[id].name.toLowerCase()} paid`).test(lower)) || author;
  const named = ids.filter((id) => new RegExp(`\\b${db.users[id].name.toLowerCase()}\\b`).test(lower));
  const sharedBy = /\b(everyone|all of us|the group)\b/.test(lower)
    ? ids
    : [...new Set([author, ...(named.length ? named : [friendId])])];
  const forMatch = /for (.+?)(?:[,.]| with | for me|$)/i.exec(text);
  const raw = forMatch ? forMatch[1].trim() : "Shared expense";
  const label = raw.charAt(0).toUpperCase() + raw.slice(1);
  const fixed = /(rent|airbnb|hotel|ticket|uber|taxi|ride|flight|train|parking|lesson)/i.test(text);
  return {
    description: label,
    paidBy: payer,
    items: [{ label, amount, kind: fixed ? "shared-fixed" : "consumable", sharedBy }],
    reply: `Got it: ${label} for ${money(amount)}, split evenly with ${sharedBy.filter((u) => u !== author).map((u) => db.users[u].name).join(", ")}.`,
  };
}

/* ------------------------------------------------------------------ */
/* Agent-to-agent negotiation                                          */
/* ------------------------------------------------------------------ */

type Review = { disputes: { itemId: string; reason: string }[]; message: string };
type Decision = "remove" | "keep";
type Ruling = { rulings: { itemId: string; decision: Decision; reason: string }[]; message: string };

/* ---- Keeping the agents' words consistent with what Square charges ----
 * The amount is computed only from each ruling's structured decision. Anything a model writes
 * in free text is checked against those decisions before it is shown; text that doesn't match
 * is retried once, then replaced with plain wording generated from the decision, and the
 * settle-up goes to the human for approval instead of paying automatically. */

const asDecision = (r: { decision?: unknown; accept?: unknown }): Decision | null =>
  r.decision === "remove" || r.decision === "keep" ? r.decision : typeof r.accept === "boolean" ? (r.accept ? "remove" : "keep") : null;

/** An independent read of an explanation: does it say the item comes off the bill or stays? */
async function explanationSays(itemLabel: string, debtorName: string, reason: string): Promise<Decision | "unclear"> {
  try {
    const r = await askJSON<{ says?: string }>(
      "You check another agent's explanation for consistency. You do not decide anything yourself; you only report what the text says.",
      [
        `Item: "${itemLabel}".`,
        `Explanation: "${reason}"`,
        `Does the explanation say ${debtorName}'s share of this item is removed from the bill, or kept on it?`,
        `Return {"says": "remove" | "keep" | "unclear"}.`,
      ].join("\n"),
      100,
    );
    return r.says === "remove" || r.says === "keep" ? r.says : "unclear";
  } catch {
    return "unclear";
  }
}

/** Every dollar amount a sentence mentions must be one Square computed. */
function amountsMatch(text: string, allowed: number[]) {
  const found = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
  return found.every((v) => allowed.some((a) => Math.abs(a - v) < 0.005));
}

/** Free text from an agent, kept only if it uses Square's numbers and doesn't name items it shouldn't. */
async function sayChecked(u: User, counterparty: User, prompt: string, fallback: string, allowed: number[], avoid: string[] = []) {
  const text = await say(u, counterparty, prompt, fallback);
  if (text === fallback) return text;
  const lower = text.toLowerCase();
  if (!amountsMatch(text, allowed) || avoid.some((a) => lower.includes(a.toLowerCase()))) return fallback;
  return text;
}

const plainRuling = (creditor: User, debtor: User, d: Decision) =>
  d === "remove" ? `${creditor.name}'s agent agreed to take ${debtor.name}'s share off.` : `${creditor.name}'s agent kept ${debtor.name}'s share on the bill.`;

/** Summary of the rulings, written from the decisions themselves. */
function rulingSummary(creditor: User, disputes: Dispute[]) {
  const off = disputes.filter((d) => d.accepted).map((d) => d.itemLabel);
  const kept = disputes.filter((d) => !d.accepted).map((d) => d.itemLabel);
  const list = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  if (!kept.length) return off.length === 1 ? `Fair enough, I've taken off ${list(off)}.` : `All fair, I've taken off ${list(off)}.`;
  if (!off.length) return `I've looked at each one. Under ${creditor.name}'s rules, ${list(kept)} ${kept.length === 1 ? "stays" : "stay"} on the bill.`;
  return `I've taken off ${list(off)}. Under ${creditor.name}'s rules, ${list(kept)} ${kept.length === 1 ? "stays" : "stay"}.`;
}

const groupName = (id?: string) => getDB().groups.find((g) => g.id === id)?.name ?? "no group";

function statementText(s: Statement, db = getDB()) {
  return s.lines
    .map((l) => `- [${l.itemId}] ${l.label} (${l.expense}${l.group ? `, ${groupName(l.group)}` : ""}, paid by ${db.users[l.paidBy].name}): ${l.signed >= 0 ? "" : "credit "}${money(Math.abs(l.signed))}`)
    .join("\n");
}

async function debtorReview(debtor: User, creditor: User, s: Statement): Promise<Review> {
  const db = getDB();
  const owedLines = s.lines.filter((l) => l.signed > 0);
  if (aiMode() !== "demo") {
    const items = owedLines.map((l) => {
      const exp = db.expenses.find((e) => e.id === l.expenseId)!;
      const it = exp.items.find((i) => i.id === l.itemId)!;
      return `- itemId "${l.itemId}": ${l.label} (${l.expense}, ${groupName(l.group)}), kind ${it.kind}, ${debtor.name}'s share ${money(l.share)}`;
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

async function creditorRuling(creditor: User, debtor: User, disputes: Dispute[], feedback = ""): Promise<Ruling> {
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
        `For each line, first write a one-sentence reason addressed to ${debtor.name}'s agent, then a decision: "remove" takes ${debtor.name}'s share off the bill, "keep" leaves it on. The reason must say the same thing as the decision.`,
        `Return {"rulings":[{"itemId": string, "reason": string, "decision": "remove" | "keep"}]}.`,
        feedback,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  const rulings = disputes.map((d) => {
    const it = db.expenses.find((e) => e.id === d.expenseId)!.items.find((i) => i.id === d.itemId)!;
    return it.kind === "consumable"
      ? { itemId: d.itemId, decision: "remove" as const, reason: `Fair enough, ${debtor.name} didn't have it.` }
      : { itemId: d.itemId, decision: "keep" as const, reason: `That was booked for ${debtor.name} too, so it stays split even though ${debtor.name} didn't use all of it.` };
  });
  const accepted = rulings.filter((r) => r.decision === "remove").length;
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

/**
 * Get the creditor's decision on each dispute and an explanation that says the same thing.
 * Retries once with feedback; anything still inconsistent is replaced and flagged for the human.
 */
async function decideDisputes(n: Negotiation, creditor: User, debtor: User) {
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let ruling: Ruling;
    try {
      ruling = await creditorRuling(creditor, debtor, n.disputes, feedback);
    } catch {
      ruling = { rulings: [], message: "" };
    }
    const problems: string[] = [];
    for (const d of n.disputes) {
      const r = ruling.rulings?.find((x) => x.itemId === d.itemId);
      const decision = r ? asDecision(r as { decision?: unknown; accept?: unknown }) : null;
      if (!decision) {
        problems.push(`No valid decision for "${d.itemLabel}".`);
        d.accepted = false;
        d.ruling = plainRuling(creditor, debtor, "keep");
        d.rulingCheck = "replaced";
        continue;
      }
      d.accepted = decision === "remove";
      const reason = String(r?.reason || "").trim();
      if (aiMode() === "demo") {
        d.ruling = reason;
        d.rulingCheck = "rules";
        continue;
      }
      const says = reason ? await explanationSays(d.itemLabel, debtor.name, reason) : "unclear";
      if (says === decision) {
        d.ruling = reason;
        d.rulingCheck = "matched";
      } else {
        problems.push(`For "${d.itemLabel}" your decision was "${decision}" but your reason reads as "${says}".`);
        d.ruling = plainRuling(creditor, debtor, decision);
        d.rulingCheck = "replaced";
      }
    }
    if (!problems.length) return;
    feedback = `Your previous answer was inconsistent: ${problems.join(" ")} Decide again; each reason must say exactly what its decision does.`;
  }
  // Still inconsistent after a retry: the amount follows the structured decisions, the shown
  // explanations were rewritten from them, and a human confirms before any money moves.
  n.reviewFlag = `${creditor.name}'s agent gave an explanation that didn't match its decision, so Square rewrote it from the decision.`;
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

/** The shares a negotiation covers: used to compute its statement over exactly those shares. */
const claimedBy = (n: Negotiation): ShareFilter => (e, u) => n.claims.some((c) => c.expenseId === e.id && c.user === u);

export async function negotiate(a: UserId, b: UserId): Promise<Negotiation> {
  // Everything up to the first `await` runs synchronously, so checking for an active settle-up
  // between these two and reserving their shares happen atomically: a second simultaneous request
  // sees the reservation and gets a Conflict instead of negotiating (and later charging) the same shares.
  // Different pairs in the group never touch the same shares, so they can settle in parallel.
  const n = mutate((db) => {
    if (!db.users[a] || !db.users[b] || a === b) throw new Error("Pick two different people in the group.");
    const key = pairKey(a, b);
    const busy = db.negotiations.find((x) => ACTIVE.includes(x.status) && pairKey(x.debtor, x.creditor) === key);
    if (busy) throw new Conflict(`Finish ${db.users[a].name} and ${db.users[b].name}'s current settle-up first (it's ${busy.status.replace("_", " ")}).`);
    const s = buildStatement(db.expenses, [a, b], [], freeShare);
    const claims = [...new Map(s.lines.map((l) => [`${l.expenseId}:${l.owedBy}`, { expenseId: l.expenseId, user: l.owedBy }])).values()];
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
      claims: s.total > 0 ? claims : [],
      aiMode: aiMode(),
    };
    for (const c of n.claims) {
      const e = db.expenses.find((x) => x.id === c.expenseId)!;
      (e.reservedBy ??= {})[c.user] = n.id;
    }
    db.negotiations.unshift(n);
    return n;
  });
  const db = getDB();
  const pair: [UserId, UserId] = [n.debtor, n.creditor];
  const covered = db.expenses.filter((e) => n.claims.some((c) => c.expenseId === e.id));
  const s0 = buildStatement(db.expenses, pair, [], claimedBy(n));
  const debtor = db.users[n.debtor];
  const creditor = db.users[n.creditor];
  const push = (m: AgentMessage) => n.messages.push(m);

  try {
    if (s0.total === 0) {
      push(msg("square", "AGREE", `Nothing to settle. ${db.users[a].name} and ${db.users[b].name} are all square.`));
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
            : `${debtor.name} hasn't approved a PayPal allowance yet, so ${debtor.name}'s agent can negotiate but can't pay. If you agree, ${debtor.name} approves this one payment in PayPal instead.`,
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
    const proposeText = await sayChecked(
      creditor,
      debtor,
      `Open the settle-up with ${debtor.name}'s agent. Net, ${debtor.name} owes ${money(s0.total)} across ${s0.lines.length} lines from the expenses they shared. Mention the total and invite them to check the lines.`,
      `Across your shared expenses, ${debtor.name} owes ${creditor.name} ${money(s0.total)} net. Itemized lines attached, take a look.`,
      [s0.total],
    );
    push(msg(creditor.id, "PROPOSE", proposeText, { total: s0.total, lines: s0.lines, ledgerHash: sha256(covered).slice(0, 16) }));

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
      const disputeText = amountsMatch(review.message || "", [s0.total, ...s0.lines.map((l) => l.share)]) && review.message
        ? review.message
        : `Before ${debtor.name} pays, I'd like to raise ${valid.length === 1 ? "one line" : `${valid.length} lines`}.`;
      push(msg(debtor.id, "DISPUTE", disputeText, { disputes: valid.map(({ itemId, itemLabel, reason }) => ({ itemId, itemLabel, reason })) }));

      // 4. Ruling: creditor's agent decides each dispute under its human's rules.
      await decideDisputes(n, creditor, debtor);
      push(
        msg(creditor.id, "RULING", rulingSummary(creditor, n.disputes), {
          rulings: n.disputes.map(({ itemId, itemLabel, accepted, ruling: why, rulingCheck }) => ({ itemId, itemLabel, accepted, why, check: rulingCheck })),
        }),
      );
    }

    // 5. Agreement on a number Square recomputes from the accepted adjustments.
    const s1 = buildStatement(db.expenses, pair, n.disputes, claimedBy(n));
    // If the accepted adjustments wipe out (or flip) what the debtor owes, nothing moves.
    n.agreedAmount = s1.debtor === n.debtor ? s1.total : 0;
    if (n.agreedAmount === 0) {
      push(msg("square", "AGREE", `After those adjustments ${debtor.name} and ${creditor.name} are all square. Nothing to pay.`));
      n.status = "nothing_owed";
      save(n);
      closeExpenses(n, "settledIn");
      return getDB().negotiations.find((x) => x.id === n.id)!;
    }
    const changed = round2(s0.total - s1.total);
    const agreeText = await sayChecked(
      debtor,
      creditor,
      `Agree to settle. The final amount is ${money(s1.total)}${changed ? ` (down ${money(changed)} from the opening ${money(s0.total)})` : ""}. ${
        n.disputes.some((d) => !d.accepted) ? "Accept the lines they kept gracefully." : ""
      } Use no other amounts and don't name individual items.`,
      `Deal. ${money(s1.total)} it is${changed ? `, thanks for taking ${money(changed)} off` : ""}.`,
      [s1.total, s0.total, changed],
      n.disputes.map((d) => d.itemLabel),
    );
    push(msg(debtor.id, "AGREE", agreeText, { amount: s1.total, agreementHash: sha256({ lines: s1.lines, total: s1.total }).slice(0, 16) }));

    // 6. Guardrails: deterministic rules, not the model, decide whether money can move.
    if (n.reviewFlag && debtor.paypal.paymentTokenId && process.env.SQUARE_UNLINKED !== "invoice") {
      n.status = "awaiting_approval";
      n.approval = { userId: debtor.id, reason: n.reviewFlag };
      push(msg("square", "ESCALATE", `${n.reviewFlag} ${debtor.name}, please check the lines before anything is paid.`, { amount: s1.total, rule: "consistency" }));
      return save(n);
    }
    if (!debtor.paypal.paymentTokenId) {
      if (process.env.SQUARE_UNLINKED === "invoice") return save(await invoiceInstead(n, debtor, creditor, s1));
      // No saved allowance: the human approves this one payment in PayPal checkout.
      n.status = "awaiting_approval";
      n.approval = {
        userId: debtor.id,
        mode: "checkout",
        reason: `${n.reviewFlag ? `${n.reviewFlag} ` : ""}${debtor.name} hasn't saved a PayPal allowance, so this payment is approved in PayPal.`,
      };
      push(
        msg(debtor.id, "ESCALATE", `${debtor.name} hasn't given me a standing allowance, so I can't pay on my own. ${debtor.name} will approve this one payment in PayPal.`, {
          amount: s1.total,
          rule: "noAllowance",
        }),
      );
      return save(n);
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

/** Free a settle-up's shares (it ended without payment), so a new settle-up can include them. */
function release(n: Negotiation) {
  mutate((db) => {
    for (const c of n.claims) {
      const e = db.expenses.find((x) => x.id === c.expenseId);
      if (e?.reservedBy?.[c.user] === n.id) delete e.reservedBy[c.user];
    }
  });
}

/** Mark exactly this settle-up's shares closed, applying its accepted adjustments. */
function closeExpenses(n: Negotiation, as: "settledIn" | "invoicedIn") {
  mutate((db) => {
    for (const c of n.claims) {
      const e = db.expenses.find((x) => x.id === c.expenseId);
      if (!e || e.reservedBy?.[c.user] !== n.id) continue;
      if (as === "settledIn") {
        for (const it of e.items) {
          const disp = n.disputes.find((x) => x.itemId === it.id && x.accepted && x.remove === c.user);
          if (disp && !it.waived?.includes(c.user)) (it.waived ??= []).push(c.user);
        }
        delete e.reservedBy[c.user];
        if (e.invoicedIn) delete e.invoicedIn[c.user];
      }
      (e[as] ??= {})[c.user] = n.id;
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
export const ACTIVE: Negotiation["status"][] = ["negotiating", "awaiting_approval", "awaiting_payer", "settling", "payout_pending", "payout_failed", "unverified", "failed"];
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
  const pre = getDB().negotiations.find((x) => x.id === negotiationId);
  if (decision === "approved" && pre?.approval?.mode === "checkout") throw new Conflict("This payment is approved in PayPal. Use Pay with PayPal.");
  const n = claim(negotiationId, ["awaiting_approval", "awaiting_payer"]);
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

/** Checkout mode, step 1: create the order and hand back PayPal's approval link. Nothing is charged yet. */
export async function startCheckout(negotiationId: string, baseUrl: string) {
  const n = claim(negotiationId, ["awaiting_approval", "awaiting_payer"]);
  if (n.approval?.mode !== "checkout") {
    n.status = "awaiting_approval";
    save(n);
    throw new Conflict("This settle-up uses the saved allowance. Use Approve and pay.");
  }
  const debtor = getDB().users[n.debtor];
  const creditor = getDB().users[n.creditor];
  try {
    const base = {
      amount: n.agreedAmount,
      description: `Square: ${debtor.name} settling up with ${creditor.name}`,
      reference: n.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30),
      returnUrl: `${baseUrl}/api/paypal/checkout-return?n=${encodeURIComponent(n.id)}`,
      cancelUrl: `${baseUrl}/api/paypal/checkout-cancel?n=${encodeURIComponent(n.id)}`,
    };
    let direct = n.payment!.direct ?? paymentRoute() === "direct";
    let o;
    try {
      // Its own request ID, separate from any earlier allowance attempt, so PayPal never replays that response.
      o = await createCheckoutOrder({ ...base, requestId: direct ? `${n.payment!.requestId}-co` : `${n.payment!.requestId}-platform`, payeeEmail: direct ? payeeOf(creditor) : undefined });
    } catch (e) {
      // Creating an order moves no money, so falling back to Square-as-payee here is always safe.
      if (!direct || !isPayeeRefusal(e)) throw e;
      direct = false;
      o = await createCheckoutOrder({ ...base, requestId: `${n.payment!.requestId}-platform` });
    }
    n.payment!.direct = direct;
    n.payment!.orderId = o.orderId;
    n.status = "awaiting_payer";
    save(n);
    return o.approveUrl;
  } catch (e) {
    n.status = "awaiting_approval";
    n.messages.push(msg("square", "ERROR", `PayPal couldn't start the payment, so nothing was charged: ${(e as Error).message}`));
    save(n);
    throw e;
  }
}

/** Checkout mode, step 2: the payer approved in PayPal. Capture once, then pay out, verify and close as usual. */
export async function finishCheckout(negotiationId: string, orderId: string) {
  const n = claim(negotiationId, ["awaiting_payer"]);
  const p = n.payment!;
  if (!p.orderId || p.orderId !== orderId) {
    n.status = "awaiting_payer";
    save(n);
    throw new Error("That PayPal order doesn't belong to this settle-up.");
  }
  const debtor = getDB().users[n.debtor];
  try {
    const c = await captureCheckoutOrder(orderId, p.requestId);
    p.captureId = c.captureId || c.orderId;
    p.chargedAt = now();
    n.approval!.decision = "approved";
    n.approval!.decidedAt = now();
    n.messages.push(msg(debtor.id, "APPROVED", `${debtor.name} approved ${money(n.agreedAmount)} in PayPal.`, { approvedBy: debtor.id, via: "checkout" }));
    const creditor = getDB().users[n.creditor];
    n.messages.push(
      msg(
        debtor.id,
        "SETTLE",
        p.direct
          ? `PayPal captured ${money(n.agreedAmount)} from ${debtor.name} and paid it straight to ${creditor.name}. Square never held it.`
          : `PayPal captured ${money(n.agreedAmount)} from ${debtor.name}.`,
        { orderId, captureId: c.captureId, via: "checkout", direct: p.direct },
      ),
    );
    save(n);
  } catch (e) {
    n.status = "awaiting_approval";
    n.messages.push(msg("square", "ERROR", `PayPal didn't complete the payment, so nothing was taken: ${(e as Error).message}`));
    return save(n);
  }
  return settleClaimed(n, "human");
}

/** The payer cancelled on PayPal's page: nothing was charged, the approval stays open. */
export function cancelCheckout(negotiationId: string) {
  return mutate((db) => {
    const n = db.negotiations.find((x) => x.id === negotiationId);
    if (n && n.status === "awaiting_payer") n.status = "awaiting_approval";
    return n;
  });
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
/** Where the creditor is paid: the PayPal email they connected, or their sandbox account. */
const payeeOf = (u: User) => u.paypal.payerEmail || u.sandboxEmail;

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
      const charge = { vaultId: debtor.paypal.paymentTokenId, amount: n.agreedAmount, description: `Square: ${debtor.name} settling up with ${creditor.name}`, reference };
      p.direct ??= paymentRoute() === "direct";
      let order;
      try {
        order = await chargeAllowance({ ...charge, requestId: p.direct ? p.requestId : `${p.requestId}-platform`, payeeEmail: p.direct ? payeeOf(creditor) : undefined });
      } catch (e) {
        if (!p.direct || !isPayeeRefusal(e)) throw e;
        // PayPal won't charge a saved allowance straight to a friend (nothing was charged). Keep the
        // money person to person: ask the debtor to approve this one payment in PayPal instead.
        n.status = "awaiting_approval";
        n.approval = {
          userId: debtor.id,
          reason: `PayPal can't send ${debtor.name}'s saved allowance straight to ${creditor.name}, so ${debtor.name} approves this one payment in PayPal.`,
          mode: "checkout",
        };
        p.settlingSince = undefined;
        n.messages.push(
          msg("square", "ESCALATE", `PayPal can't send a saved allowance straight to ${creditor.name}, and nothing was charged. ${debtor.name}, approve this one payment in PayPal and it goes directly to ${creditor.name}.`, {
            amount: n.agreedAmount,
            rule: "directPayment",
          }),
        );
        return save(n);
      }
      p.orderId = order.orderId;
      p.captureId = order.captureId || order.orderId;
      p.chargedAt = now();
      p.lastError = undefined;
      n.messages.push(
        msg(
          debtor.id,
          "SETTLE",
          p.direct
            ? `Paid ${money(n.agreedAmount)} from ${debtor.name}'s PayPal allowance straight to ${creditor.name}. PayPal moved it person to person; Square never held it.`
            : `Charged ${money(n.agreedAmount)} to ${debtor.name}'s PayPal allowance.`,
          { orderId: order.orderId, captureId: order.captureId, via, direct: p.direct, payee: p.direct ? maskEmail(payeeOf(creditor)) : undefined },
        ),
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
  if (!p.direct) {
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
  }

  // 3. The creditor's agent checks PayPal itself: the order is complete, for the agreed amount,
  //    and (when paid directly) the money went to the creditor. Code decides; the agent explains.
  const check = await verifyOrder(p.orderId!, n.agreedAmount, p.direct ? payeeOf(creditor) : undefined).catch((e) => ({ ok: false, status: String((e as Error).message), amount: "" }));
  const confirmation = await confirmOnPayPal(creditor, debtor, p.orderId!, n.agreedAmount, check.ok);
  n.messages.push(msg(creditor.id, "CONFIRM", confirmation.text, { verified: check.ok, orderStatus: check.status, amount: check.amount, toolCalls: confirmation.calls }));
  if (!check.ok) {
    n.status = "unverified";
    return save(n);
  }
  p.verifiedAt = now();

  // 4. Only now: signed receipt, close the ledger, make accepted adjustments permanent.
  const covered = getDB().expenses.filter((e) => n.claims.some((c) => c.expenseId === e.id));
  const ledgerHash = sha256(covered).slice(0, 16);
  const agreementHash = sha256({ id: n.id, amount: n.agreedAmount, disputes: n.disputes }).slice(0, 16);
  const receiptBody = { id: uid("rcpt"), ledgerHash, agreementHash, paymentRef: p.orderId!, issuedAt: now() };
  n.settlement = {
    mode: paypalMode(),
    orderId: p.orderId!,
    orderStatus: check.status,
    captureId: p.captureId,
    payoutBatchId: p.payouts.at(-1)?.batchId,
    payoutItemId: p.payouts.at(-1)?.itemId,
    payoutStatus: p.direct ? "PAID_DIRECTLY" : p.payouts.at(-1)?.status,
    amount: n.agreedAmount,
    currency: "USD",
    settledAt: now(),
    receipt: { ...receiptBody, sig: sign("square", receiptBody) },
  };
  n.status = "settled";
  p.settlingSince = undefined;
  // Close exactly the shares this settle-up was negotiated over; anything added since stays open.
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
