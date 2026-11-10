// Penyimpanan sederhana berbasis file JSON (data/db.json).
// Cukup untuk 1 server; ganti ke database sungguhan bila pengguna sudah banyak.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, config } from "./config.js";

const FILE = path.join(DATA_DIR, "db.json");
const EMPTY = { accounts: {}, products: [], threads: [], autopilot: {} };

let db = structuredClone(EMPTY);
if (fs.existsSync(FILE)) db = { ...EMPTY, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };

export function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export const newId = () => crypto.randomBytes(8).toString("hex");

// --- enkripsi token akses saat disimpan ---
const KEY = crypto.createHash("sha256").update(`token:${config.secret}`).digest();

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function decrypt(packed) {
  const [iv, tag, body] = packed.split(".").map((s) => Buffer.from(s, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// --- akun ---
export const accounts = {
  get: (id) => db.accounts[id],
  all: () => Object.values(db.accounts),
  upsert(account) {
    db.accounts[account.id] = { ...db.accounts[account.id], ...account };
    save();
    return db.accounts[account.id];
  },
  remove(id) {
    delete db.accounts[id];
    delete db.autopilot[id];
    db.products = db.products.filter((p) => p.accountId !== id);
    db.threads = db.threads.filter((t) => t.accountId !== id);
    save();
  },
};

// --- produk ---
export const products = {
  list: (accountId) => db.products.filter((p) => p.accountId === accountId),
  get: (id) => db.products.find((p) => p.id === id),
  create(data) {
    const product = { id: newId(), createdAt: Date.now(), lastUsedAt: 0, ...data };
    db.products.push(product);
    save();
    return product;
  },
  update(id, patch) {
    const product = products.get(id);
    Object.assign(product, patch);
    save();
    return product;
  },
  remove(id) {
    db.products = db.products.filter((p) => p.id !== id);
    save();
  },
};

// --- utas ---
export const threads = {
  list: (accountId) =>
    db.threads.filter((t) => t.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt),
  all: () => db.threads,
  get: (id) => db.threads.find((t) => t.id === id),
  create(data) {
    const thread = { id: newId(), createdAt: Date.now(), results: [], error: null, ...data };
    db.threads.push(thread);
    save();
    return thread;
  },
  remove(id) {
    db.threads = db.threads.filter((t) => t.id !== id);
    save();
  },
};

// --- autopilot ---
export const DEFAULT_AUTOPILOT = {
  enabled: false,
  times: ["09:00", "19:30"],
  postCount: 5,
  tone: "santai",
  disclosure: true,
  ran: [],
};

export const autopilot = {
  get: (accountId) => ({ ...DEFAULT_AUTOPILOT, ...db.autopilot[accountId] }),
  set(accountId, patch) {
    db.autopilot[accountId] = { ...autopilot.get(accountId), ...patch };
    save();
    return db.autopilot[accountId];
  },
};
