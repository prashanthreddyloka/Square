import type { Dispute, Expense, Statement, UserId } from "./types";

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const other = (u: UserId): UserId => (u === "alex" ? "maya" : "alex");

/**
 * Build an itemized statement of who owes whom across all unsettled expenses.
 * Positive `signed` means the debtor owes the creditor for that line.
 * Money is always computed here, deterministically; the AI never does arithmetic.
 */
export function buildStatement(expenses: Expense[], disputes: Dispute[] = []): Statement {
  const removed = new Map<string, Set<UserId>>();
  for (const d of disputes) {
    if (d.accepted) {
      const s = removed.get(d.itemId) ?? new Set<UserId>();
      s.add(d.remove);
      removed.set(d.itemId, s);
    }
  }

  // owes[a] = what a owes the other person in total
  const raw: { expenseId: string; itemId: string; label: string; expense: string; paidBy: UserId; owedBy: UserId; share: number }[] = [];
  for (const e of expenses) {
    if (e.settledIn || e.invoicedIn) continue;
    for (const it of e.items) {
      const sharers = it.sharedBy.filter((u) => !removed.get(it.id)?.has(u));
      if (sharers.length === 0) continue;
      const share = round2(it.amount / sharers.length);
      for (const u of sharers) {
        if (u === e.paidBy) continue;
        raw.push({ expenseId: e.id, itemId: it.id, label: it.label, expense: e.description, paidBy: e.paidBy, owedBy: u, share });
      }
    }
  }

  const alexOwes = round2(raw.filter((r) => r.owedBy === "alex").reduce((s, r) => s + r.share, 0));
  const mayaOwes = round2(raw.filter((r) => r.owedBy === "maya").reduce((s, r) => s + r.share, 0));
  const debtor: UserId = alexOwes >= mayaOwes ? "alex" : "maya";
  const creditor = other(debtor);

  const lines = raw.map((r) => ({
    expenseId: r.expenseId,
    itemId: r.itemId,
    label: r.label,
    expense: r.expense,
    paidBy: r.paidBy,
    share: r.share,
    signed: r.owedBy === debtor ? r.share : -r.share,
  }));
  const total = round2(Math.abs(alexOwes - mayaOwes));
  return { debtor, creditor, lines, total };
}

export function balanceFor(expenses: Expense[], user: UserId, invoices: { debtor: UserId; creditor: UserId; amount: number }[] = []) {
  const inv = invoices.find((i) => i.debtor === user || i.creditor === user);
  if (inv) {
    return inv.debtor === user
      ? { label: "Invoice to pay", amount: inv.amount, direction: "invoiced" as const, counterparty: inv.creditor }
      : { label: "Invoice sent", amount: inv.amount, direction: "invoiced" as const, counterparty: inv.debtor };
  }
  const s = buildStatement(expenses);
  if (s.total === 0) return { label: "All square", amount: 0, direction: "even" as const };
  return s.debtor === user
    ? { label: `You owe`, amount: s.total, direction: "owe" as const, counterparty: s.creditor }
    : { label: `Owed to you`, amount: s.total, direction: "owed" as const, counterparty: s.debtor };
}

export function money(n: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}
