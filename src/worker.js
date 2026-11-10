// Titik masuk Cloudflare Worker: API + login (fetch) dan penjadwal (scheduled).
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createContext } from "./context.js";
import { randomHex, seal, unseal } from "./security.js";
import { authorizeUrl, connectAccount, MAX_POST_LENGTH } from "./threadsApi.js";
import { AiError, generateThread, TONES } from "./ai.js";
import { runAutopilot, tick } from "./publisher.js";

const SESSION_COOKIE = "utasin_session";
const STATE_COOKIE = "utasin_state";
const MAX_POSTS = 20; // menjaga jumlah subrequest per utas di bawah batas Workers

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const web = new Hono();

// Konteks aplikasi + sesi (cookie bertanda tangan berisi daftar akun yang terhubung).
web.use("*", async (c, next) => {
  const app = await createContext(c.env);
  const ids = (await unseal(app.secret, getCookie(c, SESSION_COOKIE))) || [];
  const known = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const account = await app.store.accounts.get(id);
    if (account) known.push(account);
  }
  c.set("app", app);
  c.set("accounts", known);
  await next();
});

const cookieOptions = (c, maxAge) => ({
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
  secure: new URL(c.req.url).protocol === "https:",
  maxAge,
});

async function writeSession(c, ids) {
  const value = await seal(c.get("app").secret, [...new Set(ids)]);
  setCookie(c, SESSION_COOKIE, value, cookieOptions(c, 60 * 86_400));
}

const sessionIds = (c) => c.get("accounts").map((a) => a.id);
const redirectUri = (c) => `${new URL(c.req.url).origin}/auth/threads/callback`;
const body = (c) => c.req.json().catch(() => ({}));
const text = (value, max) => String(value ?? "").trim().slice(0, max);
const isUrl = (value) => /^https?:\/\/\S+$/i.test(value);
const clampCount = (n) => Math.min(12, Math.max(3, Number(n) || 5));
const publicAccount = (a) => ({ id: a.id, username: a.username, name: a.name, picture: a.picture, demo: a.demo });

/** Pastikan akun yang diminta memang milik sesi ini. */
function ownAccount(c, accountId) {
  const account = c.get("accounts").find((a) => a.id === String(accountId));
  if (!account) throw new HttpError(401, "Silakan masuk dengan akun Threads dulu.");
  return account;
}

async function ownProduct(c, id) {
  const product = await c.get("app").store.products.get(id);
  if (!product || !sessionIds(c).includes(product.accountId)) throw new HttpError(404, "Produk tidak ditemukan.");
  return product;
}

async function ownThread(c, id) {
  const thread = await c.get("app").store.threads.get(id);
  if (!thread || !sessionIds(c).includes(thread.accountId)) throw new HttpError(404, "Utas tidak ditemukan.");
  return thread;
}

// ---------- login ----------

web.get("/auth/threads/login", (c) => {
  const app = c.get("app");
  if (!app.threads.configured) return c.redirect("/?error=" + encodeURIComponent("Threads API belum dikonfigurasi di server."));
  const state = randomHex(16);
  setCookie(c, STATE_COOKIE, state, cookieOptions(c, 600));
  return c.redirect(authorizeUrl(app, redirectUri(c), state));
});

web.get("/auth/threads/callback", async (c) => {
  const fail = (message) => c.redirect("/?error=" + encodeURIComponent(message));
  const { code, state, error_description: denied } = c.req.query();
  if (denied) return fail(denied);
  if (!code || !state || state !== getCookie(c, STATE_COOKIE)) return fail("Login tidak valid, coba lagi.");
  try {
    const account = await connectAccount(c.get("app"), redirectUri(c), code);
    await writeSession(c, [...sessionIds(c), account.id]);
    deleteCookie(c, STATE_COOKIE, { path: "/" });
    return c.redirect(`/?account=${account.id}`);
  } catch (err) {
    console.error("[login]", err.message);
    return fail(err.message);
  }
});

