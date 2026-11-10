// Tanda tangan cookie dan enkripsi token, memakai WebCrypto (tersedia di Workers).
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

export const randomHex = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Kemas nilai JSON menjadi "payload.tandatangan". */
export async function seal(secret, value) {
  const payload = b64(enc.encode(JSON.stringify(value)));
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return `${payload}.${b64(mac)}`;
}

/** Kebalikan `seal`; mengembalikan null bila tanda tangan tidak cocok. */
export async function unseal(secret, raw) {
  const [payload, mac] = String(raw || "").split(".");
  if (!payload || !mac) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), unb64(mac), enc.encode(payload));
    return ok ? JSON.parse(dec.decode(unb64(payload))) : null;
  } catch {
    return null;
  }
}

async function aesKey(secret) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`token:${secret}`));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(text));
  return `${b64(iv)}.${b64(body)}`;
}

export async function decrypt(secret, packed) {
  const [iv, body] = packed.split(".").map(unb64);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aesKey(secret), body));
}
