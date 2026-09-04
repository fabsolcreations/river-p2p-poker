/**
 * Userscript bootstrap.
 *
 * The build concatenates the compiled hook bundle ahead of this file, so by the
 * time this runs the collector has already booted itself. There is deliberately
 * nothing to do here beyond leaving a breadcrumb in the console - the two
 * shipping shapes must run byte-identical hook code, and any logic that lived
 * only in the userscript path would break that guarantee.
 */

export {};

try {
  const scout = (window as unknown as { __BETBY_SCOUT__?: { version: string } }).__BETBY_SCOUT__;
  if (scout) {
    console.info(
      `[betby-scout] userscript collector ${scout.version} active. A cross-origin BETBY iframe needs the extension instead - see docs/INSTALL.md.`,
    );
  }
} catch {
  /* console can be unavailable in a hardened page */
}
