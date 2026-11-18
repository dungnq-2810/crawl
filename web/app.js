/* Viral Radar — giao diện web (vanilla JS, không cần build) */
"use strict";

// ============================================================ helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NF_C = new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 });
const NF = new Intl.NumberFormat("vi-VN");
const NF_1 = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const PCT = new Intl.NumberFormat("vi-VN", { style: "percent", maximumFractionDigits: 1 });
const RTF = new Intl.RelativeTimeFormat("vi", { numeric: "auto" });
const DTF = new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" });
const nC = (v) => (v == null ? "–" : NF_C.format(v));
const nN = (v) => (v == null ? "–" : NF.format(Math.round(v)));
const PCT_FINE = new Intl.NumberFormat("vi-VN", { style: "percent", maximumSignificantDigits: 2 });
const pct = (v) => (v == null ? "–" : v > 0 && v < 0.01 ? PCT_FINE.format(v) : PCT.format(v));
const times = (v) => (v == null ? "–" : (v >= 100 ? NF_C.format(Math.round(v)) : NF_1.format(v)) + "×");
const lan = (v) => (v >= 100 ? NF.format(Math.round(v)) : NF_1.format(v)) + " lần";
const icon = (id, cls = "i") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const PLAT = { tiktok: "TikTok", youtube: "Shorts" };
const PLAT_LONG = { tiktok: "TikTok", youtube: "YouTube Shorts" };
const KIND = { search: "Từ khóa", keyword: "Từ khóa", hashtag: "Hashtag", user: "Kênh" };

function ago(tsSec) {
  if (!tsSec) return "chưa có";
  const d = tsSec - Date.now() / 1000;
  const a = Math.abs(d);
  if (a < 60) return "vừa xong";
  if (a < 3600) return RTF.format(Math.round(d / 60), "minute");
  if (a < 86400) return RTF.format(Math.round(d / 3600), "hour");
  return RTF.format(Math.round(d / 86400), "day");
}
function ageText(days) {
  if (days == null) return "";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} giờ trước`;
  if (days < 60) return `${Math.round(days)} ngày trước`;
  return `${Math.round(days / 30)} tháng trước`;
}
function dur(s) { if (!s) return ""; const m = Math.floor(s / 60); return `${m}:${String(Math.round(s % 60)).padStart(2, "0")}`; }
function level(v) { if (v == null) return 0; if (v >= 35) return 4; if (v >= 25) return 3; if (v >= 18) return 2; if (v >= 10) return 1; return 0; }
const TIER = ["Chưa nổi bật", "Tiềm năng", "Mạnh", "Rất mạnh", "Xuất sắc"];
const sig = (l) => `<span class="sig" data-l="${l}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
function profileUrl(v) {
  return v.platform === "youtube"
    ? `https://www.youtube.com/channel/${encodeURIComponent(v.creator_id)}/shorts`
    : `https://www.tiktok.com/@${encodeURIComponent(v.username)}`;
}
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  let data = null;
  try { data = await r.json(); } catch (e) { /* trống */ }
  if (!r.ok) throw new Error((data && data.detail) || `Lỗi ${r.status}`);
  return data;
}
function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } }
function load(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }

// ============================================================ state
const S = {
  videos: [], byId: new Map(), searches: [], watch: [], jobs: [], loaded: false,
  filters: Object.assign({ platform: "all", queries: null, days: 30, minViews: 10000, maxFollowers: 0, hideAds: true, shop: false, text: "", sort: "virality", pivot: null },
    load("vr-filters", {}), { queries: null, pivot: null, text: "" }),
  view: load("vr-view", "grid"), shown: 48, tableSort: { key: "virality", dir: -1 }, groupTab: "product",
  scan: Object.assign({ platform: "tiktok", kind: "search", limit: 60, enrich: 0 }, load("vr-scan", {}), { chips: [] }),
  page: null, drawerVideo: null, lastFocus: null,
};
function saveFilters() { const { queries, pivot, text, ...rest } = S.filters; store("vr-filters", rest); }

async function loadData() {
  const [v, s, w] = await Promise.all([api("/api/videos"), api("/api/searches"), api("/api/watch")]);
  S.videos = v; S.searches = s; S.watch = w; S.loaded = true;
  S.byId = new Map(v.map((x) => [x.id, x]));
  if (S.filters.queries) {
    const keys = new Set(s.map((x) => x.query + "|" + x.platform));
    S.filters.queries = new Set([...S.filters.queries].filter((k) => keys.has(k)));
    if (!S.filters.queries.size) S.filters.queries = null;
  }
  $("#navCount").textContent = v.length ? nC(v.length) : "";
  $("#watchCount").textContent = w.length ? w.length : "";
}

// ============================================================ filtering
function pivotMatch(v, p) {
  if (!p) return true;
  if (p.type === "hashtag") return (v.hashtags || "").toLowerCase().split(/\s+/).includes(p.value.toLowerCase());
  if (p.type === "product") return (v.products || "").split(" | ").includes(p.value);
  if (p.type === "music") return musicKey(v) === p.value;
  if (p.type === "creator") return v.platform + "|" + v.creator_id === p.value;
  return true;
}
function musicKey(v) { return v.music_title ? v.music_title + (v.music_author ? " – " + v.music_author : "") : ""; }
function filtered(opts = {}) {
  const f = S.filters;
  const text = f.text.trim().toLowerCase().replace(/^[@#]/, "");
  const rows = S.videos.filter((v) =>
    (f.platform === "all" || v.platform === f.platform) &&
    (!f.queries || v.queries.some((q) => f.queries.has(q))) &&
    (v.age_days == null || v.age_days <= f.days) &&
    v.views >= f.minViews &&
    (!f.maxFollowers || (v.followers ?? 0) <= f.maxFollowers) &&
    (!f.hideAds || !v.is_ad) &&
    (!f.shop || !!v.products) &&
    (opts.ignorePivot || pivotMatch(v, f.pivot)) &&
    (!text || [v.caption, v.username, v.nickname, v.hashtags, v.products, v.music_title].join(" ").toLowerCase().includes(text)));
  const k = f.sort;
  rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  return rows;
}

// ============================================================ filter bar (dùng chung cho Khám phá + Nhóm theo)
function filterBar() {
  const f = S.filters;
  const nQ = f.queries ? f.queries.size : S.searches.length;
  const pivotLabel = f.pivot ? { hashtag: "#", product: "Sản phẩm: ", music: "Âm thanh: ", creator: "Kênh: " }[f.pivot.type] + (f.pivot.label || f.pivot.value) : "";
  return `<div class="filters" role="group" aria-label="Bộ lọc">
    <div class="seg" role="group" aria-label="Nền tảng">
      ${["all", "tiktok", "youtube"].map((p) => `<button type="button" data-fp="${p}" aria-pressed="${f.platform === p}">${p === "all" ? "Tất cả" : `<i class="pdot ${p}"></i>${PLAT[p]}`}</button>`).join("")}
    </div>
    <div class="drop" id="qDrop">
      <button type="button" class="btn" id="qBtn" aria-haspopup="true" aria-expanded="false" style="height:34px">${f.queries ? `${nQ} / ${S.searches.length} truy vấn` : "Mọi truy vấn"}</button>
      <div class="drop-menu" id="qMenu">
        <div class="row-actions"><button type="button" class="btn sm" data-qa="all">Chọn tất cả</button><button type="button" class="btn sm ghost" data-qa="none">Bỏ chọn</button></div>
        ${S.searches.map((s) => { const key = s.query + "|" + s.platform; const on = !f.queries || f.queries.has(key);
          return `<label><input type="checkbox" value="${esc(key)}" ${on ? "checked" : ""}><i class="pdot ${s.platform}"></i>${esc(s.query)}<span class="meta">${KIND[s.kind] || ""}, ${s.found} video</span></label>`; }).join("") || `<p class="muted" style="padding:10px">Chưa có truy vấn nào.</p>`}
      </div>
    </div>
    <label class="sr-only" for="fDays">Thời gian đăng</label>
    <select class="field" id="fDays">${[[1, "Đăng trong 24 giờ"], [7, "Đăng trong 7 ngày"], [30, "Đăng trong 30 ngày"], [90, "Đăng trong 90 ngày"], [365, "Đăng trong 1 năm"], [100000, "Mọi thời điểm"]].map(([v, t]) => `<option value="${v}" ${f.days == v ? "selected" : ""}>${t}</option>`).join("")}</select>
    <label class="sr-only" for="fMin">Lượt xem tối thiểu</label>
    <select class="field" id="fMin">${[[0, "Mọi lượt xem"], [10000, "Từ 10 N view"], [100000, "Từ 100 N view"], [1000000, "Từ 1 Tr view"]].map(([v, t]) => `<option value="${v}" ${f.minViews == v ? "selected" : ""}>${t}</option>`).join("")}</select>
    <label class="sr-only" for="fMaxF">Quy mô kênh</label>
    <select class="field" id="fMaxF">${[[0, "Mọi quy mô kênh"], [10000, "Kênh dưới 10 N follower"], [100000, "Kênh dưới 100 N follower"], [1000000, "Kênh dưới 1 Tr follower"]].map(([v, t]) => `<option value="${v}" ${f.maxFollowers == v ? "selected" : ""}>${t}</option>`).join("")}</select>
    <label class="check"><input type="checkbox" id="fAds" ${f.hideAds ? "checked" : ""}>Ẩn tài trợ</label>
    <label class="check"><input type="checkbox" id="fShop" ${f.shop ? "checked" : ""}>Có gắn Shop</label>
    <label class="sr-only" for="fText">Lọc theo chữ</label>
    <input class="field search" id="fText" type="search" placeholder="Lọc caption, @kênh, #tag…" autocomplete="off" spellcheck="false" value="${esc(f.text)}">
    ${f.pivot ? `<span class="pivot">${esc(pivotLabel)}<button type="button" id="pivotX" aria-label="Bỏ lọc ${esc(pivotLabel)}">${icon("x")}</button></span>` : ""}
  </div>`;
}
function bindFilters(rerender) {
  const f = S.filters;
  const changed = () => { S.shown = 48; saveFilters(); rerender(); };
  $$("[data-fp]").forEach((b) => (b.onclick = () => { f.platform = b.dataset.fp; changed(); }));
  $("#fDays").onchange = (e) => { f.days = +e.target.value; changed(); };
  $("#fMin").onchange = (e) => { f.minViews = +e.target.value; changed(); };
  $("#fMaxF").onchange = (e) => { f.maxFollowers = +e.target.value; changed(); };
  $("#fAds").onchange = (e) => { f.hideAds = e.target.checked; changed(); };
  $("#fShop").onchange = (e) => { f.shop = e.target.checked; changed(); };
  let t; $("#fText").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.text = e.target.value; const pos = e.target.selectionStart; changed(); const el = $("#fText"); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }, 250); };
  const px = $("#pivotX"); if (px) px.onclick = () => { f.pivot = null; changed(); };
  const drop = $("#qDrop"), btn = $("#qBtn"), menu = $("#qMenu");
  btn.onclick = (e) => { e.stopPropagation(); const o = drop.classList.toggle("open"); btn.setAttribute("aria-expanded", o); };
  menu.onclick = (e) => e.stopPropagation();
  menu.onchange = () => {
    const sel = $$("input:checked", menu).map((i) => i.value);
    f.queries = sel.length === S.searches.length ? null : new Set(sel);
    changed(); $("#qDrop").classList.add("open"); $("#qBtn").setAttribute("aria-expanded", "true");
  };
  $$("[data-qa]", menu).forEach((b) => (b.onclick = () => { $$("input", menu).forEach((i) => (i.checked = b.dataset.qa === "all")); menu.onchange(); }));
}
document.addEventListener("click", () => { const d = $("#qDrop"); if (d) { d.classList.remove("open"); $("#qBtn")?.setAttribute("aria-expanded", "false"); } $$(".pop.open").forEach((p) => p.classList.remove("open")); });

// ============================================================ scan bar
function scanBar() {
  const s = S.scan;
  const ph = { search: "Nhập từ khóa rồi Enter, ví dụ: nồi chiên không dầu…", hashtag: "Nhập hashtag rồi Enter, ví dụ: reviewlamdep…", user: s.platform === "youtube" ? "Nhập @handle hoặc link kênh YouTube…" : "Nhập @tên_kênh TikTok…" }[s.kind];
  return `<form class="scan" id="scanForm" aria-label="Quét video mới">
    <div class="seg" role="group" aria-label="Quét trên nền tảng">
      ${["tiktok", "youtube"].map((p) => `<button type="button" data-sp="${p}" aria-pressed="${s.platform === p}"><i class="pdot ${p}"></i>${PLAT_LONG[p]}</button>`).join("")}
    </div>
    <label class="sr-only" for="sKind">Kiểu tìm</label>
    <select class="field kind" id="sKind">${[["search", "Từ khóa"], ["hashtag", "Hashtag"], ["user", "Kênh"]].map(([v, t]) => `<option value="${v}" ${s.kind === v ? "selected" : ""}>${t}</option>`).join("")}</select>
    <div class="chips-input" id="chips">
      ${s.chips.map((c, i) => `<span class="qchip">${esc(c)}<button type="button" data-rm="${i}" aria-label="Bỏ ${esc(c)}">${icon("x")}</button></span>`).join("")}
      <label class="sr-only" for="sInput">Từ khóa cần quét</label>
      <input id="sInput" name="q" autocomplete="off" spellcheck="false" placeholder="${s.chips.length ? "Thêm…" : esc(ph)}">
    </div>
    <div class="scan-opts">
      <button type="button" class="btn icon" id="optBtn" aria-label="Tùy chọn quét" aria-haspopup="true" aria-expanded="false">${icon("sliders")}</button>
      <div class="pop" id="optPop">
        <label class="lbl" for="sLimit">Số video mỗi từ khóa<input class="field num" id="sLimit" type="number" inputmode="numeric" min="10" max="300" step="10" value="${s.limit}"><span class="hint">Nhiều hơn thì quét lâu hơn. TikTok khoảng 1 phút cho 60 video.</span></label>
        <label class="lbl" for="sEnrich">Tính Outlier cho kênh top<input class="field num" id="sEnrich" type="number" inputmode="numeric" min="0" max="50" value="${s.enrich}"><span class="hint">Mở trang của N kênh đứng đầu để so video với mức view thường ngày của kênh. Mỗi kênh thêm 10 đến 30 giây.</span></label>
      </div>
    </div>
    <button type="submit" class="btn signal go">Quét</button>
    <p class="scan-note">${s.platform === "tiktok" ? "TikTok mở một cửa sổ Chrome để lấy dữ liệu. Nếu thấy captcha, bạn tự giải trong cửa sổ đó, lượt quét sẽ chạy tiếp." : "YouTube Shorts lấy dữ liệu trực tiếp, không mở trình duyệt."}</p>
  </form>`;
}
function bindScan(rerender) {
  const s = S.scan;
  const save = () => { const { chips, ...rest } = s; store("vr-scan", rest); };
  $$("[data-sp]").forEach((b) => (b.onclick = () => { s.platform = b.dataset.sp; save(); rerender(); }));
  $("#sKind").onchange = (e) => { s.kind = e.target.value; save(); rerender(); };
  const input = $("#sInput");
  const addChip = () => { const parts = input.value.split(",").map((x) => x.trim()).filter(Boolean); if (!parts.length) return false; s.chips.push(...parts.filter((p) => !s.chips.includes(p))); return true; };
  input.onkeydown = (e) => {
    if ((e.key === "Enter" || e.key === ",") && input.value.trim()) { e.preventDefault(); addChip(); rerender(); $("#sInput").focus(); }
    else if (e.key === "Backspace" && !input.value && s.chips.length) { s.chips.pop(); rerender(); $("#sInput").focus(); }
  };
  $("#chips").onclick = (e) => { const rm = e.target.closest("[data-rm]"); if (rm) { s.chips.splice(+rm.dataset.rm, 1); rerender(); $("#sInput").focus(); return; } input.focus(); };
  const pop = $("#optPop"), ob = $("#optBtn");
  ob.onclick = (e) => { e.stopPropagation(); const o = pop.classList.toggle("open"); ob.setAttribute("aria-expanded", o); };
  pop.onclick = (e) => e.stopPropagation();
  $("#sLimit").onchange = (e) => { s.limit = Math.max(10, Math.min(300, +e.target.value || 60)); save(); };
  $("#sEnrich").onchange = (e) => { s.enrich = Math.max(0, Math.min(50, +e.target.value || 0)); save(); };
  $("#scanForm").onsubmit = async (e) => {
    e.preventDefault();
    addChip();
    if (!s.chips.length) { $("#sInput").focus(); toast("Nhập ít nhất một từ khóa để quét."); return; }
    const btn = $(".go"); btn.disabled = true; btn.textContent = "Đang gửi…";
    try {
      await api("/api/collect", { method: "POST", body: JSON.stringify({ platform: s.platform, kind: s.kind, queries: s.chips, limit: s.limit, enrich: s.enrich }) });
      toast(`Đã xếp lượt quét: ${s.chips.join(", ")}. Kết quả tự cập nhật khi xong.`);
      s.chips = []; pollJobs(true);
    } catch (err) { toast(err.message, true); }
    rerender();
  };
}

