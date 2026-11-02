import { resetDB } from "../../../lib/store";
import { json } from "../../../lib/http";

export async function POST(req: Request) {
  const { keepPayPal = true } = await req.json().catch(() => ({}));
  resetDB(Boolean(keepPayPal));
  return json({ ok: true });
}
