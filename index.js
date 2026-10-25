// delka shop: бот + мини-приложение в одном файле.
// Переменные окружения: BOT_TOKEN, DATABASE_URL (Postgres). Build: npm install pg   Start: node index.js
const http = require("http"), crypto = require("crypto"), { Pool } = require("pg");
const T = process.env.BOT_TOKEN, API = "https://api.telegram.org/bot" + T;
const BASE = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL;
const CH = ["delka_shop", "delkateam"], RATE = 2, REF = 18;
let BOTNAME = "";
// Призы рулетки: [рублей, вес из 1000]. Меняйте шансы здесь (сумма весов = 1000).
const PRIZES = [[1, 350], [2, 250], [5, 200], [10, 120], [25, 60], [50, 18], [100, 2]];
const SECRET = crypto.createHash("sha256").update("wh" + T).digest("hex").slice(0, 32);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === "0" ? false : { rejectUnauthorized: false } });
const q = (s, p) => db.query(s, p).then(r => r.rows);
const tg = async (m, p) => {
  const r = await fetch(API + "/" + m, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p || {}) });
  const j = await r.json(); if (!j.ok) throw new Error(m + ": " + j.description); return j.result;
};

const cache = new Map();
async function missing(uid, fresh) {
  const c = cache.get(uid); if (!fresh && c && Date.now() - c[0] < 15000) return c[1];
  const miss = [];
  for (const ch of CH) {
    const m = await tg("getChatMember", { chat_id: "@" + ch, user_id: uid });
    if (m.status === "left" || m.status === "kicked" || (m.status === "restricted" && !m.is_member)) miss.push(ch);
  }
  cache.set(uid, [Date.now(), miss]); return miss;
}
const gateText = m => "🔒 <b>Подпишитесь на каналы, чтобы продолжить</b>\n\n" + CH.map(c => (m.includes(c) ? "❌" : "✅") + " @" + c).join("\n");
const gateKb = m => ({ inline_keyboard: m.map(c => [{ text: "📢 @" + c, url: "https://t.me/" + c }]).concat([[{ text: "✅ Я подписался", callback_data: "check" }]]) });
const rub = k => (k / 100).toLocaleString("ru-RU") + " ₽";
const welcome = id => tg("sendMessage", {
  chat_id: id, parse_mode: "HTML",
  text: "<b>Добро пожаловать в delka shop!</b>\n\nПокупай софты, обучения, сервисы по выгодной цене!\nОткрывай каталог в веб-приложении по кнопке ниже!\nКанал с новостями и бонусами: @delka_shop",
  reply_markup: { inline_keyboard: [[{ text: "🛍 Открыть каталог", web_app: { url: BASE } }], [{ text: "📢 Перейти в канал", url: "https://t.me/delka_shop" }]] }
});
const upsert = (u, ref) => q("INSERT INTO users(id,first_name,last_name,username,photo,ref_by) VALUES($1,$2,$3,$4,$5,(SELECT id FROM users WHERE id=$6::bigint AND id<>$1)) ON CONFLICT(id) DO UPDATE SET first_name=$2,last_name=$3,username=$4,photo=COALESCE(NULLIF($5,''),users.photo)", [u.id, u.first_name || "", u.last_name || "", u.username || "", u.photo_url || "", ref || null]);
const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const TYS = { stars: ["⭐", "Пополнение звёздами"], crypto: ["₿", "Пополнение криптой"], bonus: ["🎁", "Бонус за задание"], roulette: ["🎰", "Рулетка"], ref: ["👥", "Реферал"], purchase: ["🛒", "Покупка"] };
async function notify(uid, type, kop, note, from, bal) {
  const y = TYS[type] || ["💠", type]; let who = "";
  if (from) { const r = await q("SELECT first_name FROM users WHERE id=$1", [from]); if (r[0]) who = "\nот " + esc(r[0].first_name); }
  await tg("sendMessage", { chat_id: uid, parse_mode: "HTML", text: y[0] + " <b>" + y[1] + "</b>" + who + (note ? "\n" + esc(note) : "") + "\n<b>" + (kop < 0 ? "−" : "+") + rub(Math.abs(kop)) + "</b>\n💼 Баланс: <b>" + rub(bal) + "</b>" });
}
const addBal = (uid, kop, type, from, note) => q("WITH u AS (UPDATE users SET balance_kop=balance_kop+$2 WHERE id=$1 RETURNING balance_kop) INSERT INTO tx(user_id,type,kop,ref_user,note) VALUES($1,$3,$2,$4,$5) RETURNING (SELECT balance_kop FROM u) AS b", [uid, kop, type, from || null, note || ""]).then(r => { const b = Number(r[0].b); notify(uid, type, kop, note, from, b).catch(e => console.error(e.message)); return b; });

