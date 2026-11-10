// Penulis utas: Claude mengubah data produk menjadi utas Threads siap posting.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { MAX_POST_LENGTH } from "./threadsApi.js";


const ThreadSchema = z.object({
  posts: z.array(z.string()).describe("Isi tiap post, berurutan dari post pembuka sampai penutup"),
});

export const TONES = {
  santai: "santai dan akrab seperti cerita ke teman, boleh pakai kata sehari-hari (gue/aku sesuai konteks)",
  storytelling: "storytelling: berangkat dari masalah atau pengalaman yang relate, baru mengalir ke produk",
  edukatif: "edukatif: beri tips atau wawasan yang berguna dulu, produk muncul sebagai solusi",
  review: "review jujur: bahas kelebihan dan kekurangan secara berimbang",
  listicle: "listicle: poin-poin bernomor yang ringkas dan gampang dipindai",
};

const SYSTEM = `Kamu copywriter Indonesia yang ahli menulis utas (thread) di Threads untuk jualan affiliate.

Tujuanmu: utas yang enak dibaca sampai habis dan membuat orang penasaran mengklik link, tanpa terasa seperti iklan.

Cara menulis:
- Post pertama adalah hook. Harus bikin orang berhenti scroll dan membuka utasnya. Jangan sebut nama produk atau link di sini.
- Tiap post satu ide, mengalir ke post berikutnya. Kalimat pendek, bahasa Indonesia yang natural seperti orang sungguhan menulis.
- Post terakhir berisi ajakan yang jelas dan link affiliate.
- Maksimal 450 karakter per post, termasuk link. Teks polos saja: Threads tidak merender markdown, jadi jangan pakai tanda bintang, pagar judul, atau bullet markdown. Emoji boleh, secukupnya.
- Jangan menomori post ("1/5" dan sejenisnya) kecuali gayanya listicle.

Kejujuran (wajib, karena akun penjual bisa kena sanksi dan pembaca bisa dirugikan):
- Pakai hanya fakta yang ada di data produk. Jangan mengarang harga, diskon, stok, testimoni, angka penjualan, atau klaim kesehatan.
- Kalau data produknya tipis, tulis dari sudut manfaat dan situasi pemakaian, bukan klaim spesifik yang tidak kamu ketahui.
- Jangan membuat urgensi palsu ("tinggal 3 lagi!") bila tidak ada di data.
- Tulis link affiliate persis seperti yang diberikan, jangan diubah atau dipendekkan.`;

function buildPrompt(product, opts) {
  const lines = [
    `Tulis utas Threads sebanyak ${opts.postCount} post untuk produk ini.`,
    "",
    `Nama produk: ${product.name}`,
    product.price ? `Harga: ${product.price}` : null,
    product.description ? `Deskripsi dan keunggulan:\n${product.description}` : null,
    product.audience ? `Target pembaca: ${product.audience}` : null,
    `Link affiliate: ${product.link}`,
    "",
    `Gaya: ${TONES[opts.tone] || TONES.santai}.`,
    opts.disclosure
      ? "Sertakan keterangan affiliate yang singkat dan wajar di post terakhir (misalnya tagar #affiliate), supaya pembaca tahu ini link affiliate."
      : null,
    opts.angle ? `Arahan tambahan dari pemilik akun: ${opts.angle}` : null,
    opts.avoid?.length
      ? `Hook yang sudah pernah dipakai untuk produk ini, pakai sudut pandang yang berbeda:\n${opts.avoid.map((h) => `- ${h}`).join("\n")}`
      : null,
  ];
  return lines.filter((l) => l !== null).join("\n");
}

/** Potong post yang kepanjangan di batas kalimat/kata terdekat. */
function fit(text) {
  const clean = text.replace(/\*\*|__/g, "").trim();
  if (clean.length <= MAX_POST_LENGTH) return clean;
  const cut = clean.slice(0, MAX_POST_LENGTH - 1);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  return `${cut.slice(0, stop > 200 ? stop : cut.length).trimEnd()}…`;
}

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {object} app konteks aplikasi (lihat context.js)
 * @param {{name: string, link: string, price?: string, description?: string, audience?: string}} product
 * @param {{postCount: number, tone: string, disclosure: boolean, angle?: string, avoid?: string[]}} opts
 * @returns {Promise<string[]>} isi tiap post
 */
export async function generateThread(app, product, opts) {
  if (!app.anthropic.apiKey) {
    throw new AiError("API key Claude belum diisi. Tambahkan secret ANTHROPIC_API_KEY di Cloudflare.", 500);
  }
  const client = new Anthropic(app.anthropic);
  let response;
  try {
    response = await client.beta.messages.parse({
      model: app.model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: buildPrompt(product, opts) }],
      output_config: { effort: "medium", format: betaZodOutputFormat(ThreadSchema) },
      // Bila model utama menolak karena filter keamanan, API otomatis mencoba model cadangan.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new AiError("API key Claude tidak valid. Periksa secret ANTHROPIC_API_KEY.", 500);
    }
    if (err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.NotFoundError) {
      throw new AiError(`Model "${app.model}" tidak bisa diakses dengan API key ini.`, 500);
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new AiError("Claude sedang kena rate limit. Coba lagi sebentar lagi.", 429);
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new AiError("Tidak bisa terhubung ke Claude API. Periksa koneksi server.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new AiError(`Claude API error ${err.status}: ${err.message}`);
    }
    throw new AiError(`Claude belum bisa dipakai: ${err.message}`, 500);
  }

  if (response.stop_reason === "refusal") {
    throw new AiError("Claude menolak menulis utas untuk produk ini. Coba ubah deskripsi produknya.", 422);
  }
  if (response.stop_reason === "max_tokens" || !response.parsed_output) {
    throw new AiError("Jawaban Claude terpotong atau tidak terbaca. Coba generate ulang.");
  }

  const posts = response.parsed_output.posts.map(fit).filter(Boolean);
  if (posts.length === 0) throw new AiError("Claude tidak menghasilkan post. Coba generate ulang.");

  // Jaminan terakhir: link affiliate harus ada di utas.
  if (!posts.some((p) => p.includes(product.link))) {
    const last = posts.length - 1;
    const joined = `${posts[last]}\n\n${product.link}`;
    if (joined.length <= MAX_POST_LENGTH) posts[last] = joined;
    else posts.push(`Link-nya di sini 👇\n${product.link}`);
  }
  return posts;
}
