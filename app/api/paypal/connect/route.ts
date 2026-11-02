import { createSetupToken } from "../../../../lib/paypal";
import { getDB, mutate } from "../../../../lib/store";
import { baseUrl, fail, isUser, json } from "../../../../lib/http";

export async function POST(req: Request) {
  try {
    const { user } = await req.json();
    if (!isUser(user)) return fail("Unknown user.");
    const base = baseUrl(req);
    const human = getDB().users[user].name;
    const t = await createSetupToken({
      human,
      returnUrl: `${base}/api/paypal/return?user=${user}`,
      cancelUrl: `${base}/api/paypal/cancel?user=${user}`,
    });
    mutate((db) => {
      db.users[user].paypal = { status: "pending", setupTokenId: t.id, approveUrl: t.approveUrl };
    });
    return json({ approveUrl: t.approveUrl });
  } catch (e) {
    return fail(e, 500);
  }
}
