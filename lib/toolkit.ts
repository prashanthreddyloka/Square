/**
 * PayPal Agent Toolkit bridge.
 *
 * Square agents call PayPal through the official Agent Toolkit, exposed to Claude
 * as tools. The creditor's agent uses it to independently verify that money really
 * arrived before it signs off, and to send an itemized PayPal invoice when the
 * friend has no agent yet.
 */
import { paypalMode } from "./paypal";

type OpenAITool = { type: "function"; function: { name: string; description?: string; parameters: Record<string, unknown> } };
type ToolkitLike = { getTools(): OpenAITool[]; handleToolCall(c: unknown): Promise<{ content: unknown }> };

let kit: ToolkitLike | null = null;

function toolkit(): ToolkitLike {
  if (kit) return kit;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PayPalAgentToolkit } = require("@paypal/agent-toolkit/openai");
  kit = new PayPalAgentToolkit({
    clientId: process.env.PAYPAL_CLIENT_ID || "demo",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || "demo",
    configuration: {
      actions: {
        orders: { get: true },
        transactions: { list: true },
        invoices: { create: true, send: true, get: true },
      },
      context: { sandbox: process.env.PAYPAL_ENV !== "live" },
    },
  }) as ToolkitLike;
  return kit;
}

/** Toolkit tools, converted to Anthropic tool definitions. */
export function claudeTools(names: string[]) {
  return toolkit()
    .getTools()
    .filter((t) => names.includes(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: (t.function.description || "").trim().slice(0, 1000),
      // Anthropic expects a plain JSON Schema object; drop the draft-07 marker the toolkit adds.
      input_schema: Object.fromEntries(Object.entries(t.function.parameters).filter(([k]) => k !== "$schema")),
    }));
}

/** Run a toolkit tool. Demo mode returns simulated PayPal responses. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (paypalMode() === "demo") return JSON.stringify(simulate(name, args));
  const r = await toolkit().handleToolCall({
    id: `call_${Date.now()}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  });
  return typeof r.content === "string" ? r.content : JSON.stringify(r.content);
}

function simulate(name: string, args: Record<string, unknown>) {
  const now = new Date().toISOString();
  switch (name) {
    case "get_order":
      return {
        id: args.id,
        status: "COMPLETED",
        intent: "CAPTURE",
        purchase_units: [{ payments: { captures: [{ status: "COMPLETED", final_capture: true, create_time: now }] } }],
        _note: "simulated (demo mode)",
      };
    case "list_transactions":
      return { transaction_details: [], _note: "simulated (demo mode)" };
    case "create_invoice":
      return { id: `INV2-DEMO-${Math.random().toString(36).slice(2, 6).toUpperCase()}`, status: "DRAFT", _note: "simulated (demo mode)" };
    case "send_invoice":
      return { href: "https://www.sandbox.paypal.com/invoice/p/#DEMO", _note: "simulated (demo mode)" };
    default:
      return { _note: "simulated (demo mode)" };
  }
}

/** Itemized invoice for a friend who isn't on Square yet. */
export async function sendFriendInvoice(opts: {
  fromName: string;
  fromEmail: string;
  toName: string;
  toEmail: string;
  lines: { name: string; description: string; amount: number }[];
  note: string;
}) {
  const created = JSON.parse(
    await runTool("create_invoice", {
      currency_code: "USD",
      note: opts.note.slice(0, 4000),
      invoicer_given_name: opts.fromName,
      invoicer_email_address: process.env.PAYPAL_MERCHANT_EMAIL || undefined,
      primary_recipients: [{ billing_info: { name: { given_name: opts.toName }, email_address: opts.toEmail } }],
      items: opts.lines.map((l) => ({
        name: l.name.slice(0, 200),
        description: l.description.slice(0, 1000),
        quantity: "1",
        unit_amount: { currency_code: "USD", value: l.amount.toFixed(2) },
      })),
    }),
  );
  const id: string = created.id || String(created.href || "").split("/").pop() || "";
  const sent = JSON.parse(await runTool("send_invoice", { invoice_id: id, send_to_recipient: true, note: opts.note.slice(0, 300) }));
  return { id, url: sent.href as string | undefined };
}
