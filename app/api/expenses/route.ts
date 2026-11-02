import { captureExpense } from "../../../lib/agents";
import { fail, isUser, json } from "../../../lib/http";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { author, text, image } = await req.json();
    if (!isUser(author)) return fail("Unknown user.");
    if (!text && !image) return fail("Tell your agent what you paid for, or attach a receipt.");
    if (image && String(image).length > 6_000_000) return fail("That photo is too large. Try one under 4 MB.");
    return json(await captureExpense(author, String(text || ""), image));
  } catch (e) {
    return fail(e);
  }
}
