'use strict';
// Servidor de informes de servicio - SOIM Chile.
// Sin dependencias externas: solo módulos incluidos en Node (>= 22.13).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const sec = require('./lib/security');
const { writeZip } = require('./lib/zip');

// ------------------------------------------------------------------ configuración
const PROD = process.env.NODE_ENV === 'production';
const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const RECEIPT_DIR = path.join(DATA_DIR, 'comprobantes');
const PUBLIC = path.join(__dirname, 'public');
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined ? +process.env.TRUST_PROXY : (PROD ? 1 : 0);
const SESSION_DAYS = 30;
const MAX_PDF = 25 * 1024 * 1024;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 16) {
  if (PROD) { console.error('Falta la variable SESSION_SECRET (mínimo 16 caracteres).'); process.exit(1); }
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[aviso] SESSION_SECRET no definido: se usa uno temporal (las sesiones se pierden al reiniciar).');
}

fs.mkdirSync(PDF_DIR, { recursive: true });
fs.mkdirSync(RECEIPT_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'soim.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rut TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('tecnico','admin')),
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 0,
  token_ver INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reports(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  fecha TEXT NOT NULL,
  cliente TEXT NOT NULL,
  tecnico TEXT,
  equipo TEXT,
  tipo TEXT,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_reports_fecha ON reports(fecha);
CREATE INDEX IF NOT EXISTS ix_reports_user ON reports(user_id);
CREATE TABLE IF NOT EXISTS expenses(
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  fecha TEXT NOT NULL,
  monto INTEGER NOT NULL,
  categoria TEXT NOT NULL,
  doc_tipo TEXT NOT NULL,
  doc_numero TEXT,
  proveedor TEXT,
  cliente TEXT,
  report_id TEXT,
  justificacion TEXT NOT NULL,
  receipt TEXT,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobado','rechazado')),
  motivo TEXT,
  revisado_por INTEGER REFERENCES users(id),
  revisado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_exp_fecha ON expenses(fecha);
CREATE INDEX IF NOT EXISTS ix_exp_user ON expenses(user_id);
`);

// Administrador inicial (solo si todavía no existe ninguno)
(function bootstrapAdmin() {
  const has = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n;
  if (has) return;
  const rut = sec.normRut(process.env.ADMIN_RUT);
  const pw = process.env.ADMIN_PASSWORD || '';
  if (!rut || sec.passwordError(pw, rut)) {
    console.warn('[aviso] No hay administrador. Defina ADMIN_RUT (RUT válido) y ADMIN_PASSWORD (mínimo 8 caracteres) y reinicie.');
    return;
  }
  db.prepare('INSERT INTO users(rut,name,role,pass_hash,must_change) VALUES(?,?,?,?,1)')
    .run(rut, (process.env.ADMIN_NAME || 'Administrador').slice(0, 100), 'admin', sec.hashPassword(pw));
  console.log('Administrador inicial creado: ' + rut + ' (deberá cambiar la contraseña al entrar).');
})();

// ------------------------------------------------------------------ utilidades
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function clean(v, n = 200) { return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n); }
function safeName(name, fallback) {
  let n = clean(name, 150).replace(/[^\w.\- ÁÉÍÓÚÑáéíóúñÜü]/g, '_').replace(/\.+$/, '');
  if (!n) n = fallback || 'informe';
  if (!/\.pdf$/i.test(n)) n += '.pdf';
  return n;
}
function likeEsc(s) { return '%' + String(s).replace(/[\\%_]/g, c => '\\' + c) + '%'; }
function todayIso() { return new Date().toISOString().slice(0, 10); }

function clientIp(req) {
  if (TRUST_PROXY > 0) {
    const x = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (x.length) return x[Math.max(0, x.length - TRUST_PROXY)];
  }
  return req.socket.remoteAddress || '?';
}

// Límite de intentos en memoria
const buckets = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.t > windowMs) b = { n: 0, t: now };
  b.n++; buckets.set(key, b);
  return b.n <= max;
}
function peek(key, max, windowMs) {
  const b = buckets.get(key);
  return !(b && Date.now() - b.t <= windowMs && b.n >= max);
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 3600e3) buckets.delete(k); }, 600e3).unref();

function send(res, status, body, headers) {
  const h = Object.assign({}, headers);
  if (typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; h['Cache-Control'] = 'no-store'; }
  res.writeHead(status, h);
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    req.on('data', c => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; reject(new HttpError(413, 'El archivo es demasiado grande.')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}
async function readJson(req, limit = 50 * 1024) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { const j = JSON.parse(buf.toString('utf8')); return j && typeof j === 'object' ? j : {}; }
  catch (e) { throw new HttpError(400, 'Solicitud inválida.'); }
}
function parseCookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return o;
}
function setSession(res, u) {
  const token = sec.signToken({ uid: u.id, v: u.token_ver, exp: Date.now() + SESSION_DAYS * 864e5 }, SECRET);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${PROD ? '; Secure' : ''}`);
}
function clearSession(res) {
  res.setHeader('Set-Cookie', `sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${PROD ? '; Secure' : ''}`);
}
const pub = u => ({ id: u.id, rut: u.rut, name: u.name, role: u.role, mustChange: !!u.must_change });

const qUserById = db.prepare('SELECT id,rut,name,role,active,must_change,token_ver FROM users WHERE id=?');
function currentUser(req) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  const p = sec.verifyToken(t, SECRET);
  if (!p) return null;
  const u = qUserById.get(p.uid);
  return u && u.active && u.token_ver === p.v ? u : null;
}
function needUser(ctx, { allowMust = false } = {}) {
  const u = currentUser(ctx.req);
  if (!u) throw new HttpError(401, 'Debe iniciar sesión.');
  if (u.must_change && !allowMust) throw new HttpError(403, 'Debe cambiar su contraseña antes de continuar.');
  ctx.user = u; return u;
}
function needAdmin(ctx) { const u = needUser(ctx); if (u.role !== 'admin') throw new HttpError(403, 'Solo para administradores.'); return u; }

