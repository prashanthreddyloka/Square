import { NextResponse } from "next/server";
import { finishCheckout } from "../../../../lib/agents";
import { baseUrl } from "../../../../lib/http";
import { getDB } from "../../../../lib/store";

/** Reopen the two phones this payment belongs to. */
function pairOf(id: string) {
  const neg = getDB().negotiations.find((x) => x.id === id);
  return neg ? encodeURIComponent(`${neg.debtor},${neg.creditor}`) : "";
}

export const maxDuration = 120;

/** PayPal sends the payer back here after they approve the order. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const n = url.searchParams.get("n") || "";
  const token = url.searchParams.get("token") || "";
  const base = baseUrl(req);
  try {
    const r = await finishCheckout(n, token);
    return NextResponse.redirect(`${base}/?pair=${pairOf(n)}&paid=${encodeURIComponent(r.status)}`);
  } catch (e) {
    return NextResponse.redirect(`${base}/?pair=${pairOf(n)}&paid=error&reason=${encodeURIComponent((e as Error).message.slice(0, 160))}`);
  }
}
