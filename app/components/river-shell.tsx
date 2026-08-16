"use client";

import { ArrowRight, Menu, Play, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

type RiverShellProps = {
  children: React.ReactNode;
  active?: "home" | "lobby" | "new" | "tournaments" | "clubs" | "receipts" | "proof" | "protocol" | "account";
  dark?: boolean;
  footer?: boolean;
};

type SessionUser = { id: string; username: string; balance: number };

const navigation = [
  { id: "lobby", label: "Lobby", href: "/lobby" },
  { id: "tournaments", label: "Tournaments", href: "/tournaments" },
  { id: "clubs", label: "Clubs", href: "/clubs" },
  { id: "receipts", label: "Receipts", href: "/receipts" },
  { id: "protocol", label: "Fairness", href: "/fairness" },
] as const;

export function RiverMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`river-wordmark ${compact ? "is-compact" : ""}`}>
      <span className="river-glyph" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && <b>RIVER</b>}
    </span>
  );
}

export function RiverShell({ children, active = "home", dark = false, footer = true }: RiverShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // "loading" until the real session cookie resolves - the same
  // client-only-bootstrap situation as app/account/page.tsx, and now the
  // single source of truth for who's signed in everywhere on the site.
  // (This used to be a separate localStorage "darc.demo" wallet toggle,
  // disconnected from the real account system entirely - a signed-in user
  // saw "Demo profile" in the header regardless of their real session.)
  const [session, setSession] = useState<SessionUser | null | "loading">("loading");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((response) => response.json())
      .then((body: { user: SessionUser | null }) => setSession(body.user))
      .catch(() => setSession(null));
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  return (
    <div className={`river-site ${dark ? "river-site-dark" : ""}`}>
      <a className="skip-link" href="#river-content">Skip to content</a>
      <header className="river-nav">
        <Link className="river-home-link" href="/" aria-label="RIVER home">
          <RiverMark />
          <span className="prototype-tag">TEST CHIPS</span>
        </Link>

        <nav className="river-nav-links" aria-label="Primary navigation">
          {navigation.map((item) => (
            <Link
              className={active === item.id ? "active" : ""}
              href={item.href}
              aria-current={active === item.id ? "page" : undefined}
              key={item.id}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="river-nav-actions">
          <Link className="nav-create-table" href="/lobby"><Play size={14} /> Play now</Link>
          <Link className="nav-account" href="/account">
            {session === "loading" ? null : session ? (
              <>
                <span className="nav-account-avatar">{session.username.slice(0, 1).toUpperCase()}</span>
                <span className="nav-account-detail"><b>{session.username}</b><small>{session.balance} chips</small></span>
              </>
            ) : (
              <span className="nav-account-detail"><b>Sign in</b></span>
            )}
          </Link>
          <button
            className="nav-menu-button"
            aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
      </header>

      {menuOpen && (
        <nav className="river-mobile-menu" aria-label="Mobile navigation">
          <Link href="/lobby" onClick={() => setMenuOpen(false)}><span>00</span>Play now<Play size={17} /></Link>
          {navigation.map((item, index) => (
            <Link href={item.href} key={item.id} onClick={() => setMenuOpen(false)}>
              <span>0{index + 1}</span>{item.label}<ArrowRight size={17} />
            </Link>
          ))}
          <Link href="/account" onClick={() => setMenuOpen(false)}>
            <span>{navigation.length + 1}</span>{session && session !== "loading" ? session.username : "Sign in"}<ArrowRight size={17} />
          </Link>
        </nav>
      )}

      <div id="river-content">{children}</div>

      {footer && <footer className="river-footer">
        <div className="footer-brand-block">
          <RiverMark />
          <p>A trusted dealer.<br />A receipt for every hand.</p>
        </div>
        <div className="footer-link-column">
          <span>PRODUCT</span>
          <Link href="/lobby">Game lobby</Link>
          <Link href="/tournaments">Tournaments</Link>
          <Link href="/clubs">Club console</Link>
          <Link href="/account">Account &amp; bankroll</Link>
        </div>
        <div className="footer-link-column">
          <span>FAIRNESS</span>
          <Link href="/fairness">How hands are proven</Link>
          <Link href="/receipts">Receipt archive</Link>
          <Link href="/fairness#threats">Threat model</Link>
          <Link href="/play">Proof engine (protocol lab)</Link>
        </div>
        <div className="footer-link-column">
          <span>RELEASE SCOPE</span>
          <Link href="/responsible">Responsible play</Link>
          <Link href="/responsible#scope">What&apos;s real vs. planned</Link>
          <Link href="/responsible#legal">Jurisdiction note</Link>
        </div>
        <div className="footer-bottom">
          <span>RIVER</span>
          <span>TEST CHIPS ONLY</span>
          <span>NOT REAL MONEY</span>
        </div>
      </footer>}
    </div>
  );
}
