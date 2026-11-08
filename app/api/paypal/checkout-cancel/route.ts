import { NextResponse } from "next/server";
import { cancelCheckout } from "../../../../lib/agents";
import { baseUrl } from "../../../../lib/http";
import { getDB } from "../../../../lib/store";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("n") || "";
  cancelCheckout(id);
  const n = getDB().negotiations.find((x) => x.id === id);
  const pair = n ? `pair=${encodeURIComponent(`${n.debtor},${n.creditor}`)}&` : "";
  return NextResponse.redirect(`${baseUrl(req)}/?${pair}paid=cancelled`);
}
