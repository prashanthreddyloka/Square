import type { Dispute, Expense, Statement, UserId } from "./types";

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Stable key for a pair of members, independent of order. */
export const pairKey = (a: UserId, b: UserId) => [a, b].sort().join("|");

export type ShareFilter = (e: Expense, owedBy: UserId) => boolean;

/** A member's share of an expense that hasn't been settled or put on an invoice. */
export const openShare: ShareFilter = (e, u) => !e.settledIn?.[u] && !e.invoicedIn?.[u];
/** Open and not part of any in-progress settle-up. */
export const freeShare: ShareFilter = (e, u) => openShare(e, u) && !e.reservedBy?.[u];

/**
 * Itemized statement of what one member owes the other, from the expenses one of them paid
 * that the other shared. Positive `signed` means the debtor owes the creditor for that line.
 * Expenses paid by anyone else don't affect this pair.
 * Money is always computed here, deterministically; the AI never does arithmetic.
 */
export function buildStatement(expenses: Expense[], pair: [UserId, UserId], disputes: Dispute[] = [], include: ShareFilter = openShare): Statement {
  const [a, b] = pair;
  const waivedNow = new Set(disputes.filter((d) => d.accepted).map((d) => `${d.itemId}:${d.remove}`));
  const raw: Statement["lines"] = [];
  for (const e of expenses) {
    if (e.paidBy !== a && e.paidBy !== b) continue;
    const owedBy = e.paidBy === a ? b : a;
    if (!include(e, owedBy)) continue;
    for (const it of e.items) {
      if (!it.sharedBy.includes(owedBy) || it.sharedBy.length === 0) continue;
      if (it.waived?.includes(owedBy) || waivedNow.has(`${it.id}:${owedBy}`)) continue;
      const share = round2(it.amount / it.sharedBy.length);
      raw.push({ expenseId: e.id, itemId: it.id, label: it.label, expense: e.description, group: e.group, paidBy: e.paidBy, owedBy, share, signed: 0 });
    }
  }
  const owes = (u: UserId) => round2(raw.filter((r) => r.owedBy === u).reduce((s, r) => s + r.share, 0));
  const debtor = owes(a) >= owes(b) ? a : b;
  const creditor = debtor === a ? b : a;
  // Keep each group's lines together (in order of first appearance) so a combined statement reads by group.
  const order = [...new Set(raw.map((r) => r.group))];
  const lines = raw
    .map((r, i) => ({ r, i }))
    .sort((x, y) => order.indexOf(x.r.group) - order.indexOf(y.r.group) || x.i - y.i)
    .map(({ r }) => ({ ...r, signed: r.owedBy === debtor ? r.share : -r.share }));
  return { debtor, creditor, lines, total: round2(Math.abs(owes(a) - owes(b))) };
}

/** Every pair of members, in a stable order. */
export function allPairs(ids: UserId[]): [UserId, UserId][] {
  const out: [UserId, UserId][] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push([ids[i], ids[j]]);
  return out;
}

export function money(n: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}
