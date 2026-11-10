import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { config, ROOT } from "./src/config.js";
import { accounts, autopilot, products, threads } from "./src/store.js";
import { authorizeUrl, connectAccount, MAX_POST_LENGTH } from "./src/threadsApi.js";
import { AiError, generateThread, TONES } from "./src/ai.js";
import { publishThread, runAutopilot, startScheduler } from "./src/publisher.js";

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "200kb" }));

// ---------- sesi: cookie bertanda tangan berisi daftar akun yang terhubung ----------

const SESSION_COOKIE = "utasin_session";
const STATE_COOKIE = "utasin_state";
const sign = (value) => crypto.createHmac("sha256", config.secret).update(value).digest("base64url");

function readCookie(req, name) {
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const attrs = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (config.secure) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

function readSession(req) {
  const raw = readCookie(req, SESSION_COOKIE);
  if (!raw) return [];
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return [];
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return [];
  try {
    const ids = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return ids.filter((id) => accounts.get(id));
  } catch {
    return [];
  }
}

function writeSession(res, ids) {
  const payload = Buffer.from(JSON.stringify([...new Set(ids)])).toString("base64url");
  setCookie(res, SESSION_COOKIE, `${payload}.${sign(payload)}`, 60 * 86_400);
}

app.use((req, _res, next) => {
  req.accountIds = readSession(req);
  next();
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Pastikan akun yang diminta memang milik sesi ini. */
function ownAccount(req, accountId) {
  if (!accountId || !req.accountIds.includes(String(accountId))) {
    throw new HttpError(401, "Silakan masuk dengan akun Threads dulu.");
  }
  return accounts.get(String(accountId));
}

const publicAccount = (a) => ({ id: a.id, username: a.username, name: a.name, picture: a.picture, demo: a.demo });

// ---------- login ----------

app.get("/auth/threads/login", (req, res) => {
  if (!config.threads.configured) return res.redirect("/?error=" + encodeURIComponent("Threads API belum dikonfigurasi di server."));
  const state = crypto.randomBytes(16).toString("hex");
  setCookie(res, STATE_COOKIE, state, 600);
  res.redirect(authorizeUrl(state));
});

app.get("/auth/threads/callback", async (req, res) => {
  const fail = (message) => res.redirect("/?error=" + encodeURIComponent(message));
  const { code, state, error_description: denied } = req.query;
  if (denied) return fail(String(denied));
  if (!code || !state || state !== readCookie(req, STATE_COOKIE)) return fail("Login tidak valid, coba lagi.");
  try {
    const account = await connectAccount(String(code));
    writeSession(res, [...req.accountIds, account.id]);
    setCookie(res, STATE_COOKIE, "", 0);
    res.redirect(`/?account=${account.id}`);
  } catch (err) {
    console.error("[login]", err.message);
    fail(err.message);
  }
});

app.post("/auth/demo", (req, res) => {
  if (!config.demoMode) throw new HttpError(403, "Mode demo tidak aktif.");
  const account = accounts.upsert({
    id: "demo",
    username: "akun_demo",
    name: "Akun Demo",
    picture: "",
    demo: true,
  });
  writeSession(res, [...req.accountIds, account.id]);
  res.json({ account: publicAccount(account) });
});

app.post("/auth/logout", (req, res) => {
  const { accountId, disconnect } = req.body || {};
  if (accountId) {
    ownAccount(req, accountId);
    if (disconnect) accounts.remove(String(accountId)); // hapus token & semua datanya
    writeSession(res, req.accountIds.filter((id) => id !== String(accountId)));
  } else {
    writeSession(res, []);
  }
  res.json({ ok: true });
});

// ---------- API ----------

app.get("/api/me", (req, res) => {
  res.json({
    accounts: req.accountIds.map((id) => publicAccount(accounts.get(id))),
    demoMode: config.demoMode,
    threadsConfigured: config.threads.configured,
    timezone: config.timezone,
    maxPostLength: MAX_POST_LENGTH,
    tones: Object.keys(TONES),
  });
});

const text = (value, max) => String(value ?? "").trim().slice(0, max);

function productInput(body) {
  const product = {
    name: text(body.name, 150),
    link: text(body.link, 500),
    price: text(body.price, 60),
    description: text(body.description, 3000),
    audience: text(body.audience, 300),
    imageUrl: text(body.imageUrl, 500),
    active: body.active !== false,
  };
  if (!product.name) throw new HttpError(400, "Nama produk wajib diisi.");
  if (!/^https?:\/\/\S+$/i.test(product.link)) throw new HttpError(400, "Link affiliate harus berupa URL (https://...).");
  if (product.imageUrl && !/^https?:\/\/\S+$/i.test(product.imageUrl)) throw new HttpError(400, "URL gambar tidak valid.");
  return product;
}

function ownProduct(req, id) {
  const product = products.get(id);
  if (!product || !req.accountIds.includes(product.accountId)) throw new HttpError(404, "Produk tidak ditemukan.");
  return product;
}

app.get("/api/products", (req, res) => {
  const account = ownAccount(req, req.query.accountId);
  res.json({ products: products.list(account.id) });
});

app.post("/api/products", (req, res) => {
  const account = ownAccount(req, req.body.accountId);
  res.json({ product: products.create({ accountId: account.id, ...productInput(req.body) }) });
});

app.put("/api/products/:id", (req, res) => {
  const product = ownProduct(req, req.params.id);
  res.json({ product: products.update(product.id, productInput(req.body)) });
});

app.delete("/api/products/:id", (req, res) => {
  products.remove(ownProduct(req, req.params.id).id);
  res.json({ ok: true });
});

const clampCount = (n) => Math.min(12, Math.max(3, Number(n) || 5));

app.post("/api/generate", async (req, res) => {
  const product = ownProduct(req, req.body.productId);
  const avoid = threads
    .list(product.accountId)
    .filter((t) => t.productId === product.id)
    .slice(0, 5)
    .map((t) => t.posts[0]);
  const posts = await generateThread(product, {
    postCount: clampCount(req.body.postCount),
    tone: text(req.body.tone, 30),
    disclosure: req.body.disclosure !== false,
    angle: text(req.body.angle, 500),
    avoid,
  });
  res.json({ posts });
});

function ownThread(req, id) {
  const thread = threads.get(id);
  if (!thread || !req.accountIds.includes(thread.accountId)) throw new HttpError(404, "Utas tidak ditemukan.");
  return thread;
}

app.get("/api/threads", (req, res) => {
  const account = ownAccount(req, req.query.accountId);
  res.json({ threads: threads.list(account.id) });
});

app.post("/api/threads", (req, res) => {
  const account = ownAccount(req, req.body.accountId);
  const posts = (Array.isArray(req.body.posts) ? req.body.posts : []).map((p) => String(p).trim()).filter(Boolean);
  if (posts.length === 0) throw new HttpError(400, "Utas masih kosong.");
  if (posts.length > 25) throw new HttpError(400, "Maksimal 25 post per utas.");
  const tooLong = posts.findIndex((p) => p.length > MAX_POST_LENGTH);
  if (tooLong >= 0) throw new HttpError(400, `Post ke-${tooLong + 1} melebihi ${MAX_POST_LENGTH} karakter.`);

  const imageUrl = text(req.body.imageUrl, 500);
  if (imageUrl && !/^https?:\/\/\S+$/i.test(imageUrl)) throw new HttpError(400, "URL gambar tidak valid.");

  let scheduledAt = null;
  if (req.body.scheduledAt) {
    scheduledAt = new Date(req.body.scheduledAt).getTime();
    if (!Number.isFinite(scheduledAt)) throw new HttpError(400, "Waktu jadwal tidak valid.");
    if (scheduledAt < Date.now() - 60_000) throw new HttpError(400, "Waktu jadwal sudah lewat.");
  }

  const product = req.body.productId ? ownProduct(req, req.body.productId) : null;
  if (product) products.update(product.id, { lastUsedAt: Date.now() });

  const thread = threads.create({
    accountId: account.id,
    productId: product?.id || null,
    productName: product?.name || "",
    posts,
    imageUrl,
    scheduledAt,
    status: scheduledAt ? "scheduled" : "publishing",
    source: "manual",
  });
  if (!scheduledAt) publishThread(thread); // berjalan di latar; UI memantau statusnya
  res.json({ thread });
});

app.post("/api/threads/:id/retry", (req, res) => {
  const thread = ownThread(req, req.params.id);
  if (thread.status !== "failed") throw new HttpError(400, "Hanya utas yang gagal yang bisa dilanjutkan.");
  publishThread(thread);
  res.json({ thread });
});

app.delete("/api/threads/:id", (req, res) => {
  const thread = ownThread(req, req.params.id);
  if (thread.status === "publishing") throw new HttpError(400, "Utas sedang diterbitkan.");
  threads.remove(thread.id);
  res.json({ ok: true });
});

app.get("/api/autopilot", (req, res) => {
  const account = ownAccount(req, req.query.accountId);
  res.json({ autopilot: autopilot.get(account.id) });
});

app.put("/api/autopilot", (req, res) => {
  const account = ownAccount(req, req.body.accountId);
  const times = [...new Set((Array.isArray(req.body.times) ? req.body.times : []).map(String))]
    .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
    .sort()
    .slice(0, 6);
  if (req.body.enabled && times.length === 0) throw new HttpError(400, "Isi minimal satu jam posting.");
  const tone = Object.hasOwn(TONES, req.body.tone) ? req.body.tone : "santai";
  res.json({
    autopilot: autopilot.set(account.id, {
      enabled: Boolean(req.body.enabled),
      times,
      tone,
      postCount: clampCount(req.body.postCount),
      disclosure: req.body.disclosure !== false,
      lastError: null,
    }),
  });
});

app.post("/api/autopilot/run", async (req, res) => {
  const account = ownAccount(req, req.body.accountId);
  try {
    res.json({ thread: await runAutopilot(account.id) });
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new HttpError(400, err.message);
  }
});

// ---------- statis & error ----------

app.use(express.static(path.join(ROOT, "public")));

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof AiError)) console.error(err);
  res.status(status).json({ error: err.message || "Terjadi kesalahan di server." });
});

app.listen(config.port, () => {
  console.log(`Utasin jalan di ${config.baseUrl}`);
  if (!config.threads.configured) console.log("Threads API belum diisi -> mode demo (posting hanya simulasi).");
  startScheduler();
});
