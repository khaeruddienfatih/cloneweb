// Menerbitkan utas, menjalankan jadwal, dan Autopilot. Dipanggil oleh Cron Trigger tiap menit.
import { publishPost, refreshExpiringTokens } from "./threadsApi.js";
import { generateThread } from "./ai.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Terbitkan utas post demi post; tiap post membalas post sebelumnya.
 * Pemanggil harus sudah menandai utas sebagai "publishing" (lihat threads.claim).
 * Aman dilanjutkan: post yang sudah terbit (ada di `results`) tidak diulang.
 */
export async function publishThread(app, thread) {
  const { store } = app;
  try {
    const account = await store.accounts.get(thread.accountId);
    if (!account) throw new Error("Akun sudah tidak terhubung.");
    for (let i = thread.results.length; i < thread.posts.length; i++) {
      const result = await publishPost(app, account, {
        text: thread.posts[i],
        imageUrl: i === 0 ? thread.imageUrl : undefined,
        replyToId: i > 0 ? thread.results[i - 1].id : undefined,
      });
      thread.results.push(result);
      await store.threads.save(thread);
      if (i < thread.posts.length - 1) await sleep(account.demo ? 200 : 4000);
    }
    thread.status = "published";
    thread.publishedAt = Date.now();
  } catch (err) {
    thread.status = "failed";
    thread.error = err.message;
    console.error(`[publish] utas ${thread.id} gagal: ${err.message}`);
  }
  await store.threads.save(thread);
  return thread;
}

/** Jam dinding saat ini di zona waktu aplikasi. */
function localNow(timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
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
export async function runAutopilot(app, accountId) {
  const { store } = app;
  const settings = await store.autopilot.get(accountId);
  const candidates = (await store.products.list(accountId)).filter((p) => p.active !== false);
  if (candidates.length === 0) throw new Error("Belum ada produk aktif untuk Autopilot.");
  const product = candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];

  const posts = await generateThread(app, product, {
    postCount: settings.postCount,
    tone: settings.tone,
    disclosure: settings.disclosure,
    avoid: await store.threads.recentHooks(accountId, product.id),
  });
  await store.products.update(product.id, { lastUsedAt: Date.now() });
  const thread = await store.threads.create({
    accountId,
    productId: product.id,
    productName: product.name,
    posts,
    imageUrl: product.imageUrl || "",
    scheduledAt: null,
    status: "publishing",
    source: "autopilot",
  });
  return publishThread(app, thread);
}

async function runAutopilotSlots(app) {
  const { store } = app;
  const local = localNow(app.timezone);
  for (const accountId of await store.autopilot.enabledAccountIds()) {
    const settings = await store.autopilot.get(accountId);
    for (const time of settings.times) {
      const [h, m] = time.split(":").map(Number);
      const late = local.minutes - (h * 60 + m);
      const key = `${local.date} ${time}`;
      // Slot hari ini yang jatuh dalam 10 menit terakhir dan belum dijalankan.
      if (late < 0 || late > 10 || settings.ran.includes(key)) continue;
      settings.ran = [...settings.ran, key].slice(-30);
      await store.autopilot.set(accountId, { ran: settings.ran }); // tandai dulu, supaya tick berikutnya tidak mengulang
      try {
        await runAutopilot(app, accountId);
      } catch (err) {
        console.error(`[autopilot] ${accountId} ${key}: ${err.message}`);
        await store.autopilot.set(accountId, { lastError: `${key} — ${err.message}` });
      }
    }
  }
}

/** Satu putaran penjadwal. */
export async function tick(app, scheduledTime = Date.now()) {
  const { store } = app;

  // Utas yang tersangkut tidak dilanjutkan otomatis supaya tidak ada post ganda; pengguna menekan "Lanjutkan".
  for (const thread of await store.threads.stuck(Date.now() - STUCK_AFTER_MS)) {
    thread.status = "failed";
    thread.error = "Penerbitan terhenti di tengah jalan. Tekan Lanjutkan untuk meneruskan.";
    await store.threads.save(thread);
  }

  for (const thread of await store.threads.due(Date.now())) {
    if (!(await store.threads.claim(thread.id))) continue; // sudah diambil tick lain
    thread.status = "publishing";
    thread.error = null;
    await publishThread(app, thread);
  }

  await runAutopilotSlots(app);

  if (new Date(scheduledTime).getUTCMinutes() === 0) await refreshExpiringTokens(app);
}