// ============================================================ video cards
function card(v, extra = "") {
  const l = level(v.virality);
  const prod = (v.products || "").split(" | ").filter(Boolean)[0];
  const hotX = (v.x_followers ?? 0) >= 20, hotO = (v.outlier ?? 0) >= 3, hotE = (v.engagement ?? 0) >= 0.05;
  return `<article class="vcard">
    <a class="main" href="#/${S.page}?video=${encodeURIComponent(v.id)}" data-video="${esc(v.id)}">
      <div class="thumb">
        <div class="ph">${esc((v.caption || "").slice(0, 80))}</div>
        ${v.cover ? `<img src="${esc(v.cover)}" alt="" width="300" height="400" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
        <div class="shade"></div>
        <span class="tl plat"><i class="pdot ${v.platform}"></i>${PLAT[v.platform]}</span>
        ${l ? `<span class="tr sig-pill" title="Virality ${NF_1.format(v.virality)}">${sig(l)}<span class="num">${Math.round(v.virality)}</span><span class="sr-only">Tín hiệu ${TIER[l]}</span></span>` : ""}
        ${extra}
        <div class="bl"><div class="views num">${nC(v.views)}<small>lượt xem, ${ageText(v.age_days)}</small></div>${v.is_ad ? `<span class="tag-sponsored">Tài trợ</span>` : ""}</div>
        ${v.duration ? `<span class="br dur num">${dur(v.duration)}</span>` : ""}
      </div>
      <p class="cap">${esc(v.caption) || '<span class="muted">Không có caption</span>'}</p>
    </a>
    <div class="who"><span class="h" translate="no">@${esc(v.username)}</span><span class="f">${nC(v.followers)} follower</span>
      <a class="ext" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer" aria-label="Mở video trên ${PLAT_LONG[v.platform]}" title="Mở trên ${PLAT_LONG[v.platform]}">${icon("ext")}</a></div>
    <div class="metrics num">
      <span class="${hotX ? "hot" : ""}"><b>${times(v.x_followers)}</b>follower</span>
      <span class="${hotE ? "hot" : ""}"><b>${pct(v.engagement)}</b>tương tác</span>
      ${v.outlier != null ? `<span class="${hotO ? "hot" : ""}"><b>${times(v.outlier)}</b>so với kênh</span>` : ""}
    </div>
    ${prod ? `<div class="prod">${icon("cart")}<span title="${esc(v.products)}">${esc(prod)}</span></div>` : ""}
  </article>`;
}

// ============================================================ page: Khám phá
function renderExplore() {
  const main = $("#main");
  const rows = filtered();
  const strong = rows.filter((v) => level(v.virality) >= 2).length;
  const creators = new Set(rows.map((v) => v.platform + v.creator_id)).size;
  const engs = rows.map((v) => v.engagement).filter((x) => x != null).sort((a, b) => a - b);
  const medE = engs.length ? engs[Math.floor(engs.length / 2)] : null;

  let body;
  if (!S.videos.length) {
    body = `<div class="panel empty"><h2>Bắt đầu bằng một từ khóa</h2>
      <p>Gõ một chủ đề trong ngách của bạn vào ô phía trên rồi bấm Quét. Tool sẽ tìm video, chấm điểm và đưa video vượt trội nhất lên đầu.</p>
      <div class="row">${["nồi chiên không dầu", "review son", "skincare cho da dầu"].map((x) => `<button type="button" class="btn" data-try="${esc(x)}">${esc(x)}</button>`).join("")}</div></div>`;
  } else if (!rows.length) {
    body = `<div class="panel empty"><h2>Không có video khớp bộ lọc</h2>
      <p>Bộ lọc hiện tại đang loại hết ${nN(S.videos.length)} video. Nới thời gian đăng hoặc bỏ giới hạn lượt xem để xem thêm.</p>
      <div class="row"><button type="button" class="btn primary" id="loosen">Nới bộ lọc</button></div></div>`;
  } else {
    body = `
      <div class="summary">
        <div>
          <div class="headline"><span class="big num">${nN(strong || rows.length)}</span><span class="big-label">${strong ? "video có tín hiệu mạnh" : "video khớp bộ lọc"}</span></div>
          <p class="subline">${strong ? `Trong <b class="num">${nN(rows.length)}</b> video khớp bộ lọc, ` : ""}từ <b class="num">${nN(creators)}</b> kênh. Tương tác trung vị <b class="num">${pct(medE)}</b>.</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="sr-only" for="fSort">Sắp xếp</label>
          <select class="field" id="fSort">${[["virality", "Xếp theo tín hiệu viral"], ["outlier", "Xếp theo Outlier"], ["x_followers", "Xếp theo lần follower"], ["views_per_hour", "Xếp theo view mỗi giờ"], ["views", "Xếp theo lượt xem"], ["engagement", "Xếp theo tương tác"], ["created_at", "Mới đăng nhất"]].map(([v, t]) => `<option value="${v}" ${S.filters.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>
          <div class="seg" role="group" aria-label="Cách hiển thị">
            ${[["grid", "Lưới"], ["table", "Bảng"], ["map", "Bản đồ outlier"]].map(([v, t]) => `<button type="button" data-view="${v}" aria-pressed="${S.view === v}">${t}</button>`).join("")}
          </div>
        </div>
      </div>
      <div id="viewBody"></div>`;
  }
  const nActive = [S.filters.platform !== "all", !!S.filters.queries, S.filters.minViews > 0, S.filters.maxFollowers > 0, S.filters.shop, !!S.filters.text].filter(Boolean).length;
  main.innerHTML = `
    <div class="page-head"><div><h1>Khám phá</h1><p>Video vượt xa lượng follower của kênh được xếp lên đầu. Bấm vào video để xem vì sao nó nổi bật.</p></div></div>
    <div class="m-bar m-only"><button type="button" class="btn" id="mScan" aria-expanded="${main.classList.contains("show-scan")}">${icon("plus")}Quét mới</button>${S.videos.length ? `<button type="button" class="btn" id="mFilt" aria-expanded="${main.classList.contains("show-filt")}">${icon("sliders")}Bộ lọc${nActive ? ` (${nActive})` : ""}</button>` : ""}</div>
    ${scanBar()}
    ${S.videos.length ? filterBar() : ""}
    ${body}`;
  $("#mScan").onclick = () => { main.classList.toggle("show-scan"); renderExplore(); };
  const mf = $("#mFilt"); if (mf) mf.onclick = () => { main.classList.toggle("show-filt"); renderExplore(); };
  if (!S.videos.length) main.classList.add("show-scan");
  bindScan(renderExplore);
  if (S.videos.length) bindFilters(renderExplore);
  $$("[data-try]").forEach((b) => (b.onclick = () => { S.scan.chips = [b.dataset.try]; S.scan.kind = "search"; renderExplore(); $(".go").focus(); }));
  const lo = $("#loosen"); if (lo) lo.onclick = () => { Object.assign(S.filters, { days: 100000, minViews: 0, maxFollowers: 0, shop: false, text: "", pivot: null, queries: null, platform: "all" }); saveFilters(); renderExplore(); };
  if (!rows.length) return;
  $("#fSort").onchange = (e) => { S.filters.sort = e.target.value; S.shown = 48; saveFilters(); renderExplore(); };
  $$("[data-view]").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; store("vr-view", S.view); renderExplore(); }));
  const vb = $("#viewBody");
  if (S.view === "table") renderTable(vb, rows);
  else if (S.view === "map") renderMap(vb, rows);
  else {
    vb.innerHTML = `<div class="wall">${rows.slice(0, S.shown).map((v) => card(v)).join("")}</div>
      ${rows.length > S.shown ? `<div class="more"><button type="button" class="btn" id="moreBtn">Xem thêm ${nN(Math.min(48, rows.length - S.shown))} video (còn ${nN(rows.length - S.shown)})</button></div>` : ""}`;
    const m = $("#moreBtn"); if (m) m.onclick = () => { S.shown += 48; renderExplore(); };
  }
}

