// Penyimpanan di Cloudflare D1. Tiap baris menyimpan objek utuh di kolom `data` (JSON);
// kolom lain hanya salinan untuk keperluan pencarian.
import { randomHex } from "./security.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS products_account ON products (account_id)`,
  `CREATE TABLE IF NOT EXISTS threads (
     id TEXT PRIMARY KEY, account_id TEXT NOT NULL, status TEXT NOT NULL,
     scheduled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS threads_account ON threads (account_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS threads_status ON threads (status, scheduled_at)`,
  `CREATE TABLE IF NOT EXISTS autopilot (account_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, data TEXT NOT NULL)`,
];

export const DEFAULT_AUTOPILOT = {
  enabled: false,
  times: ["09:00", "19:30"],
  postCount: 5,
  tone: "santai",
  disclosure: true,
  ran: [],
  lastError: null,
};

let schemaReady; // sekali per isolate
const parse = (row) => (row ? JSON.parse(row.data) : null);
const parseAll = (result) => result.results.map(parse);

/** Bungkus binding D1 menjadi API penyimpanan aplikasi. Tabel dibuat otomatis saat pertama dipakai. */
export async function openStore(d1) {
  schemaReady ??= d1.batch(SCHEMA.map((sql) => d1.prepare(sql))).catch((err) => {
    schemaReady = undefined;
    throw err;
  });
  await schemaReady;

  const run = (sql, ...args) => d1.prepare(sql).bind(...args).run();
  const first = (sql, ...args) => d1.prepare(sql).bind(...args).first();
  const all = (sql, ...args) => d1.prepare(sql).bind(...args).all();

  const store = {
    /** Rahasia aplikasi: dibuat otomatis sekali lalu disimpan, kecuali SESSION_SECRET diisi. */
    async secret() {
      await run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('secret', ?)`, randomHex(48));
      return (await first(`SELECT value FROM settings WHERE key = 'secret'`)).value;
    },

    accounts: {
      get: async (id) => parse(await first(`SELECT data FROM accounts WHERE id = ?`, String(id))),
      all: async () => parseAll(await all(`SELECT data FROM accounts`)),
      async upsert(account) {
        const merged = { ...(await store.accounts.get(account.id)), ...account };
        await run(`INSERT OR REPLACE INTO accounts (id, data) VALUES (?, ?)`, merged.id, JSON.stringify(merged));
        return merged;
      },
      remove: (id) =>
        d1.batch(
          ["accounts WHERE id", "autopilot WHERE account_id", "products WHERE account_id", "threads WHERE account_id"].map(
            (target) => d1.prepare(`DELETE FROM ${target} = ?`).bind(id),
          ),
        ),
    },

    products: {
      list: async (accountId) => parseAll(await all(`SELECT data FROM products WHERE account_id = ?`, accountId)),
      get: async (id) => parse(await first(`SELECT data FROM products WHERE id = ?`, String(id))),
      async create(data) {
        const product = { id: randomHex(8), createdAt: Date.now(), lastUsedAt: 0, ...data };
        await run(`INSERT INTO products (id, account_id, data) VALUES (?, ?, ?)`, product.id, product.accountId, JSON.stringify(product));
        return product;
      },
      async update(id, patch) {
        const product = { ...(await store.products.get(id)), ...patch };
        await run(`UPDATE products SET data = ? WHERE id = ?`, JSON.stringify(product), id);
        return product;
      },
      remove: (id) => run(`DELETE FROM products WHERE id = ?`, id),
    },

    threads: {
      list: async (accountId) =>
        parseAll(await all(`SELECT data FROM threads WHERE account_id = ? ORDER BY created_at DESC LIMIT 100`, accountId)),
      get: async (id) => parse(await first(`SELECT data FROM threads WHERE id = ?`, String(id))),
      /** Hook dari utas-utas terakhir sebuah produk, supaya Claude tidak mengulang sudut pandang. */
      async recentHooks(accountId, productId) {
        const recent = await store.threads.list(accountId);
        return recent.filter((t) => t.productId === productId).slice(0, 5).map((t) => t.posts[0]);
      },
      async create(data) {
        const thread = { id: randomHex(8), createdAt: Date.now(), results: [], error: null, ...data };
        await run(
          `INSERT INTO threads (id, account_id, status, scheduled_at, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          thread.id, thread.accountId, thread.status, thread.scheduledAt, thread.createdAt, Date.now(), JSON.stringify(thread),
        );
        return thread;
      },
      save: (thread) =>
        run(
          `UPDATE threads SET status = ?, scheduled_at = ?, updated_at = ?, data = ? WHERE id = ?`,
          thread.status, thread.scheduledAt, Date.now(), JSON.stringify(thread), thread.id,
        ),
      remove: (id) => run(`DELETE FROM threads WHERE id = ?`, id),
      due: async (now) =>
        parseAll(await all(`SELECT data FROM threads WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 20`, now)),
      /** Ambil alih utas untuk diterbitkan. Atomik, jadi dua tick cron tidak menerbitkan utas yang sama. */
      async claim(id) {
        const result = await run(`UPDATE threads SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'`, Date.now(), id);
        return result.meta.changes === 1;
      },
      /** Utas yang "publishing" tapi sudah lama tidak ada kemajuan (worker terhenti di tengah jalan). */
      stuck: async (before) =>
        parseAll(await all(`SELECT data FROM threads WHERE status = 'publishing' AND updated_at < ?`, before)),
    },

    autopilot: {
      get: async (accountId) => ({
        ...DEFAULT_AUTOPILOT,
        ...parse(await first(`SELECT data FROM autopilot WHERE account_id = ?`, accountId)),
      }),
      async set(accountId, patch) {
        const settings = { ...(await store.autopilot.get(accountId)), ...patch };
        await run(
          `INSERT OR REPLACE INTO autopilot (account_id, enabled, data) VALUES (?, ?, ?)`,
          accountId, settings.enabled ? 1 : 0, JSON.stringify(settings),
        );
        return settings;
      },
      enabledAccountIds: async () =>
        (await all(`SELECT account_id FROM autopilot WHERE enabled = 1`)).results.map((row) => row.account_id),
    },
  };
  return store;
}
