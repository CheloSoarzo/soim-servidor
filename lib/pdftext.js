'use strict';
// Lector mínimo de texto de PDF (sin dependencias). Devuelve las "celdas" de texto con su posición.
const zlib = require('zlib');

function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch (_) {}
  try { return zlib.inflateRawSync(buf); } catch (_) {}
  try { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (_) {}
  return null;
}

function a85(buf) {
  const t = buf.toString('latin1').replace(/\s+/g, '').replace(/^<~/, ''), out = []; let g = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i]; if (c === '~') break;
    if (c === 'z' && !g.length) { out.push(0, 0, 0, 0); continue; }
    g.push(t.charCodeAt(i) - 33);
    if (g.length === 5) { let v = 0; for (const d of g) v = v * 85 + d; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); g = []; }
  }
  if (g.length > 1) { const n = g.length; while (g.length < 5) g.push(84); let v = 0; for (const d of g) v = v * 85 + d; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
  return Buffer.from(out);
}
function decodeStream(dict, data) {
  const fl = (/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict) || [])[1] || '';
  const names = [...fl.matchAll(/\/(\w+)/g)].map(m => m[1]);
  for (const n of names) {
    if (!data) return null;
    if (n === 'ASCII85Decode' || n === 'A85') data = a85(data);
    else if (n === 'ASCIIHexDecode' || n === 'AHx') data = Buffer.from(data.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
    else if (n === 'FlateDecode' || n === 'Fl') data = inflate(data);
    else return null;
  }
  return data;
}

function parseObjects(buf) {
  const s = buf.toString('latin1'), objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const num = +m[1], start = re.lastIndex;
    const end = s.indexOf('endobj', start);
    if (end < 0) break;
    const body = s.slice(start, end);
    const si = body.indexOf('stream');
    let dict = body, data = null;
    if (si >= 0 && /^\s*<<[\s\S]*>>\s*stream/.test(body.slice(0, si + 6))) {
      dict = body.slice(0, si);
      let ds = start + si + 6;
      if (s[ds] === '\r') ds++;
      if (s[ds] === '\n') ds++;
      let de = s.indexOf('endstream', ds);
      if (de < 0) de = end;
      data = buf.subarray(ds, de);
      data = decodeStream(dict, data);
    }
    objs.set(num, { dict, data });
    re.lastIndex = end + 6;
  }
  // flujos de objetos (PDF 1.5+)
  for (const [, o] of [...objs]) {
    if (o.data && /\/Type\s*\/ObjStm/.test(o.dict)) {
      const n = +(/\/N\s+(\d+)/.exec(o.dict) || [])[1], first = +(/\/First\s+(\d+)/.exec(o.dict) || [])[1];
      if (!n || !first) continue;
      const t = o.data.toString('latin1'), nums = t.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i++) {
        const id = nums[i * 2], off = nums[i * 2 + 1], next = i + 1 < n ? nums[i * 2 + 3] : t.length - first;
        if (Number.isFinite(id) && !objs.has(id)) objs.set(id, { dict: t.slice(first + off, first + next), data: null });
      }
    }
  }
  return objs;
}

function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const cs = /begincodespacerange\s*<([0-9a-fA-F]+)>/.exec(text);
  if (cs) bytes = Math.max(1, cs[1].length / 2);
  const u16 = h => { let r = ''; for (let i = 0; i + 4 <= h.length; i += 4) r += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return r; };
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(p[1], 16), u16(p[2]));
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g))
    for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const a = parseInt(p[1], 16), z = parseInt(p[2], 16);
      if (z - a > 70000) continue;
      if (p[3][0] === '[') { const arr = [...p[3].matchAll(/<([0-9a-fA-F]*)>/g)]; for (let i = 0; i <= z - a && i < arr.length; i++) map.set(a + i, u16(arr[i][1])); }
      else { const h = p[3].slice(1, -1); const base = u16(h); for (let c = a; c <= z; c++) { const last = base.charCodeAt(base.length - 1) + (c - a); map.set(c, base.slice(0, -1) + String.fromCharCode(last)); } }
    }
  return { map, bytes };
}

