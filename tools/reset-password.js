#!/usr/bin/env node
'use strict';
// Restablece la contraseña de un usuario desde el servidor (por ejemplo si el administrador quedó sin acceso).
// Uso:  DATA_DIR=/var/data node tools/reset-password.js 12.345.678-5 "NuevaClaveTemporal1"
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const sec = require('../lib/security');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const rut = sec.normRut(process.argv[2]), pw = process.argv[3] || '';
if (!rut) { console.error('RUT inválido.'); process.exit(1); }
const err = sec.passwordError(pw, rut);
if (err) { console.error(err); process.exit(1); }
const db = new DatabaseSync(path.join(DATA_DIR, 'soim.db'));
const r = db.prepare('UPDATE users SET pass_hash=?, must_change=1, active=1, token_ver=token_ver+1 WHERE rut=?').run(sec.hashPassword(pw), rut);
console.log(r.changes ? 'Contraseña restablecida para ' + rut + '. Deberá cambiarla al entrar.' : 'No existe un usuario con ese RUT.');
