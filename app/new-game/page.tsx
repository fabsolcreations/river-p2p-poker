import { redirect } from "next/navigation";

// This was the pre-Phase-2 local-only demo's "create a table" flow -
// superseded by the real /lobby (real Cloudflare Durable Object rooms,
// real accounts, host-configurable stakes). Nothing in the site links
// here anymore; kept as a redirect rather than a 404 so an old bookmark
// or shared link still lands somewhere real instead of stale demo copy.
export default function NewGamePage() {
  redirect("/lobby");
}