async function entry(u, chat, ref) {
  await upsert(u, ref);
  let m; try { m = await missing(u.id, true); } catch (e) { console.error(e.message); return tg("sendMessage", { chat_id: chat, text: "⚠️ Не удалось проверить подписку. Попробуйте позже." }); }
  return m.length ? tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: gateText(m), reply_markup: gateKb(m) }) : welcome(chat);
}
async function credit(uid, stars, charge) {
  const kop = stars * RATE * 100;
  const r = await q("WITH i AS (INSERT INTO payments(charge_id,user_id,stars,kop) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id,kop), u AS (UPDATE users SET balance_kop=balance_kop+i.kop FROM i WHERE users.id=i.user_id RETURNING users.balance_kop AS b, users.ref_by AS r), t AS (INSERT INTO tx(user_id,type,kop,note) SELECT user_id,'stars',kop,$5::text FROM i) SELECT b,r FROM u", [charge, uid, stars, kop, stars + " ⭐"]);
  if (!r.length) return null;
  if (r[0].r) { // 18% пригласившему
    const ref = r[0].r, bonus = Math.floor(kop * REF / 100);
    addBal(ref, bonus, "ref", uid, "18% с пополнения").catch(e => console.error(e.message));
  }
  return Number(r[0].b);
}
async function handle(u) {
  if (u.pre_checkout_query) return tg("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
  if (u.callback_query && /^bc_/.test(u.callback_query.data || "")) return bcCallback(u.callback_query);
  if (u.callback_query) {
    const c = u.callback_query, m = c.message; let miss;
    try { miss = await missing(c.from.id, true); } catch (e) { return tg("answerCallbackQuery", { callback_query_id: c.id, text: "Не удалось проверить подписку", show_alert: true }); }
    if (miss.length) {
      await tg("answerCallbackQuery", { callback_query_id: c.id, text: "Вы ещё не подписались на: " + miss.map(x => "@" + x).join(", "), show_alert: true });
      return tg("editMessageText", { chat_id: m.chat.id, message_id: m.message_id, parse_mode: "HTML", text: gateText(miss), reply_markup: gateKb(miss) }).catch(() => {});
    }
    await tg("answerCallbackQuery", { callback_query_id: c.id });
    await tg("deleteMessage", { chat_id: m.chat.id, message_id: m.message_id }).catch(() => {});
    return welcome(m.chat.id);
  }
  if (u.chat_member) { // человек отписался от канала
    const c = u.chat_member, un = (c.chat.username || "").toLowerCase(), id = c.new_chat_member.user.id;
    if (CH.includes(un) && ["left", "kicked"].includes(c.new_chat_member.status) && (await q("SELECT 1 FROM users WHERE id=$1", [id])).length) {
      cache.delete(id); const m = await missing(id, true);
      return tg("sendMessage", { chat_id: id, parse_mode: "HTML", text: "⚠️ Вы отписались от @" + un + ". Доступ к магазину закрыт, пока вы не подпишетесь снова.\n\n" + gateText(m), reply_markup: gateKb(m) }).catch(() => {});
    }
    return;
  }
  const msg = u.message; if (!msg) return;
  if (msg.successful_payment) {
    const p = msg.successful_payment; if (p.currency !== "XTR") return;
    await upsert(msg.from);
    if (String(p.invoice_payload).startsWith("spin:")) {
      await q("INSERT INTO spin_tickets(charge_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [p.telegram_payment_charge_id, msg.from.id]);
      return tg("sendMessage", { chat_id: msg.chat.id, text: "🎰 Прокрутка рулетки оплачена! Возвращайтесь в каталог и крутите." });
    }
    const bal = await credit(msg.from.id, p.total_amount, p.telegram_payment_charge_id); if (bal === null) return;
    return tg("sendMessage", {
      chat_id: msg.chat.id, parse_mode: "HTML",
      text: "✅ <b>Оплата прошла успешно!</b>\n\n⭐ Отправлено звёзд: <b>" + p.total_amount + "</b>\n💰 Зачислено: <b>" + rub(p.total_amount * RATE * 100) + "</b>\n💼 Баланс: <b>" + rub(bal) + "</b>\n\nСпасибо, что выбираете delka shop! 💙",
      reply_markup: { inline_keyboard: [[{ text: "🛍 Перейти в каталог", web_app: { url: BASE } }]] }
    });
  }
  if (msg.chat.type === "private" && isAdmin(msg.from.id) && await adminFlow(msg)) return;
  if (msg.chat.type === "private") { const rm = /^\/start ref(\d+)/.exec(msg.text || ""); return entry(msg.from, msg.chat.id, rm && rm[1]); }
}

const ADMINS = (process.env.ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
const isAdmin = id => ADMINS.includes(String(id));
const bc = new Map(), sleep = ms => new Promise(r => setTimeout(r, ms));
function parseKb(t) {
  const rows = [];
  for (const line of t.split("\n")) { const m = /^(.+?)\s+[-–—]\s+((?:https?:\/\/|t\.me\/)\S+)$/.exec(line.trim()); if (m) rows.push([{ text: m[1], url: m[2].startsWith("http") ? m[2] : "https://" + m[2] }]); }
  return rows;
}
async function adminFlow(msg) {
  const id = msg.from.id, st = bc.get(id), t = (msg.text || "").trim();
  if (t.toLowerCase() === "+рассылка") { bc.set(id, { step: "msg" }); await tg("sendMessage", { chat_id: id, text: "📣 Отправьте сообщение для рассылки: текст, фото, видео, файл, с форматированием и премиум-эмодзи. Отмена: /cancel" }); return true; }
  if (!st) return false;
  if (t === "/cancel") { bc.delete(id); await tg("sendMessage", { chat_id: id, text: "Рассылка отменена." }); return true; }
  if (st.step === "msg") {
    bc.set(id, { step: "btn", mid: msg.message_id });
    await tg("sendMessage", { chat_id: id, text: "Добавить кнопки? Отправьте по одной на строке в формате:\nТекст кнопки - https://ссылка\n\nИли отправьте «нет»." }); return true;
  }
  if (st.step === "btn") {
    const no = /^(нет|no|-)$/i.test(t), kb = no ? [] : parseKb(t);
    if (!no && !kb.length) { await tg("sendMessage", { chat_id: id, text: "Не понял формат. Пример:\nКаталог - https://t.me/delka_shop" }); return true; }
    st.kb = kb; st.step = "ok";
    const rm = kb.length ? { inline_keyboard: kb } : undefined;
    await tg("copyMessage", { chat_id: id, from_chat_id: id, message_id: st.mid, reply_markup: rm });
    const n = (await q("SELECT count(*) AS n FROM users"))[0].n;
    await tg("sendMessage", { chat_id: id, text: "Так увидят сообщение. Отправить " + n + " пользователям?", reply_markup: { inline_keyboard: [[{ text: "✅ Отправить", callback_data: "bc_yes" }, { text: "✖️ Отмена", callback_data: "bc_no" }]] } });
    return true;
  }
  return false;
}
async function bcCallback(c) {
  const id = c.from.id, st = bc.get(id);
  await tg("answerCallbackQuery", { callback_query_id: c.id }).catch(() => {});
  if (!isAdmin(id) || !st || st.step !== "ok") return;
  bc.delete(id);
  if (c.data === "bc_no") return tg("sendMessage", { chat_id: id, text: "Рассылка отменена." });
  const users = await q("SELECT id FROM users"), rm = st.kb.length ? { inline_keyboard: st.kb } : undefined;
  await tg("sendMessage", { chat_id: id, text: "🚀 Рассылка запущена: " + users.length + " получателей." });
  let ok = 0, fail = 0;
  for (const u of users) {
    for (let a = 0; a < 2; a++) {
      try { await tg("copyMessage", { chat_id: u.id, from_chat_id: id, message_id: st.mid, reply_markup: rm }); ok++; break; }
      catch (e) { const m = /retry after (\d+)/.exec(e.message); if (m && a === 0) await sleep(m[1] * 1000 + 500); else { fail++; break; } }
    }
    await sleep(40);
  }
  return tg("sendMessage", { chat_id: id, text: "✅ Рассылка завершена.\nДоставлено: " + ok + "\nНе доставлено: " + fail + " (заблокировали бота)" });
}
function auth(init) {
  if (!init) return null;
  const p = new URLSearchParams(init), h = p.get("hash"); p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const sec = crypto.createHmac("sha256", "WebAppData").update(T).digest();
  if (crypto.createHmac("sha256", sec).update(dcs).digest("hex") !== h || Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
  return JSON.parse(p.get("user") || "null");
}
async function api(res, path, b) {
  const u = auth(b.initData); if (!u) return send(res, 401, { error: "auth" });
  await upsert(u); let m;
  try { m = await missing(u.id); } catch (e) { console.error(e.message); return send(res, 503, { error: "check" }); }
  if (path === "/api/me") {
    const r = await q("SELECT balance_kop FROM users WHERE id=$1", [u.id]);
    return send(res, 200, { user: { id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" "), photo: u.photo_url || "" }, missing: m, balance: Number(r[0].balance_kop) / 100, rate: RATE });
  }
  if (m.length) return send(res, 403, { error: "sub", missing: m });
  if (path === "/api/invoice") {
    const spin = b.kind === "spin", s = spin ? 8 : Math.floor(Number(b.stars)); if (!(s >= 1 && s <= 10000)) return send(res, 400, { error: "amount" });
    const link = await tg("createInvoiceLink", { title: spin ? "Прокрутка рулетки" : "Пополнение баланса", description: spin ? "Одна прокрутка рулетки delka shop" : s + " ⭐ → " + s * RATE + " ₽ на баланс delka shop", payload: (spin ? "spin:" : "topup:") + u.id + ":" + s, currency: "XTR", prices: [{ label: spin ? "Рулетка" : "Пополнение", amount: s }] });
    return send(res, 200, { link });
  }
  if (path === "/api/history") return send(res, 200, { list: await q("SELECT t.type,t.kop,t.note,t.created_at,x.first_name AS fn FROM tx t LEFT JOIN users x ON x.id=t.ref_user WHERE t.user_id=$1 ORDER BY t.id DESC LIMIT 40", [u.id]) });
  if (path === "/api/ref") {
    const l = await q("SELECT x.id,x.first_name,x.last_name,x.photo,COALESCE(SUM(t.kop),0) AS e FROM users x LEFT JOIN tx t ON t.user_id=$1 AND t.type='ref' AND t.ref_user=x.id WHERE x.ref_by=$1 GROUP BY x.id ORDER BY e DESC,x.created_at LIMIT 50", [u.id]);
    const t = (await q("SELECT (SELECT COALESCE(SUM(kop),0) FROM tx WHERE user_id=$1 AND type='ref') AS s,(SELECT count(*) FROM users WHERE ref_by=$1) AS n", [u.id]))[0];
    return send(res, 200, { link: "https://t.me/" + BOTNAME + "?start=ref" + u.id, earned: Number(t.s) / 100, count: Number(t.n), list: l.map(x => ({ id: x.id, name: [x.first_name, x.last_name].filter(Boolean).join(" "), photo: x.photo || "", earned: Number(x.e) / 100 })) });
  }
  if (path === "/api/bonus") {
    const r = (await q("SELECT (SELECT count(*) FROM users WHERE ref_by=$1) AS n,(SELECT count(*) FROM tasks_done WHERE user_id=$1 AND task='inv25') AS d,(SELECT count(*) FROM spin_tickets WHERE user_id=$1 AND NOT used) AS t,(SELECT count(*) FROM ad_rewards WHERE user_id=$1 AND created_at>now()-interval '24 hours') AS au,(SELECT count(*) FROM ad_rewards WHERE user_id=$1 AND NOT used) AS aq,GREATEST(0,EXTRACT(EPOCH FROM last_spin+interval '12 hours'-now())) AS w FROM users WHERE id=$1", [u.id]))[0];
    return send(res, 200, { invited: Number(r.n), done: Number(r.d) > 0, tickets: Number(r.t), wait: Math.ceil(Number(r.w) || 0), prizes: PRIZES, cost: 8, adLeft: Math.max(0, 2 - Number(r.au)), adTickets: Number(r.aq), adBlock: process.env.ADSGRAM_BLOCK_ID || "" });
  }
  if (path === "/api/claim") {
    const n = Number((await q("SELECT count(*) AS n FROM users WHERE ref_by=$1", [u.id]))[0].n);
    if (n < 25) return send(res, 400, { error: "not_yet" });
    if (!(await q("INSERT INTO tasks_done(user_id,task) VALUES($1,'inv25') ON CONFLICT DO NOTHING RETURNING 1 AS ok", [u.id])).length) return send(res, 400, { error: "done" });
    return send(res, 200, { balance: (await addBal(u.id, 10000, "bonus", null, "Задание: пригласить 25 друзей")) / 100 });
  }
  if (path === "/api/spin") {
    const t = b.mode === "ticket";
    const ok = b.mode === "ad" ? await q("UPDATE ad_rewards SET used=true WHERE NOT used AND id=(SELECT id FROM ad_rewards WHERE user_id=$1 AND NOT used ORDER BY id LIMIT 1) RETURNING 1 AS ok", [u.id])
      : t ? await q("UPDATE spin_tickets SET used=true WHERE NOT used AND charge_id=(SELECT charge_id FROM spin_tickets WHERE user_id=$1 AND NOT used ORDER BY created_at LIMIT 1) RETURNING 1 AS ok", [u.id])
      : await q("UPDATE users SET last_spin=now() WHERE id=$1 AND (last_spin IS NULL OR last_spin<now()-interval '12 hours') RETURNING 1 AS ok", [u.id]);
    if (!ok.length) return send(res, 400, { error: "wait" });
    let x = crypto.randomInt(0, 1000), i = 0; while (x >= PRIZES[i][1]) x -= PRIZES[i++][1];
    return send(res, 200, { index: i, prize: PRIZES[i][0], balance: (await addBal(u.id, PRIZES[i][0] * 100, "roulette", null, t ? "Платная прокрутка (8 ⭐)" : b.mode === "ad" ? "Прокрутка за рекламу" : "Бесплатная прокрутка")) / 100 });
  }
  send(res, 404, { error: "404" });
}
const send = (res, code, data, type) => { res.writeHead(code, { "content-type": type || "application/json" }); res.end(typeof data === "string" ? data : JSON.stringify(data)); };
const body = req => new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  try {
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/") return send(res, 200, HTML, "text/html;charset=utf-8");
    if (req.method === "GET" && path === "/api/ads/reward") { // Reward URL для Adsgram
      const sp = new URL(req.url, "http://x").searchParams, uid = sp.get("userid") || "";
      if (!process.env.ADS_SECRET || sp.get("secret") !== process.env.ADS_SECRET || !/^\d+$/.test(uid)) return send(res, 403, "no", "text/plain");
      await q("INSERT INTO ad_rewards(user_id) SELECT $1::bigint WHERE EXISTS(SELECT 1 FROM users WHERE id=$1::bigint) AND (SELECT count(*) FROM ad_rewards WHERE user_id=$1::bigint AND created_at>now()-interval '24 hours')<2", [uid]);
      return send(res, 200, "ok", "text/plain");
    }
    if (req.method === "POST" && path === "/tg") {
      if (req.headers["x-telegram-bot-api-secret-token"] !== SECRET) return send(res, 403, {});
      const u = await body(req); send(res, 200, {}); handle(u).catch(e => console.error(e.message)); return;
    }
    if (req.method === "POST" && path.startsWith("/api/")) return await api(res, path, await body(req));
    send(res, 200, "ok", "text/plain");
  } catch (e) { console.error(e); send(res, 500, { error: "server" }); }
}).listen(process.env.PORT || 3000);

(async () => {
  for (;;) {
    try {
      await q("CREATE TABLE IF NOT EXISTS users(id BIGINT PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT, balance_kop BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now())");
      await q("CREATE TABLE IF NOT EXISTS payments(charge_id TEXT PRIMARY KEY, user_id BIGINT, stars INT, kop BIGINT, created_at TIMESTAMPTZ DEFAULT now())");
      await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT, ADD COLUMN IF NOT EXISTS ref_by BIGINT, ADD COLUMN IF NOT EXISTS last_spin TIMESTAMPTZ");
      await q("CREATE TABLE IF NOT EXISTS tx(id BIGSERIAL PRIMARY KEY, user_id BIGINT, type TEXT, kop BIGINT, ref_user BIGINT, note TEXT, created_at TIMESTAMPTZ DEFAULT now())");
      await q("CREATE TABLE IF NOT EXISTS tasks_done(user_id BIGINT, task TEXT, PRIMARY KEY(user_id,task))");
      await q("CREATE TABLE IF NOT EXISTS ad_rewards(id BIGSERIAL PRIMARY KEY, user_id BIGINT, used BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now())");
      await q("CREATE TABLE IF NOT EXISTS spin_tickets(charge_id TEXT PRIMARY KEY, user_id BIGINT, used BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT now())");
      break;
    } catch (e) { console.error("db:", e.message); await new Promise(r => setTimeout(r, 3000)); }
  }
  BOTNAME = (await tg("getMe")).username;
  await tg("setWebhook", { url: BASE + "/tg", secret_token: SECRET, allowed_updates: ["message", "callback_query", "pre_checkout_query", "chat_member"] });
  await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Каталог", web_app: { url: BASE } } });
  await tg("setMyCommands", { commands: [{ command: "start", description: "Запустить бота" }] });
  console.log("ready", BASE);
})().catch(e => console.error(e));

const HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>delka shop</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script><script src="https://sad.adsgram.ai/js/sad.min.js"></script><style>
*{box-sizing:border-box;margin:0;-webkit-tap-highlight-color:transparent}
:root{--bg:#050810;--s:#0b1222;--s2:#111b33;--l:rgba(110,150,255,.15);--t:#eaf0ff;--m:#7f8fb3;--a:#2f6bff;--b:#19c3ff}
body{background:radial-gradient(110% 50% at 50% -8%,rgba(47,107,255,.28),transparent 62%),var(--bg);color:var(--t);font:15px/1.4 -apple-system,"SF Pro Display",Inter,Roboto,"Segoe UI",sans-serif;min-height:100vh;padding:calc(env(safe-area-inset-top) + 16px) 18px 120px}
.view{display:none}.view.on{display:block;animation:in .25s}@keyframes in{from{opacity:0;transform:translateY(6px)}}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:18px;letter-spacing:-.3px}
.logo i{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,var(--a),var(--b));display:grid;place-items:center;font-style:normal;box-shadow:0 8px 22px -6px var(--a)}
.chip{background:var(--s2);border:1px solid var(--l);color:var(--t);border-radius:99px;padding:8px 14px;font-family:inherit;font-weight:600;font-size:14px}
h1{font-size:34px;letter-spacing:-1px;font-weight:800}.sub{color:var(--m);margin:4px 0 22px}
.cat{width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;color:var(--t);font-family:inherit;background:linear-gradient(135deg,rgba(47,107,255,.16),var(--s) 70%);border:1px solid var(--l);border-radius:26px;padding:20px;margin-bottom:14px}
.cat b{display:block;font-size:22px;letter-spacing:-.4px}.cat span{display:block;color:var(--m);margin:2px 0 10px}.cat em{display:inline-block;margin-top:10px;font-style:normal;font-size:12px;color:var(--b);background:rgba(25,195,255,.1);padding:4px 10px;border-radius:99px}
.ic{width:72px;height:72px;border-radius:22px;display:grid;place-items:center;background:linear-gradient(135deg,var(--g1),var(--g2));box-shadow:0 14px 34px -10px var(--g1);flex:none}
svg{width:32px;height:32px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.item{background:var(--s);border:1px solid var(--l);border-radius:20px;padding:16px;margin-bottom:12px}.item b{display:block;font-size:17px}.item span{color:var(--m);display:block;margin:2px 0 8px}.item strong{color:var(--b)}
.back{background:none;border:0;color:var(--b);font-family:inherit;font-weight:600;font-size:15px;margin-bottom:14px;padding:0}
.empty{text-align:center;padding:44px 12px}.empty .ic{margin:0 auto 20px}.empty b{display:block;font-size:19px}.empty span{display:block;color:var(--m);margin-top:6px}
.who{text-align:center;margin:8px 0 24px}.av{position:relative;width:104px;height:104px;margin:0 auto 18px;border-radius:50%;box-shadow:0 0 0 3px var(--bg),0 0 0 6px var(--a);overflow:hidden;background:linear-gradient(135deg,var(--a),#0a1a4a)}
.av span{position:absolute;inset:0;display:grid;place-items:center;font-size:42px;font-weight:700}.av img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.who h2{font-size:24px;letter-spacing:-.5px}.id{background:var(--s2);border:1px solid var(--l);color:var(--m);border-radius:99px;padding:5px 14px;margin-top:8px;font-family:inherit;font-size:14px}
.bal{border-radius:28px;padding:24px;background:radial-gradient(120% 120% at 100% 0,rgba(25,195,255,.35),transparent 55%),linear-gradient(135deg,#1d4fe0,#0b1f66);border:1px solid rgba(120,170,255,.3);box-shadow:0 20px 50px -20px #2f6bff}
.bal span{color:#cfe0ff}.bal strong{display:block;font-size:46px;letter-spacing:-1.5px;margin:4px 0 18px}.bal button{width:100%;border:0;border-radius:16px;padding:15px;background:#fff;color:#0b2a8f;font-family:inherit;font-weight:700;font-size:16px}
#tabs{position:fixed;left:18px;right:18px;bottom:calc(env(safe-area-inset-bottom) + 14px);display:flex;gap:6px;padding:6px;border-radius:26px;background:rgba(11,18,34,.82);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid var(--l)}
#tabs button{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border:0;border-radius:20px;padding:9px 0;background:none;color:var(--m);font-family:inherit;font-weight:600;font-size:11px}
#tabs svg{width:22px;height:22px;stroke:currentColor}#tabs button.on{background:linear-gradient(135deg,var(--a),#1b8cff);color:#fff;box-shadow:0 8px 22px -8px var(--a)}
#sh{position:fixed;inset:0;background:rgba(2,4,10,.7);display:none;align-items:flex-end;z-index:5}#sh.on{display:flex}
.pn{width:100%;background:var(--s);border-radius:30px 30px 0 0;border-top:1px solid var(--l);padding:12px 18px calc(env(safe-area-inset-bottom) + 20px);animation:up .25s}@keyframes up{from{transform:translateY(40px);opacity:0}}
.grab{width:40px;height:4px;border-radius:9px;background:var(--l);margin:0 auto 16px}.pn h2{font-size:22px;margin-bottom:14px}
.opt{display:flex;gap:14px;align-items:center;padding:14px;border-radius:20px;border:1px solid var(--l);background:var(--s2);margin-bottom:10px}.opt.on{border-color:var(--a);box-shadow:0 0 0 1px var(--a) inset}.opt.off{opacity:.55}
.opt b{display:block}.opt span{color:var(--m);font-size:13px}.ic.sm{width:46px;height:46px;border-radius:15px;font-weight:800;font-size:22px;box-shadow:none}.ic.sm svg{width:24px;height:24px}
.chips{display:flex;gap:8px;margin:14px 0 10px}.chips button{flex:1;padding:12px 0;border-radius:14px;border:1px solid var(--l);background:var(--s2);color:var(--t);font-family:inherit;font-weight:600}.chips button.on{background:var(--a);border-color:var(--a)}
#am{width:100%;padding:14px;border-radius:14px;border:1px solid var(--l);background:var(--bg);color:var(--t);font-size:16px;font-family:inherit}
.get{color:var(--b);margin:12px 0;min-height:20px;text-align:center;font-weight:600}
.go{width:100%;border:0;border-radius:16px;padding:16px;background:linear-gradient(135deg,var(--a),var(--b));color:#fff;font-family:inherit;font-weight:700;font-size:16px}.go:disabled{opacity:.5}
#toast{position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 14px);transform:translate(-50%,-90px);background:var(--s2);border:1px solid var(--l);padding:11px 18px;border-radius:99px;z-index:9;transition:.25s}#toast.on{transform:translate(-50%,0)}
.card{background:var(--s);border:1px solid var(--l);border-radius:24px;padding:18px;margin-bottom:14px}
.row{display:flex;gap:14px;align-items:center;margin-bottom:14px}.row b{display:block}.row span{color:var(--m);font-size:13px}
.bar{height:8px;border-radius:9px;background:var(--s2);overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--a),var(--b));border-radius:9px}.meta{color:var(--m);font-size:13px;margin:8px 0 14px}
.seg{display:flex;background:var(--s2);border:1px solid var(--l);border-radius:18px;padding:4px;margin-bottom:18px}.seg button{flex:1;border:0;border-radius:14px;padding:11px;background:none;color:var(--m);font-family:inherit;font-weight:600;font-size:15px}.seg button.on{background:var(--a);color:#fff}
.wheelw{position:relative;width:min(300px,80vw);margin:10px auto 22px}#wh{transition:transform 4.5s cubic-bezier(.12,.7,.1,1);border-radius:50%;box-shadow:0 0 60px -10px var(--a)}#wh svg{width:100%;height:auto;display:block;stroke-width:0}
.ptr{position:absolute;left:50%;top:-10px;margin-left:-11px;border:11px solid transparent;border-top:22px solid var(--b);z-index:2;filter:drop-shadow(0 4px 6px #000)}
.pz{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;justify-content:center}.pz span{background:var(--s2);border:1px solid var(--l);border-radius:12px;padding:6px 10px;font-size:13px;color:var(--m)}.pz b{color:var(--t)}
.lbl{color:var(--m);font-size:13px}.lnk{background:var(--bg);border:1px solid var(--l);border-radius:14px;padding:12px;margin:8px 0 12px;word-break:break-all;color:var(--b);font-size:14px}.two{display:flex;gap:10px}.two .go{flex:1}.alt{background:var(--s2)!important;border:1px solid var(--l)!important}
.h2{font-size:20px;margin:24px 0 12px;letter-spacing:-.3px}.empty.small{padding:22px 12px;color:var(--m)}
.ur{display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--s);border:1px solid var(--l);border-radius:18px;margin-bottom:8px}.ur .n{width:20px;color:var(--m);font-weight:700}.ur .tl{width:42px;height:42px;border-radius:14px;background:var(--s2);display:grid;place-items:center;font-size:20px;flex:none}
.ur .av{width:44px;height:44px;margin:0;box-shadow:none;flex:none}.ur .av span{font-size:18px}.ur .nm{flex:1;min-width:0}.ur .nm b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ur .nm span{color:var(--m);font-size:12px}.ur strong{color:var(--b);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<section id="v-c" class="view on"><div class="top"><div class="logo"><i>d</i>delka shop</div><button class="chip" onclick="show('v-p')" id="hb">...</button></div><h1>Каталог</h1><p class="sub">Софты, обучения и сервисы по выгодной цене</p><div id="cats"></div></section>
<section id="v-k" class="view"><button class="back" onclick="show('v-c')">‹ Каталог</button><h1 id="kt"></h1><p class="sub"></p><div id="ki"></div></section>
<section id="v-p" class="view"></section>
<section id="v-b" class="view"></section>
<section id="v-r" class="view"></section>
<section id="v-l" class="view"></section>
<nav id="tabs"><button id="t-c" class="on" onclick="show('v-c')"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg>Каталог</button><button id="t-b" onclick="show('v-b')"><svg viewBox="0 0 24 24"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v9h14v-9M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/></svg>Бонусы</button><button id="t-r" onclick="show('v-r')"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3.2-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c3 0 5 2 5 5"/></svg>Рефералы</button><button id="t-p" onclick="show('v-p')"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>Профиль</button></nav>
<div id="sh" onclick="if(event.target===this)closeSheet()"><div class="pn"><div class="grab"></div><h2>Пополнение баланса</h2>
<div class="opt on"><div class="ic sm" style="--g1:#ffb800;--g2:#ff8a00"><svg viewBox="0 0 24 24" style="fill:#fff"><polygon points="12 2 15 9 22 9.5 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.5 9 9"/></svg></div><div><b>Звёздами Telegram</b><span>1 ⭐ = 2 ₽</span></div></div>
<div class="opt off" onclick="toast('Временно недоступно')"><div class="ic sm" style="--g1:#26a17b;--g2:#0e7a5a">₿</div><div><b>Криптовалютой</b><span>Временно недоступно</span></div></div>
<div class="chips" id="ch"></div><input id="am" type="number" inputmode="numeric" min="1" max="10000" placeholder="Своя сумма в звёздах" oninput="setS(this.value)"><div class="get" id="gt"></div><button class="go" id="go" onclick="pay()"></button></div></div>
<div id="toast"></div>
<script>
var tg=window.Telegram.WebApp,me=null,stars=100,$=function(i){return document.getElementById(i)};
var CATS=[
{n:"Софты",d:"Программы и инструменты",c:["#2f6bff","#19c3ff"],i:'<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="14" y1="4" x2="10" y2="20"/>',items:[]},
{n:"Обучения",d:"Курсы и гайды",c:["#5b4dff","#2f9bff"],i:'<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/>',items:[]},
{n:"Сервисы",d:"Подписки и аккаунты",c:["#0a7cff","#12e0d0"],i:'<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',items:[]}];
try{tg.ready();tg.expand();tg.setHeaderColor("#050810");tg.setBackgroundColor("#050810")}catch(e){}
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function rub(n){return n.toLocaleString("ru-RU")+" ₽"}
function toast(t){var e=$("toast");e.textContent=t;e.className="on";setTimeout(function(){e.className=""},2400)}
function api(p,b){b=b||{};b.initData=tg.initData;return fetch(p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}).then(function(r){return r.json().then(function(j){j.s=r.status;return j})})}
function show(v){["v-c","v-k","v-p","v-l","v-b","v-r"].forEach(function(x){$(x).className="view"+(x===v?" on":"")});$("tabs").style.display=v==="v-l"?"none":"flex";var on={c:v==="v-c"||v==="v-k",b:v==="v-b",r:v==="v-r",p:v==="v-p"};["c","b","r","p"].forEach(function(k){$("t-"+k).className=on[k]?"on":""});if(v==="v-b")loadB();if(v==="v-r")loadR();if(v==="v-p"){load();loadH()}scrollTo(0,0)}
function icon(c){return'<div class="ic" style="--g1:'+c.c[0]+';--g2:'+c.c[1]+'"><svg viewBox="0 0 24 24">'+c.i+'</svg></div>'}
$("cats").innerHTML=CATS.map(function(c,i){return'<button class="cat" onclick="openCat('+i+')"><div><b>'+c.n+'</b><em>'+(c.items.length?c.items.length+" товаров":"Скоро")+'</em></div>'+icon(c)+'</button>'}).join("");
function openCat(i){var c=CATS[i];$("kt").textContent=c.n;$("ki").innerHTML=c.items.length?c.items.map(function(p){return'<div class="item"><b>'+esc(p.t)+'</b><span>'+esc(p.d)+'</span><strong>'+rub(p.p)+'</strong></div>'}).join(""):'<div class="empty">'+icon(c)+'<b>Здесь скоро появятся товары</b><span>Подпишитесь на @delka_shop, чтобы не пропустить новинки</span></div>';show("v-k")}
function openCh(c){tg.openTelegramLink("https://t.me/"+c)}
function renderP(){var u=me.user;$("v-p").innerHTML='<div class="top"><div class="logo"><i>d</i>Профиль</div></div><div class="who">'+av(u.name,u.photo)+'<h2>'+esc(u.name)+'</h2><button class="id" onclick="cp()">ID '+u.id+'</button></div><div class="bal"><span>Баланс</span><strong>'+rub(me.balance)+'</strong><button onclick="openSheet()">Пополнить баланс</button></div><h2 class="h2">История операций</h2><div id="hist">'+hh+'</div>'}
function cp(){try{navigator.clipboard.writeText(String(me.user.id))}catch(e){}toast("ID скопирован")}
function load(){return api("/api/me").then(function(j){
 if(!tg.initData||j.error==="auth"){$("v-l").innerHTML='<h1>Откройте через бота</h1><p class="sub">Магазин работает только внутри Telegram.</p>';show("v-l");return}
 if(j.error){toast("Нет связи, попробуйте позже");return}
 me=j;$("hb").textContent=rub(j.balance);renderP();
 if(j.missing.length){$("v-l").innerHTML='<h1>Подпишитесь на каналы</h1><p class="sub">Магазин откроется после подписки на оба канала.</p>'+j.missing.map(function(c){return'<button class="cat" data-c="'+c+'" onclick="openCh(this.dataset.c)"><div><b>@'+c+'</b><span>Нажмите, чтобы подписаться</span></div></button>'}).join("")+'<button class="go" onclick="load()">Проверить подписку</button>';show("v-l")}
 else if($("v-l").className.indexOf("on")>-1)show("v-c")})}
function openSheet(){$("sh").className="on";setS(stars)}
function closeSheet(){$("sh").className=""}
function pick(n){$("am").value="";setS(n)}
function setS(v){stars=Math.max(0,Math.min(10000,Math.floor(Number(v))||0));$("ch").innerHTML=[50,100,250,500].map(function(n){return'<button class="'+(n===stars?"on":"")+'" onclick="pick('+n+')">'+n+' ⭐</button>'}).join("");$("gt").textContent=stars?"Вы получите "+rub(stars*me.rate):"";$("go").textContent=stars?"Оплатить "+stars+" ⭐":"Введите сумму";$("go").disabled=!stars}
function pay(){if(!stars)return;var old=me.balance;$("go").disabled=true;api("/api/invoice",{stars:stars}).then(function(j){$("go").disabled=false;if(!j.link){toast("Не удалось создать счёт");return}tg.openInvoice(j.link,function(s){if(s==="paid"){closeSheet();toast("Оплата прошла ✅");var n=0,t=setInterval(function(){load().then(function(){if(me.balance>old||++n>8)clearInterval(t)})},1500)}})})}
var hh="",rd=null,bd=null,bs=0,rot=0,busy=false;
var TY={stars:["⭐","Пополнение звёздами"],crypto:["₿","Пополнение криптой"],bonus:["🎁","Бонус за задание"],roulette:["🎰","Рулетка"],ref:["👥","Реферал"]};
function av(n,p){return'<div class="av"><span>'+esc((n||"?").trim().charAt(0).toUpperCase())+'</span>'+(p?'<img src="'+esc(p)+'" onerror="this.remove()">':'')+'</div>'}
function dt(s){return new Date(s).toLocaleString("ru-RU",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}
function setBal(b){me.balance=b;$("hb").textContent=rub(b);renderP()}
function loadH(){api("/api/history").then(function(j){if(j.error)return;hh=j.list.length?j.list.map(function(t){var y=TY[t.type]||["💠",t.type];return'<div class="ur"><div class="tl">'+y[0]+'</div><div class="nm"><b>'+y[1]+'</b><span>'+(t.type==="ref"&&t.fn?"от "+esc(t.fn)+" · ":(t.note?esc(t.note)+" · ":""))+dt(t.created_at)+'</span></div><strong>'+(t.kop<0?"−":"+")+rub(Math.abs(t.kop)/100)+'</strong></div>'}).join(""):'<div class="empty small">Операций пока нет</div>';if($("hist"))$("hist").innerHTML=hh})}
function loadR(){api("/api/ref").then(function(j){if(j.error)return;rd=j;renderR()})}
function renderR(){$("v-r").innerHTML='<div class="top"><div class="logo"><i>d</i>Рефералы</div></div><div class="bal"><span>Заработано с рефералов</span><strong>'+rub(rd.earned)+'</strong><span>Приглашено: '+rd.count+' · вы получаете 18% с каждого пополнения друга</span></div><div class="card" style="margin-top:14px"><span class="lbl">Ваша реферальная ссылка</span><div class="lnk">'+esc(rd.link)+'</div><div class="two"><button class="go" onclick="cpl()">Копировать</button><button class="go alt" onclick="shr()">Поделиться</button></div></div><h2 class="h2">Топ приглашённых</h2>'+(rd.list.length?rd.list.map(function(x,i){return'<div class="ur"><div class="n">'+(i+1)+'</div>'+av(x.name,x.photo)+'<div class="nm"><b>'+esc(x.name||"Без имени")+'</b><span>ID '+x.id+'</span></div><strong>+'+rub(x.earned)+'</strong></div>'}).join(""):'<div class="empty small">Пока никого. Отправьте ссылку друзьям.</div>')}
function cpl(){try{navigator.clipboard.writeText(rd.link)}catch(e){}toast("Ссылка скопирована")}
function shr(){tg.openTelegramLink("https://t.me/share/url?url="+encodeURIComponent(rd.link)+"&text="+encodeURIComponent("Софты, обучения и сервисы по выгодной цене — delka shop"))}
function sb(x){bs=x;renderB()}
function loadB(){api("/api/bonus").then(function(j){if(j.error)return;bd=j;bd.t0=Date.now();renderB()})}
function renderB(){if(!bd||busy)return;var h='<div class="top"><div class="logo"><i>d</i>Бонусы</div></div><div class="seg"><button class="'+(bs?"":"on")+'" onclick="sb(0)">Задания</button><button class="'+(bs?"on":"")+'" onclick="sb(1)">Рулетка</button></div>';
 if(!bs){var p=Math.min(bd.invited,25),ok=bd.invited>=25;h+='<div class="card"><div class="row"><div class="ic sm" style="--g1:#2f6bff;--g2:#19c3ff"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3.2-6 7-6s7 2.5 7 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c3 0 5 2 5 5"/></svg></div><div><b>Пригласи 25 друзей</b><span>Награда 100 ₽ · выполняется один раз</span></div></div><div class="bar"><i style="width:'+p*4+'%"></i></div><div class="meta">'+p+' из 25</div>'+(bd.done?'<button class="go" disabled>Выполнено ✓</button>':'<button class="go" '+(ok?'':'disabled')+' onclick="claim()">'+(ok?'Забрать 100 ₽':'Приглашайте друзей по ссылке')+'</button>')+'</div>'}
 else{var n=bd.prizes.length,s=360/n,w="",cl=["#1d4fe0","#0e2a6b","#0a7cff"];bd.prizes.forEach(function(z,i){var a=i*s*Math.PI/180,b=(i+1)*s*Math.PI/180;w+='<path d="M0 0L'+100*Math.sin(a)+' '+-100*Math.cos(a)+'A100 100 0 0 1 '+100*Math.sin(b)+' '+-100*Math.cos(b)+'Z" fill="'+(i===n-1?"#12b7e8":cl[i%3])+'" stroke="#050810" stroke-width="2"/><text transform="rotate('+(i+.5)*s+') translate(0,-66)" text-anchor="middle" dominant-baseline="middle" fill="#fff" stroke="none" font-size="15" font-weight="700">'+z[0]+' ₽</text>'});
 h+='<div class="wheelw"><div class="ptr"></div><div id="wh" style="transform:rotate('+rot+'deg)"><svg viewBox="-104 -104 208 208">'+w+'<circle r="13" fill="#050810" stroke="#19c3ff" stroke-width="2"/></svg></div></div><button class="go" id="sp" onclick="spin()">'+(bd.tickets?"Крутить (прокрутка оплачена)":bd.wait>0?"Крутить за "+bd.cost+" ⭐":"Крутить бесплатно")+'</button>'+(bd.adBlock&&(bd.adLeft>0||bd.adTickets)?'<button class="go alt" style="margin-top:10px" onclick="ad()">'+(bd.adTickets?"Крутить (награда за рекламу)":"📺 Смотреть рекламу · осталось "+bd.adLeft+" из 2")+'</button>':'')+'<div class="get" id="cd"></div><div class="pz">'+bd.prizes.map(function(z){return'<span><b>'+z[0]+' ₽</b> · '+z[1]/10+'%</span>'}).join("")+'</div>'}
 $("v-b").innerHTML=h;tick()}
function tick(){var e=$("cd");if(!e||!bd||busy||bs!==1)return;var l=Math.ceil(bd.wait-(Date.now()-bd.t0)/1000);if(bd.wait>0&&l<=0){loadB();return}e.textContent=(bd.wait>0&&!bd.tickets)?"Бесплатная прокрутка через "+[l/3600,l%3600/60,l%60].map(function(x){x=Math.floor(x);return x<10?"0"+x:x}).join(":"):""}
setInterval(tick,1000);
function claim(){api("/api/claim").then(function(j){if(j.error){toast("Пока недоступно");return}setBal(j.balance);toast("Начислено 100 ₽ 🎉");loadB()})}
function spin(){if(busy)return;if(bd.tickets)go("ticket");else if(bd.wait<=0)go("free");else buy()}
function go(m){busy=true;var sp=$("sp");if(sp)sp.disabled=true;api("/api/spin",{mode:m}).then(function(j){if(j.error){busy=false;toast("Прокрутка недоступна");loadB();return}var c=(j.index+.5)*360/bd.prizes.length;rot=Math.ceil(rot/360)*360+1800+(360-c);if($("wh"))$("wh").style.transform="rotate("+rot+"deg)";setTimeout(function(){busy=false;setBal(j.balance);toast("Выигрыш: "+j.prize+" ₽ 🎉");loadB()},4700)})}
function buy(){api("/api/invoice",{kind:"spin"}).then(function(j){if(!j.link){toast("Не удалось создать счёт");return}tg.openInvoice(j.link,function(s){if(s==="paid"){var n=0,t=setInterval(function(){api("/api/bonus").then(function(d){if(d.tickets||++n>10){clearInterval(t);d.t0=Date.now();bd=d;renderB();if(d.tickets)go("ticket")}})},1200)}})})}
function ad(){if(busy)return;if(bd.adTickets){go("ad");return}
 if(!window.Adsgram){toast("Реклама недоступна");return}
 try{window.Adsgram.init({blockId:bd.adBlock}).show().then(function(r){if(r.done)waitAd();else toast("Досмотрите рекламу до конца")}).catch(function(){toast("Реклама сейчас недоступна, попробуйте позже")})}catch(e){toast("Реклама сейчас недоступна")}}
function waitAd(){var n=0,t=setInterval(function(){api("/api/bonus").then(function(d){if(d.adTickets||++n>10){clearInterval(t);d.t0=Date.now();bd=d;renderB();if(d.adTickets)go("ad");else toast("Награда не пришла, попробуйте позже")}})},1200)}
document.addEventListener("visibilitychange",function(){if(!document.hidden)load()});
load();
</script></body></html>`;
