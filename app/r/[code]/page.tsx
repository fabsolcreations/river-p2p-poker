import { redirect } from "next/navigation";

// This was the pre-Phase-2 local-only demo's room-invite screen - its
// room codes were never real Cloudflare Durable Object rooms, just local
// client state, so there's nothing meaningful to carry forward. Nothing
// in the site links here anymore; kept as a redirect rather than a 404
// so an old bookmark or shared link still lands somewhere real.
export default function RoomInvitePage() {
  redirect("/lobby");
}
