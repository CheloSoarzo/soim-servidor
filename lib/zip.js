'use strict';
// Escritor ZIP mínimo (sin dependencias). Soporta nombres UTF-8 y compresión deflate.
const zlib = require('zlib');

function dosTime(d) {
  return {
    t: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    d: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  };
}

// entries: [{ name, data: Buffer | () => Buffer, date? }]
function writeZip(out, entries) {
  let offset = 0;
  const central = [];
  const put = b => { out.write(b); offset += b.length; };
  for (const e of entries) {
    const raw = typeof e.data === 'function' ? e.data() : e.data;
    const crc = zlib.crc32(raw) >>> 0;
    const comp = zlib.deflateRawSync(raw);
    const deflated = comp.length < raw.length;
    const body = deflated ? comp : raw, method = deflated ? 8 : 0;
    const name = Buffer.from(e.name, 'utf8');
    const dt = dosTime(e.date || new Date());
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt16LE(dt.t, 10); lh.writeUInt16LE(dt.d, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const start = offset;
    put(lh); put(name); put(body);
    central.push({ name, crc, cs: body.length, us: raw.length, method, dt, start });
  }
  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.dt.t, 12); h.writeUInt16LE(c.dt.d, 14);
    h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.cs, 20); h.writeUInt32LE(c.us, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(c.start, 42);
    put(h); put(c.name);
  }
  const size = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(cdStart, 16);
  out.end(end);
}
module.exports = { writeZip };
