import type { Metadata } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { Web3Provider } from "./components/web3-provider";
import "./tokens.css";
import "./globals.css";
import "./home.css";
import "./product.css";
import "./proof.css";
import "./refresh.css";
import "./experience.css";
import "./client.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Display face for headlines only - Geist stays the workhorse for UI/body
// text. Fraunces' soft, slightly ink-y serif gives RIVER's headlines real
// character instead of leaning on the same "safe" system-sans look every
// other AI-drafted interface reaches for.
const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const origin = `${protocol}://${host}`;

  return {
    // Kept in step with the homepage hero deliberately. "Poker without the
    // house" was the pre-pivot peer-to-peer framing and is now simply false
    // - a trusted server deals every hand - so it doesn't belong on the tab
    // title or the link preview, which are the first thing anyone shared a
    // link actually sees.
    title: "RIVER — Real hands. Real receipts.",
    description:
      "Server-dealt hold'em where every completed hand ships a cryptographic receipt you can verify yourself. 2-10 seats, host-set stakes, test chips.",
    applicationName: "RIVER",
    category: "games",
    keywords: ["provably fair poker", "online poker", "verifiable poker", "poker with friends", "hold'em"],
    alternates: { canonical: origin },
    openGraph: {
      type: "website",
      url: origin,
      siteName: "RIVER",
      title: "RIVER — Real hands. Real receipts.",
      description: "Server-dealt hold'em with a verifiable receipt after every hand. Test chips.",
      images: [{ url: `${origin}/og-v2.png`, width: 1672, height: 941, alt: "RIVER — Real hands. Real receipts." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "RIVER — Real hands. Real receipts.",
      description: "Server-dealt hold'em with a verifiable receipt after every hand. Test chips.",
      images: [`${origin}/og-v2.png`],
    },
    robots: { index: true, follow: true },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Font variable classes live on <html>, not <body>: tokens.css's :root
    // rule (--rv-font-display: var(--font-display), ...) needs --font-display
    // visible AT :root to resolve - custom properties inherit their computed
    // (already-resolved) value downward, so if --font-display were only
    // defined on <body> (a descendant of :root), var(--font-display) would
    // be unresolvable at :root's own computed-value time and the whole
    // --rv-font-display property would compute as invalid for every
    // descendant, body included. Confirmed via getComputedStyle before this
    // fix: --rv-font-display read as "" everywhere despite --font-display
    // itself being correctly set.
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable}`}>
      <body className="antialiased">
        <Web3Provider>{children}</Web3Provider>
      </body>
    </html>
  );
}
