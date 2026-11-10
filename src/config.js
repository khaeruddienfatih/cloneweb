import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, "secret");
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  }
  return fs.readFileSync(file, "utf8").trim();
}

const port = Number(process.env.PORT) || 3000;
const baseUrl = (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const threadsConfigured = Boolean(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET);

export const config = {
  port,
  baseUrl,
  secure: baseUrl.startsWith("https://"),
  secret: loadSecret(),
  timezone: process.env.TIMEZONE || "Asia/Jakarta",
  model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
  threads: {
    configured: threadsConfigured,
    appId: process.env.THREADS_APP_ID || "",
    appSecret: process.env.THREADS_APP_SECRET || "",
    redirectUri: `${baseUrl}/auth/threads/callback`,
    scopes: "threads_basic,threads_content_publish",
  },
  demoMode: process.env.DEMO_MODE === "1" || !threadsConfigured,
};