web.post("/auth/demo", async (c) => {
  const app = c.get("app");
  if (!app.demoMode) throw new HttpError(403, "Mode demo tidak aktif.");
  // Tiap pengunjung mendapat akun demo sendiri, supaya datanya tidak bercampur.
  const id = `demo_${randomHex(6)}`;
  const account = await app.store.accounts.upsert({ id, username: "akun_demo", name: "Akun Demo", picture: "", demo: true });
  await writeSession(c, [...sessionIds(c), account.id]);
  return c.json({ account: publicAccount(account) });
});

web.post("/auth/logout", async (c) => {
  const { accountId, disconnect } = await body(c);
  if (!accountId) {
    await writeSession(c, []);
    return c.json({ ok: true });
  }
  const account = ownAccount(c, accountId);
  if (disconnect) await c.get("app").store.accounts.remove(account.id); // hapus token & semua datanya
  await writeSession(c, sessionIds(c).filter((id) => id !== account.id));
  return c.json({ ok: true });
});

// ---------- API ----------

web.get("/api/me", (c) => {
  const app = c.get("app");
  return c.json({
    accounts: c.get("accounts").map(publicAccount),
    demoMode: app.demoMode,
    threadsConfigured: app.threads.configured,
    timezone: app.timezone,
    maxPostLength: MAX_POST_LENGTH,
    tones: Object.keys(TONES),
  });
});

function productInput(input) {
  const product = {
    name: text(input.name, 150),
    link: text(input.link, 500),
    price: text(input.price, 60),
    description: text(input.description, 3000),
    audience: text(input.audience, 300),
    imageUrl: text(input.imageUrl, 500),
    active: input.active !== false,
  };
  if (!product.name) throw new HttpError(400, "Nama produk wajib diisi.");
  if (!isUrl(product.link)) throw new HttpError(400, "Link affiliate harus berupa URL (https://...).");
  if (product.imageUrl && !isUrl(product.imageUrl)) throw new HttpError(400, "URL gambar tidak valid.");
  return product;
}

web.get("/api/products", async (c) => {
  const account = ownAccount(c, c.req.query("accountId"));
  return c.json({ products: await c.get("app").store.products.list(account.id) });
});

web.post("/api/products", async (c) => {
  const input = await body(c);
  const account = ownAccount(c, input.accountId);
  return c.json({ product: await c.get("app").store.products.create({ accountId: account.id, ...productInput(input) }) });
});

web.put("/api/products/:id", async (c) => {
  const product = await ownProduct(c, c.req.param("id"));
  return c.json({ product: await c.get("app").store.products.update(product.id, productInput(await body(c))) });
});

web.delete("/api/products/:id", async (c) => {
  const product = await ownProduct(c, c.req.param("id"));
  await c.get("app").store.products.remove(product.id);
  return c.json({ ok: true });
});

web.post("/api/generate", async (c) => {
  const app = c.get("app");
  const input = await body(c);
  const product = await ownProduct(c, input.productId);
  const posts = await generateThread(app, product, {
    postCount: clampCount(input.postCount),
    tone: text(input.tone, 30),
    disclosure: input.disclosure !== false,
    angle: text(input.angle, 500),
    avoid: await app.store.threads.recentHooks(product.accountId, product.id),
  });
  return c.json({ posts });
});

web.get("/api/threads", async (c) => {
  const account = ownAccount(c, c.req.query("accountId"));
  return c.json({ threads: await c.get("app").store.threads.list(account.id) });
});

