// Menerbitkan utas, menjalankan jadwal, dan Autopilot.
import { config } from "./config.js";
import { accounts, autopilot, products, save, threads } from "./store.js";
import { publishPost, refreshExpiringTokens } from "./threadsApi.js";
import { generateThread } from "./ai.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const running = new Set();

/**
 * Terbitkan utas post demi post; tiap post membalas post sebelumnya.
 * Aman dilanjutkan: post yang sudah terbit (ada di `results`) tidak diulang.
 */
export async function publishThread(thread) {
  if (running.has(thread.id)) return;
  running.add(thread.id);
  thread.status = "publishing";
  thread.error = null;
  save();
  try {
    const account = accounts.get(thread.accountId);
    if (!account) throw new Error("Akun sudah tidak terhubung.");
    for (let i = thread.results.length; i < thread.posts.length; i++) {
      const result = await publishPost(account, {
        text: thread.posts[i],
        imageUrl: i === 0 ? thread.imageUrl : undefined,
        replyToId: i > 0 ? thread.results[i - 1].id : undefined,
      });
      thread.results.push(result);
      save();
      if (i < thread.posts.length - 1) await sleep(account.demo ? 200 : 4000);
    }
    thread.status = "published";
    thread.publishedAt = Date.now();
  } catch (err) {
    thread.status = "failed";
    thread.error = err.message;
    console.error(`[publish] utas ${thread.id} gagal: ${err.message}`);
  } finally {
    running.delete(thread.id);
    save();
  }
}

/** Jam dinding saat ini di zona waktu aplikasi. */
function localNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: config.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Buat dan terbitkan satu utas otomatis untuk produk yang paling lama tidak dipromosikan. */
export async function runAutopilot(accountId) {
  const settings = autopilot.get(accountId);
  const candidates = products.list(accountId).filter((p) => p.active !== false);
  if (candidates.length === 0) throw new Error("Belum ada produk aktif untuk Autopilot.");
  const product = candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];

  const avoid = threads
    .list(accountId)
    .filter((t) => t.productId === product.id)
    .slice(0, 5)
    .map((t) => t.posts[0]);

  const posts = await generateThread(product, {
    postCount: settings.postCount,
    tone: settings.tone,
    disclosure: settings.disclosure,
    avoid,
  });
  products.update(product.id, { lastUsedAt: Date.now() });
  const thread = threads.create({
    accountId,
    productId: product.id,
    productName: product.name,
    posts,
    imageUrl: product.imageUrl || "",
    scheduledAt: null,
    status: "publishing",
    source: "autopilot",
  });
  await publishThread(thread);
  return thread;
}

async function tick() {
  const now = Date.now();

  // 1) Utas terjadwal yang sudah waktunya
  for (const thread of threads.all()) {
    if (thread.status === "scheduled" && thread.scheduledAt <= now) {
      publishThread(thread); // sengaja tidak di-await: tiap utas jalan sendiri
    }
  }

  // 2) Autopilot: slot hari ini yang jatuh dalam 10 menit terakhir dan belum dijalankan
  const local = localNow();
  for (const account of accounts.all()) {
    const settings = autopilot.get(account.id);
    if (!settings.enabled) continue;
    for (const time of settings.times) {
      const [h, m] = time.split(":").map(Number);
      const late = local.minutes - (h * 60 + m);
      const key = `${local.date} ${time}`;
      if (late < 0 || late > 10 || settings.ran.includes(key)) continue;
      autopilot.set(account.id, { ran: [...settings.ran, key].slice(-30) });
      runAutopilot(account.id).catch((err) => {
        console.error(`[autopilot] @${account.username} ${key}: ${err.message}`);
        autopilot.set(account.id, { lastError: `${key} — ${err.message}` });
      });
    }
  }
}

export function startScheduler() {
  // Utas yang masih "publishing" saat server mati tidak dilanjutkan otomatis,
  // supaya tidak ada post ganda. Pengguna bisa menekan "Lanjutkan".
  for (const thread of threads.all()) {
    if (thread.status === "publishing") {
      thread.status = "failed";
      thread.error = "Server berhenti saat utas sedang diterbitkan. Tekan Lanjutkan untuk meneruskan.";
    }
  }
  save();

  const safeTick = () => tick().catch((err) => console.error("[scheduler]", err));
  setInterval(safeTick, 30_000);
  safeTick();

  const refresh = () => refreshExpiringTokens().catch((err) => console.error("[token]", err));
  setInterval(refresh, 12 * 3_600_000);
  refresh();
}