// ---------- bảng
const TCOLS = [
  { k: "caption", t: "Video", f: (v) => `<button type="button" class="rowlink" data-open="${esc(v.id)}">${v.cover ? `<img class="tiny" src="${esc(v.cover)}" alt="" width="34" height="44" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">` : ""}<span>${esc(v.caption) || "Không có caption"}</span></button>`, str: 1 },
  { k: "platform", t: "Nền tảng", f: (v) => `<span style="display:inline-flex;gap:6px;align-items:center"><i class="pdot ${v.platform}"></i>${PLAT[v.platform]}</span>`, str: 1 },
  { k: "username", t: "Kênh", f: (v) => `<span translate="no">@${esc(v.username)}</span>`, str: 1 },
  { k: "virality", t: "Tín hiệu", r: 1, f: (v) => v.virality == null ? "–" : `<span style="display:inline-flex;gap:8px;align-items:center">${sig(level(v.virality))}${NF_1.format(v.virality)}</span>` },
  { k: "outlier", t: "Outlier", r: 1, f: (v) => times(v.outlier) },
  { k: "views", t: "Lượt xem", r: 1, f: (v) => nN(v.views) },
  { k: "followers", t: "Follower", r: 1, f: (v) => nN(v.followers) },
  { k: "x_followers", t: "Lần follower", r: 1, f: (v) => times(v.x_followers) },
  { k: "views_per_hour", t: "View/giờ", r: 1, f: (v) => nN(v.views_per_hour) },
  { k: "engagement", t: "Tương tác", r: 1, f: (v) => pct(v.engagement) },
  { k: "age_days", t: "Đăng", r: 1, f: (v) => ageText(v.age_days) },
  { k: "products", t: "Sản phẩm Shop", f: (v) => esc((v.products || "").split(" | ")[0] || ""), str: 1 },
];
function renderTable(el, rows) {
  const { key, dir } = S.tableSort;
  const col = TCOLS.find((c) => c.k === key);
  const sorted = [...rows].sort((a, b) => col && col.str ? dir * String(a[key] ?? "").localeCompare(String(b[key] ?? ""), "vi") : dir * ((a[key] ?? -Infinity) - (b[key] ?? -Infinity)));
  el.innerHTML = `<div class="panel tbl-wrap"><table><thead><tr>${TCOLS.map((c) => `<th class="${c.r ? "r" : ""}" scope="col" aria-sort="${key === c.k ? (dir < 0 ? "descending" : "ascending") : "none"}"><button type="button" data-sort="${c.k}">${c.t}${key === c.k ? (dir < 0 ? " ↓" : " ↑") : ""}</button></th>`).join("")}</tr></thead>
    <tbody>${sorted.slice(0, 400).map((v) => `<tr>${TCOLS.map((c) => `<td class="${c.r ? "r num" : ""}">${c.f(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${sorted.length > 400 ? `<p class="tbl-note">Đang hiện 400 trên ${nN(sorted.length)} video. Thu hẹp bộ lọc để xem phần còn lại.</p>` : ""}`;
  $$("[data-sort]", el).forEach((b) => (b.onclick = () => { const k = b.dataset.sort; S.tableSort = { key: k, dir: S.tableSort.key === k ? -S.tableSort.dir : -1 }; renderTable(el, rows); $(`[data-sort="${k}"]`, el).focus(); }));
}

// ---------- bản đồ outlier
function renderMap(el, rows) {
  const pts = rows.filter((v) => v.followers > 0 && v.views > 0);
  const series = [...new Set(pts.map((v) => v.platform))];
  el.innerHTML = `<div class="panel chart"><div class="chart-head"><h2>Lượt xem so với follower của kênh</h2>
    <div class="legend">${series.map((p) => `<span><i class="pdot ${p}"></i>${PLAT_LONG[p]}</span>`).join("")}</div></div>
    <p class="muted" style="font-size:13px;margin-bottom:8px">Chấm càng cao so với đường chéo, video càng vượt lượng follower. Bấm chấm để xem chi tiết.</p>
    <svg id="scatter" role="img" aria-label="Biểu đồ phân tán lượt xem theo follower, ${pts.length} video"></svg></div>
    <p class="tbl-note">${nN(pts.length)} video có số follower. Xem số liệu chi tiết ở chế độ Bảng.</p>`;
  const svg = $("#scatter");
  const W = svg.clientWidth, H = svg.clientHeight, m = { l: 64, r: 24, t: 12, b: 48 };
  const lg = Math.log10;
  const fx = pts.map((v) => lg(v.followers)), fy = pts.map((v) => lg(v.views));
  const x0 = Math.floor(Math.min(...fx, 2)), x1 = Math.ceil(Math.max(...fx, 3));
  const y0 = Math.floor(Math.min(...fy, 3)), y1 = Math.ceil(Math.max(...fy, 4));
  const sx = (v) => m.l + (lg(v) - x0) / (x1 - x0) * (W - m.l - m.r);
  const sy = (v) => H - m.b - (lg(v) - y0) / (y1 - y0) * (H - m.t - m.b);
  let g = `<g class="grid">`;
  for (let e = y0; e <= y1; e++) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${sy(10 ** e)}" y2="${sy(10 ** e)}"/><text x="${m.l - 8}" y="${sy(10 ** e) + 4}" text-anchor="end">${NF_C.format(10 ** e)}</text>`;
  for (let e = x0; e <= x1; e++) g += `<line y1="${m.t}" y2="${H - m.b}" x1="${sx(10 ** e)}" x2="${sx(10 ** e)}"/><text y="${H - m.b + 18}" x="${sx(10 ** e)}" text-anchor="middle">${NF_C.format(10 ** e)}</text>`;
  g += `</g>`;
  for (const [mult, lab] of [[1, "bằng follower"], [10, "gấp 10"], [100, "gấp 100"], [1000, "gấp 1000"]]) {
    const a = Math.max(10 ** x0, 10 ** y0 / mult), b = Math.min(10 ** x1, 10 ** y1 / mult);
    if (b <= a) continue;
    g += `<line class="ref" x1="${sx(a)}" y1="${sy(a * mult)}" x2="${sx(b)}" y2="${sy(b * mult)}"/><text x="${sx(b) - 4}" y="${sy(b * mult) + 14}" text-anchor="end">${lab}</text>`;
  }
  g += `<text class="axis-title" x="${(W + m.l) / 2}" y="${H - 8}" text-anchor="middle">Follower của kênh (thang log)</text>`;
  g += `<text class="axis-title" transform="translate(16 ${(H - m.b) / 2}) rotate(-90)" text-anchor="middle">Lượt xem (thang log)</text>`;
  g += [...pts].sort((a, b) => (a.virality ?? 0) - (b.virality ?? 0)).map((v) => `<circle class="${v.platform}" data-id="${esc(v.id)}" cx="${sx(v.followers)}" cy="${sy(v.views)}" r="${level(v.virality) >= 2 ? 6 : 4.5}"/>`).join("");
  svg.innerHTML = g;
  const tip = $("#tip");
  svg.onmousemove = (e) => {
    const c = e.target.closest("circle");
    $$("circle.on", svg).forEach((x) => x.classList.remove("on"));
    if (!c) { tip.style.display = "none"; return; }
    c.classList.add("on");
    const v = S.byId.get(c.dataset.id);
    tip.innerHTML = `<div class="t1">${esc(v.caption) || "Không có caption"}</div><dl class="num">
      <dt>Kênh</dt><dd translate="no">@${esc(v.username)}</dd><dt>Lượt xem</dt><dd>${nN(v.views)}</dd><dt>Follower</dt><dd>${nN(v.followers)}</dd>
      <dt>Lần follower</dt><dd>${times(v.x_followers)}</dd><dt>Tín hiệu</dt><dd>${v.virality == null ? "–" : `${TIER[level(v.virality)]}, ${NF_1.format(v.virality)}`}</dd><dt>Đăng</dt><dd>${ageText(v.age_days)}</dd></dl>`;
    tip.style.display = "block";
    tip.style.left = Math.min(e.clientX + 16, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 8) + "px";
  };
  svg.onmouseleave = () => (tip.style.display = "none");
  svg.onclick = (e) => { const c = e.target.closest("circle"); if (c) { tip.style.display = "none"; openVideo(c.dataset.id); } };
}

// ============================================================ page: Nhóm theo
function groupRows(rows, type) {
  const m = new Map();
  for (const v of rows) {
    let keys = [];
    if (type === "product") keys = (v.products || "").split(" | ").filter(Boolean);
    else if (type === "hashtag") keys = (v.hashtags || "").split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    else if (type === "music") keys = musicKey(v) ? [musicKey(v)] : [];
    else if (type === "creator") keys = [v.platform + "|" + v.creator_id];
    for (const k of new Set(keys)) {
      if (!m.has(k)) m.set(k, { key: k, n: 0, views: 0, vir: [], best: v, plats: new Set(), sample: v });
      const g = m.get(k);
      g.n++; g.views += v.views; g.plats.add(v.platform);
      if (v.virality != null) g.vir.push(v.virality);
      if ((v.virality ?? -1) > (g.best.virality ?? -1)) g.best = v;
    }
  }
  return [...m.values()].map((g) => ({ ...g, med: g.vir.length ? g.vir.sort((a, b) => a - b)[Math.floor(g.vir.length / 2)] : null }))
    .sort((a, b) => b.n - a.n || b.views - a.views);
}
function renderGroups() {
  const rows = filtered({ ignorePivot: true });
  const tab = S.groupTab;
  const TABS = [["product", "Sản phẩm Shop"], ["hashtag", "Hashtag"], ["music", "Âm thanh"], ["creator", "Kênh"]];
  const groups = groupRows(rows, tab).slice(0, 200);
  const maxN = Math.max(1, ...groups.map((g) => g.n));
  const NOTE = {
    product: "Sản phẩm được nhiều video viral gắn giỏ cùng lúc thường đang bán chạy. Chỉ TikTok có dữ liệu này.",
    hashtag: "Hashtag xuất hiện nhiều nhất trong các video đang lọc, kèm mức tín hiệu trung vị.",
    music: "Âm thanh được nhiều video dùng. Âm thanh đang lan nhanh thường là trend sắp nổ.",
    creator: "Kênh có video vượt xa mức view thường ngày là kênh đang lên, đáng theo dõi hoặc hợp tác.",
  }[tab];
  let table;
  if (!S.videos.length) table = `<div class="panel empty"><h2>Chưa có dữ liệu để nhóm</h2><p>Quét vài từ khóa ở Khám phá trước, các nhóm sẽ hiện ở đây.</p><div class="row"><a class="btn primary" href="#/explore">Đến Khám phá</a></div></div>`;
  else if (!groups.length) table = `<div class="panel empty"><h2>Không có ${TABS.find((t) => t[0] === tab)[1].toLowerCase()} trong bộ lọc hiện tại</h2><p>${NOTE}</p></div>`;
  else if (tab === "creator") {
    table = `<div class="panel tbl-wrap"><table><thead><tr><th scope="col">Kênh</th><th scope="col">Nền tảng</th><th class="r" scope="col">Follower</th><th class="r" scope="col">Video</th><th class="r" scope="col">Tín hiệu cao nhất</th><th class="r" scope="col">View thường ngày</th><th scope="col">Video nổi bật nhất</th><th scope="col"><span class="sr-only">Hành động</span></th></tr></thead><tbody>
      ${groups.map((g) => { const v = g.sample; const watched = isWatched(v);
        return `<tr><td><button type="button" class="rowlink" data-pivot="creator" data-value="${esc(g.key)}" data-label="@${esc(v.username)}"><span translate="no">@${esc(v.username)}</span></button><span class="muted" style="font-size:12px">${esc(v.nickname || "")}</span></td>
        <td><span style="display:inline-flex;gap:6px;align-items:center"><i class="pdot ${v.platform}"></i>${PLAT[v.platform]}</span></td>
        <td class="r num">${nN(v.followers)}</td><td class="r num">${g.n}</td>
        <td class="r num"><span style="display:inline-flex;gap:8px;align-items:center">${sig(level(g.best.virality))}${g.best.virality == null ? "–" : NF_1.format(g.best.virality)}</span></td>
        <td class="r num">${v.median_views == null ? `<button type="button" class="btn sm" data-enrich="${esc(v.id)}">Tính</button>` : nC(v.median_views)}</td>
        <td><button type="button" class="rowlink" data-open="${esc(g.best.id)}"><span>${esc((g.best.caption || "").slice(0, 48)) || "Không có caption"}</span></button></td>
        <td><div style="display:flex;gap:6px"><button type="button" class="btn sm" data-follow="${esc(v.id)}" ${watched ? "disabled" : ""}>${watched ? "Đang theo dõi" : "Theo dõi"}</button><a class="btn sm icon" href="${esc(profileUrl(v))}" target="_blank" rel="noopener noreferrer" aria-label="Mở kênh @${esc(v.username)}">${icon("ext")}</a></div></td></tr>`; }).join("")}
      </tbody></table></div>`;
  } else {
    table = `<div class="panel tbl-wrap"><table><thead><tr><th scope="col">${TABS.find((t) => t[0] === tab)[1]}</th><th class="r" scope="col">Số video</th><th class="r" scope="col">Tổng lượt xem</th><th class="r" scope="col">Tín hiệu trung vị</th><th scope="col">Nền tảng</th><th scope="col">Video nổi bật nhất</th></tr></thead><tbody>
      ${groups.map((g) => { const label = tab === "hashtag" ? "#" + g.key : g.key;
        return `<tr><td><button type="button" class="rowlink" data-pivot="${tab}" data-value="${esc(g.key)}" data-label="${esc(tab === "hashtag" ? g.key : g.key)}" title="Xem các video có ${esc(label)}"><span>${esc(label)}</span></button></td>
        <td class="r num"><span class="barcell">${g.n}<i style="width:${Math.round((g.n / maxN) * 96)}px"></i></span></td>
        <td class="r num">${nC(g.views)}</td>
        <td class="r num"><span style="display:inline-flex;gap:8px;align-items:center">${sig(level(g.med))}${g.med == null ? "–" : NF_1.format(g.med)}</span></td>
        <td>${[...g.plats].map((p) => `<span style="display:inline-flex;gap:6px;align-items:center;margin-right:10px"><i class="pdot ${p}"></i>${PLAT[p]}</span>`).join("")}</td>
        <td><button type="button" class="rowlink" data-open="${esc(g.best.id)}"><span>${esc((g.best.caption || "").slice(0, 56)) || "Không có caption"}</span></button></td></tr>`; }).join("")}
      </tbody></table></div>`;
  }
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Nhóm theo</h1><p>Gộp video đang lọc theo sản phẩm, hashtag, âm thanh hoặc kênh. Bấm một dòng để xem các video thuộc nhóm đó.</p></div></div>
    ${S.videos.length ? filterBar() : ""}
    <div class="tabs" role="tablist" aria-label="Nhóm theo">${TABS.map(([k, t]) => `<button type="button" role="tab" aria-selected="${tab === k}" data-gtab="${k}">${t}</button>`).join("")}</div>
    ${table}
    ${groups.length ? `<p class="tbl-note">${NOTE}</p>` : ""}`;
  if (S.videos.length) bindFilters(renderGroups);
  $$("[data-gtab]").forEach((b) => (b.onclick = () => { S.groupTab = b.dataset.gtab; renderGroups(); $(`[data-gtab="${S.groupTab}"]`).focus(); }));
  $$("[data-pivot]").forEach((b) => (b.onclick = () => { S.filters.pivot = { type: b.dataset.pivot, value: b.dataset.value, label: b.dataset.label }; S.shown = 48; location.hash = "#/explore"; }));
}

// ============================================================ page: Theo dõi
function isWatched(v) {
  const q = v.platform === "youtube" ? v.creator_id : "@" + v.username;
  return S.watch.some((w) => w.platform === v.platform && w.kind === "user" && (w.query === q || w.query === v.username || w.query === "@" + v.username));
}
async function renderWatch() {
  let br = [], settings = null;
  try { [br, settings] = await Promise.all([api("/api/breakouts"), api("/api/settings")]); } catch (e) { /* hiển thị phần còn lại */ }
  if (S.page !== "watch") return;
  const w = S.watch;
  const intervals = [[1, "Mỗi giờ"], [3, "3 giờ một lần"], [6, "6 giờ một lần"], [12, "12 giờ một lần"], [24, "Mỗi ngày"]];
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Theo dõi</h1><p>Kênh và từ khóa trong danh sách được quét lại tự động khi tool đang mở. Video tăng view nhanh nhất giữa hai lần quét hiện ở đầu trang.</p></div></div>
    <section class="section" style="margin-top:8px" aria-labelledby="hBreak">
      <div class="section-head"><h2 id="hBreak">Đang bùng nổ</h2><p>Xếp theo lượt xem tăng thêm mỗi giờ, video đăng trong 14 ngày.</p></div>
      ${br.length ? `<div class="wall">${br.map((v) => { S.byId.has(v.id) || S.byId.set(v.id, { ...v, queries: [] }); return card(S.byId.get(v.id), `<span class="velo num">${icon("bolt")}+${nC(v.views_per_hour)}/giờ</span>`); }).join("")}</div>`
        : `<div class="panel empty"><h2>Chưa đo được tốc độ tăng view</h2><p>Cần ít nhất hai lần quét cùng một kênh hoặc từ khóa, cách nhau từ 30 phút. Thêm mục vào danh sách bên dưới, tool sẽ tự quét lại theo lịch.</p></div>`}
    </section>
    <section class="section" aria-labelledby="hList">
      <div class="section-head"><h2 id="hList">Danh sách theo dõi</h2>
        <p>${settings && settings.telegram_token_set && settings.telegram_chat_id ? `Video bùng nổ được gửi về Telegram khi tín hiệu từ ${NF.format(settings.notify_min_virality)} trở lên.` : `Thông báo Telegram đang tắt. <a href="#/settings">Bật trong Cài đặt</a>`}</p></div>
      <form class="panel addrow" id="addWatch" aria-label="Thêm mục theo dõi">
        <div class="seg" role="group" aria-label="Nền tảng">${["tiktok", "youtube"].map((p, i) => `<button type="button" data-wp="${p}" aria-pressed="${i === 0}"><i class="pdot ${p}"></i>${PLAT_LONG[p]}</button>`).join("")}</div>
        <label class="sr-only" for="wKind">Loại</label>
        <select class="field" id="wKind"><option value="user">Kênh</option><option value="search">Từ khóa</option><option value="hashtag">Hashtag</option></select>
        <label class="sr-only" for="wQuery">Kênh hoặc từ khóa</label>
        <input class="field q" id="wQuery" autocomplete="off" spellcheck="false" placeholder="@tên_kênh hoặc từ khóa…">
        <label class="sr-only" for="wInt">Tần suất</label>
        <select class="field" id="wInt">${intervals.map(([v, t]) => `<option value="${v}" ${v === 6 ? "selected" : ""}>${t}</option>`).join("")}</select>
        <button type="submit" class="btn primary">${icon("plus")}Thêm</button>
      </form>
      ${w.length ? `<div class="panel tbl-wrap" style="margin-top:12px"><table><thead><tr><th scope="col">Theo dõi</th><th scope="col">Loại</th><th scope="col">Tần suất</th><th scope="col">Quét gần nhất</th><th scope="col">Lần tới</th><th scope="col">Tự động</th><th scope="col"><span class="sr-only">Hành động</span></th></tr></thead><tbody>
        ${w.map((r) => `<tr><td><span style="display:inline-flex;gap:8px;align-items:center"><i class="pdot ${r.platform}"></i><b style="font-weight:600" translate="no">${esc(r.query)}</b></span></td>
          <td>${KIND[r.kind]}, ${PLAT[r.platform]}</td>
          <td><label class="sr-only" for="wi${r.id}">Tần suất ${esc(r.query)}</label><select class="field" id="wi${r.id}" data-wint="${r.id}" style="height:32px">${intervals.map(([v, t]) => `<option value="${v}" ${r.interval_hours == v ? "selected" : ""}>${t}</option>`).join("")}</select></td>
          <td>${r.busy ? `<span class="status run">Đang quét</span>` : ago(r.last_run)}</td>
          <td class="muted">${r.enabled ? (r.next_run ? (r.next_run * 1000 < Date.now() ? "Sắp chạy" : ago(r.next_run)) : "Sắp chạy") : "Đã tắt"}</td>
          <td><label class="switch"><input type="checkbox" data-wen="${r.id}" ${r.enabled ? "checked" : ""} aria-label="Tự động quét ${esc(r.query)}"><span></span></label></td>
          <td><div style="display:flex;gap:6px;justify-content:flex-end"><button type="button" class="btn sm" data-wrun="${r.id}" ${r.busy ? "disabled" : ""}>${icon("refresh")}Quét ngay</button><button type="button" class="btn sm icon danger" data-wdel="${r.id}" aria-label="Bỏ theo dõi ${esc(r.query)}">${icon("trash")}</button></div></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="tbl-note">Chưa theo dõi gì. Thêm kênh đối thủ hoặc từ khóa ngách ở trên, hoặc bấm “Theo dõi kênh” trong trang chi tiết video.</p>`}
    </section>`;
  let wp = "tiktok";
  $$("[data-wp]").forEach((b) => (b.onclick = () => { wp = b.dataset.wp; $$("[data-wp]").forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
  $("#addWatch").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("#wQuery").value.trim();
    if (!q) { $("#wQuery").focus(); toast("Nhập tên kênh hoặc từ khóa cần theo dõi."); return; }
    try { await api("/api/watch", { method: "POST", body: JSON.stringify({ platform: wp, kind: $("#wKind").value, query: q, interval_hours: +$("#wInt").value }) });
      toast(`Đã thêm “${q}” và bắt đầu quét lần đầu.`); await refreshWatch(); pollJobs(true); } catch (err) { toast(err.message, true); }
  };
  $$("[data-wint]").forEach((s) => (s.onchange = async () => { await api(`/api/watch/${s.dataset.wint}`, { method: "PATCH", body: JSON.stringify({ interval_hours: +s.value }) }); await refreshWatch(); }));
  $$("[data-wen]").forEach((c) => (c.onchange = async () => { await api(`/api/watch/${c.dataset.wen}`, { method: "PATCH", body: JSON.stringify({ enabled: c.checked }) }); await refreshWatch(); }));
  $$("[data-wrun]").forEach((b) => (b.onclick = async () => { await api(`/api/watch/${b.dataset.wrun}/run`, { method: "POST" }); toast("Đã xếp lượt quét."); pollJobs(true); await refreshWatch(); }));
  $$("[data-wdel]").forEach((b) => (b.onclick = async () => {
    const r = S.watch.find((x) => x.id == b.dataset.wdel);
    if (!confirm(`Bỏ theo dõi “${r.query}”? Video đã quét vẫn được giữ lại.`)) return;
    await api(`/api/watch/${r.id}`, { method: "DELETE" }); toast(`Đã bỏ theo dõi “${r.query}”.`); await refreshWatch();
  }));
}
async function refreshWatch() { S.watch = await api("/api/watch"); $("#watchCount").textContent = S.watch.length || ""; if (S.page === "watch") renderWatch(); }

async function follow(v) {
  const query = v.platform === "youtube" ? v.creator_id : "@" + v.username;
  try { await api("/api/watch", { method: "POST", body: JSON.stringify({ platform: v.platform, kind: "user", query, interval_hours: 6 }) });
    toast(`Đang theo dõi @${v.username}, quét lại 6 giờ một lần.`); await refreshWatch(); pollJobs(true); return true; }
  catch (err) { toast(err.message, true); return false; }
}
async function enrich(v) {
  try { await api("/api/enrich", { method: "POST", body: JSON.stringify({ platform: v.platform, creator_id: v.creator_id }) });
    toast(`Đang tính Outlier cho @${v.username}. Mất khoảng 10 đến 30 giây.`); pollJobs(true); }
  catch (err) { toast(err.message, true); }
}

// ============================================================ page: Lịch sử quét
function renderHistory() {
  const jobs = S.jobs;
  const st = (j) => ({ queued: `<span class="status wait">Chờ</span>`, running: `<span class="status run">Đang quét</span>`, done: `<span class="status ok">Xong</span>`, error: `<span class="status err">Lỗi</span>` }[j.status]);
  $("#main").innerHTML = `
    <div class="page-head"><div><h1>Lịch sử quét</h1><p>Các lượt quét chạy lần lượt từng cái. Quét lại một truy vấn sau từ 30 phút để đo tốc độ tăng view.</p></div></div>
    <section aria-labelledby="hJobs"><div class="section-head"><h2 id="hJobs">Lượt quét gần đây</h2></div>
      ${jobs.length ? `<div class="panel">${jobs.map((j) => `<div class="job"><div class="job-top">${j.status === "running" ? `<span class="spin" aria-hidden="true"></span>` : ""}<span class="name">${esc(j.label)}</span>${j.platform ? `<span style="display:inline-flex;gap:6px;align-items:center;font-size:13px"><i class="pdot ${j.platform}"></i>${PLAT[j.platform]}</span>` : ""}<span class="muted" style="font-size:12px">${j.source === "schedule" ? "Theo lịch" : "Bấm tay"}, ${ago(j.created)}</span>${st(j)}</div>
          ${j.log.length ? `<details ${j.status === "running" ? "open" : ""}><summary class="muted" style="font-size:12px;cursor:pointer;margin-top:6px">Nhật ký (${j.log.length} dòng)</summary><pre class="log">${esc(j.log.join("\n"))}</pre></details>` : ""}</div>`).join("")}</div>`
        : `<p class="tbl-note">Chưa có lượt quét nào từ lúc mở tool.</p>`}
    </section>
    <section class="section" aria-labelledby="hSearch"><div class="section-head"><h2 id="hSearch">Truy vấn đã quét</h2><p>${nN(S.searches.length)} truy vấn</p></div>
      ${S.searches.length ? `<div class="panel tbl-wrap"><table><thead><tr><th scope="col">Truy vấn</th><th scope="col">Loại</th><th class="r" scope="col">Video</th><th class="r" scope="col">Số lần quét</th><th scope="col">Quét gần nhất</th><th scope="col"><span class="sr-only">Hành động</span></th></tr></thead><tbody>
        ${S.searches.map((s, i) => `<tr><td><span style="display:inline-flex;gap:8px;align-items:center"><i class="pdot ${s.platform}"></i><b style="font-weight:600">${esc(s.query)}</b></span></td><td>${KIND[s.kind] || s.kind}, ${PLAT[s.platform]}</td><td class="r num">${nN(s.found)}</td><td class="r num">${s.runs}</td><td title="${DTF.format(new Date(s.ran_at * 1000))}">${ago(s.ran_at)}</td>
          <td><div style="display:flex;gap:6px;justify-content:flex-end"><button type="button" class="btn sm" data-see="${i}">Xem video</button><button type="button" class="btn sm" data-rerun="${i}">${icon("refresh")}Quét lại</button><button type="button" class="btn sm" data-watchq="${i}">Theo dõi</button></div></td></tr>`).join("")}
      </tbody></table></div>` : `<div class="panel empty"><h2>Chưa quét gì</h2><p>Lượt quét đầu tiên bắt đầu từ trang Khám phá.</p><div class="row"><a class="btn primary" href="#/explore">Đến Khám phá</a></div></div>`}
    </section>`;
  const kindApi = (k) => (k === "keyword" ? "search" : k);
  $$("[data-see]").forEach((b) => (b.onclick = () => { const s = S.searches[+b.dataset.see]; S.filters.queries = new Set([s.query + "|" + s.platform]); S.filters.pivot = null; S.filters.platform = "all"; location.hash = "#/explore"; }));
  $$("[data-rerun]").forEach((b) => (b.onclick = async () => { const s = S.searches[+b.dataset.rerun];
    try { await api("/api/collect", { method: "POST", body: JSON.stringify({ platform: s.platform, kind: kindApi(s.kind), queries: [s.query], limit: Math.max(40, s.found), enrich: 0 }) }); toast(`Đã xếp lượt quét lại “${s.query}”.`); pollJobs(true); } catch (e) { toast(e.message, true); } }));
  $$("[data-watchq]").forEach((b) => (b.onclick = async () => { const s = S.searches[+b.dataset.watchq];
    try { await api("/api/watch", { method: "POST", body: JSON.stringify({ platform: s.platform, kind: kindApi(s.kind), query: s.query, interval_hours: 6 }) }); toast(`Đang theo dõi “${s.query}”.`); await refreshWatch(); pollJobs(true); } catch (e) { toast(e.message, true); } }));
}

// ============================================================ page: Cài đặt
async function renderSettings() {
  let s;
  try { s = await api("/api/settings"); } catch (e) { $("#main").innerHTML = `<div class="panel empty"><h2>Không tải được cài đặt</h2><p>${esc(e.message)}</p></div>`; return; }
  if (S.page !== "settings") return;
  const theme = document.documentElement.dataset.theme || "system";
  const MK = [
    ["vi", "Việt Nam", "Từ khóa tiếng Việt và cách gọi khác. Từ bạn gõ luôn được tìm."],
    ["en", "Quốc tế", "Từ khóa tiếng Anh và hashtag. YouTube tìm ở thị trường Mỹ."],
    ["zh", "Tiếng Trung", "Từ khóa tiếng Trung. YouTube tìm ở thị trường Đài Loan."],
  ];
  const est = (n) => { const lim = s.limit_per_term; const tt = n * (lim / 30) * 20, yt = n * (lim / 30) * 8; return Math.max(1, Math.round(Math.max(tt, yt) / 60)); };
  $("#main").innerHTML = `
    <div class="set-wrap">
      <a class="backlink" href="#/">${icon("back")}Trang chủ</a>
      <h1 class="set-title">Cài đặt</h1>

      <section class="set-card" aria-labelledby="hAiKey">
        <div class="set-head"><h2 id="hAiKey">AI Gemini</h2>
          ${s.gemini_key_set ? `<span class="set-badge ok">${icon("check")}Đã kết nối</span>` : `<span class="set-badge">Chưa kết nối</span>`}</div>
        <p class="set-desc">Dùng để tạo bộ từ khóa thông minh khi tìm kiếm (thay cho dịch tự động) và để phân tích nội dung video. Gói miễn phí của Google là đủ dùng cá nhân.</p>
        ${s.gemini_key_set && !R.editKey ? `
          <dl class="set-kv"><div><dt>API key</dt><dd class="num">${esc(s.gemini_key_hint)}</dd></div><div><dt>Model</dt><dd>${esc(s.gemini_model || "tự chọn")}</dd></div></dl>
          <div class="set-row"><button type="button" class="btn" id="keyChange">Đổi key</button><button type="button" class="btn ghost danger" id="keyDel">${icon("trash")}Xóa key</button></div>`
        : `<form id="keyForm" class="set-form">
            <label class="lbl" for="keyIn">API key<input class="field" id="keyIn" type="password" autocomplete="off" spellcheck="false" placeholder="Dán key, bắt đầu bằng AIza…"></label>
            <p class="set-hint">Lấy key miễn phí: vào <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>, đăng nhập Google, bấm <b>Create API key</b>. Key chỉ lưu trên máy chạy tool.</p>
            <div class="set-row"><button type="submit" class="btn primary">Kiểm tra và lưu</button>${s.gemini_key_set ? `<button type="button" class="btn ghost" id="keyCancel">Hủy</button>` : ""}</div>
          </form>`}
      </section>

      <section class="set-card" aria-labelledby="hSearch">
        <div class="set-head"><h2 id="hSearch">Tìm kiếm</h2></div>
        <p class="set-desc">Mỗi lần tìm, tool tạo bộ từ khóa theo các thị trường bạn bật dưới đây và quét từng từ khóa trên TikTok và YouTube Shorts.</p>
        <form id="searchForm" class="set-form">
          <fieldset class="mk-list"><legend class="lbl">Thị trường / ngôn ngữ</legend>
            ${MK.map(([v, t, d]) => `<label class="mk"><input type="checkbox" name="lang" value="${v}" ${s.search_langs.includes(v) ? "checked" : ""}><span class="lang ${v}">${LANG[v]}</span><span><b>${t}</b><small>${d}</small></span></label>`).join("")}
          </fieldset>
          <div class="set-grid">
            <label class="lbl" for="maxTerms">Số từ khóa tối đa mỗi lần tìm
              <select class="field" id="maxTerms">${[2, 3, 4, 5, 6, 8].map((n) => `<option value="${n}" ${s.max_terms == n ? "selected" : ""}>${n} từ khóa</option>`).join("")}</select></label>
            <label class="lbl" for="perTerm">Số video mỗi từ khóa, mỗi nguồn
              <select class="field" id="perTerm">${[20, 30, 50].map((n) => `<option value="${n}" ${s.limit_per_term == n ? "selected" : ""}>${n} video</option>`).join("")}</select></label>
          </div>
          <p class="set-hint" id="estLine">Ước tính mỗi lần tìm mới: khoảng ${est(s.max_terms)} phút.</p>
          <div class="set-row"><button type="submit" class="btn primary">Lưu cài đặt tìm kiếm</button></div>
        </form>
      </section>

      <section class="set-card" aria-labelledby="hTheme">
        <div class="set-head"><h2 id="hTheme">Giao diện</h2></div>
        <div class="seg" role="group" aria-label="Chế độ màu">${[["system", "Theo hệ thống"], ["light", "Sáng"], ["dark", "Tối"]].map(([v, t]) => `<button type="button" data-theme="${v}" aria-pressed="${theme === v}">${t}</button>`).join("")}</div>
      </section>
    </div>`;

  const kc = $("#keyChange"); if (kc) kc.onclick = () => { R.editKey = true; renderSettings(); };
  const kx = $("#keyCancel"); if (kx) kx.onclick = () => { R.editKey = false; renderSettings(); };
  const kd = $("#keyDel"); if (kd) kd.onclick = async () => {
    if (!confirm("Xóa API key Gemini? Tool sẽ quay về dịch tự động khi tạo từ khóa, và tắt phân tích AI.")) return;
    await api("/api/settings/gemini", { method: "DELETE" }); toast("Đã xóa API key Gemini."); renderSettings();
  };
  const kf = $("#keyForm"); if (kf) kf.onsubmit = async (e) => {
    e.preventDefault();
    const key = $("#keyIn").value.trim(); if (!key) { $("#keyIn").focus(); return; }
    const b = kf.querySelector("button[type=submit]"); b.disabled = true; b.textContent = "Đang kiểm tra…";
    try { const r = await api("/api/settings/gemini", { method: "POST", body: JSON.stringify({ key }) }); R.editKey = false; toast(`Đã kết nối Gemini (${r.model}).`); renderSettings(); }
    catch (err) { b.disabled = false; b.textContent = "Kiểm tra và lưu"; toast(err.message, true); }
  };
  const sf = $("#searchForm");
  const upd = () => { $("#estLine").textContent = `Ước tính mỗi lần tìm mới: khoảng ${est(+$("#maxTerms").value)} phút.`; };
  $("#maxTerms").onchange = upd; $("#perTerm").onchange = () => { s.limit_per_term = +$("#perTerm").value; upd(); };
  sf.onsubmit = async (e) => {
    e.preventDefault();
    const langs = $$("input[name=lang]:checked", sf).map((i) => i.value);
    if (!langs.length) { toast("Bật ít nhất một thị trường.", true); return; }
    try { await api("/api/settings", { method: "POST", body: JSON.stringify({ search_langs: langs, max_terms: +$("#maxTerms").value, limit_per_term: +$("#perTerm").value }) });
      toast("Đã lưu. Áp dụng từ lần tìm tiếp theo."); renderSettings(); }
    catch (err) { toast(err.message, true); }
  };
  $$("[data-theme]").forEach((b) => (b.onclick = () => { setTheme(b.dataset.theme); renderSettings(); }));
}

// ============================================================ drawer: chi tiết video
function openVideo(id, push = true) {
  const v = S.byId.get(id);
  if (!v) return;
  S.drawerVideo = id;
  if (push) { const h = `#/${S.page}?video=${encodeURIComponent(id)}`; if (location.hash !== h) history.pushState(null, "", h); }
  if (!$("#drawer").classList.contains("open")) S.lastFocus = document.activeElement;
  const l = level(v.virality);
  const tags = (v.hashtags || "").split(/\s+/).filter(Boolean).slice(0, 24);
  const prods = (v.products || "").split(" | ").filter(Boolean);
  const watched = isWatched(v);
  const xf = v.x_followers;
  const why = xf == null ? "Chưa có số follower của kênh nên chưa chấm được tín hiệu."
    : xf >= 1 ? `Lượt xem gấp ${lan(xf)} số follower của kênh${v.outlier != null ? `, và gấp ${lan(v.outlier)} mức view thường ngày của kênh` : ""}.`
    : "Lượt xem chưa vượt số follower của kênh.";
  const d = $("#drawer");
  d.hidden = false;
  d.innerHTML = `
    <div class="drawer-head"><span class="plat"><i class="pdot ${v.platform}"></i>${PLAT_LONG[v.platform]}</span><h2 id="drawerTitle" style="font-size:15px;font-weight:600">Chi tiết video</h2>
      <button type="button" class="btn ghost icon" id="dClose" aria-label="Đóng chi tiết" style="margin-left:auto">${icon("x")}</button></div>
    <div class="drawer-body">
      <div class="d-top">
        <a class="thumb" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer" aria-label="Mở video trên ${PLAT_LONG[v.platform]}"><div class="ph">${esc((v.caption || "").slice(0, 60))}</div>${v.cover ? `<img src="${esc(v.cover)}" alt="" width="148" height="263" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<div class="shade"></div><span class="bl views num" style="font-size:18px">${nC(v.views)}</span></a>
        <div class="d-score">
          <span class="tier">${v.virality == null ? "Chưa chấm" : TIER[l]}</span>
          <div class="sig-big"><span class="score num">${v.virality == null ? "–" : Math.round(v.virality)}</span>${sig(l)}</div>
          <p>${why}</p>
          <div class="d-actions"><a class="btn primary" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${icon("play")}Mở trên ${PLAT[v.platform]}</a><a class="btn" href="${esc(profileUrl(v))}" target="_blank" rel="noopener noreferrer">${icon("user")}Xem kênh</a></div>
        </div>
      </div>
      <dl class="kv num">
        <div><dt>Lượt xem</dt><dd>${nN(v.views)}</dd></div>
        <div><dt>Follower</dt><dd>${nN(v.followers)}</dd></div>
        <div><dt>Lần follower</dt><dd class="${(xf ?? 0) >= 20 ? "hot" : ""}">${times(xf)}</dd></div>
        <div><dt>Outlier</dt><dd class="${(v.outlier ?? 0) >= 3 ? "hot" : ""}">${v.outlier == null ? `<button type="button" class="btn sm" id="dEnrich">Tính</button>` : times(v.outlier)}</dd></div>
        <div><dt>Tương tác</dt><dd class="${(v.engagement ?? 0) >= 0.05 ? "hot" : ""}">${pct(v.engagement)}</dd></div>
        <div><dt>View mỗi giờ</dt><dd>${nC(v.views_per_hour)}</dd></div>
        <div><dt>Thích</dt><dd>${nC(v.likes)}</dd></div>
        <div><dt>Bình luận</dt><dd>${nC(v.comments)}</dd></div>
        <div><dt>${v.platform === "tiktok" ? "Chia sẻ" : "Đăng"}</dt><dd>${v.platform === "tiktok" ? nC(v.shares) : ageText(v.age_days)}</dd></div>
      </dl>
      <div class="d-sec hist" id="dHist"><h3>Lượt xem qua các lần quét</h3><p class="muted" style="font-size:13px">Đang tải…</p></div>
      <div class="d-sec"><h3>Caption</h3><p class="full">${esc(v.caption) || '<span class="muted">Không có caption</span>'}</p>
        <p class="muted" style="font-size:12px;margin-top:6px">Đăng ${ageText(v.age_days)}${v.created_at ? `, ${DTF.format(new Date(v.created_at * 1000))}` : ""}${v.duration ? `, dài ${dur(v.duration)}` : ""}${v.is_ad ? ". Có nhãn tài trợ" : ""}.</p></div>
      ${tags.length ? `<div class="d-sec"><h3>Hashtag</h3><div class="tags">${tags.map((t) => `<button type="button" data-dpivot="hashtag" data-value="${esc(t.toLowerCase())}" data-label="${esc(t.toLowerCase())}">#${esc(t)}</button>`).join("")}</div></div>` : ""}
      ${musicKey(v) ? `<div class="d-sec"><h3>Âm thanh</h3><div class="tags"><button type="button" data-dpivot="music" data-value="${esc(musicKey(v))}" data-label="${esc(v.music_title)}">${esc(musicKey(v))}</button></div></div>` : ""}
      ${prods.length ? `<div class="d-sec"><h3>Sản phẩm TikTok Shop</h3><div class="tags">${prods.map((p) => `<button type="button" data-dpivot="product" data-value="${esc(p)}" data-label="${esc(p)}">${esc(p)}</button>`).join("")}</div></div>` : ""}
      ${v.queries.length ? `<div class="d-sec"><h3>Tìm thấy qua</h3><p>${v.queries.map((q) => esc(q.split("|")[0])).join(", ")}</p></div>` : ""}
      <div class="d-sec"><h3>Kênh @${esc(v.username)}</h3><p class="muted" style="font-size:13px;margin-bottom:10px">${v.median_views != null ? `Mức view thường ngày của kênh khoảng ${nC(v.median_views)}.` : "Chưa tính mức view thường ngày của kênh."}</p>
        <div class="d-actions"><button type="button" class="btn" id="dFollow" ${watched ? "disabled" : ""}>${icon("watch")}${watched ? "Đang theo dõi" : "Theo dõi kênh"}</button><button type="button" class="btn" data-dpivot="creator" data-value="${esc(v.platform + "|" + v.creator_id)}" data-label="@${esc(v.username)}">Xem video khác của kênh</button></div></div>
    </div>`;
  requestAnimationFrame(() => { d.classList.add("open"); $("#scrim").classList.add("open"); });
  $("#dClose").focus({ preventScroll: true });
  $("#dClose").onclick = closeVideo;
  const de = $("#dEnrich"); if (de) de.onclick = () => enrich(v);
  $("#dFollow").onclick = async (e) => { if (await follow(v)) { e.target.closest("button").disabled = true; e.target.closest("button").lastChild.textContent = "Đang theo dõi"; } };
  $$("[data-dpivot]", d).forEach((b) => (b.onclick = () => { S.filters.pivot = { type: b.dataset.dpivot, value: b.dataset.value, label: b.dataset.label }; S.shown = 48; closeVideo(false); location.hash = "#/explore"; if (S.page === "explore") renderExplore(); }));
  api(`/api/videos/${encodeURIComponent(id)}/snapshots`).then((snaps) => { if (S.drawerVideo === id) drawHistory(snaps); }).catch(() => {});
}
function drawHistory(snaps) {
  const el = $("#dHist");
  if (!el) return;
  if (snaps.length < 2) { el.innerHTML = `<h3>Lượt xem qua các lần quét</h3><p class="muted" style="font-size:13px">Mới quét một lần. Quét lại từ khóa này sau từ 30 phút để thấy tốc độ tăng, hoặc theo dõi kênh để tool tự quét.</p>`; return; }
  const W = 470, H = 120, m = { l: 44, r: 12, t: 10, b: 22 };
  const t0 = snaps[0].ts, t1 = snaps.at(-1).ts;
  const vmin = Math.min(...snaps.map((s) => s.views)), vmax = Math.max(...snaps.map((s) => s.views));
  const sx = (t) => m.l + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const sy = (v) => H - m.b - (vmax === vmin ? 0.5 : (v - vmin) / (vmax - vmin)) * (H - m.t - m.b);
  const path = snaps.map((s, i) => `${i ? "L" : "M"}${sx(s.ts).toFixed(1)} ${sy(s.views).toFixed(1)}`).join("");
  const gain = snaps.at(-1).views - snaps[0].views;
  const spanH = (t1 - t0) / 3600;
  const spanTxt = spanH < 1 ? `${Math.round(spanH * 60)} phút` : spanH < 48 ? `${NF_1.format(spanH)} giờ` : `${Math.round(spanH / 24)} ngày`;
  el.innerHTML = `<h3>Lượt xem qua các lần quét</h3><p class="muted" style="font-size:13px;margin-bottom:6px">Tăng <b class="num" style="color:var(--ink)">${nN(gain)}</b> view qua ${snaps.length} lần quét trong ${spanTxt}.${gain === 0 && v0Rounded(snaps) ? " TikTok làm tròn số view trong kết quả tìm kiếm nên thay đổi nhỏ có thể chưa hiện." : ""}</p>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lượt xem tăng ${nN(gain)} qua ${snaps.length} lần quét">
      <line x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/><line x1="${m.l}" x2="${W - m.r}" y1="${m.t}" y2="${m.t}"/>
      <text x="${m.l - 6}" y="${m.t + 4}" text-anchor="end">${NF_C.format(vmax)}</text><text x="${m.l - 6}" y="${H - m.b + 4}" text-anchor="end">${NF_C.format(vmin)}</text>
      <text x="${m.l}" y="${H - 4}">${DTF.format(new Date(t0 * 1000))}</text><text x="${W - m.r}" y="${H - 4}" text-anchor="end">${DTF.format(new Date(t1 * 1000))}</text>
      <path class="line" d="${path}"/>${snaps.map((s) => `<circle cx="${sx(s.ts).toFixed(1)}" cy="${sy(s.views).toFixed(1)}" r="4"><title>${DTF.format(new Date(s.ts * 1000))}: ${nN(s.views)} view</title></circle>`).join("")}
    </svg>`;
}
function v0Rounded(snaps) { return snaps.every((s) => s.views >= 10000 && s.views % 100 === 0); }
function closeVideo(push = true) {
  const d = $("#drawer");
  if (!d.classList.contains("open")) return;
  d.classList.remove("open"); $("#scrim").classList.remove("open");
  S.drawerVideo = null;
  setTimeout(() => { if (!d.classList.contains("open")) d.hidden = true; }, 260);
  if (push && /[?&]video=/.test(location.hash)) history.pushState(null, "", `#/${S.page}`);
  if (S.lastFocus && document.contains(S.lastFocus)) S.lastFocus.focus({ preventScroll: true });
}
$("#scrim").onclick = () => closeVideo();
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#drawer").classList.contains("open")) closeVideo();
  if (e.key === "Tab" && $("#drawer").classList.contains("open")) { // giữ focus trong panel
    const f = $$('#drawer a[href], #drawer button:not([disabled])'); if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-video]");
  if (a && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); openVideo(a.dataset.video); return; }
  const o = e.target.closest("[data-open]"); if (o) { openVideo(o.dataset.open); return; }
  const f = e.target.closest("[data-follow]"); if (f) { const v = S.byId.get(f.dataset.follow); follow(v).then((ok) => { if (ok) { f.disabled = true; f.textContent = "Đang theo dõi"; } }); return; }
  const en = e.target.closest("[data-enrich]"); if (en) { enrich(S.byId.get(en.dataset.enrich)); en.disabled = true; en.textContent = "Đang tính…"; }
});

// ============================================================ jobs + toast
let pollTimer = null, lastActive = new Set();
async function pollJobs(soon = false) {
  clearTimeout(pollTimer);
  try { S.jobs = await api("/api/jobs"); } catch (e) { pollTimer = setTimeout(pollJobs, 10000); return; }
  const active = S.jobs.filter((j) => j.status === "running" || j.status === "queued");
  const finished = S.jobs.filter((j) => lastActive.has(j.id) && (j.status === "done" || j.status === "error"));
  lastActive = new Set(active.map((j) => j.id));
  const mini = $("#jobMini");
  if (active.length) {
    const run = active.find((j) => j.status === "running") || active[0];
    const last = (run.log.at(-1) || "Đang chuẩn bị…").replace(/^\s+/, "");
    mini.classList.add("on");
    mini.innerHTML = `<span class="spin" aria-hidden="true"></span><div><b>${run.status === "running" ? "Đang quét" : "Đang chờ"}: ${esc(run.label)}</b><span>${esc(last)}</span>${active.length > 1 ? `<span>Còn ${active.length - 1} lượt chờ</span>` : ""}</div>`;
  } else { mini.classList.remove("on"); mini.innerHTML = ""; }
  if (finished.length && ["home", "search", "video"].includes(S.page)) { /* trang tìm kiếm tự cập nhật */ }
  else if (finished.length) {
    await loadData();
    for (const j of finished) toast(j.status === "done" ? `Quét xong: ${j.label}.` : `Lượt quét “${j.label}” gặp lỗi. Xem nhật ký ở Lịch sử quét.`, j.status === "error");
    if (!S.drawerVideo) render(); else if (S.page === "history") renderHistory();
  } else if (S.page === "history") renderHistory();
  pollTimer = setTimeout(pollJobs, active.length || soon ? 2000 : 10000);
}
function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.setAttribute("role", err ? "alert" : "status");
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Đóng thông báo">Đóng</button>`;
  t.querySelector("button").onclick = () => t.remove();
  $("#toasts").append(t);
  if (!err) setTimeout(() => t.remove(), 6000);
}

// ============================================================ theme
function setTheme(mode) {
  if (mode === "system") { delete document.documentElement.dataset.theme; try { localStorage.removeItem("vr-theme"); } catch (e) {} }
  else { document.documentElement.dataset.theme = mode; try { localStorage.setItem("vr-theme", mode); } catch (e) {} }
  syncThemeBtn();
  if (S.page === "explore" && S.view === "map") renderExplore();
}
function isDark() { const t = document.documentElement.dataset.theme; return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches; }
function syncThemeBtn() {
  const b = $("#themeBtn"), dark = isDark();
  b.innerHTML = `${icon(dark ? "sun" : "moon")}<span>${dark ? "Giao diện sáng" : "Giao diện tối"}</span>`;
  const b2 = $("#themeBtn2"); b2.innerHTML = icon(dark ? "sun" : "moon"); b2.setAttribute("aria-label", dark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối");
}
$("#themeBtn").onclick = () => setTheme(isDark() ? "light" : "dark");
$("#themeBtn2").onclick = () => setTheme(isDark() ? "light" : "dark");
$("#topSearch").onsubmit = (e) => { e.preventDefault(); goSearch($("#topQ").value); };
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeBtn);

// ============================================================ BẢN ĐƠN GIẢN: trang chủ → kết quả → phân tích video
const R = { q: "", data: null, poll: null, sort: "virality", platform: "all", days: 100000, term: "", market: "all", editTerms: null, autoStarted: new Set() };
const searchHref = (q) => `#/search?q=${encodeURIComponent(q)}`;
const videoHref = (id, q) => `#/video/${encodeURIComponent(id)}${q ? `?q=${encodeURIComponent(q)}` : ""}`;
function goSearch(q) { q = q.trim(); if (!q) return; R.autoStarted.delete(q.toLowerCase()); R.fresh = q.toLowerCase(); location.hash = searchHref(q); }

async function renderHome() {
  const main = $("#main");
  main.innerHTML = `<section class="home">
      <span class="badge-pill"><i></i>Quét TikTok và YouTube Shorts cùng lúc</span>
      <h1>Video nào đang viral trong <em>ngách của bạn?</em></h1>
      <p class="lead">Gõ chủ đề bạn làm content. Viral Radar tìm những video vượt xa lượng follower của kênh và giải thích vì sao chúng nổi.</p>
      <div class="search-card">
        <form class="bigsearch" id="homeForm" role="search">
          <label class="sr-only" for="homeQ">Chủ đề cần tìm</label>
          <input id="homeQ" name="q" type="search" autocomplete="off" spellcheck="false" placeholder="${matchMedia("(max-width: 520px)").matches ? "Ví dụ: chó cưng, review son…" : "Ví dụ: chó cưng, review son, nồi chiên không dầu…"}">
          <button type="submit" class="btn pill">Tìm video<span class="arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></button>
        </form>
        <p class="hint-line">Mỗi lần tìm mới mất khoảng 1 phút.</p>
        <div class="try"><span>Thử</span>${["chó cưng", "review son", "nồi chiên không dầu", "skincare cho da dầu"].map((t) => `<a href="${searchHref(t)}" data-try="${esc(t)}">${esc(t)}</a>`).join("")}</div>
      </div>
      <div class="recent" id="recent"></div>
    </section>`;
  $("#homeForm").onsubmit = (e) => { e.preventDefault(); goSearch($("#homeQ").value); };
  $$("[data-try]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); goSearch(a.dataset.try); }));
  if (matchMedia("(pointer: fine)").matches) $("#homeQ").focus();
  try {
    const rec = await api("/api/recent");
    if (rec.length && S.page === "home") $("#recent").innerHTML = `<h2>Bạn đã tìm gần đây</h2><div class="tags">${rec.map((r) => `<a href="${searchHref(r.q)}">${esc(r.q)}</a>`).join("")}</div>`;
  } catch (e) { /* bỏ qua */ }
}

const LANG = { vi: "VI", en: "EN", zh: "中文" };
const LANG_NAME = { vi: "Việt Nam", en: "Quốc tế", zh: "Tiếng Trung" };
const busy = (d) => !!(d && d.scanning);

function cellStatus(s) {
  if (!s || s.state === "none") return `<span class="ts muted">chưa quét</span>`;
  if (s.state === "wait") return `<span class="ts muted">đang chờ</span>`;
  if (s.state === "run") return `<span class="ts run"><span class="spin" aria-hidden="true"></span>${s.count ? `${s.count} video` : "đang tìm"}</span>`;
  if (s.state === "error") return `<span class="ts err">${icon("alert")}lỗi</span>`;
  return `<span class="ts ok">${icon("check")}${s.count != null ? `${s.count} video` : "xong"}</span>`;
}

function progressInfo(d) {
  const done = d.terms.reduce((n, t) => n + PLATFORMS_UI.filter((p) => ["done", "error"].includes(t.status[p]?.state)).length, 0);
  const total = d.terms.length * PLATFORMS_UI.length;
  const phase = d.phase === "expanding" ? "Đang tạo bộ từ khóa liên quan…" : `Đã quét ${done}/${total} lượt (mỗi từ khóa quét trên TikTok và YouTube Shorts)`;
  const pctDone = d.phase === "expanding" ? 4 : Math.max(6, Math.round((done / Math.max(total, 1)) * 100));
  const terms = d.phase === "expanding" ? "" : d.terms.map((t) => `<span class="lang ${t.lang}">${LANG[t.lang] || ""}</span>${esc(t.term)}`).join(`<span class="sep"></span>`);
  return { phase, pctDone, terms };
}
// Khối tiến độ: chiều cao cố định, nhật ký cuộn bên trong (không đẩy trang xuống)
function progressPanel(d) {
  const p = progressInfo(d);
  return `<section class="progress" id="progress" aria-labelledby="hProg">
    <div class="prog-head"><h2 id="hProg">Đang tìm video về “${esc(d.q)}”</h2><p id="progPhase" aria-live="polite">${p.phase}</p></div>
    <div class="bar" role="progressbar" aria-label="Tiến độ quét" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.pctDone}"><i id="progBar" style="width:${p.pctDone}%"></i></div>
    <p class="prog-terms" id="progTerms">${p.terms}</p>
    <p class="human" id="progHuman" ${d.needs_human ? "" : "hidden"}>${icon("alert")}<span>TikTok cần xác minh: một cửa sổ Chrome vừa hiện lên, hãy giải captcha trong đó. Giải xong tool tự quét tiếp.</span></p>
    <div class="logbox"><div class="log-title">Nhật ký</div><ol id="progLog" tabindex="0" aria-label="Nhật ký quét"></ol></div>
    <p class="prog-note">Video sẽ hiện khi quét xong. Bạn có thể mở trang khác, quét vẫn chạy tiếp.</p>
  </section>`;
}
function updateProgress(d) {
  const p = progressInfo(d);
  $("#progPhase").textContent = p.phase;
  $("#progBar").style.width = p.pctDone + "%";
  $("#progBar").parentElement.setAttribute("aria-valuenow", p.pctDone);
  $("#progTerms").innerHTML = p.terms;
  $("#progHuman").hidden = !d.needs_human;
  const ol = $("#progLog");
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 24; // chỉ tự cuộn nếu người dùng đang ở cuối
  const lines = d.log.length ? d.log : ["Đang khởi động…"];
  ol.innerHTML = lines.map((l) => `<li>${esc(l)}</li>`).join("");
  if (atBottom || !ol.dataset.init) { ol.scrollTop = ol.scrollHeight; ol.dataset.init = "1"; }
}

function termsBar(d) {
  const total = (t) => (t.found.tiktok || 0) + (t.found.youtube || 0);
  const src = { ai: "do AI tạo", "dịch": "dịch tự động", "người dùng": "bạn đã chỉnh", "gốc": "" }[d.term_source] || "";
  if (R.editTerms) {
    return `<form class="terms-edit" id="termsForm"><div class="row-between"><b>Sửa bộ từ khóa</b><span class="muted">Tối đa 8 từ khóa. Mỗi từ khóa quét một lượt trên mỗi nguồn.</span></div>
      <div class="chips-input" id="tChips">${R.editTerms.map((t, i) => `<span class="qchip">${esc(t)}<button type="button" data-trm="${i}" aria-label="Bỏ ${esc(t)}">${icon("x")}</button></span>`).join("")}
        <label class="sr-only" for="tInput">Thêm từ khóa</label><input id="tInput" autocomplete="off" spellcheck="false" placeholder="Thêm từ khóa rồi Enter…"></div>
      <div class="row"><button type="submit" class="btn primary">Tìm lại với bộ từ khóa này</button><button type="button" class="btn ghost" id="tCancel">Hủy</button></div></form>`;
  }
  return `<div class="terms-bar"><span class="muted">Từ khóa${src ? ` (${src})` : ""}:</span>
    <button type="button" class="tchip ${!R.term ? "on" : ""}" data-term="">Tất cả</button>
    ${d.terms.map((t) => `<button type="button" class="tchip ${R.term === t.term ? "on" : ""}" data-term="${esc(t.term)}"><span class="lang ${t.lang}">${LANG[t.lang] || ""}</span>${esc(t.term)}<span class="n num">${total(t)}</span></button>`).join("")}
    ${d.scanning ? "" : `<button type="button" class="btn ghost sm" id="editTerms">Sửa từ khóa</button>`}</div>`;
}

async function renderSearch(q) {
  const key = q.trim().toLowerCase();
  if (R.q !== q) { R.q = q; R.data = null; R.term = ""; R.market = "all"; R.editTerms = null; }
  $("#topQ").value = q;
  clearTimeout(R.poll);
  let d;
  try { d = await api(`/api/search?q=${encodeURIComponent(q)}`); } catch (e) { $("#main").innerHTML = `<div class="panel empty"><h2>Không tải được kết quả</h2><p>${esc(e.message)}</p></div>`; return; }
  if (S.page !== "search" || R.q !== q) return;
  // Tìm mới (bấm Tìm) -> quét nếu lần quét gần nhất đã quá 30 phút. Mở lại link cũ -> chỉ quét nếu chưa có gì.
  const last = Math.max(0, ...Object.values(d.sources).map((s) => s.last_ran || 0));
  const stale = !last || Date.now() / 1000 - last > 1800;
  const wantScan = R.fresh === key ? stale : !d.videos.length;
  if (wantScan && !d.scanning && !R.autoStarted.has(key)) {
    R.autoStarted.add(key); R.fresh = null;
    try { await api("/api/search", { method: "POST", body: JSON.stringify({ q }) }); d = await api(`/api/search?q=${encodeURIComponent(q)}`); }
    catch (e) { toast(e.message, true); }
  }
  R.fresh = null;
  const wasBusy = busy(R.data);
  R.data = d;
  d.videos.forEach((v) => S.byId.set(v.id, v));
  drawSearch();
  if (busy(d)) R.poll = setTimeout(() => renderSearch(q), 2000);
  else if (wasBusy) toast(`Đã quét xong “${q}”: ${nN(d.videos.length)} video từ ${d.terms.length} từ khóa.`);
}

function drawSearch() {
  const d = R.data, q = R.q;
  // Đang quét: chỉ hiện khối tiến độ. Lần đầu vẽ khối, các lần sau chỉ cập nhật bên trong (giữ vị trí cuộn).
  if (d.scanning) {
    if (!$("#progress")) { $("#main").innerHTML = progressPanel(d); window.scrollTo(0, 0); }
    updateProgress(d);
    return;
  }
  let rows = d.videos.filter((v) => !v.is_ad && (R.platform === "all" || v.platform === R.platform) &&
    (v.age_days == null || v.age_days <= R.days) && (!R.term || v.terms.includes(R.term)) &&
    (R.market === "all" || v.markets.includes(R.market)));
  const k = R.sort;
  rows.sort((a, b) => (b[k] ?? -Infinity) - (a[k] ?? -Infinity));
  const strong = rows.filter((v) => level(v.virality) >= 2).length;
  const last = Math.max(0, ...Object.values(d.sources).map((s) => s.last_ran || 0));
  let body;
  if (!d.videos.length) {
    body = `<div class="panel empty"><h2>Chưa tìm thấy video nào cho “${esc(q)}”</h2><p>Thử từ khóa ngắn hơn, hoặc bấm Sửa từ khóa để thêm cách gọi khác.</p><div class="row"><button type="button" class="btn primary" id="rescan">${icon("refresh")}Quét lại</button></div></div>`;
  } else if (!rows.length) {
    body = `<div class="panel empty"><h2>Không có video khớp lựa chọn</h2><p>Chọn “Tất cả” từ khóa, “Mọi thị trường” hoặc “Mọi lúc” để xem thêm.</p></div>`;
  } else {
    body = `<div class="wall">${rows.slice(0, S.shown).map((v) => card(v).replace(/href="#\/[^"]*\?video=([^"]+)" data-video="[^"]*"/, () => `href="${videoHref(v.id, q)}"`)).join("")}</div>
      ${rows.length > S.shown ? `<div class="more"><button type="button" class="btn" id="moreBtn">Xem thêm ${nN(Math.min(48, rows.length - S.shown))} video</button></div>` : ""}`;
  }
  const markets = [...new Set(d.terms.map((t) => t.lang))];
  $("#main").innerHTML = `
    <div class="results-head">
      <div><div class="headline"><span class="big num">${nN(strong || rows.length)}</span><span class="big-label">${strong ? "video đang viral" : "video"} về “${esc(q)}”</span></div>
      <p class="subline">Trong <b class="num">${nN(d.videos.length)}</b> video tìm được trên TikTok và YouTube Shorts.${last ? ` Quét lần cuối ${ago(last)}.` : ""} Bấm vào video để xem phân tích.</p></div>
      ${d.videos.length ? `<button type="button" class="btn ghost sm" id="rescan2" title="Quét lại để cập nhật số liệu">${icon("refresh")}Quét lại</button>` : ""}
    </div>
    ${termsBar(d)}
    ${d.videos.length ? `<div class="controls">
      <div class="seg" role="group" aria-label="Nguồn">${["all", "tiktok", "youtube"].map((p) => `<button type="button" data-rp="${p}" aria-pressed="${R.platform === p}">${p === "all" ? "Mọi nguồn" : `<i class="pdot ${p}"></i>${PLAT[p]}`}</button>`).join("")}</div>
      ${markets.length > 1 ? `<label class="sr-only" for="rMarket">Thị trường</label><select class="field" id="rMarket"><option value="all">Mọi thị trường</option>${markets.map((m) => `<option value="${m}" ${R.market === m ? "selected" : ""}>${LANG_NAME[m]}</option>`).join("")}</select>` : ""}
      <label class="sr-only" for="rDays">Thời gian đăng</label>
      <select class="field" id="rDays">${[[100000, "Mọi lúc"], [30, "30 ngày qua"], [7, "7 ngày qua"]].map(([v, t]) => `<option value="${v}" ${R.days == v ? "selected" : ""}>${t}</option>`).join("")}</select>
      <label class="sr-only" for="rSort">Sắp xếp</label>
      <select class="field" id="rSort">${[["virality", "Viral nhất"], ["views", "Nhiều view nhất"], ["engagement", "Tương tác cao nhất"], ["created_at", "Mới đăng nhất"]].map(([v, t]) => `<option value="${v}" ${R.sort === v ? "selected" : ""}>${t}</option>`).join("")}</select>
    </div>` : ""}
    ${body}`;
  $$("[data-rp]").forEach((b) => (b.onclick = () => { R.platform = b.dataset.rp; S.shown = 48; drawSearch(); }));
  $$("[data-term]").forEach((b) => (b.onclick = () => { R.term = b.dataset.term; S.shown = 48; drawSearch(); }));
  const rm = $("#rMarket"); if (rm) rm.onchange = (e) => { R.market = e.target.value; S.shown = 48; drawSearch(); };
  const rd = $("#rDays"); if (rd) rd.onchange = (e) => { R.days = +e.target.value; S.shown = 48; drawSearch(); };
  const rs = $("#rSort"); if (rs) rs.onchange = (e) => { R.sort = e.target.value; S.shown = 48; drawSearch(); };
  const m = $("#moreBtn"); if (m) m.onclick = () => { S.shown += 48; drawSearch(); };
  const startScan = async (terms) => {
    try { await api("/api/search", { method: "POST", body: JSON.stringify(terms ? { q, terms } : { q }) }); R.editTerms = null; renderSearch(q); }
    catch (e) { toast(e.message, true); }
  };
  [$("#rescan"), $("#rescan2")].forEach((b) => b && (b.onclick = () => startScan()));
  const et = $("#editTerms"); if (et) et.onclick = () => { R.editTerms = d.terms.map((t) => t.term); drawSearch(); $("#tInput").focus(); };
  const form = $("#termsForm");
  if (form) {
    const inp = $("#tInput");
    const add = () => { const v = inp.value.trim().toLowerCase(); if (v && !R.editTerms.includes(v) && R.editTerms.length < 8) R.editTerms.push(v); inp.value = ""; };
    inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) { e.preventDefault(); add(); drawSearch(); $("#tInput").focus(); } };
    $("#tChips").onclick = (e) => { const b = e.target.closest("[data-trm]"); if (b) { R.editTerms.splice(+b.dataset.trm, 1); drawSearch(); $("#tInput").focus(); } };
    $("#tCancel").onclick = () => { R.editTerms = null; drawSearch(); };
    form.onsubmit = (e) => { e.preventDefault(); add(); if (!R.editTerms.length) { toast("Cần ít nhất một từ khóa."); return; } startScan(R.editTerms); };
  }
}
const PLATFORMS_UI = ["tiktok", "youtube"];

