import { allPairs, buildStatement, openShare, pairKey, round2 } from "./ledger";
import type { DB, PayPalLink, User, UserId } from "./types";

export const maskId = (v?: string | null) => (v ? `••••${v.slice(-4)}` : "");
export const maskEmail = (v?: string) => {
  if (!v) return "";
  const [name, domain] = v.split("@");
  return domain ? `${name.slice(0, 2)}•••@${domain}` : maskId(v);
};

/** What the browser may see about a PayPal link: never the vault token, customer ID or setup token. */
function publicLink(l: PayPalLink) {
  return {
    status: l.status,
    payerEmail: maskEmail(l.payerEmail),
    payerRef: maskId(l.payerId),
    allowanceRef: maskId(l.paymentTokenId),
    linkedAt: l.linkedAt,
    mode: l.mode,
  };
}

export function publicUser(u: User) {
  return { ...u, sandboxEmail: maskEmail(u.sandboxEmail), paypal: publicLink(u.paypal) };
}

const ACTIVE_STATUSES = ["negotiating", "awaiting_approval", "awaiting_payer", "settling", "payout_pending", "payout_failed", "unverified", "failed"];

/** The client view of the database. Payment-token identifiers stay on the server. */
export function publicState(db: DB) {
  const ids = Object.keys(db.users);
  const inGroup = (g: string) => db.expenses.filter((e) => e.group === g);
  const pairs = allPairs(ids).map(([a, b]) => {
    const s = buildStatement(db.expenses, [a, b], [], openShare);
    // What each shared group contributes, signed from the overall debtor's side.
    const byGroup = db.groups
      .filter((g) => g.members.includes(a) && g.members.includes(b))
      .map((g) => {
        const gs = buildStatement(inGroup(g.id), [a, b], [], openShare);
        return { group: g.id, amount: gs.total === 0 ? 0 : gs.debtor === s.debtor ? gs.total : -gs.total };
      })
      .filter((x) => x.amount !== 0);
    const key = pairKey(a, b);
    const mine = db.negotiations.filter((n) => pairKey(n.debtor, n.creditor) === key);
    const invoiced = mine.filter((n) => n.status === "invoiced").reduce((t, n) => t + n.agreedAmount, 0);
    return {
      key,
      a,
      b,
      debtor: s.debtor,
      creditor: s.creditor,
      total: s.total,
      lines: s.lines,
      byGroup,
      invoiced: round2(invoiced),
      active: mine.find((n) => ACTIVE_STATUSES.includes(n.status))?.status,
    };
  });
  const members = Object.fromEntries(
    ids.map((id) => {
      const owes = round2(pairs.filter((p) => p.total > 0 && p.debtor === id).reduce((t, p) => t + p.total, 0));
      const owed = round2(pairs.filter((p) => p.total > 0 && p.creditor === id).reduce((t, p) => t + p.total, 0));
      return [id, { owes, owed, net: round2(owed - owes) }];
    }),
  ) as Record<UserId, { owes: number; owed: number; net: number }>;
  // The same picture inside each group, for the group switcher.
  const groups = db.groups.map((g) => {
    const gp = allPairs(g.members).map(([a, b]) => {
      const s = buildStatement(inGroup(g.id), [a, b], [], openShare);
      return { key: pairKey(a, b), a, b, debtor: s.debtor, creditor: s.creditor, total: s.total };
    });
    const totals = Object.fromEntries(
      g.members.map((id) => {
        const owes = round2(gp.filter((p) => p.total > 0 && p.debtor === id).reduce((t, p) => t + p.total, 0));
        const owed = round2(gp.filter((p) => p.total > 0 && p.creditor === id).reduce((t, p) => t + p.total, 0));
        return [id, { owes, owed, net: round2(owed - owes) }];
      }),
    ) as Record<UserId, { owes: number; owed: number; net: number }>;
    return { ...g, expenseCount: inGroup(g.id).length, pairs: gp, members: g.members, totals };
  });
  return {
    groups,
    users: Object.fromEntries(ids.map((id) => [id, publicUser(db.users[id])])) as Record<UserId, ReturnType<typeof publicUser>>,
    expenses: db.expenses,
    negotiations: db.negotiations.map(({ payment, ...n }) => ({
      ...n,
      pair: pairKey(n.debtor, n.creditor),
      retryable: ["payout_pending", "payout_failed", "unverified", "failed"].includes(n.status),
      charged: Boolean(payment?.captureId),
    })),
    webhookEvents: db.webhookEvents,
    pairs,
    members,
  };
}
