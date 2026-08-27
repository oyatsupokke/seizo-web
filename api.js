/* =====================================================================
 * 製造管理 Phase A 共通API（ビルド不要の静的アプリ・cake-yoyaku webと同流儀）
 * - 認証: Supabase Auth（店アカウント・ログインしっぱなし運用）
 * - データ: PostgREST（RLS越し）＋ RPC（開始/完了/臨時仕込み等）
 * ===================================================================== */

const CONFIG = {
  url: "https://lafcksultbvpjnqwvifj.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxhZmNrc3VsdGJ2cGpucXd2aWZqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY3Njg5NjcsImV4cCI6MjEwMjM0NDk2N30.Nm7Hxo5yZK4hjHdgDTCmFSLQ2EpUnegDKwAPsfkNeIs",
};

const KUBUN_CLASS = { "仕込み": "shikomi", "オーダーケーキ": "cake", "プチギフト": "gift", "発送": "hasso" };

/* ---------- 認証（localStorageにセッション保持・共用端末でログインしっぱなし） ---------- */

function session() {
  try { return JSON.parse(localStorage.getItem("seizo_session")) || null; }
  catch { return null; }
}
function saveSession(s) { localStorage.setItem("seizo_session", JSON.stringify(s)); }
function clearSession() { localStorage.removeItem("seizo_session"); }

async function login(email, password) {
  const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.msg || "ログインに失敗しました");
  saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at });
  return data;
}

