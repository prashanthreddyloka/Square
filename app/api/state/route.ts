import { getDB } from "../../../lib/store";
import { paypalMode } from "../../../lib/paypal";
import { aiMode } from "../../../lib/ai";
import { publicState } from "../../../lib/view";
import { json } from "../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET() {
  return json({ ...publicState(getDB()), modes: { paypal: paypalMode(), ai: aiMode() } });
}
