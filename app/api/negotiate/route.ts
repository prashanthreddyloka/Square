import { Conflict, negotiate } from "../../../lib/agents";
import { fail, isUser, json } from "../../../lib/http";

export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const { a, b } = await req.json();
    if (!isUser(a) || !isUser(b) || a === b) return fail("Pick two different people in the group.");
    const n = await negotiate(a, b);
    return json({ id: n.id, status: n.status });
  } catch (e) {
    return fail(e, e instanceof Conflict ? 409 : 500);
  }
}
