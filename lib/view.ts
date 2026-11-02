import { balanceFor, buildStatement } from "./ledger";
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

/** The client view of the database. Payment-token identifiers stay on the server. */
export function publicState(db: DB) {
  const open = db.expenses.filter((e) => !e.settledIn && !e.invoicedIn);
  const invoices = db.negotiations
    .filter((n) => n.status === "invoiced")
    .map((n) => ({ debtor: n.debtor, creditor: n.creditor, amount: n.agreedAmount }));
  return {
    users: { alex: publicUser(db.users.alex), maya: publicUser(db.users.maya) } as Record<UserId, ReturnType<typeof publicUser>>,
    expenses: db.expenses,
    negotiations: db.negotiations.map(({ payment, ...n }) => ({
      ...n,
      retryable: ["payout_pending", "payout_failed", "unverified", "failed"].includes(n.status),
      charged: Boolean(payment?.captureId),
    })),
    webhookEvents: db.webhookEvents,
    statement: buildStatement(open),
    balances: { alex: balanceFor(db.expenses, "alex", invoices), maya: balanceFor(db.expenses, "maya", invoices) },
  };
}