// ---------- phân tích video (dựa trên số liệu, so với các video cùng kết quả tìm)
function median(a) { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }
function pctRank(arr, v) { const s = arr.filter((x) => x != null); if (!s.length || v == null) return null; return s.filter((x) => x <= v).length / s.length; }
const FORMATS = [
  [/review|đánh giá|trải nghiệm|dùng thử|test thử/i, "Review / dùng thử"],
  [/unbox|đập hộp|mở hộp/i, "Đập hộp"],
  [/\bpov\b/i, "POV, nhập vai"],
  [/cách |hướng dẫn|mẹo|tips?\b|how to|tutorial|bí quyết/i, "Hướng dẫn, mẹo"],
  [/trước.{0,6}sau|before.{0,6}after/i, "Trước và sau"],
  [/\btop ?\d|\d+ (món|cách|điều|lý do|loại|bước)/i, "Danh sách"],
  [/hài|funny|cười|meme|troll|prank/i, "Hài hước"],
  [/vlog|một ngày|a day in/i, "Vlog"],
  [/grwm|get ready|makeup|trang điểm/i, "Làm đẹp, GRWM"],
  [/asmr/i, "ASMR"],
  [/nấu|công thức|recipe|món ngon|làm bánh/i, "Nấu ăn"],
  [/cún|chó|mèo|\bpet\b|\bdog|\bcat\b|puppy|kitten|samoyed|corgi|husky/i, "Thú cưng"],
  [/baby|em bé|con tôi|bé nhà/i, "Em bé, gia đình"],
  [/sale|giảm giá|deal|voucher|giá rẻ|chỉ \d/i, "Khuyến mãi, giá rẻ"],
];
function analyze(v, cohort) {
  const C = cohort.filter((x) => x.id !== v.id && x.views > 0);
  const out = { finds: [], tips: [] };
  const lvlOf = (r) => (r == null ? "mid" : r >= 0.75 ? "hi" : r <= 0.3 ? "lo" : "mid");
  const lvlTxt = { hi: "Nổi bật", mid: "Trung bình", lo: "Thấp" };
  const rate = (x, key) => (x.views ? (x[key] || 0) / x.views : null);

  // 1. vượt follower
  if (v.x_followers != null) {
    const r = pctRank(C.map((x) => x.x_followers), v.x_followers);
    out.finds.push({ l: v.x_followers >= 20 ? "hi" : v.x_followers >= 3 ? "mid" : "lo", h: `Lượt xem gấp ${lan(v.x_followers)} số follower`,
      p: v.x_followers >= 20 ? `Video được thuật toán đẩy ra xa ngoài tệp người theo dõi${r != null ? `, cao hơn ${PCT.format(r)} video cùng chủ đề` : ""}. Đây là dấu hiệu viral rõ nhất.`
        : v.x_followers >= 1 ? "Video vượt tệp follower nhưng chưa bùng nổ mạnh." : "Lượt xem còn thấp hơn số follower, chủ yếu đến từ người đã theo dõi kênh." });
  }
  if (v.outlier != null) out.finds.push({ l: v.outlier >= 3 ? "hi" : "mid", h: `Gấp ${lan(v.outlier)} mức view thường ngày của kênh`, p: v.outlier >= 3 ? "Kênh này bình thường không đạt được mức này, nên chính nội dung video mới là lý do, không phải sức mạnh của kênh." : "Gần với mức thường ngày của kênh." });

  // 2. tốc độ
  const perDay = v.age_days ? v.views / Math.max(v.age_days, 0.04) : null;
  if (perDay != null) {
    const r = pctRank(C.map((x) => (x.age_days ? x.views / Math.max(x.age_days, 0.04) : null)), perDay);
    out.finds.push({ l: lvlOf(r), h: `Trung bình ${nC(perDay)} lượt xem mỗi ngày`, p: `Đăng ${ageText(v.age_days)}.${r != null ? ` Nhanh hơn ${PCT.format(r)} video cùng chủ đề.` : ""}${v.velocity_source === "snapshot" ? ` Giữa hai lần quét gần nhất tăng khoảng ${nC(v.views_per_hour)} view mỗi giờ.` : ""}` });
  }

  // 3. tương tác chi tiết
  const metrics = [["likes", "Thích"], ["comments", "Bình luận"], ["shares", "Chia sẻ"], ["saves", "Lưu"]].filter(([k]) => v.platform === "tiktok" || k === "likes" || k === "comments");
  const rows = metrics.map(([k, t]) => ({ k, t, me: rate(v, k), base: median(C.filter((x) => x.platform === v.platform).map((x) => rate(x, k))) }));
  const eRank = pctRank(C.map((x) => x.engagement), v.engagement);
  const notes = [];
  for (const r of rows) {
    if (r.me == null || r.base == null || !r.base) continue;
    const ratio = r.me / r.base;
    if (r.k === "shares" && ratio >= 1.5) notes.push("tỉ lệ chia sẻ cao, người xem gửi video cho bạn bè nên video lan rộng");
    if (r.k === "saves" && ratio >= 1.5) notes.push("tỉ lệ lưu cao, nội dung có ích nên người xem giữ lại để xem sau");
    if (r.k === "comments" && ratio >= 1.5) notes.push("nhiều bình luận, nội dung gây tò mò hoặc tranh luận");
    if (r.k === "likes" && ratio <= 0.6) notes.push("tỉ lệ thích thấp, video có thể nổi nhờ âm thanh hoặc được đề xuất hơn là nội dung");
  }
  out.finds.push({ l: lvlOf(eRank), h: `Tương tác ${pct(v.engagement)} lượt xem`, p: (notes.length ? notes.map((n, i) => (i ? n : n[0].toUpperCase() + n.slice(1))).join("; ") + "." : "Mức tương tác gần với các video cùng chủ đề."),
    table: rows.filter((r) => r.me != null) });

  // 4. nội dung
  const text = `${v.caption || ""} ${v.hashtags || ""}`;
  const formats = FORMATS.filter(([re]) => re.test(text)).map(([, n]) => n).slice(0, 3);
  const hookQ = /\?/.test(v.caption || "");
  out.finds.push({ l: "mid", h: formats.length ? `Dạng nội dung: ${formats.join(", ")}` : "Chưa đoán được dạng nội dung từ caption",
    p: `${formats.length ? "Đoán từ caption và hashtag. " : "Caption quá ngắn hoặc chỉ có hashtag, hãy xem video để biết cách mở đầu. "}${hookQ ? "Caption đặt câu hỏi, một kiểu hook gợi tò mò. " : ""}${(v.caption || "").length < 40 ? "Caption rất ngắn, sức hút nằm ở hình ảnh trong video." : ""}` });

  if (v.duration) {
    const top = C.filter((x) => level(x.virality) >= 2 && x.duration);
    const medTop = median(top.map((x) => x.duration));
    out.finds.push({ l: "mid", h: `Dài ${dur(v.duration)}`, p: `${v.duration < 15 ? "Rất ngắn, dễ được xem lại nhiều lần, giúp tăng thời gian xem." : v.duration <= 60 ? "Độ dài phổ biến của video ngắn." : "Khá dài cho video ngắn, cần nội dung giữ chân tốt."}${medTop ? ` Các video viral cùng chủ đề dài khoảng ${dur(medTop)}.` : ""}` });
  }
  if (musicKey(v)) {
    const same = C.filter((x) => musicKey(x) === musicKey(v)).length;
    const original = /âm thanh gốc|original sound|nhạc nền/i.test(v.music_title || "");
    out.finds.push({ l: same >= 2 ? "hi" : "mid", h: `Âm thanh: ${v.music_title}`, p: original ? "Dùng âm thanh gốc của kênh, nội dung tự đứng được, không dựa vào trend nhạc." : same ? `Có thêm ${same} video khác trong kết quả dùng cùng âm thanh này, có thể là âm thanh đang thành trend.` : "Âm thanh có sẵn trên nền tảng, chưa thấy video khác trong kết quả dùng chung." });
  }
  const tags = (v.hashtags || "").split(/\s+/).filter(Boolean);
  if (tags.length) {
    const cnt = new Map(); C.forEach((x) => (x.hashtags || "").toLowerCase().split(/\s+/).forEach((t) => t && cnt.set(t, (cnt.get(t) || 0) + 1)));
    const shared = tags.filter((t) => cnt.get(t.toLowerCase()) >= 2).slice(0, 5);
    out.finds.push({ l: "mid", h: `${tags.length} hashtag`, p: shared.length ? `Hashtag phổ biến trong chủ đề này: ${shared.map((t) => "#" + t).join(", ")}.` : "Các hashtag của video không trùng nhiều với video khác cùng chủ đề." });
  }
  const prods = (v.products || "").split(" | ").filter(Boolean);
  if (prods.length) {
    const same = C.filter((x) => (x.products || "").split(" | ").some((p) => prods.includes(p))).length;
    out.finds.push({ l: "hi", h: "Có gắn giỏ hàng TikTok Shop", p: `Sản phẩm: ${prods.join(", ")}.${same ? ` Thêm ${same} video khác trong kết quả cũng bán sản phẩm này, dấu hiệu sản phẩm đang chạy tốt.` : ""}` });
  }
  const f = v.followers;
  if (f != null) {
    const size = f < 10000 ? "kênh nhỏ (dưới 10 N follower)" : f < 100000 ? "kênh vừa (10 N đến 100 N follower)" : f < 1000000 ? "kênh lớn (100 N đến 1 Tr follower)" : "kênh rất lớn (trên 1 Tr follower)";
    out.finds.push({ l: "mid", h: `Đăng bởi ${size}`, p: f < 10000 ? "Kênh nhỏ vẫn viral nghĩa là công thức nội dung này dễ làm lại, không cần sẵn lượng người theo dõi."
      : (v.x_followers ?? 0) >= 20 ? "Dù kênh đã có nhiều người theo dõi, lượt xem vẫn gấp nhiều lần số đó, nên chính nội dung video mới là lý do chính."
      : "Kênh có sẵn lượng người xem, một phần lượt xem đến từ sức mạnh kênh." });
  }

  // gợi ý
  if (formats.length) out.tips.push(`Làm theo dạng <b>${esc(formats[0].toLowerCase())}</b>, mở đầu giống video này trong 3 giây đầu. Xem video gốc để ghi lại câu mở đầu và khung hình đầu tiên.`);
  else out.tips.push("Xem video gốc và ghi lại 3 giây đầu: câu nói, chữ trên màn hình, khung hình đầu tiên. Đó là phần quyết định người xem có ở lại không.");
  if (v.duration) out.tips.push(`Giữ độ dài khoảng <b>${dur(v.duration)}</b>.`);
  if (musicKey(v) && !/âm thanh gốc|original sound/i.test(v.music_title || "")) out.tips.push(`Dùng cùng âm thanh <b>${esc(v.music_title)}</b> khi nó còn đang được nhiều video dùng.`);
  const topTags = tags.slice(0, 4); if (topTags.length) out.tips.push(`Gắn các hashtag: ${topTags.map((t) => "#" + esc(t)).join(" ")}.`);
  if (rows.find((r) => r.k === "comments" && r.me && r.base && r.me / r.base >= 1.5)) out.tips.push("Đọc phần bình luận của video gốc: người xem đang hỏi gì, tranh luận gì, đó là ý tưởng cho video tiếp theo.");
  if (prods.length) out.tips.push(`Nếu làm affiliate, tìm sản phẩm <b>${esc(prods[0])}</b> trên TikTok Shop và làm video theo cùng cách trình bày.`);
  out.tips.push("Không đăng lại video của người khác. Hãy làm lại theo ý tưởng và cách trình bày bằng nội dung của bạn.");
  return out;
}