web.post("/api/threads", async (c) => {
  const { store } = c.get("app");
  const input = await body(c);
  const account = ownAccount(c, input.accountId);

  const posts = (Array.isArray(input.posts) ? input.posts : []).map((p) => String(p).trim()).filter(Boolean);
  if (posts.length === 0) throw new HttpError(400, "Utas masih kosong.");
  if (posts.length > MAX_POSTS) throw new HttpError(400, `Maksimal ${MAX_POSTS} post per utas.`);
  const tooLong = posts.findIndex((p) => p.length > MAX_POST_LENGTH);
  if (tooLong >= 0) throw new HttpError(400, `Post ke-${tooLong + 1} melebihi ${MAX_POST_LENGTH} karakter.`);

  const imageUrl = text(input.imageUrl, 500);
  if (imageUrl && !isUrl(imageUrl)) throw new HttpError(400, "URL gambar tidak valid.");

  // "Posting sekarang" = dijadwalkan untuk saat ini; cron mengambilnya dalam ±1 menit.
  let scheduledAt = Date.now();
  if (input.scheduledAt) {
    scheduledAt = new Date(input.scheduledAt).getTime();
    if (!Number.isFinite(scheduledAt)) throw new HttpError(400, "Waktu jadwal tidak valid.");
    if (scheduledAt < Date.now() - 60_000) throw new HttpError(400, "Waktu jadwal sudah lewat.");
  }

  const product = input.productId ? await ownProduct(c, input.productId) : null;
  if (product) await store.products.update(product.id, { lastUsedAt: Date.now() });

  const thread = await store.threads.create({
    accountId: account.id,
    productId: product?.id || null,
    productName: product?.name || "",
    posts,
    imageUrl,
    scheduledAt,
    immediate: !input.scheduledAt,
    status: "scheduled",
    source: "manual",
  });
  return c.json({ thread });
});

web.post("/api/threads/:id/retry", async (c) => {
  const thread = await ownThread(c, c.req.param("id"));
  if (thread.status !== "failed") throw new HttpError(400, "Hanya utas yang gagal yang bisa dilanjutkan.");
  Object.assign(thread, { status: "scheduled", scheduledAt: Date.now(), immediate: true, error: null });
  await c.get("app").store.threads.save(thread);
  return c.json({ thread });
});

web.delete("/api/threads/:id", async (c) => {
  const thread = await ownThread(c, c.req.param("id"));
  if (thread.status === "publishing") throw new HttpError(400, "Utas sedang diterbitkan.");
  await c.get("app").store.threads.remove(thread.id);
  return c.json({ ok: true });
});

web.get("/api/autopilot", async (c) => {
  const account = ownAccount(c, c.req.query("accountId"));
  return c.json({ autopilot: await c.get("app").store.autopilot.get(account.id) });
});

web.put("/api/autopilot", async (c) => {
  const input = await body(c);
  const account = ownAccount(c, input.accountId);
  const times = [...new Set((Array.isArray(input.times) ? input.times : []).map(String))]
    .filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))
    .sort()
    .slice(0, 6);
  if (input.enabled && times.length === 0) throw new HttpError(400, "Isi minimal satu jam posting.");
  const autopilot = await c.get("app").store.autopilot.set(account.id, {
    enabled: Boolean(input.enabled),
    times,
    tone: Object.hasOwn(TONES, input.tone) ? input.tone : "santai",
    postCount: clampCount(input.postCount),
    disclosure: input.disclosure !== false,
    lastError: null,
  });
  return c.json({ autopilot });
});

web.post("/api/autopilot/run", async (c) => {
  const account = ownAccount(c, (await body(c)).accountId);
  try {
    return c.json({ thread: await runAutopilot(c.get("app"), account.id) });
  } catch (err) {
    if (err instanceof AiError) throw err;
    throw new HttpError(400, err.message);
  }
});

web.notFound((c) => c.json({ error: "Tidak ditemukan." }, 404));

web.onError((err, c) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  return c.json({ error: err.message || "Terjadi kesalahan di server." }, status);
});

export default {
  fetch: web.fetch,
  async scheduled(controller, env) {
    await tick(await createContext(env), controller.scheduledTime);
  },
};