// ------------------------------------------------------------------ rutas API
const routes = [];
function route(method, pattern, fn) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, fn });
}

route('GET', '/healthz', ctx => send(ctx.res, 200, 'ok', { 'Content-Type': 'text/plain' }));

route('POST', '/api/login', async ctx => {
  const ip = clientIp(ctx.req);
  if (!peek('ip:' + ip, 40, 15 * 60e3)) throw new HttpError(429, 'Demasiados intentos. Espere unos minutos.');
  const body = await readJson(ctx.req);
  const rut = sec.normRut(body.rut), pw = String(body.password || '');
  const bad = () => { hit('ip:' + ip, 40, 15 * 60e3); if (rut) hit('rut:' + rut, 10, 15 * 60e3); throw new HttpError(401, 'RUT o contraseña incorrectos.'); };
  if (!rut || !pw || pw.length > 200) { sec.verifyPassword(pw.slice(0, 200), sec.DUMMY); bad(); }
  if (!peek('rut:' + rut, 10, 15 * 60e3)) throw new HttpError(429, 'Demasiados intentos para este RUT. Espere unos minutos.');
  const u = db.prepare('SELECT * FROM users WHERE rut=?').get(rut);
  const ok = sec.verifyPassword(pw, u ? u.pass_hash : sec.DUMMY);
  if (!u || !ok || !u.active) bad();
  buckets.delete('rut:' + rut);
  setSession(ctx.res, u);
  send(ctx.res, 200, { user: pub(u) });
});

route('POST', '/api/logout', ctx => { clearSession(ctx.res); send(ctx.res, 200, { ok: true }); });

route('GET', '/api/me', ctx => { const u = needUser(ctx, { allowMust: true }); send(ctx.res, 200, { user: pub(u) }); });

