import { buildWalletLinkChallenge } from "../../../../worker/chain";
import { getSessionUser } from "../../../../worker/auth";

export async function GET(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return Response.json({ error: "Not signed in." }, { status: 401 });
  return Response.json({ message: buildWalletLinkChallenge(user.id) });
}
