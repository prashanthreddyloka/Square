import { onInvoicePaid, onPayoutEvent } from "../../../../lib/agents";
import { verifyWebhook } from "../../../../lib/paypal";
import { mutate, uid } from "../../../../lib/store";
import { json } from "../../../../lib/http";

// Subscribe this URL to PAYMENT.CAPTURE.COMPLETED, PAYMENT.PAYOUTS-ITEM.SUCCEEDED, PAYMENT.PAYOUTS-ITEM.FAILED,
// PAYMENT.PAYOUTS-ITEM.UNCLAIMED and INVOICING.INVOICE.PAID. Without PAYPAL_WEBHOOK_ID, events are logged but
// never acted on, because their signature can't be checked.
export async function POST(req: Request) {
  const event = await req.json().catch(() => null);
  if (!event?.event_type) return json({ ok: false }, 400);
  let verified = false;
  try {
    verified = await verifyWebhook(req.headers, event);
  } catch {
    verified = false;
  }
  if (process.env.PAYPAL_WEBHOOK_ID && !verified) return json({ ok: false, error: "signature" }, 401);
  mutate((db) => {
    db.webhookEvents.unshift({
      id: event.id || uid("evt"),
      type: event.event_type,
      receivedAt: new Date().toISOString(),
      summary: `${event.summary || event.resource?.status || ""}${verified ? "" : " (unverified, ignored)"}`,
    });
    db.webhookEvents = db.webhookEvents.slice(0, 30);
  });
  if (!verified) return json({ ok: true, acted: false });

  const type: string = event.event_type;
  if (type.startsWith("PAYMENT.PAYOUTS-ITEM.")) {
    const batchId = event.resource?.payout_batch_id;
    if (batchId) await onPayoutEvent(batchId);
  } else if (type === "INVOICING.INVOICE.PAID") {
    const invoiceId = event.resource?.invoice?.id || event.resource?.id;
    if (invoiceId) onInvoicePaid(invoiceId);
  }
  return json({ ok: true, acted: true });
}