async function refreshToken() {
  const s = session();
  if (!s?.refresh_token) return false;
  const res = await fetch(`${CONFIG.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: CONFIG.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok) { clearSession(); return false; }
  const data = await res.json();
  saveSession({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at });
  return true;
}

function requireLogin() {
  if (!session()) { location.href = "login.html"; return false; }
  return true;
}

/* ---------- API（401なら1回だけリフレッシュして再試行） ---------- */

async function apiFetch(path, options = {}, retried = false) {
  const s = session();
  const res = await fetch(CONFIG.url + path, {
    ...options,
    headers: {
      apikey: CONFIG.anonKey,
      Authorization: `Bearer ${s?.access_token || CONFIG.anonKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && !retried && (await refreshToken())) {
    return apiFetch(path, options, true);
  }
  if (res.status === 401) { location.href = "login.html"; throw new Error("要ログイン"); }
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const rest = (pathQuery) => apiFetch(`/rest/v1/${pathQuery}`);
const rpc = (fn, args = {}) =>
  apiFetch(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
const insert = (table, rows) =>
  apiFetch(`/rest/v1/${table}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(rows),
  });

/* ---------- 商品の新規作成（recipe.html・shohin.htmlの🆕共通） ----------
 * 初期状態が入口によって割れないよう、商品のinsertは必ずここを通す（genba指摘） */
let _sharedTid = null;
async function sharedTenantId() {
  if (!_sharedTid) _sharedTid = (await rpc("fn_my_tenant_id")) || null;
  return _sharedTid;
}
async function createProduct(name) {
  const [row] = await insert("products", { tenant_id: await sharedTenantId(), name, is_active: true });
  return row;
}
/* 材料の新規作成（recipe.htmlの仮登録・zairyo.htmlの🆕共通。初期状態を割らない） */
async function createIngredient(name) {
  const [row] = await insert("ingredients", {
    tenant_id: await sharedTenantId(), name, category: "未分類", kind: "購入材料", unit: "g", is_active: true,
  });
  return row;
}

/* ---------- レシピ表示（読み取り専用・×バッチ計算・生地の中身は最初から展開） ----------
 * 商品マスタ／材料マスタ（半製品）／今日やることの📖で共通。
 * RV.show(el, key, name, n) で開始。keyは "product_id=eq.X" か "ingredient_id=eq.X"。
 * 二段レシピ（商品→生地）は、生地の行の下に中身（粉・バター…）をインデントで
 * そのまま見せる（タップで潜らせない・まりほ指摘 2026-08-27）。 */
const RV = {
  el: null, n: 1, data: null,
  async show(el, key, name, n) {
    this.el = el; this.n = Number(n) || 1;
    this.el.innerHTML = "読み込み中…";
    try {
      const recs = await rest(`recipes?${key}&is_active=is.true&select=method_memo,recipe_items(amount_g_per_batch,ingredients(id,name,kind))&limit=1`);
      const r = recs[0];
      if (!r || !r.recipe_items?.length) { this.data = null; this.render(); return; }
      const items = r.recipe_items.slice().sort((a, b) => b.amount_g_per_batch - a.amount_g_per_batch);
      // 半製品（生地・クリーム）の中身レシピをまとめて取得
      const subIds = items.filter((it) => it.ingredients?.kind === "半製品").map((it) => it.ingredients.id);
      const subs = {};
      if (subIds.length) {
        const srs = await rest(`recipes?ingredient_id=in.(${subIds.join(",")})&is_active=is.true&select=ingredient_id,recipe_items(amount_g_per_batch,ingredients(name))`);
        for (const s of srs) {
          const sitems = (s.recipe_items || []).slice().sort((a, b) => b.amount_g_per_batch - a.amount_g_per_batch);
          const stotal = sitems.reduce((x, it) => x + Number(it.amount_g_per_batch), 0);
          if (sitems.length && stotal > 0) subs[s.ingredient_id] = { items: sitems, total: stotal };
        }
      }
      this.data = { items, subs, memo: r.method_memo };
      this.render();
    } catch (e) {
      this.el.innerHTML = '<div class="empty">レシピの読み込みエラー</div>';
      console.error(e);
    }
  },
  setN(n) {
    if (n === "other") {
      const v = prompt("バッチ数");
      if (v === null || v === "" || Number(v) <= 0) return;
      n = Number(v);
    }
    this.n = n;
    this.render();
  },
  render() {
    if (!this.data) {
      this.el.innerHTML = '<div class="empty">レシピが未登録です（登録は「📖 レシピ登録」から）</div>';
      return;
    }
    const { items, subs, memo } = this.data;
    const n = this.n;
    const r1 = (x) => Math.round(x * 10) / 10;
    const total = items.reduce((s2, it) => s2 + Number(it.amount_g_per_batch), 0);
    const chips = [1, 2, 3, 4].map((b) =>
      `<button class="chip ${b === n ? "setted" : ""}" style="margin:0;" onclick="RV.setN(${b})">×${b}</button>`).join(" ")
      + ` <button class="chip ${![1, 2, 3, 4].includes(n) ? "setted" : ""}" style="margin:0;" onclick="RV.setN('other')">${![1, 2, 3, 4].includes(n) ? `×${n}` : "その他"}</button>`;
    const rowsHtml = items.map((it) => {
      const g = Number(it.amount_g_per_batch);
      const isHansei = it.ingredients?.kind === "半製品";
      let html = `<tr style="border-top:1px solid #eee;">
        <td style="padding:6px 2px;${isHansei ? " color:#5b3fa8; font-weight:700;" : ""}">${esc(it.ingredients?.name || "?")}</td>
        <td style="text-align:right; padding:6px 2px;">${g}g</td>
        ${n !== 1 ? `<td style="text-align:right; padding:6px 2px;"><b>${r1(g * n)}g</b></td>` : ""}</tr>`;
      // 生地・クリームは中身をその場に展開（この行の量に按分したg）
      const sub = isHansei && subs[it.ingredients.id];
      if (sub) {
        const f = g / sub.total;
        html += sub.items.map((s) => {
          const sg = r1(Number(s.amount_g_per_batch) * f);
          return `<tr style="color:#777; font-size:.85em;">
            <td style="padding:2px 2px 2px 18px;">└ ${esc(s.ingredients?.name || "?")}</td>
            <td style="text-align:right; padding:2px;">${sg}g</td>
            ${n !== 1 ? `<td style="text-align:right; padding:2px;">${r1(sg * n)}g</td>` : ""}</tr>`;
        }).join("");
      }
      return html;
    }).join("");
    this.el.innerHTML =
      `<div style="display:flex; gap:6px; align-items:center; margin-bottom:8px; flex-wrap:wrap;">
        <span style="font-size:12px; color:#888;">バッチ数</span>${chips}</div>
      <table style="width:100%; border-collapse:collapse; font-size:15px;">
        <tr style="color:#888; font-size:12px;"><th style="text-align:left; padding:4px 2px;">材料</th>
          <th style="text-align:right; padding:4px 2px;">1バッチ</th>
          ${n !== 1 ? `<th style="text-align:right; padding:4px 2px;">×${n}バッチ</th>` : ""}</tr>
        ${rowsHtml}
        <tr style="border-top:2px solid #ddd; font-weight:700;">
          <td style="padding:6px 2px;">合計</td>
          <td style="text-align:right; padding:6px 2px;">${r1(total)}g</td>
          ${n !== 1 ? `<td style="text-align:right; padding:6px 2px;">${r1(total * n)}g</td>` : ""}</tr>
      </table>` +
      (memo ? `<div class="detail" style="margin-top:10px; white-space:pre-wrap;">${esc(memo)}</div>` : "");
  },
};

/* ---------- CSVダウンロード（Excel/スプレッドシート互換：BOM付きUTF-8・CRLF） ---------- */
function downloadCsv(filename, rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 共通ユーティリティ ---------- */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const jpDate = (d) => d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
const mmdd = (iso) => { const [, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}`; };
