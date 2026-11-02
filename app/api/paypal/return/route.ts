import { NextResponse } from "next/server";
import { createPaymentToken, paypalMode } from "../../../../lib/paypal";
import { getDB, mutate } from "../../../../lib/store";
import { baseUrl, isUser } from "../../../../lib/http";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const user = url.searchParams.get("user");
  const base = baseUrl(req);
  if (!isUser(user)) return NextResponse.redirect(`${base}/?linked=error`);
  const db = getDB();
  const setupTokenId = url.searchParams.get("approval_token_id") || db.users[user].paypal.setupTokenId;
  try {
    if (!setupTokenId) throw new Error("Missing setup token");
    const t = await createPaymentToken(setupTokenId, db.users[user].sandboxEmail);
    mutate((d) => {
      d.users[user].paypal = {
        status: "linked",
        setupTokenId,
        paymentTokenId: t.id,
        customerId: t.customerId,
        payerId: t.payerId,
        payerEmail: t.email,
        linkedAt: new Date().toISOString(),
        mode: paypalMode(),
      };
    });
    // The vault token never goes to the browser. It's printed here, in the server log only the
    // operator can read, so it can be pinned as ALEX_VAULT_TOKEN / ALEX_PAYER_ID for a hosted demo.
    console.log(`[square] ${user} PayPal allowance approved: ${user.toUpperCase()}_VAULT_TOKEN=${t.id} ${user.toUpperCase()}_PAYER_ID=${t.payerId}`);
    return NextResponse.redirect(`${base}/?linked=${user}`);
  } catch (e) {
    mutate((d) => {
      d.users[user].paypal = { status: "unlinked" };
    });
    return NextResponse.redirect(`${base}/?linked=error&reason=${encodeURIComponent((e as Error).message.slice(0, 160))}`);
  }
}
