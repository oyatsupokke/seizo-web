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
