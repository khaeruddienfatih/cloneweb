// Konteks aplikasi per permintaan: konfigurasi dari binding/secret Cloudflare + penyimpanan D1.
import { openStore } from "./db.js";

export async function createContext(env) {
  if (!env.DB) throw new Error("Binding D1 `DB` tidak ditemukan. Periksa wrangler.jsonc.");
  const store = await openStore(env.DB);
  const threadsConfigured = Boolean(env.THREADS_APP_ID && env.THREADS_APP_SECRET);
  return {
    store,
    secret: env.SESSION_SECRET || (await store.secret()),
    timezone: env.TIMEZONE || "Asia/Jakarta",
    model: env.CLAUDE_MODEL || "claude-opus-5-5",
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined },
    threads: {
      configured: threadsConfigured,
      appId: env.THREADS_APP_ID || "",
      appSecret: env.THREADS_APP_SECRET || "",
      scopes: "threads_basic,threads_content_publish",
    },
    demoMode: env.DEMO_MODE === "1" || !threadsConfigured,
  };
}
