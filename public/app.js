// Utasin — antarmuka satu halaman tanpa framework.
const root = document.getElementById("app");
const toastEl = document.getElementById("toast");

const TONE_LABELS = {
  santai: "Santai, seperti cerita ke teman",
  storytelling: "Storytelling",
  edukatif: "Edukatif (tips dulu, produk belakangan)",
  review: "Review jujur",
  listicle: "Listicle bernomor",
};
const STATUS_LABELS = {
  scheduled: "Terjadwal",
  publishing: "Sedang diposting",
  published: "Terbit",
  failed: "Gagal",
};

const state = {
  me: null,
  accountId: null,
  tab: "buat",
  products: [],
  threads: [],
  autopilot: null,
  editingProduct: null, // null | "new" | id
  draft: newDraft(),
};

function newDraft() {
  return { productId: "", tone: "santai", postCount: 5, angle: "", disclosure: true, posts: [], imageUrl: "", when: "now", scheduledAt: "" };
}

// ---------- util ----------

/** Pembuat elemen kecil: h("div", {class: "x", onclick}, anak...) — teks selalu lewat textContent. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "value") el.value = value;
    else if (key === "checked" || key === "disabled" || key === "selected") el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === false || child == null) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer;
function toast(message, bad = false) {
  toastEl.textContent = message;
  toastEl.className = `show${bad ? " bad" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ""), bad ? 6000 : 2800);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Gagal (${res.status})`);
  return data;
}

/** Jalankan aksi tombol: kunci tombol selama proses, tampilkan error sebagai toast. */
async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

const account = () => state.me.accounts.find((a) => a.id === state.accountId);
const fmtTime = (ms) =>
  new Date(ms).toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function field(label, input, hint) {
  return h("div", {}, h("label", {}, label), input, hint && h("p", { class: "muted small" }, hint));
}

function avatar(acc) {
  return acc.picture
    ? h("img", { class: "avatar", src: acc.picture, alt: "" })
    : h("span", { class: "avatar" }, acc.username[0].toUpperCase());
}

// ---------- data ----------

async function loadAccountData() {
  const q = `?accountId=${encodeURIComponent(state.accountId)}`;
  const [p, t, a] = await Promise.all([
    api("GET", `/api/products${q}`),
    api("GET", `/api/threads${q}`),
    api("GET", `/api/autopilot${q}`),
  ]);
  state.products = p.products;
  state.threads = t.threads;
  state.autopilot = a.autopilot;
}

async function refreshThreads() {
  const { threads } = await api("GET", `/api/threads?accountId=${encodeURIComponent(state.accountId)}`);
  const changed = JSON.stringify(threads) !== JSON.stringify(state.threads);
  state.threads = threads;
  if (changed && state.tab === "riwayat") render();
}

// Pantau status selagi ada utas yang berjalan atau menunggu jadwal.
setInterval(() => {
  if (!state.accountId || document.hidden) return;
  if (state.threads.some((t) => t.status === "publishing" || t.status === "scheduled") || state.tab === "riwayat") {
    refreshThreads().catch(() => {});
  }
}, 4000);

async function switchAccount(id) {
  state.accountId = id;
  localStorage.setItem("utasin_account", id);
  state.draft = newDraft();
  state.editingProduct = null;
  await loadAccountData();
  render();
}

// ---------- login ----------