function tokenize(src) {
  const t = []; let i = 0; const n = src.length;
  const ws = c => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const dl = c => '()<>[]{}/%'.indexOf(c) >= 0;
  while (i < n) {
    const c = src[i];
    if (ws(c)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') {
      let d = 1, out = []; i++;
      while (i < n && d > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1];
          if (nx >= '0' && nx <= '7') { let o = nx, k = 2; while (k < 4 && src[i + k] >= '0' && src[i + k] <= '7') o += src[i + k++]; out.push(parseInt(o, 8) & 255); i += k; continue; }
          const map = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (nx in map) out.push(map[nx]); else if (nx === '\n' || nx === '\r') { if (nx === '\r' && src[i + 2] === '\n') i++; } else out.push(nx.charCodeAt(0) & 255);
          i += 2; continue;
        }
        if (ch === '(') d++; else if (ch === ')') { d--; if (d === 0) { i++; break; } }
        out.push(ch.charCodeAt(0) & 255); i++;
      }
      t.push({ s: Buffer.from(out) }); continue;
    }
    if (c === '<' && src[i + 1] === '<') { i += 2; t.push({ op: '<<' }); continue; }
    if (c === '>' && src[i + 1] === '>') { i += 2; t.push({ op: '>>' }); continue; }
    if (c === '<') { const e = src.indexOf('>', i); let h = src.slice(i + 1, e).replace(/\s+/g, ''); if (h.length % 2) h += '0'; t.push({ s: Buffer.from(h, 'hex') }); i = e + 1; continue; }
    if (c === '[' || c === ']') { t.push({ op: c }); i++; continue; }
    if (c === '/') { let j = i + 1; while (j < n && !ws(src[j]) && !dl(src[j])) j++; t.push({ name: src.slice(i + 1, j) }); i = j; continue; }
    let j = i; while (j < n && !ws(src[j]) && !dl(src[j])) j++;
    if (j === i) { i++; continue; }
    const w = src.slice(i, j), num = Number(w);
    t.push(Number.isFinite(num) && /^[-+.\d]/.test(w) ? { num } : { op: w }); i = j;
  }
  return t;
}

function decode(buf, font) {
  if (font && font.cmap) {
    const { map, bytes } = font.cmap; let r = '';
    for (let i = 0; i + bytes <= buf.length; i += bytes) {
      let code = 0; for (let k = 0; k < bytes; k++) code = code * 256 + buf[i + k];
      const ch = map.get(code); r += ch !== undefined ? ch : (bytes === 1 ? String.fromCharCode(code) : '');
    }
    return r;
  }
  if (font && font.twoByte) { let r = ''; for (let i = 0; i + 1 < buf.length; i += 2) r += String.fromCharCode(buf[i] * 256 + buf[i + 1]); return r; }
  return buf.toString('latin1');
}

function runsOfStream(text, fonts, page, out) {
  const st = []; let font = null, x = 0, y = 0, lx = 0, ly = 0, lead = 0, cur = null;
  const flush = () => { if (cur && cur.t.trim()) out.push({ page, x: cur.x, y: cur.y, t: cur.t }); cur = null; };
  const show = (str, gap) => {
    const tx = decode(str, font);
    if (!tx) return;
    if (cur && Math.abs(cur.y - y) < 0.5 && !gap && cur.lastX === x) cur.t += tx; else { flush(); cur = { x, y, t: tx, lastX: x }; }
    if (gap && cur) cur.t = cur.t; // sin cambio
  };
  const nl = () => { y -= lead; };
  for (const tk of tokenize(text)) {
    if (tk.op === undefined) { st.push(tk); continue; }
    const op = tk.op, nums = () => st.filter(a => a.num !== undefined).map(a => a.num);
    if (op === '[') { st.push({ arr: [] }); continue; }
    if (op === ']') { const arr = []; while (st.length) { const a = st.pop(); if (a.arr && !a.closed) { a.arr = arr.reverse(); a.closed = true; st.push(a); break; } arr.push(a); } continue; }
    if (op === 'BT') { flush(); x = y = lx = ly = 0; st.length = 0; continue; }
    if (op === 'ET') { flush(); st.length = 0; continue; }
    if (op === 'Tf') { const nm = st.filter(a => a.name !== undefined).pop(); font = nm ? fonts[nm.name] || null : null; }
    else if (op === 'Tm') { const v = nums(); if (v.length >= 6) { flush(); x = v[4]; y = v[5]; lx = x; ly = y; } }
    else if (op === 'Td' || op === 'TD') { const v = nums(); if (v.length >= 2) { flush(); lx += v[0]; ly += v[1]; x = lx; y = ly; if (op === 'TD') lead = -v[1]; } }
    else if (op === 'TL') { const v = nums(); if (v.length) lead = v[0]; }
    else if (op === 'T*') { flush(); ly -= lead; y = ly; x = lx; }
    else if (op === 'Tj') { const s = st.filter(a => a.s).pop(); if (s) show(s.s, false); }
    else if (op === "'" || op === '"') { flush(); ly -= lead; y = ly; x = lx; const s = st.filter(a => a.s).pop(); if (s) show(s.s, false); }
    else if (op === 'TJ') {
      const a = st.filter(q => q.arr).pop();
      if (a) for (const e of a.arr) { if (e.s) show(e.s, false); else if (e.num !== undefined && e.num < -250 && cur) cur.t += ' '; }
    }
    st.length = 0;
  }
  flush();
}

