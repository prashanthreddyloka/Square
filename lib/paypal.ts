/**
 * PayPal sandbox integration.
 *
 * Live mode (PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET set):
 *   - Vault v3 setup tokens + payment tokens: each human approves their agent's allowance once
 *   - Orders v2 with a vault_id: the debtor's agent pays without the human present
 *   - Payouts v1: Square forwards the money to the friend's PayPal account
 *   - Invoicing v2 (via PayPal Agent Toolkit): fallback when the friend has no agent yet
 *   - Webhooks: payout and capture events land in the activity feed
 *
 * Demo mode (no credentials): the same flow with simulated PayPal responses,
 * clearly labelled in the UI, so the project always runs, even without keys.
 */
import { uid } from "./store";

const BASE = process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export const paypalMode = (): "live" | "demo" =>
  process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? "live" : "demo";

let cached: { token: string; exp: number } | null = null;

export async function accessToken() {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function pp<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": uid("sq"),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.details?.[0]?.description || j.message || j.error_description || text;
    } catch {}
    throw new Error(`PayPal ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/* ---------- Vault: one-time approval of an agent allowance ---------- */

export async function createSetupToken(opts: { returnUrl: string; cancelUrl: string; human: string }) {
  if (paypalMode() === "demo") {
    const id = uid("DEMO-SETUP");
    return { id, approveUrl: `${opts.returnUrl}${opts.returnUrl.includes("?") ? "&" : "?"}approval_token_id=${id}&demo=1` };
  }
  const r = await pp<{ id: string; links: { rel: string; href: string }[] }>("POST", "/v3/vault/setup-tokens", {
    payment_source: {
      paypal: {
        description: `Square agent allowance for ${opts.human}: lets your Square agent settle shared expenses with friends within the limits you set.`,
        usage_pattern: "IMMEDIATE",
        usage_type: "MERCHANT",
        customer_type: "CONSUMER",
        permit_multiple_payment_tokens: false,
        experience_context: {
          brand_name: "Square",
          locale: "en-US",
          shipping_preference: "NO_SHIPPING",
          return_url: opts.returnUrl,
          cancel_url: opts.cancelUrl,
        },
      },
    },
  });
  const approveUrl = r.links.find((l) => l.rel === "approve")?.href;
  if (!approveUrl) throw new Error("PayPal did not return an approval link for the setup token.");
  return { id: r.id, approveUrl };
}

export async function createPaymentToken(setupTokenId: string, fallbackEmail: string) {
  if (paypalMode() === "demo") {
    return {
      id: uid("DEMO-PMTTOKEN"),
      customerId: uid("DEMO-CUST"),
      payerId: uid("DEMOPAYER").toUpperCase(),
      email: fallbackEmail,
    };
  }
  const r = await pp<{
    id: string;
    customer?: { id: string };
    payment_source?: { paypal?: { email_address?: string; payer_id?: string } };
  }>("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } });
  return {
    id: r.id,
    customerId: r.customer?.id ?? "",
    payerId: r.payment_source?.paypal?.payer_id ?? "",
    email: r.payment_source?.paypal?.email_address ?? fallbackEmail,
  };
}

/* ---------- Settlement: charge the debtor's allowance, pay the friend ---------- */

/** Test hooks for demo mode: script payout outcomes and count charges. */
type DemoHooks = { charges: Map<string, string>; payoutOutcomes: string[]; payouts: Map<string, string>; failStatusLookups: number };
const g = globalThis as unknown as { __squareDemo?: DemoHooks };
export function demoHooks(): DemoHooks {
  // SQUARE_DEMO_PAYOUTS=FAILED,SUCCESS scripts demo payout outcomes, to show failure handling without real money.
  g.__squareDemo ??= { charges: new Map(), payoutOutcomes: (process.env.SQUARE_DEMO_PAYOUTS || "").split(",").filter(Boolean), payouts: new Map(), failStatusLookups: 0 };
  return g.__squareDemo;
}

/**
 * Charge a vaulted allowance. `requestId` is sent as PayPal-Request-Id, so retrying the
 * same settlement returns the original order instead of charging the payer twice.
 */
/**
 * How the friend gets paid. "direct" (default): the friend is the payee on the PayPal order, so
 * PayPal moves the money straight from one person to the other and Square never holds it.
 * "payouts": Square's account receives the charge and sends it on with PayPal Payouts.
 */
export const paymentRoute = (): "direct" | "payouts" => (process.env.SQUARE_PAYMENT === "payouts" ? "payouts" : "direct");

/** PayPal refused to name this payee (account type, country or permissions), as opposed to a failed payment. */
export const isPayeeRefusal = (e: unknown) => /PAYEE|payee|RECEIVER|receiver/.test((e as Error)?.message || "") && /\((400|403|422)\)/.test((e as Error)?.message || "");

const unit = (o: { reference: string; description: string; amount: number; payeeEmail?: string }) => ({
  reference_id: o.reference,
  custom_id: o.reference,
  description: o.description.slice(0, 127),
  amount: { currency_code: "USD", value: o.amount.toFixed(2) },
  ...(o.payeeEmail ? { payee: { email_address: o.payeeEmail } } : {}),
});

export async function chargeAllowance(opts: { vaultId: string; amount: number; description: string; reference: string; requestId: string; payeeEmail?: string }) {
  if (paypalMode() === "demo") {
    const h = demoHooks();
    if (!h.charges.has(opts.requestId)) h.charges.set(opts.requestId, uid("DEMO-ORDER").toUpperCase());
    const orderId = h.charges.get(opts.requestId)!;
    return { orderId, status: "COMPLETED", captureId: orderId.replace("ORDER", "CAPTURE") };
  }
  type Order = {
    id: string;
    status: string;
    purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[];
  };
  let order = await pp<Order>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      payment_source: { paypal: { vault_id: opts.vaultId } },
      purchase_units: [unit(opts)],
    },
    { "PayPal-Request-Id": opts.requestId },
  );
  if (order.status === "APPROVED" || order.status === "CREATED") {
    order = await pp<Order>("POST", `/v2/checkout/orders/${order.id}/capture`, {}, { "PayPal-Request-Id": `${opts.requestId}-capture` });
  }
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || (capture && capture.status !== "COMPLETED")) {
    throw new Error(`Order ${order.id} ended in status ${order.status}${capture ? ` (capture ${capture.status})` : ""}`);
  }
  return { orderId: order.id, status: order.status, captureId: capture?.id };
}

/**
 * Per-payment checkout: used when the payer has no saved allowance (for example when the
 * sandbox account isn't enabled for Vault). The payer approves this one order in PayPal;
 * Square captures it when they return. `requestId` makes creating the order idempotent.
 */
export async function createCheckoutOrder(opts: {
  amount: number;
  description: string;
  reference: string;
  requestId: string;
  returnUrl: string;
  cancelUrl: string;
  payeeEmail?: string;
}) {
  if (paypalMode() === "demo") {
    const orderId = `DEMO-ORDER-${opts.requestId.replace(/[^A-Za-z0-9]/g, "").slice(-10).toUpperCase()}`;
    return { orderId, approveUrl: `${opts.returnUrl}${opts.returnUrl.includes("?") ? "&" : "?"}token=${orderId}` };
  }
  const order = await pp<{ id: string; links: { rel: string; href: string }[] }>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [unit(opts)],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Square",
            locale: "en-US",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
            return_url: opts.returnUrl,
            cancel_url: opts.cancelUrl,
          },
        },
      },
    },
    { "PayPal-Request-Id": opts.requestId },
  );
  const approveUrl = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
  if (!approveUrl) throw new Error("PayPal didn't return an approval link for the order.");
  return { orderId: order.id, approveUrl };
}

/** Capture an order the payer approved. Safe to call twice: an already-captured order is read back, not charged again. */
export async function captureCheckoutOrder(orderId: string, requestId: string) {
  if (paypalMode() === "demo") {
    demoHooks().charges.set(requestId, orderId);
    return { orderId, status: "COMPLETED", captureId: orderId.replace("ORDER", "CAPTURE") };
  }
  type Order = { id: string; status: string; purchase_units?: { payments?: { captures?: { id: string; status: string }[] } }[] };
  let order: Order;
  try {
    order = await pp<Order>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { "PayPal-Request-Id": `${requestId}-capture` });
  } catch (e) {
    if (!/ORDER_ALREADY_CAPTURED|UNPROCESSABLE/i.test((e as Error).message)) throw e;
    order = await pp<Order>("GET", `/v2/checkout/orders/${orderId}`);
  }
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || (capture && capture.status !== "COMPLETED")) {
    throw new Error(`Order ${order.id} ended in status ${order.status}${capture ? ` (capture ${capture.status})` : ""}`);
  }
  return { orderId: order.id, status: order.status, captureId: capture?.id };
}

export type PayoutState = "succeeded" | "pending" | "failed";

/** Map PayPal payout item statuses to what Square can safely act on. */
export function classifyPayout(status: string): PayoutState {
  const s = status.toUpperCase();
  if (s === "SUCCESS") return "succeeded";
  if (["FAILED", "RETURNED", "DENIED", "BLOCKED", "REFUNDED", "REVERSED", "CANCELED"].includes(s)) return "failed";
  return "pending"; // PENDING, UNCLAIMED, ONHOLD, NEW, PROCESSING: money has not reached the friend yet
}

/** Start a payout. `senderBatchId` must be unique per attempt; PayPal rejects duplicates, which prevents double payouts. */
export async function createPayout(opts: { senderBatchId: string; email: string; amount: number; note: string }) {
  if (paypalMode() === "demo") {
    const id = uid("DEMO-BATCH").toUpperCase();
    demoHooks().payouts.set(id, demoHooks().payoutOutcomes.shift() || "SUCCESS");
    return { batchId: id };
  }
  const r = await pp<{ batch_header: { payout_batch_id: string } }>("POST", "/v1/payments/payouts", {
    sender_batch_header: {
      sender_batch_id: opts.senderBatchId,
      email_subject: "Your friend's Square agent settled up",
      email_message: opts.note.slice(0, 1000),
    },
    items: [
      {
        recipient_type: "EMAIL",
        receiver: opts.email,
        amount: { value: opts.amount.toFixed(2), currency: "USD" },
        note: opts.note.slice(0, 4000),
        sender_item_id: `${opts.senderBatchId}-1`,
      },
    ],
  });
  return { batchId: r.batch_header.payout_batch_id };
}

/** Current status of a payout, polling briefly while PayPal processes it. */
export async function payoutStatus(batchId: string, waitMs = 6000): Promise<{ itemId?: string; status: string; state: PayoutState }> {
  if (paypalMode() === "demo" || batchId.startsWith("DEMO")) {
    if (demoHooks().failStatusLookups > 0) {
      demoHooks().failStatusLookups--;
      throw new Error("PayPal status lookup timed out (simulated)");
    }
    const status = demoHooks().payouts.get(batchId) || "SUCCESS";
    return { itemId: batchId.replace("BATCH", "ITEM"), status, state: classifyPayout(status) };
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const b = await pp<{ batch_header: { batch_status: string }; items?: { payout_item_id: string; transaction_status: string }[] }>(
      "GET",
      `/v1/payments/payouts/${batchId}`,
    );
    const item = b.items?.[0];
    const status = item?.transaction_status || b.batch_header.batch_status;
    const state = classifyPayout(status);
    if (state !== "pending" || Date.now() > deadline) return { itemId: item?.payout_item_id, status, state };
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Independent check of an order: completed, captured, and for the agreed amount. */
/** Read the order back from PayPal. With `payeeEmail`, the money must also have gone to that person. */
export async function verifyOrder(orderId: string, amount: number, payeeEmail?: string) {
  if (paypalMode() === "demo" || orderId.startsWith("DEMO")) {
    return { ok: true, status: "COMPLETED", amount: amount.toFixed(2), payee: payeeEmail };
  }
  const o = await pp<{
    status: string;
    purchase_units?: { amount?: { value: string }; payee?: { email_address?: string }; payments?: { captures?: { status: string; amount?: { value: string } }[] } }[];
  }>("GET", `/v2/checkout/orders/${orderId}`);
  const pu = o.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  const value = cap?.amount?.value || pu?.amount?.value || "";
  const payee = pu?.payee?.email_address;
  const payeeOk = !payeeEmail || (payee || "").toLowerCase() === payeeEmail.toLowerCase();
  const ok = o.status === "COMPLETED" && cap?.status === "COMPLETED" && Number(value) === Number(amount.toFixed(2)) && payeeOk;
  return { ok, status: `${o.status}${cap ? `/${cap.status}` : ""}`, amount: value, payee };
}

/* ---------- Webhooks ---------- */

export async function verifyWebhook(headers: Headers, event: unknown) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId || paypalMode() === "demo") return false;
  const r = await pp<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers.get("paypal-auth-algo"),
    cert_url: headers.get("paypal-cert-url"),
    transmission_id: headers.get("paypal-transmission-id"),
    transmission_sig: headers.get("paypal-transmission-sig"),
    transmission_time: headers.get("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return r.verification_status === "SUCCESS";
}

export const sandboxLinks = {
  order: (id: string) => `https://www.sandbox.paypal.com/activity/payment/${id}`,
};