function renderLogin(error) {
  const demoBtn = h("button", { class: "btn big", onclick: (e) => busy(e.target, "Masuk…", loginDemo) }, "Coba mode demo");
  root.replaceChildren(
    h("main", { class: "login" },
      h("div", { class: "login-box" },
        h("h1", {}, "Utas", h("span", {}, "in")),
        h("p", { class: "lead" }, "Utas Threads untuk jualan affiliate, ditulis Claude dan diposting otomatis."),
        error && h("p", { class: "notice bad", style: "margin-bottom:14px" }, error),
        state.me.threadsConfigured
          ? h("a", { class: "btn primary big", href: "/auth/threads/login", style: "display:block;text-decoration:none" }, "Masuk dengan Threads")
          : h("p", { class: "notice warn", style: "margin-bottom:14px;text-align:left" },
              "Threads API belum diisi di server (THREADS_APP_ID & THREADS_APP_SECRET di .env). Sementara ini kamu bisa mencoba mode demo — posting hanya disimulasikan."),
        state.me.demoMode && demoBtn,
        h("ol", { class: "steps" },
          h("li", {}, h("b", {}, "Masuk sekali klik. "), "Tanpa password — cukup izinkan lewat akun Threads kamu."),
          h("li", {}, h("b", {}, "Masukkan produk & link affiliate. "), "Claude menulis utasnya, kamu tinggal edit."),
          h("li", {}, h("b", {}, "Posting, jadwalkan, atau Autopilot. "), "Utas tersambung otomatis post demi post."),
        ),
      ),
    ),
  );
}

async function loginDemo() {
  const { account: acc } = await api("POST", "/auth/demo");
  state.me = await api("GET", "/api/me");
  await switchAccount(acc.id);
}

// ---------- kerangka ----------

function render() {
  if (!state.me.accounts.length) return renderLogin();
  const acc = account();
  const tabs = [["buat", "Buat Utas"], ["produk", "Produk"], ["riwayat", "Jadwal & Riwayat"], ["autopilot", "Autopilot"]];
  const views = { buat: viewCompose, produk: viewProducts, riwayat: viewHistory, autopilot: viewAutopilot };

  root.replaceChildren(
    h("div", { class: "shell" },
      h("header", { class: "topbar" },
        h("div", { class: "brand" }, "Utas", h("span", {}, "in")),
        avatar(acc),
        h("select", { class: "account-select", "aria-label": "Akun aktif", onchange: (e) => onAccountMenu(e.target.value) },
          state.me.accounts.map((a) => h("option", { value: a.id, selected: a.id === acc.id }, `@${a.username}`)),
          state.me.threadsConfigured && h("option", { value: "+add" }, "+ Hubungkan akun lain"),
          h("option", { value: "-logout" }, "Keluar dari akun ini"),
          h("option", { value: "-disconnect" }, "Putuskan & hapus data akun ini"),
        ),
      ),
      acc.demo && h("p", { class: "notice warn", style: "margin-bottom:14px" },
        "Mode demo: posting hanya disimulasikan, tidak ada yang benar-benar terbit di Threads."),
      h("nav", { class: "tabs", role: "tablist" },
        tabs.map(([id, label]) =>
          h("button", { class: "tab", role: "tab", "aria-selected": String(state.tab === id), onclick: () => { state.tab = id; render(); } }, label)),
      ),
      views[state.tab](),
    ),
  );
}

async function onAccountMenu(value) {
  try {
    if (value === "+add") return void (location.href = "/auth/threads/login");
    if (value === "-logout" || value === "-disconnect") {
      const disconnect = value === "-disconnect";
      if (disconnect && !confirm(`Putuskan @${account().username}? Token, produk, jadwal, dan riwayat akun ini akan dihapus.`)) return render();
      await api("POST", "/auth/logout", { accountId: state.accountId, disconnect });
      state.me = await api("GET", "/api/me");
      if (state.me.accounts.length) return switchAccount(state.me.accounts[0].id);
      state.accountId = null;
      return render();
    }
    await switchAccount(value);
  } catch (err) {
    toast(err.message, true);
    render();
  }
}

// ---------- Buat Utas ----------

