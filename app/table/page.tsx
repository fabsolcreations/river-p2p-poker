import { redirect } from "next/navigation";

// This was the pre-Phase-2 local-only bot demo (no real server, no real
// second player) - superseded by the real live table at /play/table-lab.
// Nothing in the site links here anymore; kept as a redirect rather than
// a 404 so an old bookmark or shared link still lands somewhere real.
export default function TablePage() {
  redirect("/lobby");
}
