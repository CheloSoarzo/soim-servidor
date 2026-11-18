'use strict';
// Lectura de boletas y facturas: OCR local (tesseract, si está instalado) o texto del PDF, y extracción de datos.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { extractRuns } = require('./pdftext');

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function amountsIn(line) {
  const out = [];
  for (const m of line.matchAll(/(?:[$S5]\s*)?(\d{1,3}(?:[.,]\d{3})+|\d{3,9})(?![\d])/g)) {
    const raw = m[1];
    if (/^\d{1,3}[.,]\d{3}\b/.test(raw) || /^\d+$/.test(raw)) {
      const v = parseInt(raw.replace(/[.,]/g, ''), 10);
      if (v >= 100 && v <= 100000000) out.push(v);
    }
  }
  return out;
}

function rutOk(body, dv) {
  let sum = 0, m = 2;
  for (let i = body.length - 1; i >= 0; i--) { sum += +body[i] * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (sum % 11), d = r === 11 ? '0' : r === 10 ? 'K' : String(r);
  return d === String(dv).toUpperCase();
}
// RUT del comercio: primero el que sigue a "R.U.T."; debe tener dígito verificador válido
function findRut(lines) {
  const re = /(\d{1,2})[.,\s]?(\d{3})[.,\s]?(\d{3})\s*[-–—]\s*([\dkK])\b/g;
  const cands = [];
  lines.forEach((l, i) => { for (const m of l.matchAll(re)) cands.push({ body: m[1] + m[2] + m[3], dv: m[4], lab: /r\.?\s*u\.?\s*t|rut/i.test(l), i }); });
  const valid = cands.filter(c => rutOk(c.body, c.dv));
  const pick = valid.find(c => c.lab) || valid[0] || cands.find(c => c.lab);
  if (!pick) return '';
  const b = pick.body, f = b.slice(0, b.length - 6) + '.' + b.slice(-6, -3) + '.' + b.slice(-3);
  return f + '-' + pick.dv.toUpperCase();
}

function parseReceipt(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const res = { fecha: '', monto: '', doc_tipo: '', doc_numero: '', proveedor: '', categoria: '' };
  const all = norm(lines.join('\n'));
  // tipo de documento
  if (/factura/.test(all)) res.doc_tipo = 'factura'; else if (/boleta/.test(all)) res.doc_tipo = 'boleta';
  // fecha
  for (const l of lines) {
    let m = /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})\b/.exec(l);
    let y, mo, d;
    if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else if ((m = /\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/.exec(l))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    if (m && y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) { res.fecha = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); break; }
  }
  if (!res.fecha) {
    const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const m = /(\d{1,2})\s+de\s+([a-z]+)\s+(?:de|del)?\s*(\d{4})/.exec(all);
    if (m && meses.indexOf(m[2]) >= 0) res.fecha = m[3] + '-' + String(meses.indexOf(m[2]) + 1).padStart(2, '0') + '-' + String(+m[1]).padStart(2, '0');
  }
  // monto: líneas con "total" (sin subtotal / neto / iva), la última; si no, "a pagar"/"monto"; si no, el mayor importe con $
  let monto = 0;
  const nl = lines.map(norm);
  for (let i = 0; i < lines.length; i++) {
    if (/\btotal\b/.test(nl[i]) && !/sub\s*total|total\s*(neto|iva|exento|afecto|impuesto|descuento)|neto|\biva\b/.test(nl[i])) {
      let a = amountsIn(lines[i]); if (!a.length && lines[i + 1]) a = amountsIn(lines[i + 1]);
      if (a.length) monto = a[a.length - 1];
    }
  }
  if (!monto) for (let i = 0; i < lines.length; i++) if (/a pagar|monto total|total a pagar|valor total|importe/.test(nl[i])) { const a = amountsIn(lines[i]); if (a.length) monto = a[a.length - 1]; }
  if (!monto) { const cand = []; lines.forEach((l, i) => { if (/\$/.test(l) && !/\d{1,2}\.\d{3}\.\d{3}-[\dk]/i.test(l)) cand.push(...amountsIn(l)); }); if (cand.length) monto = Math.max(...cand); }
  if (monto) res.monto = String(monto);
  // número de documento
  let m = /(?:boleta|factura)[^\n]{0,40}?\b(?:n[°º]?\.?|no\.?|nro\.?|numero|folio)\s*:?\s*(\d{2,12})\b/.exec(all)
    || /folio\s*(?:n[°ºo]\.?)?\s*:?\s*(\d{3,12})/.exec(all) || /\bn[°º]\s*:?\s*(\d{4,12})\b/.exec(all);
  if (m) res.doc_numero = m[1];
  // proveedor: primera línea "de nombre" del encabezado
  for (const l of lines.slice(0, 8)) {
    const n = norm(l);
    if (/r\.?u\.?t|boleta|factura|fecha|electronic|giro|direccion|sucursal|casa matriz|www\.|@|^\W*\d/.test(n)) continue;
    const letters = (l.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g) || []).length;
    if (letters >= 4 && letters / l.length > 0.55) { res.proveedor = l.replace(/[^\wÁÉÍÓÚÑáéíóúñ&.,\- ]+/g, '').trim().slice(0, 120); break; }
  }
  res.rut = findRut(lines);
  if (res.rut) res.proveedor = ((res.proveedor || '') + ' · RUT ' + res.rut).replace(/^ · /, '').slice(0, 120);
  // categoría por palabras clave
  const cats = [
    ['combustible', /copec|shell|petrobras|enex|aramco|combustible|bencina|diesel|petroleo|gasolina|\blt\b.*\$/],
    ['peajes', /peaje|autopista|vespucio|costanera|tag\b|estacionamiento|parking|ruta del/],
    ['alojamiento', /hotel|hostal|hosteria|alojamiento|residencial|cabana|apart/],
    ['transporte', /turbus|pullman|bus\b|pasaje|uber|cabify|taxi|metro|ferrocarril|sky airline|latam|jetsmart|flybondi|transporte/],
    ['alimentacion', /restaur|restoran|cafe|cafeteria|pizza|sushi|almuerzo|menu|comida|supermercado|lider|unimarc|jumbo|tottus|panaderia|fuente de soda|mcdonald|burger|empanada/],
    ['herramientas', /ferreteria|sodimac|easy\b|herramienta|construmart|imperial/],
    ['repuestos', /repuesto|electronica|insumo|componente|cable|conector|bateria|rodamiento/]
  ];
  for (const [c, re] of cats) if (re.test(all)) { res.categoria = c; break; }
  return res;
}