function viewCompose() {
  const d = state.draft;
  if (!state.products.length) {
    return h("div", { class: "card empty" },
      h("p", { style: "margin-bottom:12px" }, "Tambahkan dulu produk affiliate yang mau kamu promosikan."),
      h("button", { class: "btn primary", onclick: () => { state.tab = "produk"; state.editingProduct = "new"; render(); } }, "Tambah produk"));
  }
  if (!state.products.some((p) => p.id === d.productId)) d.productId = state.products[0].id;

  const generateBtn = h("button", { class: "btn primary" }, d.posts.length ? "Tulis ulang" : "Tulis utas dengan Claude");
  generateBtn.addEventListener("click", () =>
    busy(generateBtn, "Claude sedang menulis…", async () => {
      if (d.posts.length && !confirm("Utas yang sekarang akan diganti. Lanjut?")) return;
      const { posts } = await api("POST", "/api/generate", {
        productId: d.productId, tone: d.tone, postCount: d.postCount, angle: d.angle, disclosure: d.disclosure,
      });
      d.posts = posts;
      d.imageUrl ||= state.products.find((p) => p.id === d.productId)?.imageUrl || "";
      render();
    }));

  const settings = h("section", { class: "card stack" },
    h("h2", {}, "1. Mau promosi apa?"),
    h("div", { class: "grid2" },
      field("Produk", h("select", { onchange: (e) => (d.productId = e.target.value) },
        state.products.map((p) => h("option", { value: p.id, selected: p.id === d.productId }, p.name)))),
      field("Gaya tulisan", h("select", { onchange: (e) => (d.tone = e.target.value) },
        state.me.tones.map((t) => h("option", { value: t, selected: t === d.tone }, TONE_LABELS[t] || t)))),
    ),
    h("div", { class: "grid2" },
      field("Jumlah post", h("input", { type: "number", min: 3, max: 12, value: d.postCount, onchange: (e) => (d.postCount = Number(e.target.value)) })),
      field("Arahan tambahan (opsional)", h("input", { type: "text", value: d.angle, placeholder: "mis. fokus ke anak kos, sebut promo gratis ongkir", oninput: (e) => (d.angle = e.target.value) })),
    ),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: d.disclosure, onchange: (e) => (d.disclosure = e.target.checked) }),
      "Cantumkan keterangan affiliate (#affiliate)"),
    h("div", { class: "row" },
      generateBtn,
      !d.posts.length && h("button", { class: "btn ghost", onclick: () => { d.posts = ["", "", ""]; render(); } }, "atau tulis sendiri"),
    ),
  );

  return h("div", {}, settings, d.posts.length ? composeEditor() : null);
}

function composeEditor() {
  const d = state.draft;
  const max = state.me.maxPostLength;

  const postEls = d.posts.map((text, i) => {
    const counter = h("span", { class: `count${text.length > max ? " over" : ""}` }, `${text.length}/${max}`);
    return h("div", { class: "post" },
      h("div", { class: "rail" }, h("span", { class: "num" }, i + 1)),
      h("div", { class: "body" },
        h("textarea", {
          value: text, "aria-label": `Post ${i + 1}`,
          oninput: (e) => {
            d.posts[i] = e.target.value;
            counter.textContent = `${e.target.value.length}/${max}`;
            counter.classList.toggle("over", e.target.value.length > max);
          },
        }),
        h("div", { class: "meta" },
          counter,
          h("button", { class: "btn ghost danger small", disabled: d.posts.length <= 1, onclick: () => { d.posts.splice(i, 1); render(); } }, "Hapus"),
        ),
      ),
    );
  });

  const submitBtn = h("button", { class: "btn primary big" }, d.when === "now" ? "Posting sekarang" : "Jadwalkan");
  submitBtn.addEventListener("click", () =>
    busy(submitBtn, "Menyimpan…", async () => {
      if (d.when === "later" && !d.scheduledAt) throw new Error("Pilih tanggal dan jam jadwalnya dulu.");
      await api("POST", "/api/threads", {
        accountId: state.accountId,
        productId: d.productId,
        posts: d.posts,
        imageUrl: d.imageUrl,
        scheduledAt: d.when === "later" ? new Date(d.scheduledAt).toISOString() : null,
      });
      toast(d.when === "now" ? "Utas sedang diposting…" : "Utas dijadwalkan.");
      state.draft = newDraft();
      state.tab = "riwayat";
      await refreshThreads();
      render();
    }));

  const radio = (value, label) =>
    h("label", { class: "check" },
      h("input", { type: "radio", name: "when", checked: d.when === value, onchange: () => { d.when = value; render(); } }), label);

  return h("section", { class: "card" },
    h("div", { class: "spread", style: "margin-bottom:14px" },
      h("h2", {}, "2. Periksa & edit"),
      h("span", { class: "muted small" }, `${d.posts.length} post · sebagai @${account().username}`)),
    postEls,
    h("button", { class: "btn", style: "margin-left:40px", onclick: () => { d.posts.push(""); render(); } }, "+ Tambah post"),
    h("hr", { style: "border:0;border-top:1px solid var(--line);margin:18px 0" }),
    h("div", { class: "stack" },
      h("h2", {}, "3. Terbitkan"),
      field("Gambar untuk post pertama (opsional)",
        h("input", { type: "url", value: d.imageUrl, placeholder: "https://…/foto-produk.jpg", oninput: (e) => (d.imageUrl = e.target.value) }),
        "Harus URL gambar publik (JPG/PNG) yang bisa diakses Threads."),
      h("div", { class: "row" }, radio("now", "Sekarang"), radio("later", "Jadwalkan")),
      d.when === "later" && h("input", { type: "datetime-local", style: "max-width:260px", value: d.scheduledAt, onchange: (e) => (d.scheduledAt = e.target.value) }),
      h("div", {}, submitBtn),
    ),
  );
}

