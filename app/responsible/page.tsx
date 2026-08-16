import { AlertTriangle, ArrowLeft, Check, Scale, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { RiverShell } from "../components/river-shell";

export default function ResponsiblePage() {
  return (
    <RiverShell dark>
      <main className="policy-page">
        <Link href="/"><ArrowLeft size={15} /> Back to RIVER</Link>
        <span>RIVER / REALITY CHECK</span>
        <h1>A poker product still has responsibilities.</h1>
        <p className="policy-lede">Running a real table on test chips does not remove gambling risk, legal obligations, player protection, or the need for accountable operations.</p>
        <section id="scope"><div><ShieldCheck size={20} /><span>01</span></div><article><h2>Current scope: real product, test money</h2><p>RIVER is a real, working multiplayer poker product - real accounts, a real server-dealt table, a persistent bankroll - but every balance is test chips. It does not accept real deposits, custody real funds, or connect to real money in any way.</p><ul><li><Check size={14} />Real accounts and sessions, with a persistent test-chip bankroll</li><li><Check size={14} />Real live tables - a Cloudflare Durable Object deals every hand over a real connection</li><li><Check size={14} />A cryptographic receipt for every hand, independently verifiable</li><li><AlertTriangle size={14} />No real money anywhere - no deposits, withdrawals, or custodied funds</li><li><AlertTriangle size={14} />No gambling license; not open to real-money play in any jurisdiction</li></ul></article></section>
        <section id="legal"><div><Scale size={20} /><span>02</span></div><article><h2>Jurisdiction comes before launch</h2><p>Real-money poker laws, licensing, age verification, identity requirements, sanctions controls, taxation, marketing restrictions, and consumer protections differ by jurisdiction. A technical protocol does not exempt its builders or operators.</p><p>Before any public-money pilot, RIVER would need qualified counsel to define where the product can operate, who carries which obligations, and which parts of the club model are legally viable.</p></article></section>
        <section><div><AlertTriangle size={20} /><span>03</span></div><article><h2>Player protection must be product infrastructure</h2><p>A serious release needs self-exclusion, deposit and loss limits, session reminders, cooling-off periods, account closure, help resources, and a clear path for disputes. These controls should not be optional club settings.</p></article></section>
      </main>
    </RiverShell>
  );
}