async function renderVideo(id, q) {
  let v = S.byId.get(id);
  let cohort = [];
  if (q) {
    if (!R.data || R.q !== q) { try { R.data = await api(`/api/search?q=${encodeURIComponent(q)}`); R.q = q; } catch (e) { R.data = null; } }
    if (R.data) { cohort = R.data.videos; R.data.videos.forEach((x) => S.byId.set(x.id, x)); v = S.byId.get(id); }
  }
  if (!v) { if (!S.loaded) await loadData(); v = S.byId.get(id); cohort = cohort.length ? cohort : S.videos; }
  if (S.page !== "video") return;
  if (!v) { $("#main").innerHTML = `<div class="panel empty"><h2>Không tìm thấy video</h2><p>Video này không còn trong dữ liệu đã quét.</p><div class="row"><a class="btn primary" href="#/">Về trang chủ</a></div></div>`; return; }
  const l = level(v.virality);
  const a = analyze(v, cohort);
  const verdict = v.virality == null ? "Chưa có số follower của kênh nên chưa chấm được mức viral."
    : l >= 3 ? "Video này viral thật sự: vượt rất xa lượng người theo dõi kênh. Đáng để học cách làm."
    : l === 2 ? "Video có tín hiệu viral rõ, vượt tệp follower nhiều lần."
    : l === 1 ? "Video có tiềm năng, đang vượt tệp follower nhưng chưa bùng nổ."
    : "Video chưa nổi bật so với lượng follower của kênh.";
  document.title = `${(v.caption || "Video").slice(0, 40)} – Viral Radar`;
  $("#main").innerHTML = `
    <a class="backlink" href="${q ? searchHref(q) : "#/"}">${icon("back")}${q ? `Kết quả cho “${esc(q)}”` : "Trang chủ"}</a>
    <div class="vd">
      <div class="vd-media">
        <a class="thumb" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer" aria-label="Xem video gốc trên ${PLAT_LONG[v.platform]}">
          <div class="ph">${esc((v.caption || "").slice(0, 90))}</div>${v.cover ? `<img src="${esc(v.cover)}" alt="" width="300" height="533" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}
          <div class="shade"></div><span class="tl plat"><i class="pdot ${v.platform}"></i>${PLAT[v.platform]}</span>
          <div class="bl"><div class="views num">${nC(v.views)}<small>lượt xem</small></div></div>${v.duration ? `<span class="br dur num">${dur(v.duration)}</span>` : ""}
        </a>
        <div class="acts">
          <a class="btn primary" href="${esc(v.url)}" target="_blank" rel="noopener noreferrer">${icon("play")}Xem video gốc</a>
          <a class="btn" href="${esc(profileUrl(v))}" target="_blank" rel="noopener noreferrer">${icon("user")}Mở kênh @${esc(v.username)}</a>
        </div>
      </div>
      <div>
        <h1 class="vd-title">${esc(v.caption) || "Video không có caption"}</h1>
        <div class="vd-meta"><span><i class="pdot ${v.platform}"></i>${PLAT_LONG[v.platform]}</span><span translate="no">@${esc(v.username)}</span><span>${nC(v.followers)} follower</span><span>Đăng ${ageText(v.age_days)}</span></div>
        <div class="verdict">
          <span class="score num">${v.virality == null ? "–" : Math.round(v.virality)}</span>
          <span class="tier">${v.virality == null ? "Chưa chấm" : TIER[l]}<span class="sig-big">${sig(l)}</span></span>
          <p>${verdict}</p>
        </div>
        <dl class="kv num" style="margin-top:16px">
          <div><dt>Lượt xem</dt><dd>${nN(v.views)}</dd></div><div><dt>Thích</dt><dd>${nN(v.likes)}</dd></div><div><dt>Bình luận</dt><dd>${nN(v.comments)}</dd></div>
          <div><dt>${v.platform === "tiktok" ? "Chia sẻ" : "Follower"}</dt><dd>${nN(v.platform === "tiktok" ? v.shares : v.followers)}</dd></div><div><dt>${v.platform === "tiktok" ? "Lưu" : "Gấp follower"}</dt><dd>${v.platform === "tiktok" ? nN(v.saves) : times(v.x_followers)}</dd></div><div><dt>Tương tác</dt><dd>${pct(v.engagement)}</dd></div>
        </dl>
        <section class="ana ai" id="aiSec" aria-labelledby="hAi" aria-live="polite"></section>
        <section class="ana" aria-labelledby="hWhy"><h2 id="hWhy">Vì sao video này nổi bật</h2><p class="sub">So với ${nN(cohort.length - 1)} video khác${q ? ` cùng kết quả tìm “${esc(q)}”` : ""}.</p>
          <div class="finds">${a.finds.map((f) => `<div class="find"><span class="lvl ${f.l}">${{ hi: "Nổi bật", mid: "Thông tin", lo: "Điểm yếu" }[f.l]}</span><div><h3>${esc(f.h)}</h3><p>${esc(f.p)}</p>
            ${f.table ? `<table class="cmp num"><thead><tr><th>Tỉ lệ trên lượt xem</th><th class="r">Video này</th><th class="r">Trung vị cùng chủ đề</th></tr></thead><tbody>${f.table.map((r) => { const mx = Math.max(r.me || 0, r.base || 0) || 1;
              return `<tr><td>${r.t}</td><td class="r"><span class="bar2">${pct(r.me)}<i style="width:${Math.round(((r.me || 0) / mx) * 60)}px"></i></span></td><td class="r"><span class="bar2">${pct(r.base)}<i class="base" style="width:${Math.round(((r.base || 0) / mx) * 60)}px"></i></span></td></tr>`; }).join("")}</tbody></table>` : ""}</div></div>`).join("")}</div>
        </section>
        <section class="ana" aria-labelledby="hTips"><h2 id="hTips">Nếu bạn muốn làm video tương tự</h2><p class="sub">Gợi ý rút ra từ số liệu của video này.</p>
          <ul class="tips">${a.tips.map((t) => `<li>${t}</li>`).join("")}</ul>
        </section>
        ${(() => { const sim = cohort.filter((x) => x.id !== v.id && ((musicKey(x) && musicKey(x) === musicKey(v)) || (x.hashtags || "").split(/\s+/).some((t) => t && tags_has(v, t)))).sort((a2, b2) => (b2.virality ?? -1) - (a2.virality ?? -1)).slice(0, 4);
          return sim.length ? `<section class="ana" aria-labelledby="hSim"><h2 id="hSim">Video tương tự đang viral</h2><p class="sub">Cùng âm thanh hoặc hashtag, trong cùng kết quả tìm.</p><div class="wall" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr))">${sim.map((x) => card(x).replace(/href="#\/[^"]*\?video=([^"]+)" data-video="[^"]*"/, () => `href="${videoHref(x.id, q)}"`)).join("")}</div></section>` : ""; })()}
        <p class="fineprint">Phân tích dựa trên số liệu công khai (lượt xem, tương tác, follower), caption, hashtag và âm thanh. Tool chưa xem nội dung hình ảnh của video. Số view TikTok trong kết quả tìm kiếm có thể đã được làm tròn.</p>
      </div>
    </div>`;
  window.scrollTo(0, 0);
  loadAI(v);
}

// ---------- phân tích bằng AI: chỉ chạy khi người dùng bấm nút
const AI_STATE = { running: new Map() }; // video_id -> thời điểm bắt đầu
async function loadAI(v) {
  const el = $("#aiSec"); if (!el) return;
  let st;
  try { st = await api(`/api/videos/${encodeURIComponent(v.id)}/ai`); } catch (e) { el.innerHTML = ""; return; }
  if (!$("#aiSec") || S.page !== "video") return;
  if (st.result) return drawAI(v, st);
  if (st.running || AI_STATE.running.has(v.id)) return drawAIRunning(v);
  drawAIStart(v, st.key_set);
}
function aiIntro() {
  return `<div class="ai-head"><div><h2 id="hAi">Phân tích nội dung bằng AI</h2>
    <p class="sub">AI xem video và chỉ ra câu mở đầu, cấu trúc, vì sao giữ chân người xem, rồi viết kịch bản để bạn làm lại theo cùng công thức.</p></div></div>`;
}
function drawAIStart(v, keySet, err) {
  const el = $("#aiSec"); if (!el) return;
  el.innerHTML = `<div class="ai-card">${aiIntro()}
    ${err ? `<p class="ai-err" role="alert">${icon("alert")}<span>${esc(err)}</span></p>` : ""}
    ${keySet ? `<div class="ai-go"><button type="button" class="btn pill" id="aiRun">Phân tích bằng AI<span class="arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></button>
        <span class="muted">Mất khoảng 20 đến 60 giây. Mỗi video chỉ phân tích một lần rồi lưu lại.${v.platform === "tiktok" ? " Video TikTok được tải tạm để AI xem, xong sẽ xóa ngay." : ""}</span></div>`
      : `<form class="ai-key" id="aiKeyForm">
        <p>Cần một API key Gemini miễn phí (chỉ nhập một lần). Vào <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio</a>, đăng nhập Google, bấm <b>Create API key</b> rồi dán vào đây.</p>
        <div class="row"><label class="sr-only" for="aiKey">API key Gemini</label>
        <input class="field" id="aiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Dán API key, bắt đầu bằng AIza…">
        <button type="submit" class="btn primary">Lưu và phân tích</button></div></form>`}
  </div>`;
  const run = $("#aiRun"); if (run) run.onclick = () => runAI(v);
  const f = $("#aiKeyForm");
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const key = $("#aiKey").value.trim();
    if (!key) { $("#aiKey").focus(); return; }
    const b = f.querySelector("button"); b.disabled = true; b.textContent = "Đang kiểm tra key…";
    try { await api("/api/settings/gemini", { method: "POST", body: JSON.stringify({ key }) }); toast("Đã lưu API key Gemini."); runAI(v); }
    catch (err) { drawAIStart(v, false, err.message); }
  };
}
function drawAIRunning(v) {
  const el = $("#aiSec"); if (!el) return;
  const t0 = AI_STATE.running.get(v.id) || Date.now();
  el.innerHTML = `<div class="ai-card">${aiIntro()}<div class="ai-wait"><span class="spin" aria-hidden="true"></span>
    <span>${v.platform === "tiktok" ? "Đang tải video tạm thời và gửi cho AI xem…" : "AI đang xem video…"} <span class="muted num" id="aiTimer">${Math.round((Date.now() - t0) / 1000)} giây</span></span></div></div>`;
  clearInterval(AI_STATE.timer);
  AI_STATE.timer = setInterval(() => { const t = $("#aiTimer"); if (!t) return clearInterval(AI_STATE.timer); t.textContent = `${Math.round((Date.now() - t0) / 1000)} giây`; }, 1000);
}
async function runAI(v) {
  AI_STATE.running.set(v.id, Date.now());
  drawAIRunning(v);
  try {
    const st = await api(`/api/videos/${encodeURIComponent(v.id)}/ai`, { method: "POST" });
    AI_STATE.running.delete(v.id); clearInterval(AI_STATE.timer);
    if ($("#aiSec") && location.hash.includes(encodeURIComponent(v.id))) drawAI(v, st);
    toast("AI đã phân tích xong video.");
  } catch (err) {
    AI_STATE.running.delete(v.id); clearInterval(AI_STATE.timer);
    if ($("#aiSec")) drawAIStart(v, !/API key/.test(err.message) || /hết lượt/.test(err.message), err.message);
  }
}
function drawAI(v, st) {
  const el = $("#aiSec"); if (!el) return;
  const a = st.result || {};
  const h = a.hook || {};
  const list = (x) => (Array.isArray(x) ? x : []);
  const facts = [["Dạng nội dung", a.format], ["Cảm xúc", a.emotion], ["Ai xem và chia sẻ", a.audience], ["Cách quay và dựng", a.visual_style], ["Âm thanh", a.audio], ["Kêu gọi hành động", a.cta]].filter(([, x]) => x);
  const scriptText = list(a.script).map((s) => `${s.time}  ${s.beat}: ${s.say_or_show}`).join("\n");
  el.innerHTML = `<div class="ai-head"><div><h2 id="hAi">Phân tích nội dung bằng AI</h2>
      <p class="sub">${esc(a.summary || "")}</p></div>
      <button type="button" class="btn ghost sm" id="aiRedo" title="Gọi AI phân tích lại video này">${icon("refresh")}Phân tích lại</button></div>
    <div class="hook-card">
      <span class="hook-label">Câu mở đầu, 3 giây đầu</span>
      <blockquote>“${esc(h.text || "Không có lời hoặc chữ")}”</blockquote>
      <div class="hook-meta">${h.type ? `<span class="chip">${esc(h.type)}</span>` : ""}${h.visual ? `<span><b>Khung hình:</b> ${esc(h.visual)}</span>` : ""}</div>
      ${h.why ? `<p><b>Vì sao giữ chân người xem:</b> ${esc(h.why)}</p>` : ""}
    </div>
    ${facts.length ? `<dl class="ai-facts">${facts.map(([k, x]) => `<div><dt>${k}</dt><dd>${esc(x)}</dd></div>`).join("")}</dl>` : ""}
    ${list(a.structure).length ? `<h3 class="ai-h3">Cấu trúc video</h3><ol class="timeline">${list(a.structure).map((s) => `<li><span class="t num">${esc(s.time)}</span><span>${esc(s.what)}</span></li>`).join("")}</ol>` : ""}
    ${list(a.why_viral).length ? `<h3 class="ai-h3">Vì sao video viral</h3><ul class="ai-list">${list(a.why_viral).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    ${list(a.script).length ? `<div class="ai-h3 row-between"><h3>Kịch bản để bạn làm lại</h3><button type="button" class="btn sm" id="aiCopy">Sao chép kịch bản</button></div>
      <div class="panel tbl-wrap"><table class="script"><thead><tr><th scope="col">Thời gian</th><th scope="col">Phần</th><th scope="col">Nói hoặc hiện gì</th></tr></thead><tbody>
      ${list(a.script).map((s) => `<tr><td class="num">${esc(s.time)}</td><td><b>${esc(s.beat)}</b></td><td class="wrap">${esc(s.say_or_show)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${list(a.ideas).length ? `<h3 class="ai-h3">Ý tưởng video mới cùng công thức</h3><ol class="ai-list">${list(a.ideas).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
    <p class="fineprint">Do AI (${esc(st.model || "Gemini")}) tạo ${st.created_at ? ago(st.created_at) : ""}, có thể sai. Đối chiếu với video gốc trước khi dùng.</p>`;
  $("#aiRedo").onclick = () => runAI(v);
  const cp = $("#aiCopy");
  if (cp) cp.onclick = async () => { try { await navigator.clipboard.writeText(scriptText); toast("Đã sao chép kịch bản."); } catch (e) { toast("Trình duyệt chặn sao chép, hãy bôi đen để copy.", true); } };
}
function tags_has(v, t) { return (v.hashtags || "").toLowerCase().split(/\s+/).includes(t.toLowerCase()); }

// ============================================================ router
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  const params = new URLSearchParams(qs || "");
  const parts = path.split("/");
  if (parts[0] === "search") return { page: "search", q: params.get("q") || "" };
  if (parts[0] === "video" && parts[1]) return { page: "video", id: decodeURIComponent(parts[1]), q: params.get("q") || "" };
  if (["explore", "groups", "watch", "history", "settings"].includes(parts[0])) return { page: parts[0], video: params.get("video") };
  return { page: "home" };
}
function render() {
  const r = parseHash();
  if (r.page === "home") return renderHome();
  if (r.page === "search") return renderSearch(r.q);
  if (r.page === "video") return renderVideo(r.id, r.q);
  ({ explore: renderExplore, groups: renderGroups, watch: renderWatch, history: renderHistory, settings: renderSettings })[S.page]();
}
let lastRouteKey = null;
function onRoute() {
  const r = parseHash();
  const simple = ["home", "search", "video"].includes(r.page);
  $("#topSearch").hidden = r.page === "home";
  if (simple) {
    const key = r.page + "|" + (r.q || "") + "|" + (r.id || "");
    if (key === lastRouteKey) return;
    lastRouteKey = key;
    clearTimeout(R.poll);
    S.page = r.page; S.shown = 48;
    closeVideo(false);
    if (r.page === "home") document.title = "Viral Radar – Tìm video đang viral";
    if (r.page === "search") document.title = `${r.q} – Viral Radar`;
    render();
    if (r.page !== "search") window.scrollTo(0, 0);
    return;
  }
  lastRouteKey = null;
  const { page, video } = r;
  if (page !== S.page) {
    S.page = page;
    $$(".nav a").forEach((a) => (a.dataset.page === page ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    document.title = { explore: "Khám phá", groups: "Nhóm theo", watch: "Theo dõi", history: "Lịch sử quét", settings: "Cài đặt" }[page] + " – Viral Radar";
    closeVideo(false);
    render();
    window.scrollTo(0, 0);
  }
  if (video && video !== S.drawerVideo) openVideo(video, false);
  else if (!video && S.drawerVideo) closeVideo(false);
}
window.addEventListener("hashchange", onRoute);
window.addEventListener("popstate", onRoute);
let rz; addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (S.page === "explore" && S.view === "map") renderExplore(); }, 200); });

(async function init() {
  syncThemeBtn();
  const first = parseHash();
  if (["home", "search", "video"].includes(first.page)) { onRoute(); pollJobs(); return; }
  $("#main").innerHTML = `<div class="page-head"><div><h1>Đang tải…</h1></div></div>`;
  try { await loadData(); } catch (e) { $("#main").innerHTML = `<div class="panel empty"><h2>Không kết nối được máy chủ</h2><p>Kiểm tra cửa sổ đang chạy <code>python server.py</code> còn mở không, rồi tải lại trang.</p><div class="row"><button class="btn primary" type="button" onclick="location.reload()">Tải lại</button></div></div>`; return; }
  onRoute();
  pollJobs();
})();