// ---------- Produk ----------

function viewProducts() {
  if (state.editingProduct) return productForm();
  return h("div", {},
    h("div", { class: "spread", style: "margin-bottom:14px" },
      h("h2", {}, "Produk affiliate"),
      h("button", { class: "btn primary", onclick: () => { state.editingProduct = "new"; render(); } }, "+ Tambah produk")),
    state.products.length
      ? state.products.map((p) =>
          h("div", { class: "card" },
            h("div", { class: "spread" },
              h("h3", {}, p.name, " ", p.active === false && h("span", { class: "badge off" }, "Nonaktif")),
              h("div", { class: "row" },
                h("button", { class: "btn", onclick: () => { state.draft = { ...newDraft(), productId: p.id }; state.tab = "buat"; render(); } }, "Buat utas"),
                h("button", { class: "btn ghost", onclick: () => { state.editingProduct = p.id; render(); } }, "Edit"))),
            p.price && h("p", { class: "muted small" }, p.price),
            h("p", { class: "small", style: "overflow-wrap:anywhere" }, h("a", { href: p.link, target: "_blank", rel: "noopener nofollow" }, p.link)),
            p.description && h("p", { class: "muted small clamp", style: "margin-top:6px" }, p.description)))
      : h("div", { class: "card empty" }, "Belum ada produk. Tambahkan produk pertama kamu."),
  );
}

function productForm() {
  const existing = state.products.find((p) => p.id === state.editingProduct);
  const p = { name: "", link: "", price: "", description: "", audience: "", imageUrl: "", active: true, ...existing };
  const bind = (key) => ({ value: p[key], oninput: (e) => (p[key] = e.target.value) });
  const close = () => { state.editingProduct = null; render(); };

  const saveBtn = h("button", { class: "btn primary" }, "Simpan");
  saveBtn.addEventListener("click", () =>
    busy(saveBtn, "Menyimpan…", async () => {
      if (existing) await api("PUT", `/api/products/${existing.id}`, p);
      else await api("POST", "/api/products", { ...p, accountId: state.accountId });
      await loadAccountData();
      toast("Produk disimpan.");
      close();
    }));

  return h("section", { class: "card stack" },
    h("h2", {}, existing ? "Edit produk" : "Produk baru"),
    field("Nama produk", h("input", { type: "text", placeholder: "mis. Rak Sepatu Lipat 5 Susun", ...bind("name") })),
    field("Link affiliate", h("input", { type: "url", placeholder: "https://s.shopee.co.id/…", ...bind("link") })),
    h("div", { class: "grid2" },
      field("Harga (opsional)", h("input", { type: "text", placeholder: "mis. Rp89.000", ...bind("price") })),
      field("Target pembaca (opsional)", h("input", { type: "text", placeholder: "mis. anak kos, ibu muda", ...bind("audience") }))),
    field("Deskripsi & keunggulan", h("textarea", { rows: 5, placeholder: "Tempel deskripsi dari marketplace, atau tulis poin keunggulannya.", ...bind("description") }),
      "Claude hanya memakai fakta yang kamu tulis di sini, jadi makin lengkap makin bagus utasnya."),
    field("URL gambar produk (opsional)", h("input", { type: "url", placeholder: "https://…", ...bind("imageUrl") })),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: p.active, onchange: (e) => (p.active = e.target.checked) }), "Ikutkan di Autopilot"),
    h("div", { class: "spread" },
      h("div", { class: "row" }, saveBtn, h("button", { class: "btn", onclick: close }, "Batal")),
      existing && h("button", { class: "btn ghost danger", onclick: async () => {
        if (!confirm(`Hapus produk "${existing.name}"?`)) return;
        try { await api("DELETE", `/api/products/${existing.id}`); await loadAccountData(); close(); }
        catch (err) { toast(err.message, true); }
      } }, "Hapus produk")),
  );
}

