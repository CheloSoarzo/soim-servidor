'use strict';
const crypto = require('crypto');

// ---- Contraseñas (scrypt, con sal aleatoria)
const P = { N: 16384, r: 8, p: 1 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, P);
  return ['scrypt', P.N, P.r, P.p, salt.toString('base64'), h.toString('base64')].join('$');
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, s, h] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const exp = Buffer.from(h, 'base64');
    const got = crypto.scryptSync(pw, Buffer.from(s, 'base64'), exp.length, { N: +N, r: +r, p: +p });
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  } catch (e) { return false; }
}
const DUMMY = hashPassword('contraseña-falsa-para-igualar-tiempos');

// ---- Sesiones (token firmado con HMAC)
function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token, secret) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(exp);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

// ---- RUT chileno
function normRut(input) {
  const s = String(input || '').replace(/[.\s-]/g, '').toUpperCase();
  if (!/^\d{7,8}[\dK]$/.test(s)) return null;
  const body = s.slice(0, -1), dv = s.slice(-1);
  let sum = 0, m = 2;
  for (let i = body.length - 1; i >= 0; i--) { sum += +body[i] * m; m = m === 7 ? 2 : m + 1; }
  const r = 11 - (sum % 11);
  const exp = r === 11 ? '0' : r === 10 ? 'K' : String(r);
  return dv === exp ? body + '-' + dv : null;
}

// ---- Política de contraseñas
function passwordError(pw, rut) {
  pw = String(pw || '');
  if (pw.length < 8) return 'La contraseña debe tener al menos 8 caracteres.';
  if (Buffer.byteLength(pw) > 128) return 'La contraseña es demasiado larga.';
  if (rut) {
    const body = rut.split('-')[0];                 // RUT sin dígito verificador
    const pwd = pw.replace(/[.\s-]/g, '').toUpperCase();
    if (pwd === body || pwd === rut.replace('-', '')) return 'La contraseña no puede ser el RUT.';
  }
  if (/^(.)\1+$/.test(pw)) return 'La contraseña es demasiado simple.';
  return null;
}

module.exports = { hashPassword, verifyPassword, DUMMY, signToken, verifyToken, normRut, passwordError };
