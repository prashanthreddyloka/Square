export type UserId = "alex" | "maya";

export type ItemKind = "consumable" | "shared-fixed";

export interface LineItem {
  id: string;
  label: string;
  amount: number;
  kind: ItemKind; // consumables can be personal; fixed costs (rent, tickets, rides) are shared by booking
  sharedBy: UserId[];
}

export interface Expense {
  id: string;
  description: string;
  paidBy: UserId;
  date: string;
  items: LineItem[];
  source: "seed" | "chat" | "receipt";
  settledIn?: string; // negotiation id that paid for it (confirmed)
  invoicedIn?: string; // negotiation id whose PayPal invoice now carries it (unpaid until PayPal says so)
  reservedBy?: string; // negotiation id currently settling it; nothing else may include it
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
  remove: UserId; // who should be removed from sharedBy
  accepted?: boolean;
  ruling?: string;
}

export interface Statement {
  debtor: UserId;
  creditor: UserId;
  lines: { expenseId: string; itemId: string; label: string; expense: string; paidBy: UserId; share: number; signed: number }[];
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
  expenseIds: string[]; // exactly the expenses this settle-up covers, fixed when it starts
  debtor: UserId;
  creditor: UserId;
  startedAt: string;
  messages: AgentMessage[];
  disputes: Dispute[];
  initialTotal: number;
  agreedAmount: number;
  approval?: { userId: UserId; reason: string; decidedAt?: string; decision?: "approved" | "declined" };
  payment?: PaymentProgress;
  settlement?: Settlement;
  aiMode: "claude" | "openai" | "demo";
}

export interface DB {
  users: Record<UserId, User>;
  expenses: Expense[];
  negotiations: Negotiation[];
  webhookEvents: { id: string; type: string; receivedAt: string; summary: string }[];
}