// ---------- Jadwal & Riwayat ----------

function viewHistory() {
  if (!state.threads.length) return h("div", { class: "card empty" }, "Belum ada utas. Buat utas pertamamu di tab Buat Utas.");
  return h("div", {}, state.threads.map(threadCard));
}

function threadCard(t) {
  const link = t.results[0]?.permalink;
  const when =
    t.status === "scheduled" ? `untuk ${fmtTime(t.scheduledAt)}`
    : t.status === "published" ? fmtTime(t.publishedAt)
    : t.status === "publishing" ? `${t.results.length}/${t.posts.length} post`
    : `berhenti di post ${t.results.length + 1} dari ${t.posts.length}`;

  const act = (label, fn, cls = "btn ghost") => {
    const btn = h("button", { class: cls }, label);
    btn.addEventListener("click", () => busy(btn, "…", async () => { await fn(); await refreshThreads(); render(); }));
    return btn;
  };

  return h("article", { class: "card" },
    h("div", { class: "spread", style: "margin-bottom:8px" },
      h("div", { class: "row" },
        h("span", { class: `badge ${t.status}` }, STATUS_LABELS[t.status]),
        h("span", { class: "muted small" }, when),
        t.source === "autopilot" && h("span", { class: "badge off" }, "Autopilot")),
      h("div", { class: "row" },
        link && h("a", { class: "btn ghost", href: link, target: "_blank", rel: "noopener" }, "Lihat di Threads"),
        t.status === "failed" && act("Lanjutkan", () => api("POST", `/api/threads/${t.id}/retry`), "btn"),
        t.status !== "publishing" && act(t.status === "scheduled" ? "Batalkan" : "Hapus dari riwayat", async () => {
          if (confirm(t.status === "scheduled" ? "Batalkan jadwal utas ini?" : "Hapus dari riwayat? (Post yang sudah terbit di Threads tidak ikut terhapus.)")) {
            await api("DELETE", `/api/threads/${t.id}`);
          }
        }, "btn ghost danger"))),
    t.error && h("p", { class: "notice bad", style: "margin-bottom:8px" }, t.error),
    t.productName && h("p", { class: "muted small" }, t.productName),
    h("p", { class: "preview clamp" }, t.posts[0]),
    h("details", { style: "margin-top:8px" },
      h("summary", { class: "muted small", style: "cursor:pointer" }, `Lihat semua ${t.posts.length} post`),
      t.posts.map((text, i) => h("p", { class: "preview small", style: "margin-top:10px;padding-left:12px;border-left:2px solid var(--line)" }, `${i + 1}. ${text}`))),
  );
}

// ---------- Autopilot ----------

