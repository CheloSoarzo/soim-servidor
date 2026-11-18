'use strict';
const { extractRuns } = require('./pdftext');

const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[°º]/g, '').replace(/\s+/g, ' ').trim();
// etiquetas reconocidas, de la más específica a la más general
const LABELS = {
  cliente: ['cliente', 'institucion', 'empresa', 'razon social', 'centro medico', 'clinica', 'hospital', 'establecimiento'],
  fecha: ['fecha de servicio', 'fecha del servicio', 'fecha de visita', 'fecha de atencion', 'fecha de ejecucion', 'fecha'],
  tecnico: ['tecnico', 'ingeniero de servicio', 'ingeniero', 'realizado por', 'ejecutado por', 'responsable'],
  tipo: ['tipo de servicio', 'tipo de visita', 'tipo de mantencion', 'tipo de intervencion', 'tipo de trabajo', 'tipo', 'servicio'],
  equipo: ['tipo de equipo', 'nombre del equipo', 'equipo'],
  modelo: ['marca y modelo', 'marca / modelo', 'marca/modelo', 'modelo', 'marca'],
  serie: ['numero de serie', 'n de serie', 'n serie', 'no de serie', 'no serie', 'nro serie', 'nro de serie', 'serie', 's/n', 'n/s', 'sn'],
  problema: ['problema reportado', 'problema', 'falla reportada', 'falla', 'motivo de la visita', 'motivo', 'trabajo realizado', 'descripcion del trabajo', 'descripcion de la falla', 'descripcion', 'diagnostico', 'observaciones']
};
const ALL = [];
for (const [k, arr] of Object.entries(LABELS)) arr.forEach(l => ALL.push([k, l]));
ALL.sort((a, b) => b[1].length - a[1].length);

// ¿la celda empieza con una etiqueta? → { key, rest } (rest = texto tras ":" si lo hay)
function labelOf(text) {
  const t = norm(text).replace(/^[\s\-•*\d.)]+/, '');
  for (const [key, l] of ALL) {
    if (t === l || t === l + ':') return { key, rest: '' };
    if (t.startsWith(l) && /^\s*[:\-–]\s*\S/.test(t.slice(l.length))) {
      // texto original tras los dos puntos
      const i = text.search(/[:–-]/);
      return { key, rest: i >= 0 ? text.slice(i + 1).trim() : '' };
    }
  }
  return null;
}

function toIso(s) {
  s = String(s || '');
  let m = /\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4})\b/.exec(s);
  if (m) return ok(+m[3], +m[2], +m[1]);
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  m = /\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de|del)?\s*(\d{4})\b/i.exec(s);
  if (m) { const mi = meses.indexOf(norm(m[2]).replace('setiembre', 'septiembre')); if (mi >= 0) return ok(+m[3], mi + 1, +m[1]); }
  return '';
}
function ok(y, mo, d) { if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return ''; return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }

function fieldsFromRuns(runs) {
  // agrupar en líneas por página y coordenada y
  const byPage = new Map();
  runs.forEach(r => { if (!byPage.has(r.page)) byPage.set(r.page, []); byPage.get(r.page).push(r); });
  const lines = [];
  for (const [page, rs] of [...byPage].sort((a, b) => a[0] - b[0])) {
    rs.sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    for (const r of rs) {
      if (cur && Math.abs(cur.y - r.y) <= 2.5) cur.cells.push(r); else { cur = { page, y: r.y, cells: [r] }; lines.push(cur); }
    }
    lines.forEach(l => l.cells.sort((a, b) => a.x - b.x));
  }
  const res = {}, rawLines = lines.map(l => l.cells.map(c => c.t.trim()).filter(Boolean));
  const isLabel = t => !!labelOf(t);
  const set = (k, v) => { v = String(v || '').replace(/\s+/g, ' ').trim(); if (v && v !== '-' && !res[k]) res[k] = v; };
  lines.forEach((ln, li) => {
    ln.cells.forEach((c, ci) => {
      const lb = labelOf(c.t.trim()); if (!lb) return;
      if (res[lb.key]) return;
      if (lb.rest) { set(lb.key, lb.rest); return; }
      // 1) celdas a la derecha en la misma línea, hasta la próxima etiqueta
      const right = []; for (let k = ci + 1; k < ln.cells.length; k++) { if (isLabel(ln.cells[k].t.trim())) break; right.push(ln.cells[k].t.trim()); }
      if (right.length) { set(lb.key, right.join(' ')); return; }
      // 2) texto en la línea de abajo, alineado con la etiqueta (puede ocupar varias líneas en "problema")
      const nxt = lines[li + 1];
      if (nxt && nxt.page === ln.page) {
        const below = nxt.cells.filter(q => Math.abs(q.x - c.x) <= 6 || (q.x > c.x - 6 && q.x < c.x + 6));
        const cand = below.length ? below[0] : null;
        if (cand && !isLabel(cand.t.trim())) {
          let v = cand.t.trim();
          if (lb.key === 'problema') { let j = li + 2; while (lines[j] && lines[j].page === ln.page && lines[j].cells.length && !isLabel(lines[j].cells[0].t.trim()) && !/^[A-ZÁÉÍÓÚÑ ]{6,}$/.test(lines[j].cells[0].t.trim()) && v.length < 280 && j < li + 5) { v += ' ' + lines[j].cells[0].t.trim(); j++; } }
          set(lb.key, v);
        }
      }
    });
  });
  // fecha: normalizar; si no hay etiqueta, la primera fecha del documento
  let f = toIso(res.fecha || '');
  if (!f) { for (const l of rawLines) { const t = toIso(l.join(' ')); if (t) { f = t; break; } } }
  res.fecha = f;
  for (const k of ['cliente', 'equipo', 'modelo', 'serie', 'tipo', 'tecnico', 'problema']) res[k] = (res[k] || '').slice(0, k === 'problema' ? 300 : 150);
  // limpiar: el cliente no debería ser una fecha o etiqueta
  if (res.serie) res.serie = res.serie.replace(/^[:#\s]+/, '').split(/\s{2,}/)[0];
  return res;
}

function extractFields(buf) {
  let runs = [];
  try { runs = extractRuns(buf); } catch (_) { runs = []; }
  const f = fieldsFromRuns(runs);
  const n = Object.values(f).filter(Boolean).length;
  return { fields: f, found: n, chars: runs.reduce((a, r) => a + r.t.length, 0) };
}

module.exports = { extractFields, fieldsFromRuns, toIso };