route('POST', '/api/password', async ctx => {
  const u = needUser(ctx, { allowMust: true });
  if (!peek('pw:' + u.id, 10, 15 * 60e3)) throw new HttpError(429, 'Demasiados intentos. Espere unos minutos.');
  const body = await readJson(ctx.req);
  const full = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  if (!sec.verifyPassword(String(body.current || ''), full.pass_hash)) { hit('pw:' + u.id, 10, 15 * 60e3); throw new HttpError(400, 'La contraseña actual no es correcta.'); }
  const np = String(body.password || '');
  const err = sec.passwordError(np, u.rut);
  if (err) throw new HttpError(400, err);
  if (np === String(body.current)) throw new HttpError(400, 'La contraseña nueva debe ser distinta de la actual.');
  db.prepare('UPDATE users SET pass_hash=?, must_change=0, token_ver=token_ver+1 WHERE id=?').run(sec.hashPassword(np), u.id);
  const nu = qUserById.get(u.id);
  setSession(ctx.res, nu);
  send(ctx.res, 200, { ok: true, user: pub(nu) });
});

// ---- Informes
const qRepById = db.prepare('SELECT * FROM reports WHERE id=?');
route('POST', '/api/reports', async ctx => {
  const u = needUser(ctx);
  if (!hit('up:' + u.id, 120, 60 * 60e3)) throw new HttpError(429, 'Demasiados envíos seguidos.');
  const b = await readJson(ctx.req, 35 * 1024 * 1024);
  const id = String(b.id || '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'Identificador de informe inválido.');
  const fecha = clean(b.fecha, 10), cliente = clean(b.cliente, 150);
  if (!DATE_RE.test(fecha)) throw new HttpError(400, 'Fecha inválida.');
  if (!cliente) throw new HttpError(400, 'Falta el cliente.');
  if (typeof b.pdf !== 'string' || !b.pdf) throw new HttpError(400, 'Falta el PDF.');
  const existing = qRepById.get(id);
  if (existing) return send(ctx.res, 200, { ok: true, dup: true });
  const buf = Buffer.from(b.pdf, 'base64');
  if (buf.length < 100 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'El archivo no es un PDF válido.');
  if (buf.length > MAX_PDF) throw new HttpError(413, 'El PDF es demasiado grande (máximo 25 MB).');
  const file = path.join(PDF_DIR, id + '.pdf'), tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
  try {
    db.prepare('INSERT INTO reports(id,user_id,fecha,cliente,tecnico,equipo,tipo,filename,size) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, u.id, fecha, cliente, clean(b.tecnico, 100) || u.name, clean(b.equipo, 100), clean(b.tipo, 100), safeName(b.name, fecha + '_' + cliente), buf.length);
  } catch (e) { try { fs.unlinkSync(file); } catch (_) {} throw e; }
  send(ctx.res, 201, { ok: true });
});

function reportFilter(ctx) {
  const q = ctx.query, w = [], p = [];
  if (ctx.user.role !== 'admin') { w.push('r.user_id=?'); p.push(ctx.user.id); }
  if (DATE_RE.test(q.desde || '')) { w.push('r.fecha>=?'); p.push(q.desde); }
  if (DATE_RE.test(q.hasta || '')) { w.push('r.fecha<=?'); p.push(q.hasta); }
  for (const f of ['cliente', 'tecnico', 'equipo']) {
    const v = clean(q[f], 100);
    if (v) { w.push('r.' + f + " LIKE ? ESCAPE '\\'"); p.push(likeEsc(v)); }
  }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}

route('GET', '/api/reports', ctx => {
  needUser(ctx);
  const f = reportFilter(ctx);
  const limit = Math.min(1000, Math.max(1, +ctx.query.limit || 200)), offset = Math.max(0, +ctx.query.offset || 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM reports r ' + f.where).get(...f.params).n;
  const items = db.prepare(
    'SELECT r.id,r.fecha,r.cliente,r.tecnico,r.equipo,r.tipo,r.filename,r.size,r.created_at,u.name AS subido_por ' +
    'FROM reports r JOIN users u ON u.id=r.user_id ' + f.where + ' ORDER BY r.fecha DESC, r.created_at DESC LIMIT ? OFFSET ?'
  ).all(...f.params, limit, offset);
  send(ctx.res, 200, { total, items });
});

route('GET', '/api/reports.zip', ctx => {
  needAdmin(ctx);
  const f = reportFilter(ctx);
  const rows = db.prepare('SELECT r.id,r.fecha,r.cliente,r.filename,r.created_at FROM reports r ' + f.where + ' ORDER BY r.fecha, r.created_at LIMIT 5000').all(...f.params);
  if (!rows.length) throw new HttpError(404, 'No hay informes con esos filtros.');
  const used = new Set(), entries = [];
  for (const r of rows) {
    const file = path.join(PDF_DIR, r.id + '.pdf');
    if (!fs.existsSync(file)) continue;
    const folder = clean(r.cliente, 80).replace(/[\\/:*?"<>|]/g, '-') || 'Sin cliente';
    let name = folder + '/' + r.filename;
    if (used.has(name.toLowerCase())) name = folder + '/' + r.filename.replace(/\.pdf$/i, '') + '_' + r.id.slice(-6) + '.pdf';
    used.add(name.toLowerCase());
    entries.push({ name, data: () => fs.readFileSync(file), date: new Date(r.created_at.replace(' ', 'T') + 'Z') });
  }
  if (!entries.length) throw new HttpError(404, 'Los archivos no se encontraron en el servidor.');
  const zname = 'informes_' + (ctx.query.desde || 'inicio') + '_a_' + (ctx.query.hasta || todayIso()) + '.zip';
  ctx.res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="' + zname.replace(/[^\w.\-]/g, '_') + '"', 'Cache-Control': 'private, no-store' });
  writeZip(ctx.res, entries);
});

route('GET', '/api/reports/:id/pdf', ctx => {
  needUser(ctx);
  const id = ctx.params.id;
  if (!ID_RE.test(id)) throw new HttpError(404, 'No encontrado.');
  const r = qRepById.get(id);
  if (!r || (ctx.user.role !== 'admin' && r.user_id !== ctx.user.id)) throw new HttpError(404, 'No encontrado.');
  const file = path.join(PDF_DIR, id + '.pdf');
  if (!fs.existsSync(file)) throw new HttpError(404, 'El archivo no está en el servidor.');
  ctx.res.removeHeader('Content-Security-Policy');
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': (ctx.query.download ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(r.filename),
    'Cache-Control': 'private, no-store', 'Content-Length': fs.statSync(file).size
  });
  fs.createReadStream(file).pipe(ctx.res);
});

// ---- Gastos
const CATS = ['combustible', 'alimentacion', 'alojamiento', 'transporte', 'peajes', 'repuestos', 'herramientas', 'otros'];
const DOCS = ['boleta', 'factura', 'sin_respaldo'];
const MAX_RECEIPT = 6 * 1024 * 1024;
const qExpById = db.prepare('SELECT * FROM expenses WHERE id=?');
function receiptKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}
function readExpense(b, existing) {
  const fecha = clean(b.fecha, 10), categoria = clean(b.categoria, 30), doc = clean(b.doc_tipo, 20);
  const monto = Math.round(Number(b.monto));
  if (!DATE_RE.test(fecha)) throw new HttpError(400, 'Fecha inválida.');
  if (fecha > todayIso()) throw new HttpError(400, 'La fecha del gasto no puede ser futura.');
  if (!Number.isFinite(monto) || monto <= 0 || monto > 100000000) throw new HttpError(400, 'El monto debe ser un número mayor a 0 (en pesos).');
  if (!CATS.includes(categoria)) throw new HttpError(400, 'Categoría inválida.');
  if (!DOCS.includes(doc)) throw new HttpError(400, 'Tipo de documento inválido.');
  const just = clean(b.justificacion, 1000);
  if (just.length < 10) throw new HttpError(400, 'La justificación es obligatoria (explique para qué fue el gasto, mínimo 10 caracteres).');
  const rid = clean(b.report_id, 120);
  if (rid && !qRepById.get(rid)) throw new HttpError(400, 'El informe asociado no existe.');
  return { fecha, monto, categoria, doc_tipo: doc, doc_numero: clean(b.doc_numero, 40), proveedor: clean(b.proveedor, 120), cliente: clean(b.cliente, 150), report_id: rid || null, justificacion: just };
}
function saveReceipt(id, b, required) {
  if (!b.comprobante) { if (required) throw new HttpError(400, 'Adjunte la foto del comprobante o elija "sin respaldo".'); return null; }
  if (typeof b.comprobante !== 'string') throw new HttpError(400, 'Comprobante inválido.');
  const buf = Buffer.from(b.comprobante, 'base64');
  const kind = receiptKind(buf);
  if (!kind) throw new HttpError(400, 'El comprobante debe ser una foto (JPG o PNG) o un PDF.');
  if (buf.length > MAX_RECEIPT) throw new HttpError(413, 'El comprobante es demasiado grande (máximo 6 MB).');
  const name = id + '.' + kind, file = path.join(RECEIPT_DIR, name), tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
  return name;
}
route('POST', '/api/expenses', async ctx => {
  const u = needUser(ctx);
  if (!hit('exp:' + u.id, 200, 60 * 60e3)) throw new HttpError(429, 'Demasiados envíos seguidos.');
  const b = await readJson(ctx.req, 9 * 1024 * 1024);
  const id = String(b.id || '');
  if (!ID_RE.test(id)) throw new HttpError(400, 'Identificador inválido.');
  if (qExpById.get(id)) return send(ctx.res, 200, { ok: true, dup: true });
  const e = readExpense(b);
  const rec = saveReceipt(id, b, e.doc_tipo !== 'sin_respaldo');
  try {
    db.prepare('INSERT INTO expenses(id,user_id,fecha,monto,categoria,doc_tipo,doc_numero,proveedor,cliente,report_id,justificacion,receipt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, u.id, e.fecha, e.monto, e.categoria, e.doc_tipo, e.doc_numero, e.proveedor, e.cliente, e.report_id, e.justificacion, rec);
  } catch (err) { if (rec) try { fs.unlinkSync(path.join(RECEIPT_DIR, rec)); } catch (_) {} throw err; }
  send(ctx.res, 201, { ok: true });
});

function expFilter(ctx) {
  const q = ctx.query, w = [], p = [];
  if (ctx.user.role !== 'admin') { w.push('x.user_id=?'); p.push(ctx.user.id); }
  else if (+q.user) { w.push('x.user_id=?'); p.push(+q.user); }
  if (DATE_RE.test(q.desde || '')) { w.push('x.fecha>=?'); p.push(q.desde); }
  if (DATE_RE.test(q.hasta || '')) { w.push('x.fecha<=?'); p.push(q.hasta); }
  if (['pendiente', 'aprobado', 'rechazado'].includes(q.estado)) { w.push('x.estado=?'); p.push(q.estado); }
  if (CATS.includes(q.categoria)) { w.push('x.categoria=?'); p.push(q.categoria); }
  const cl = clean(q.cliente, 100);
  if (cl) { w.push("x.cliente LIKE ? ESCAPE '\\'"); p.push(likeEsc(cl)); }
  return { where: w.length ? 'WHERE ' + w.join(' AND ') : '', params: p };
}
const EXP_COLS = 'x.id,x.user_id,u.name AS tecnico,x.fecha,x.monto,x.categoria,x.doc_tipo,x.doc_numero,x.proveedor,x.cliente,x.report_id,x.justificacion,(x.receipt IS NOT NULL) AS tiene_comprobante,x.estado,x.motivo,x.revisado_at,rv.name AS revisado_por,x.created_at';
const EXP_FROM = 'FROM expenses x JOIN users u ON u.id=x.user_id LEFT JOIN users rv ON rv.id=x.revisado_por ';

route('GET', '/api/expenses', ctx => {
  needUser(ctx);
  const f = expFilter(ctx);
  const limit = Math.min(1000, Math.max(1, +ctx.query.limit || 300)), offset = Math.max(0, +ctx.query.offset || 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM expenses x ' + f.where).get(...f.params).n;
  const items = db.prepare('SELECT ' + EXP_COLS + ' ' + EXP_FROM + f.where + ' ORDER BY x.fecha DESC, x.created_at DESC LIMIT ? OFFSET ?').all(...f.params, limit, offset);
  send(ctx.res, 200, { total, items });
});

route('GET', '/api/expenses/summary', ctx => {
  needUser(ctx);
  const f = expFilter(ctx);
  const grp = col => db.prepare('SELECT ' + col + ' AS k, COUNT(*) AS n, SUM(x.monto) AS total FROM expenses x JOIN users u ON u.id=x.user_id ' + (f.where ? f.where + " AND x.estado<>'rechazado'" : "WHERE x.estado<>'rechazado'") + ' GROUP BY k ORDER BY total DESC').all(...f.params);
  const porEstado = db.prepare('SELECT x.estado AS k, COUNT(*) AS n, SUM(x.monto) AS total FROM expenses x ' + f.where + ' GROUP BY k').all(...f.params);
  send(ctx.res, 200, {
    nota: 'Los totales por categoría, técnico y cliente excluyen los gastos rechazados.',
    categoria: grp('x.categoria'), tecnico: grp('u.name'), cliente: grp("COALESCE(NULLIF(x.cliente,''),'(sin cliente)')"), estado: porEstado
  });
});

function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmulas en Excel
  return '"' + s.replace(/"/g, '""') + '"';
}
route('GET', '/api/expenses.csv', ctx => {
  needAdmin(ctx);
  const f = expFilter(ctx);
  const rows = db.prepare('SELECT ' + EXP_COLS + ' ' + EXP_FROM + f.where + ' ORDER BY x.fecha, x.created_at LIMIT 20000').all(...f.params);
  const head = ['Fecha', 'Técnico', 'Monto CLP', 'Categoría', 'Documento', 'N° documento', 'Proveedor', 'Cliente', 'Justificación', 'Estado', 'Motivo rechazo', 'Revisado por', 'Fecha revisión', 'Comprobante', 'ID'];
  const lines = [head.map(csvCell).join(';')];
  for (const r of rows) lines.push([r.fecha, r.tecnico, r.monto, r.categoria, r.doc_tipo, r.doc_numero, r.proveedor, r.cliente, r.justificacion, r.estado, r.motivo, r.revisado_por, r.revisado_at, r.tiene_comprobante ? 'Sí' : 'No', r.id].map(csvCell).join(';'));
  const body = Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
  send(ctx.res, 200, body, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="gastos_' + (ctx.query.desde || 'inicio') + '_a_' + (ctx.query.hasta || todayIso()) + '.csv"', 'Cache-Control': 'private, no-store' });
});

function ownExpense(ctx) {
  const u = needUser(ctx);
  if (!ID_RE.test(ctx.params.id)) throw new HttpError(404, 'No encontrado.');
  const x = qExpById.get(ctx.params.id);
  if (!x || (u.role !== 'admin' && x.user_id !== u.id)) throw new HttpError(404, 'No encontrado.');
  return x;
}
route('GET', '/api/expenses/:id/receipt', ctx => {
  const x = ownExpense(ctx);
  if (!x.receipt) throw new HttpError(404, 'Este gasto no tiene comprobante.');
  const file = path.join(RECEIPT_DIR, x.receipt);
  if (!fs.existsSync(file)) throw new HttpError(404, 'El archivo no está en el servidor.');
  const ext = path.extname(file).slice(1);
  ctx.res.removeHeader('Content-Security-Policy');
  ctx.res.writeHead(200, { 'Content-Type': ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : 'image/jpeg', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'", 'Cache-Control': 'private, no-store', 'Content-Length': fs.statSync(file).size });
  fs.createReadStream(file).pipe(ctx.res);
});

// El técnico puede corregir un gasto pendiente o rechazado; vuelve a quedar pendiente.
route('PUT', '/api/expenses/:id', async ctx => {
  const x = ownExpense(ctx);
  if (x.user_id !== ctx.user.id) throw new HttpError(403, 'Solo el autor puede editar el gasto.');
  if (x.estado === 'aprobado') throw new HttpError(409, 'Un gasto aprobado no se puede modificar.');
  const b = await readJson(ctx.req, 9 * 1024 * 1024);
  const e = readExpense(b);
  let rec = x.receipt;
  const nr = saveReceipt(x.id, b, false);
  if (nr) { if (rec && rec !== nr) try { fs.unlinkSync(path.join(RECEIPT_DIR, rec)); } catch (_) {} rec = nr; }
  if (e.doc_tipo !== 'sin_respaldo' && !rec) throw new HttpError(400, 'Adjunte la foto del comprobante o elija "sin respaldo".');
  db.prepare("UPDATE expenses SET fecha=?,monto=?,categoria=?,doc_tipo=?,doc_numero=?,proveedor=?,cliente=?,report_id=?,justificacion=?,receipt=?,estado='pendiente',motivo=NULL,revisado_por=NULL,revisado_at=NULL WHERE id=?")
    .run(e.fecha, e.monto, e.categoria, e.doc_tipo, e.doc_numero, e.proveedor, e.cliente, e.report_id, e.justificacion, rec, x.id);
  send(ctx.res, 200, { ok: true });
});

route('DELETE', '/api/expenses/:id', ctx => {
  const x = ownExpense(ctx);
  if (x.user_id !== ctx.user.id) throw new HttpError(403, 'Solo el autor puede eliminar el gasto.');
  if (x.estado === 'aprobado') throw new HttpError(409, 'Un gasto aprobado no se puede eliminar.');
  db.prepare('DELETE FROM expenses WHERE id=?').run(x.id);
  if (x.receipt) try { fs.unlinkSync(path.join(RECEIPT_DIR, x.receipt)); } catch (_) {}
  send(ctx.res, 200, { ok: true });
});

route('POST', '/api/expenses/:id/review', async ctx => {
  const me = needAdmin(ctx);
  if (!ID_RE.test(ctx.params.id)) throw new HttpError(404, 'No encontrado.');
  const x = qExpById.get(ctx.params.id);
  if (!x) throw new HttpError(404, 'No encontrado.');
  const b = await readJson(ctx.req);
  const estado = b.estado, motivo = clean(b.motivo, 500);
  if (!['aprobado', 'rechazado', 'pendiente'].includes(estado)) throw new HttpError(400, 'Estado inválido.');
  if (estado === 'rechazado' && motivo.length < 5) throw new HttpError(400, 'Indique el motivo del rechazo.');
  if (estado !== 'pendiente' && x.user_id === me.id && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get().n > 1)
    throw new HttpError(403, 'Otro administrador debe revisar sus propios gastos.');
  db.prepare('UPDATE expenses SET estado=?, motivo=?, revisado_por=?, revisado_at=? WHERE id=?')
    .run(estado, estado === 'rechazado' ? motivo : null, estado === 'pendiente' ? null : me.id, estado === 'pendiente' ? null : new Date().toISOString().replace('T', ' ').slice(0, 19), x.id);
  send(ctx.res, 200, { ok: true });
});

// ---- Usuarios (solo administradores)
route('GET', '/api/users', ctx => {
  needAdmin(ctx);
  const items = db.prepare("SELECT id,rut,name,role,active,must_change,created_at,(SELECT COUNT(*) FROM reports WHERE user_id=users.id) AS informes FROM users ORDER BY name COLLATE NOCASE").all();
  send(ctx.res, 200, { items });
});

route('POST', '/api/users', async ctx => {
  needAdmin(ctx);
  const b = await readJson(ctx.req);
  const rut = sec.normRut(b.rut), name = clean(b.name, 100), role = b.role === 'admin' ? 'admin' : 'tecnico';
  if (!rut) throw new HttpError(400, 'RUT inválido. Revise el dígito verificador.');
  if (!name) throw new HttpError(400, 'Falta el nombre.');
  const err = sec.passwordError(b.password, rut);
  if (err) throw new HttpError(400, err);
  if (db.prepare('SELECT 1 FROM users WHERE rut=?').get(rut)) throw new HttpError(409, 'Ya existe un usuario con ese RUT.');
  const r = db.prepare('INSERT INTO users(rut,name,role,pass_hash,must_change) VALUES(?,?,?,?,1)').run(rut, name, role, sec.hashPassword(String(b.password)));
  send(ctx.res, 201, { ok: true, id: Number(r.lastInsertRowid) });
});

route('PATCH', '/api/users/:id', async ctx => {
  const me = needAdmin(ctx);
  const id = +ctx.params.id;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw new HttpError(404, 'Usuario no encontrado.');
  const b = await readJson(ctx.req);
  const name = b.name !== undefined ? clean(b.name, 100) : u.name;
  const role = b.role !== undefined ? (b.role === 'admin' ? 'admin' : 'tecnico') : u.role;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;
  if (!name) throw new HttpError(400, 'El nombre no puede estar vacío.');
  if (id === me.id && (!active || role !== 'admin')) throw new HttpError(400, 'No puede desactivarse ni quitarse el rol de administrador a sí mismo.');
  const adminsAfter = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1 AND id<>?").get(id).n + (role === 'admin' && active ? 1 : 0);
  if (adminsAfter < 1) throw new HttpError(400, 'Debe quedar al menos un administrador activo.');
  let hash = u.pass_hash, must = u.must_change, ver = u.token_ver;
  if (b.password !== undefined) {
    const err = sec.passwordError(b.password, u.rut);
    if (err) throw new HttpError(400, err);
    hash = sec.hashPassword(String(b.password)); must = 1; ver++;
  }
  if (!active && u.active) ver++;
  db.prepare('UPDATE users SET name=?, role=?, active=?, pass_hash=?, must_change=?, token_ver=? WHERE id=?').run(name, role, active, hash, must, ver, id);
  send(ctx.res, 200, { ok: true });
});

// ------------------------------------------------------------------ archivos estáticos
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  else if (pathname === '/admin') pathname = '/admin.html';
  else if (pathname === '/gastos') pathname = '/gastos.html';
  let file;
  try { file = path.normalize(path.join(PUBLIC, decodeURIComponent(pathname))); } catch (e) { return send(res, 400, 'Solicitud inválida', { 'Content-Type': 'text/plain' }); }
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  const type = MIME[path.extname(file).toLowerCase()];
  if (!type) return send(res, 404, 'No encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': fs.statSync(file).size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ------------------------------------------------------------------ servidor
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cdnjs.cloudflare.com; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; manifest-src 'self'";

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  try {
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    const isApi = pathname.startsWith('/api/') || pathname === '/healthz';
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido.');
      return serveStatic(req, res, pathname);
    }
    // Protección CSRF: en métodos que modifican datos, el origen debe ser este mismo sitio
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const o = req.headers.origin;
      if (o) { let h = ''; try { h = new URL(o).host; } catch (e) {} if (h !== req.headers.host) throw new HttpError(403, 'Origen no permitido.'); }
    }
    const m = req.method === 'HEAD' ? 'GET' : req.method;
    for (const r of routes) {
      if (r.method !== m) continue;
      const mt = r.re.exec(pathname);
      if (!mt) continue;
      const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(mt[i + 1]));
      const query = {}; url.searchParams.forEach((v, k) => { query[k] = v; });
      return await r.fn({ req, res, url, params, query });
    }
    throw new HttpError(404, 'No encontrado.');
  } catch (e) {
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    if (e instanceof HttpError) {
      if (e.status === 413) res.setHeader('Connection', 'close');
      return send(res, e.status, { error: e.message });
    }
    console.error('[error]', req.method, req.url, e);
    send(res, 500, { error: 'Error interno del servidor.' });
  }
});
server.requestTimeout = 120000;
server.listen(PORT, '0.0.0.0', () => console.log('Servidor SOIM Informes escuchando en el puerto ' + PORT + (PROD ? ' (producción)' : ' (desarrollo)')));

function shutdown() { server.close(() => { try { db.close(); } catch (e) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
