import { Conflict, decide } from "../../../lib/agents";
import { fail, json } from "../../../lib/http";

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { negotiationId, decision } = await req.json();
    if (decision !== "approved" && decision !== "declined") return fail("Decision must be approved or declined.");
    const n = await decide(String(negotiationId), decision);
    return json({ id: n.id, status: n.status });
  } catch (e) {
    return fail(e, e instanceof Conflict ? 409 : 400);
  }
}
