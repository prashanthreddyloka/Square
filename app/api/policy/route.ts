import { mutate } from "../../../lib/store";
import { publicUser } from "../../../lib/view";
import { fail, isUser, json } from "../../../lib/http";

export async function POST(req: Request) {
  try {
    const { user, autoApproveMax, weeklyCap, instructions, memory } = await req.json();
    if (!isUser(user)) return fail("Unknown user.");
    const a = Number(autoApproveMax);
    const w = Number(weeklyCap);
    if (!(a >= 0) || !(w >= 0)) return fail("Limits must be zero or more.");
    if (a > w) return fail("The auto-approve limit can't be higher than the weekly cap.");
    const updated = mutate((db) => {
      const p = db.users[user].policy;
      p.autoApproveMax = a;
      p.weeklyCap = w;
      p.instructions = String(instructions ?? p.instructions).slice(0, 1200);
      if (Array.isArray(memory)) p.memory = memory.map((m: unknown) => String(m).trim()).filter(Boolean).slice(0, 12);
      return db.users[user];
    });
    return json(publicUser(updated));
  } catch (e) {
    return fail(e);
  }
}
