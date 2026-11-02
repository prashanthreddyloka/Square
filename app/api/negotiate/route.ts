import { Conflict, negotiate } from "../../../lib/agents";
import { fail, json } from "../../../lib/http";

export const maxDuration = 120;

export async function POST() {
  try {
    const n = await negotiate();
    return json({ id: n.id, status: n.status });
  } catch (e) {
    return fail(e, e instanceof Conflict ? 409 : 500);
  }
}