function extractRuns(buf) {
  const objs = parseObjects(buf), fontsByObj = new Map();
  const ref = (d, key) => { const m = new RegExp('/' + key + '\\s+(\\d+)\\s+\\d+\\s+R').exec(d); return m ? +m[1] : 0; };
  const getFont = id => {
    if (fontsByObj.has(id)) return fontsByObj.get(id);
    const o = objs.get(id), f = { cmap: null, twoByte: false };
    if (o) {
      const tu = ref(o.dict, 'ToUnicode'), to = tu && objs.get(tu);
      if (to && to.data) f.cmap = parseCMap(to.data.toString('latin1'));
      if (/\/Identity-H/.test(o.dict) && !f.cmap) f.twoByte = true;
    }
    fontsByObj.set(id, f); return f;
  };
  const dictBody = (txt, key) => { // cuerpo << ... >> tras /key, balanceado
    const i = txt.search(new RegExp('/' + key + '\\s*<<')); if (i < 0) return null;
    let j = txt.indexOf('<<', i), d = 0, k = j;
    for (; k < txt.length - 1; k++) { if (txt[k] === '<' && txt[k + 1] === '<') { d++; k++; } else if (txt[k] === '>' && txt[k + 1] === '>') { d--; k++; if (!d) break; } }
    return txt.slice(j, k + 1);
  };
  const fontsOf = (pageObj) => {
    let res = pageObj.dict, guard = 0, p = pageObj;
    while (guard++ < 6 && p && !/\/Resources/.test(p.dict)) { const par = ref(p.dict, 'Parent'); p = par ? objs.get(par) : null; }
    if (!p) return {};
    let rtxt = p.dict;
    const rr = ref(rtxt, 'Resources');
    if (rr && objs.get(rr)) rtxt = objs.get(rr).dict;
    let fd = dictBody(rtxt, 'Font'); const fr = ref(rtxt, 'Font');
    if (!fd && fr && objs.get(fr)) fd = objs.get(fr).dict;
    const out = {};
    if (fd) for (const m of fd.matchAll(/\/([^\s\/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) out[m[1]] = getFont(+m[2]);
    return out;
  };
  const pages = [...objs].filter(([, o]) => /\/Type\s*\/Page\b(?!s)/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)).sort((a, b) => a[0] - b[0]);
  const runs = [];
  pages.forEach(([, po], pi) => {
    const fonts = fontsOf(po);
    let ids = [];
    const arr = /\/Contents\s*\[([^\]]*)\]/.exec(po.dict);
    if (arr) ids = [...arr[1].matchAll(/(\d+)\s+\d+\s+R/g)].map(m => +m[1]); else { const r = ref(po.dict, 'Contents'); if (r) ids = [r]; }
    let text = '';
    for (const id of ids) { const o = objs.get(id); if (o && o.data) text += o.data.toString('latin1') + '\n'; }
    runsOfStream(text, fonts, pi, runs);
  });
  return runs;
}

module.exports = { extractRuns };