let chain = Promise.resolve();
function runTesseract(file, psm) {
  return new Promise((resolve, reject) => {
    execFile('tesseract', [file, 'stdout', '-l', 'spa+eng', '--psm', String(psm)], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) {
        if (err.code === 'ENOENT') return reject(Object.assign(new Error('no-ocr'), { noOcr: true }));
        // si falta el idioma español, reintentar solo con inglés
        return execFile('tesseract', [file, 'stdout', '-l', 'eng', '--psm', String(psm)], { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (e2, o2) => e2 ? reject(e2) : resolve(o2));
      }
      resolve(out);
    });
  });
}
// una lectura a la vez (el servidor es pequeño)
function ocrImage(buf, ext) {
  const job = chain.then(async () => {
    const f = path.join(os.tmpdir(), 'soim-ocr-' + crypto.randomBytes(8).toString('hex') + '.' + ext);
    fs.writeFileSync(f, buf);
    try {
      let txt = await runTesseract(f, 6);
      if (!parseReceipt(txt).monto) { const t2 = await runTesseract(f, 4); if (parseReceipt(t2).monto) txt = t2; }
      return txt;
    } finally { try { fs.unlinkSync(f); } catch (_) {} }
  });
  chain = job.catch(() => {});
  return job;
}

function textOfPdf(buf) {
  let runs = []; try { runs = extractRuns(buf); } catch (_) {}
  const rows = [];
  runs.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  let cur = null;
  for (const r of runs) { if (cur && cur.page === r.page && Math.abs(cur.y - r.y) <= 2.5) cur.t += ' ' + r.t.trim(); else { cur = { page: r.page, y: r.y, t: r.t.trim() }; rows.push(cur); } }
  return rows.map(r => r.t).join('\n');
}

async function scanReceipt(buf, kind) {
  let text = '';
  if (kind === 'pdf') text = textOfPdf(buf);
  else text = await ocrImage(buf, kind === 'png' ? 'png' : 'jpg');
  const data = parseReceipt(text);
  return { data, chars: text.replace(/\s/g, '').length };
}

module.exports = { parseReceipt, scanReceipt };
