import { friendlyDbError } from "../../../../db";
import { getSessionUser } from "../../../../worker/auth";

export async function GET(request: Request) {
  try {
    const user = await getSessionUser(request);
    return Response.json({ user });
  } catch (error) {
    return Response.json({ error: friendlyDbError(error) }, { status: 500 });
  }
}