function viewAutopilot() {
  const a = state.autopilot;
  const active = state.products.filter((p) => p.active !== false).length;

  const saveBtn = h("button", { class: "btn primary" }, "Simpan pengaturan");
  saveBtn.addEventListener("click", () =>
    busy(saveBtn, "Menyimpan…", async () => {
      const { autopilot } = await api("PUT", "/api/autopilot", { ...a, accountId: state.accountId });
      state.autopilot = autopilot;
      toast(autopilot.enabled ? "Autopilot aktif." : "Pengaturan disimpan.");
      render();
    }));

  const runBtn = h("button", { class: "btn" }, "Jalankan sekali sekarang");
  runBtn.addEventListener("click", () =>
    busy(runBtn, "Claude menulis & memposting…", async () => {
      if (!confirm(`Claude akan menulis satu utas dan langsung mempostingnya ke @${account().username} tanpa kamu periksa dulu. Lanjut?`)) return;
      await api("POST", "/api/autopilot/run", { accountId: state.accountId });
      await loadAccountData();
      state.tab = "riwayat";
      render();
    }));

  return h("section", { class: "card stack" },
    h("div", { class: "spread" },
      h("h2", {}, "Autopilot"),
      h("span", { class: `badge ${a.enabled ? "published" : "off"}` }, a.enabled ? "Aktif" : "Mati")),
    h("p", { class: "muted" },
      "Pada jam yang kamu tentukan, Claude menulis utas baru untuk produk yang paling lama belum dipromosikan, lalu langsung mempostingnya. ",
      "Utas terbit tanpa kamu periksa dulu — pastikan deskripsi produkmu akurat."),
    active === 0 && h("p", { class: "notice warn" }, "Belum ada produk aktif. Tambahkan produk dulu supaya Autopilot punya bahan."),
    a.lastError && h("p", { class: "notice bad" }, `Autopilot terakhir gagal: ${a.lastError}`),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: a.enabled, onchange: (e) => (a.enabled = e.target.checked) }), "Aktifkan Autopilot untuk akun ini"),
    h("div", {},
      h("label", {}, `Jam posting setiap hari (${state.me.timezone})`),
      h("div", { class: "times" },
        a.times.map((time, i) =>
          h("span", { class: "slot" },
            h("input", { type: "time", value: time, "aria-label": `Jam posting ${i + 1}`, onchange: (e) => (a.times[i] = e.target.value) }),
            h("button", { class: "btn ghost danger", "aria-label": "Hapus jam", onclick: () => { a.times.splice(i, 1); render(); } }, "×"))),
        a.times.length < 6 && h("button", { class: "btn", onclick: () => { a.times.push("12:00"); render(); } }, "+ Jam"))),
    h("div", { class: "grid2" },
      field("Gaya tulisan", h("select", { onchange: (e) => (a.tone = e.target.value) },
        state.me.tones.map((t) => h("option", { value: t, selected: t === a.tone }, TONE_LABELS[t] || t)))),
      field("Jumlah post per utas", h("input", { type: "number", min: 3, max: 12, value: a.postCount, onchange: (e) => (a.postCount = Number(e.target.value)) }))),
    h("label", { class: "check" },
      h("input", { type: "checkbox", checked: a.disclosure, onchange: (e) => (a.disclosure = e.target.checked) }),
      "Cantumkan keterangan affiliate (#affiliate)"),
    h("div", { class: "row" }, saveBtn, active > 0 && runBtn),
  );
}

// ---------- mulai ----------

(async function start() {
  try {
    state.me = await api("GET", "/api/me");
    const params = new URLSearchParams(location.search);
    const error = params.get("error");
    const wanted = params.get("account") || localStorage.getItem("utasin_account");
    if (params.size) history.replaceState(null, "", "/");
    if (!state.me.accounts.length) return renderLogin(error);
    const pick = state.me.accounts.find((a) => a.id === wanted) || state.me.accounts[0];
    await switchAccount(pick.id);
    if (error) toast(error, true);
  } catch (err) {
    root.replaceChildren(h("p", { class: "empty" }, `Gagal memuat aplikasi: ${err.message}`));
  }
})();
