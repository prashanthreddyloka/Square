import { Conflict, retrySettlement } from "../../../lib/agents";
import { fail, json } from "../../../lib/http";

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { negotiationId } = await req.json();
    const n = await retrySettlement(String(negotiationId));
    return json({ id: n.id, status: n.status });
  } catch (e) {
    return fail(e, e instanceof Conflict ? 409 : 400);
  }
}
