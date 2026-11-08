/** A group member's id, e.g. "alex". */
export type UserId = string;

export type ItemKind = "consumable" | "shared-fixed";

export interface LineItem {
  id: string;
  label: string;
  amount: number;
  kind: ItemKind; // consumables can be personal; fixed costs (rent, tickets, rides) are shared by booking
  sharedBy: UserId[];
  waived?: UserId[]; // members whose share was dropped in a settle-up (the payer absorbs it)
}

export interface Expense {
  id: string;
  description: string;
  paidBy: UserId;
  date: string;
  items: LineItem[];
  source: "seed" | "chat" | "receipt";
  group?: string; // which group it belongs to; settle-ups between two people cover all their groups
  // Each member's share of an expense is settled with the payer separately, so these are keyed
  // by the member who owes the share (never the payer).
  settledIn?: Record<UserId, string>; // share paid, in this negotiation (confirmed)
  invoicedIn?: Record<UserId, string>; // share carried by this negotiation's PayPal invoice (unpaid until PayPal says so)
  reservedBy?: Record<UserId, string>; // share is part of this in-progress negotiation; nothing else may include it
}

export interface PayPalLink {
  status: "unlinked" | "pending" | "linked";
  setupTokenId?: string;
  approveUrl?: string;
  paymentTokenId?: string;
  customerId?: string;
  payerId?: string;
  payerEmail?: string;
  linkedAt?: string;
  mode?: "live" | "demo";
}

export interface Policy {
  autoApproveMax: number; // settle without asking up to this amount
  weeklyCap: number; // never send more than this per 7 days
  instructions: string; // natural-language rules the agent follows
  memory: string[]; // things the agent knows about its human
}

export interface User {
  id: UserId;
  name: string;
  sandboxEmail: string;
  color: string;
  paypal: PayPalLink;
  policy: Policy;
}

export type MessageType =
  | "HELLO"
  | "VERIFY"
  | "PROPOSE"
  | "DISPUTE"
  | "RULING"
  | "AGREE"
  | "ESCALATE"
  | "APPROVED"
  | "DECLINED"
  | "SETTLE"
  | "CONFIRM"
  | "INVOICE"
  | "PENDING"
  | "ERROR";

export interface AgentMessage {
  id: string;
  from: UserId | "square";
  type: MessageType;
  text: string;
  data?: Record<string, unknown>;
  ts: string;
  sig?: string; // HMAC signature by the sending agent's passport key
}

export interface Dispute {
  expenseId: string;
  itemId: string;
  itemLabel: string;
  reason: string;
  remove: UserId; // whose share of the item is waived if accepted
  accepted?: boolean; // the creditor's decision; the only thing the amount is computed from
  ruling?: string; // the explanation shown, checked against the decision before it is shown
  rulingCheck?: "rules" | "matched" | "replaced"; // how the explanation was checked
}

export interface Statement {
  debtor: UserId;
  creditor: UserId;
  lines: { expenseId: string; itemId: string; label: string; expense: string; group?: string; paidBy: UserId; owedBy: UserId; share: number; signed: number }[];
  total: number;
}

export interface Settlement {
  mode: "live" | "demo";
  orderId: string;
  orderStatus: string;
  captureId?: string;
  payoutBatchId?: string;
  payoutItemId?: string;
  payoutStatus?: string;
  invoiceId?: string;
  invoiceUrl?: string;
  amount: number;
  currency: string;
  settledAt: string;
  receipt: Receipt;
}

export interface Receipt {
  id: string;
  ledgerHash: string;
  agreementHash: string;
  paymentRef: string;
  issuedAt: string;
  sig: string;
}

/** Every step of a settlement is saved as it happens, so a retry resumes instead of repeating. */
export interface PaymentProgress {
  requestId: string; // PayPal-Request-Id for the charge: retries return the same order
  direct?: boolean; // the friend was the payee on the order: PayPal paid them directly, no payout step
  orderId?: string;
  captureId?: string;
  chargedAt?: string;
  payouts: { senderBatchId: string; batchId: string; itemId?: string; status: string; state: "succeeded" | "pending" | "failed"; at: string }[];
  verifiedAt?: string;
  lastError?: string;
  settlingSince?: string;
}

export interface Negotiation {
  id: string;
  status:
    | "negotiating" // agents are talking; its expenses are reserved
    | "agreed"
    | "awaiting_approval"
    | "awaiting_payer" // sent to PayPal to approve this one payment; nothing charged yet
    | "settling" // locked: a settlement attempt is running
    | "payout_pending" // charged; PayPal hasn't confirmed the friend received it
    | "payout_failed" // charged; payout failed and can be retried without charging again
    | "unverified" // payment could not be independently verified yet
    | "settled" // charge + payout + verification all confirmed; ledger closed
    | "declined"
    | "invoiced"
    | "failed" // charge didn't complete; retry is safe (idempotent charge)
    | "error" // negotiation broke before any payment; expenses released
    | "nothing_owed";
  claims: { expenseId: string; user: UserId }[]; // exactly the shares this settle-up covers, fixed when it starts
  debtor: UserId;
  creditor: UserId;
  startedAt: string;
  messages: AgentMessage[];
  disputes: Dispute[];
  initialTotal: number;
  agreedAmount: number;
  reviewFlag?: string; // set when an agent's words didn't match its decision; forces human approval
  approval?: { userId: UserId; reason: string; mode?: "allowance" | "checkout"; decidedAt?: string; decision?: "approved" | "declined" };
  payment?: PaymentProgress;
  settlement?: Settlement;
  aiMode: "claude" | "openai" | "demo";
}

export interface Group {
  id: string;
  name: string;
  members: UserId[];
}

export interface DB {
  version?: number; // data format; older saved files are replaced with a fresh seed
  users: Record<UserId, User>;
  groups: Group[];
  expenses: Expense[];
  negotiations: Negotiation[];
  webhookEvents: { id: string; type: string; receivedAt: string; summary: string }[];
}
