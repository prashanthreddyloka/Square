import { captureExpense } from "../../../lib/agents";
import { fail, isUser, json } from "../../../lib/http";

export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { author, friend, text, image, group } = await req.json();
    if (!isUser(author) || !isUser(friend) || author === friend) return fail("Unknown user.");
    if (!text && !image) return fail("Tell your agent what you paid for, or attach a receipt.");
    if (image && String(image).length > 6_000_000) return fail("That photo is too large. Try one under 4 MB.");
    return json(await captureExpense(author, friend, String(text || ""), image, typeof group === "string" ? group : undefined));
  } catch (e) {
    return fail(e);
  }
}
