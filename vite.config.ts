import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// Local dev runs against Miniflare, which ignores these entirely - hence the
// scaffold's placeholder id, which is fine until you deploy to a real
// Cloudflare account, where it points at nothing. Set these two in the
// environment (see .env.deploy.example) and `npm run build` emits a
// dist/server/wrangler.json wired to the real database instead. Defaults are
// the original placeholders, so local dev is unchanged when they're unset.
const d1DatabaseName = process.env.CF_D1_DATABASE_NAME ?? "site-creator-d1";
const d1DatabaseId = process.env.CF_D1_DATABASE_ID ?? SITE_CREATOR_PLACEHOLDER_DATABASE_ID;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const isLocalDesktopPreview = process.env.CODEX_LOCAL_PREVIEW === "1";
const cloudflarePlugin = isLocalDesktopPreview
  ? null
  : (await import("@cloudflare/vite-plugin")).cloudflare;

// Custom domains to bind this Worker to, comma-separated (e.g.
// "playriver.gg,www.playriver.gg"). Left unset for local dev and for the
// plain workers.dev deploy - Cloudflare creates the DNS records itself when
// a custom domain is attached, which is why none are added by hand.
const customDomains = (process.env.CF_CUSTOM_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim())
  .filter(Boolean);

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  ...(customDomains.length > 0
    ? { routes: customDomains.map((pattern) => ({ pattern, custom_domain: true })) }
    : {}),
  durable_objects: {
    bindings: [{ name: "TABLE", class_name: "PokerTable" }],
  },
  migrations: [{ tag: "v1", new_sqlite_classes: ["PokerTable"] }],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: d1DatabaseName,
          database_id: d1DatabaseId,
          migrations_dir: "./drizzle",
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Production publishing wraps the RSC handler as a Cloudflare Worker entry.
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      ...(isLocalDesktopPreview
        ? []
        : [
            cloudflarePlugin!({
              viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
              config: localBindingConfig,
            }),
          ]),
    ],
  };
});
