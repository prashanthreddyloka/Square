import { Conflict, startCheckout } from "../../../lib/agents";
import { baseUrl, fail, json } from "../../../lib/http";

export const maxDuration = 60;

/** Start a one-time PayPal checkout for a settle-up whose payer has no saved allowance. */
export async function POST(req: Request) {
  try {
    const { negotiationId } = await req.json();
    const approveUrl = await startCheckout(String(negotiationId), baseUrl(req));
    return json({ approveUrl });
  } catch (e) {
    return fail(e, e instanceof Conflict ? 409 : 400);
  }
}
