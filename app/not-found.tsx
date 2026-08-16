import { ArrowLeft, Spade } from "lucide-react";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="river-not-found">
      <div><Spade size={28} /><span>404 / MISDEAL</span></div>
      <h1>This hand<br />doesn&apos;t exist.</h1>
      <p>The link may be incomplete, expired, or from a room that has not been built yet.</p>
      <Link href="/"><ArrowLeft size={16} /> Back to RIVER</Link>
    </main>
  );
}
