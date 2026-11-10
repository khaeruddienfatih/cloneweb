// Klien tipis untuk Threads API resmi (https://developers.facebook.com/docs/threads).
import { decrypt, encrypt, randomHex } from "./security.js";

const GRAPH = "https://graph.threads.net";
const API = `${GRAPH}/v1.0`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const MAX_POST_LENGTH = 500;

async function call(url, { method = "GET", params = {} } = {}) {
  const target = new URL(url);
  let body;
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  } else {
    body = new URLSearchParams(params);
  }
  const res = await fetch(target, { method, body, signal: AbortSignal.timeout(30_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const message =
      data.error?.error_user_msg || data.error?.message || data.error_message || `HTTP ${res.status}`;
    throw new Error(`Threads API: ${message}`);
  }
  return data;
}

// ---------- OAuth ("Masuk dengan Threads") ----------

export function authorizeUrl(app, redirectUri, state) {
  const url = new URL("https://threads.net/oauth/authorize");
  url.searchParams.set("client_id", app.threads.appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", app.threads.scopes);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Tukar `code` dari callback menjadi akun tersimpan dengan token jangka panjang (60 hari). */
export async function connectAccount(app, redirectUri, code) {
  const short = await call(`${GRAPH}/oauth/access_token`, {
    method: "POST",
    params: {
      client_id: app.threads.appId,
      client_secret: app.threads.appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    },
  });
  const long = await call(`${GRAPH}/access_token`, {
    params: {
      grant_type: "th_exchange_token",
      client_secret: app.threads.appSecret,
      access_token: short.access_token,
    },
  });
  const me = await call(`${API}/me`, {
    params: { fields: "id,username,name,threads_profile_picture_url", access_token: long.access_token },
  });
  return app.store.accounts.upsert({
    id: String(me.id),
    username: me.username,
    name: me.name || me.username,
    picture: me.threads_profile_picture_url || "",
    token: await encrypt(app.secret, long.access_token),
    tokenExpiresAt: Date.now() + (long.expires_in || 5_184_000) * 1000,
    demo: false,
  });
}

/** Perpanjang token yang akan habis dalam 7 hari. */
export async function refreshExpiringTokens(app) {
  const soon = Date.now() + 7 * 86_400_000;
  for (const account of await app.store.accounts.all()) {
    if (account.demo || account.tokenExpiresAt > soon) continue;
    try {
      const data = await call(`${GRAPH}/refresh_access_token`, {
        params: { grant_type: "th_refresh_token", access_token: await decrypt(app.secret, account.token) },
      });
      await app.store.accounts.upsert({
        id: account.id,
        token: await encrypt(app.secret, data.access_token),
        tokenExpiresAt: Date.now() + data.expires_in * 1000,
      });
    } catch (err) {
      console.error(`[token] gagal memperpanjang @${account.username}: ${err.message}`);
    }
  }
}

// ---------- Publikasi ----------

/** Terbitkan satu post. `replyToId` menyambungkannya menjadi utas. Mengembalikan { id, permalink }. */
export async function publishPost(app, account, { text, imageUrl, replyToId }) {
  if (account.demo) {
    await sleep(400);
    return { id: `demo_${randomHex(5)}`, permalink: "" };
  }
  const token = await decrypt(app.secret, account.token);
  const params = { media_type: imageUrl ? "IMAGE" : "TEXT", text, access_token: token };
  if (imageUrl) params.image_url = imageUrl;
  if (replyToId) params.reply_to_id = replyToId;

  const container = await call(`${API}/${account.id}/threads`, { method: "POST", params });
  // Threads butuh waktu memproses kontainer sebelum bisa diterbitkan (lebih lama untuk gambar).
  await sleep(imageUrl ? 8000 : 2000);
  const published = await call(`${API}/${account.id}/threads_publish`, {
    method: "POST",
    params: { creation_id: container.id, access_token: token },
  });
  let permalink = "";
  if (replyToId) return { id: published.id, permalink }; // permalink cukup untuk post pembuka
  try {
    const info = await call(`${API}/${published.id}`, {
      params: { fields: "permalink", access_token: token },
    });
    permalink = info.permalink || "";
  } catch {
    // permalink hanya pelengkap
  }
  return { id: published.id, permalink };
}
