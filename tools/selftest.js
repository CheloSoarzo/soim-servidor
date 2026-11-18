#!/usr/bin/env node
'use strict';
// Prueba automática del servidor: levanta una copia con datos temporales y revisa los casos principales.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soim-test-'));
const ADMIN = { rut: '12.345.678-5', pw: 'ClaveAdmin#2026' };
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } }

async function call(method, url, body, cookie, extra) {
  const h = Object.assign({}, extra);
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (cookie) h.Cookie = cookie;
  const r = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString()); } catch (e) {}
  return { status: r.status, json, buf, cookie: sc[0] ? sc[0].split(';')[0] : null, headers: r.headers };
}
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(300, 'x'), Buffer.from('\n%%EOF')]);

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, ADMIN_RUT: ADMIN.rut, ADMIN_PASSWORD: ADMIN.pw, ADMIN_NAME: 'Admin Prueba', NODE_ENV: 'test' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 50 && !log.includes('escuchando'); i++) await new Promise(r => setTimeout(r, 100));

  try {
    console.log('Estado y sesión');
    ok((await call('GET', '/healthz')).status === 200, 'healthz responde');
    ok((await call('GET', '/api/me')).status === 401, '/api/me sin sesión → 401');
    ok((await call('POST', '/api/login', { rut: ADMIN.rut, password: 'mala' })).status === 401, 'login con clave mala → 401');
    ok((await call('POST', '/api/login', { rut: '12345678-9', password: 'x' })).status === 401, 'login con RUT inválido → 401');
    let r = await call('POST', '/api/login', { rut: '12345678-5', password: ADMIN.pw });
    ok(r.status === 200 && r.cookie && r.json.user.role === 'admin' && r.json.user.mustChange, 'admin entra (RUT sin puntos) y debe cambiar clave');
    let adm = r.cookie;
    ok(/HttpOnly/i.test(r.headers.get('set-cookie')) && /SameSite=Strict/i.test(r.headers.get('set-cookie')), 'cookie con HttpOnly y SameSite=Strict');
    ok((await call('POST', '/api/reports', { id: 'x' }, adm)).status === 403, 'con clave temporal no puede enviar informes → 403');
    ok((await call('GET', '/api/users', undefined, adm)).status === 403, 'con clave temporal no puede administrar → 403');

    console.log('Cambio de contraseña');
    ok((await call('POST', '/api/password', { current: 'otra', password: 'NuevaClave#2026' }, adm)).status === 400, 'clave actual incorrecta → 400');
    ok((await call('POST', '/api/password', { current: ADMIN.pw, password: '1234' }, adm)).status === 400, 'clave nueva débil → 400');
    ok((await call('POST', '/api/password', { current: ADMIN.pw, password: '12345678-5' }, adm)).status === 400, 'clave igual al RUT → 400');
    r = await call('POST', '/api/password', { current: ADMIN.pw, password: 'NuevaClave#2026' }, adm);
    ok(r.status === 200 && r.cookie && !r.json.user.mustChange, 'cambio de clave correcto');
    const oldAdm = adm; adm = r.cookie;
    ok((await call('GET', '/api/me', undefined, oldAdm)).status === 401, 'la sesión anterior queda invalidada');
    ok((await call('GET', '/api/me', undefined, adm)).status === 200, 'la sesión nueva funciona');

    console.log('Usuarios');
    ok((await call('POST', '/api/users', { rut: '12345678-9', name: 'X', password: 'ClaveTec#2026' }, adm)).status === 400, 'crear con RUT inválido → 400');
    ok((await call('POST', '/api/users', { rut: '11.111.111-1', name: 'Ana Técnica', password: '123' }, adm)).status === 400, 'crear con clave débil → 400');
    ok((await call('POST', '/api/users', { rut: '11.111.111-1', name: 'Ana Técnica', role: 'tecnico', password: 'ClaveTec#2026' }, adm)).status === 201, 'crear técnico 1');
    ok((await call('POST', '/api/users', { rut: '76.543.210-3', name: 'Beto Técnico', role: 'tecnico', password: 'ClaveTec#2026' }, adm)).status === 201, 'crear técnico 2');
    ok((await call('POST', '/api/users', { rut: '11111111-1', name: 'Dup', password: 'ClaveTec#2026' }, adm)).status === 409, 'RUT duplicado → 409');
    async function tecLogin(rut, newpw) {
      let l = await call('POST', '/api/login', { rut, password: 'ClaveTec#2026' });
      let c = await call('POST', '/api/password', { current: 'ClaveTec#2026', password: newpw }, l.cookie);
      return c.cookie;
    }
    const t1 = await tecLogin('11111111-1', 'ClaveAna#2026'), t2 = await tecLogin('76543210-3', 'ClaveBeto#2026');
    ok(!!t1 && !!t2, 'técnicos entran y cambian su clave');
    ok((await call('GET', '/api/users', undefined, t1)).status === 403, 'técnico no puede listar usuarios → 403');
    ok((await call('POST', '/api/users', { rut: '9999999-3', name: 'Z', password: 'ClaveTec#2026' }, t1)).status === 403, 'técnico no puede crear usuarios → 403');
    const users = (await call('GET', '/api/users', undefined, adm)).json.items;
    ok(users.length === 3, 'el administrador ve 3 usuarios');
    const adminId = users.find(u => u.role === 'admin').id, ana = users.find(u => u.name.startsWith('Ana')).id;
    ok((await call('PATCH', '/api/users/' + adminId, { active: false }, adm)).status === 400, 'el administrador no puede desactivarse');
    ok((await call('PATCH', '/api/users/' + adminId, { role: 'tecnico' }, adm)).status === 400, 'el administrador no puede quitarse el rol');

    console.log('Informes');
    const rep = { id: '2026-11-02-abc123-1', name: '2026-11-02_Cliente_Prueba.pdf', fecha: '2026-11-02', cliente: 'Clinica Alemana Osorno', tecnico: 'Ana Técnica', equipo: 'Tomógrafo', tipo: 'Mantenimiento', pdf: PDF.toString('base64') };
    ok((await call('POST', '/api/reports', rep)).status === 401, 'enviar sin sesión → 401');
    ok((await call('POST', '/api/reports', Object.assign({}, rep, { pdf: Buffer.from('hola mundo, no soy un pdf, hola mundo, no soy un pdf, hola mundo, no soy un pdf, hola mundo no soy pdf').toString('base64') }), t1)).status === 400, 'archivo que no es PDF → 400');
    ok((await call('POST', '/api/reports', Object.assign({}, rep, { id: '../../etc/passwd' }), t1)).status === 400, 'id con ../ → 400');
    ok((await call('POST', '/api/reports', Object.assign({}, rep, { fecha: 'ayer' }), t1)).status === 400, 'fecha inválida → 400');
    ok((await call('POST', '/api/reports', rep, t1)).status === 201, 'técnico 1 sube informe');
    r = await call('POST', '/api/reports', rep, t1);
    ok(r.status === 200 && r.json.dup, 'reenvío del mismo informe no se duplica');
    ok((await call('POST', '/api/reports', Object.assign({}, rep, { id: '2026-10-20-zzz999-1', fecha: '2026-10-20', cliente: 'Imaval', equipo: 'Rayos X' }), t2)).status === 201, 'técnico 2 sube otro informe');
    ok((await call('GET', '/api/reports', undefined, t1)).json.total === 1, 'técnico 1 solo ve el suyo');
    r = await call('GET', '/api/reports', undefined, adm);
    ok(r.json.total === 2 && r.json.items[0].fecha === '2026-11-02', 'administrador ve ambos, el más reciente primero');
    ok((await call('GET', '/api/reports?cliente=imaval', undefined, adm)).json.total === 1, 'filtro por cliente');
    ok((await call('GET', '/api/reports?desde=2026-11-01', undefined, adm)).json.total === 1, 'filtro por fecha desde');
    ok((await call('GET', '/api/reports?tecnico=Ana&equipo=Tom', undefined, adm)).json.total === 1, 'filtro por técnico y equipo');
    ok((await call('GET', '/api/reports?cliente=%25', undefined, adm)).json.total === 0, 'el comodín % se trata como texto');
    r = await call('GET', '/api/reports/' + rep.id + '/pdf', undefined, t1);
    ok(r.status === 200 && Buffer.compare(r.buf, PDF) === 0 && r.headers.get('content-type') === 'application/pdf', 'el dueño descarga su PDF idéntico');
    ok((await call('GET', '/api/reports/' + rep.id + '/pdf', undefined, t2)).status === 404, 'otro técnico no puede ver ese PDF → 404');
    ok((await call('GET', '/api/reports/' + rep.id + '/pdf', undefined, adm)).status === 200, 'el administrador sí puede');
    ok((await call('GET', '/api/reports/' + rep.id + '/pdf')).status === 401, 'sin sesión no se descarga → 401');

    console.log('ZIP');
    r = await call('GET', '/api/reports.zip', undefined, adm);
    ok(r.status === 200 && r.buf.subarray(0, 2).toString() === 'PK', 'el administrador descarga el ZIP');
    ok((await call('GET', '/api/reports.zip', undefined, t1)).status === 403, 'el técnico no puede descargar el ZIP → 403');
    ok((await call('GET', '/api/reports.zip?desde=2030-01-01', undefined, adm)).status === 404, 'ZIP sin resultados → 404');
    const zf = path.join(dir, 'test.zip'); fs.writeFileSync(zf, r.buf);
    const py = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print("|".join(sorted(z.namelist())));print(len(z.read(z.namelist()[0])))', zf], { encoding: 'utf8' });
    if (py.status === 0) {
      const [bad, names, size] = py.stdout.trim().split('\n');
      ok(bad === 'None', 'el ZIP pasa la verificación de integridad');
      ok(names === 'Clinica Alemana Osorno/2026-11-02_Cliente_Prueba.pdf|Imaval/2026-11-02_Cliente_Prueba.pdf', 'el ZIP tiene una carpeta por cliente: ' + names);
      ok(+size === PDF.length, 'el contenido del ZIP coincide');
    } else console.log('  (python3 no disponible: se omite la verificación del ZIP)');

    console.log('Gastos');
    const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
    const ex = { id: 'g-test-0001', fecha: '2026-11-03', monto: 25990, categoria: 'combustible', doc_tipo: 'boleta', doc_numero: '1234', proveedor: 'Copec', cliente: 'Clinica Alemana Osorno', report_id: rep.id, justificacion: 'Combustible para viaje a Osorno por reparación del tomógrafo.', comprobante: JPG.toString('base64') };
    ok((await call('POST', '/api/expenses', ex)).status === 401, 'gasto sin sesión → 401');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { justificacion: 'corto' }), t1)).status === 400, 'justificación muy corta → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { monto: -5 }), t1)).status === 400, 'monto negativo → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { categoria: 'joyas' }), t1)).status === 400, 'categoría inválida → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { fecha: '2099-01-01' }), t1)).status === 400, 'fecha futura → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { comprobante: undefined }), t1)).status === 400, 'boleta sin foto → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { comprobante: Buffer.from('<script>alert(1)</script>'.repeat(5)).toString('base64') }), t1)).status === 400, 'comprobante que no es imagen → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { report_id: 'no-existe' }), t1)).status === 400, 'informe asociado inexistente → 400');
    ok((await call('POST', '/api/expenses', Object.assign({}, ex, { id: '../x' }), t1)).status === 400, 'id con ../ → 400');
    ok((await call('POST', '/api/expenses', ex, t1)).status === 201, 'técnico registra gasto con foto');
    ok((await call('POST', '/api/expenses', ex, t1)).json.dup === true, 'reenvío del gasto no se duplica');
    ok((await call('POST', '/api/expenses', { id: 'g-test-0002', fecha: '2026-11-04', monto: 8000, categoria: 'alimentacion', doc_tipo: 'sin_respaldo', justificacion: 'Almuerzo en terreno sin boleta disponible.' }, t2)).status === 201, 'gasto sin respaldo no exige foto');
    ok((await call('GET', '/api/expenses', undefined, t1)).json.total === 1, 'técnico solo ve sus gastos');
    r = await call('GET', '/api/expenses', undefined, adm);
    ok(r.json.total === 2 && r.json.items.some(x => x.tecnico.startsWith('Ana') && x.tiene_comprobante), 'administrador ve todos');
    r = await call('GET', '/api/expenses/g-test-0001/receipt', undefined, t1);
    ok(r.status === 200 && Buffer.compare(r.buf, JPG) === 0 && r.headers.get('content-type') === 'image/jpeg', 'el dueño ve su comprobante idéntico');
    ok((await call('GET', '/api/expenses/g-test-0001/receipt', undefined, t2)).status === 404, 'otro técnico no ve el comprobante → 404');
    ok((await call('GET', '/api/expenses/g-test-0001/receipt', undefined, adm)).status === 200, 'el administrador sí lo ve');
    ok((await call('POST', '/api/expenses/g-test-0001/review', { estado: 'aprobado' }, t1)).status === 403, 'técnico no puede aprobar → 403');
    ok((await call('POST', '/api/expenses/g-test-0002/review', { estado: 'rechazado' }, adm)).status === 400, 'rechazar sin motivo → 400');
    ok((await call('POST', '/api/expenses/g-test-0002/review', { estado: 'rechazado', motivo: 'Falta boleta o documento de respaldo.' }, adm)).status === 200, 'administrador rechaza con motivo');
    r = await call('GET', '/api/expenses?estado=rechazado', undefined, t2);
    ok(r.json.total === 1 && /respaldo/.test(r.json.items[0].motivo), 'el técnico ve el motivo del rechazo');
    ok((await call('PUT', '/api/expenses/g-test-0002', { fecha: '2026-11-04', monto: 8000, categoria: 'alimentacion', doc_tipo: 'sin_respaldo', justificacion: 'Almuerzo en terreno; el local no emitió boleta.' }, t2)).status === 200, 'técnico corrige el gasto rechazado');
    ok((await call('GET', '/api/expenses?estado=pendiente', undefined, adm)).json.total === 2, 'tras corregir vuelve a pendiente');
    ok((await call('PUT', '/api/expenses/g-test-0001', { fecha: '2026-11-03', monto: 1, categoria: 'otros', doc_tipo: 'boleta', justificacion: 'Intento de editar gasto ajeno.' }, t2)).status === 404, 'no se puede editar un gasto ajeno');
    ok((await call('POST', '/api/expenses/g-test-0001/review', { estado: 'aprobado' }, adm)).status === 200, 'administrador aprueba');
    ok((await call('PUT', '/api/expenses/g-test-0001', Object.assign({}, ex, { monto: 1 }), t1)).status === 409, 'un gasto aprobado no se edita → 409');
    ok((await call('DELETE', '/api/expenses/g-test-0001', undefined, t1)).status === 409, 'un gasto aprobado no se elimina → 409');
    ok((await call('DELETE', '/api/expenses/g-test-0002', undefined, t1)).status === 404, 'no se elimina un gasto ajeno');
    r = await call('GET', '/api/expenses/summary', undefined, adm);
    ok(r.json.categoria.length === 2 && r.json.categoria.reduce((a, x) => a + x.total, 0) === 33990, 'totales por categoría suman 33.990');
    ok(r.json.tecnico.length === 2 && r.json.cliente.some(x => x.k === '(sin cliente)'), 'totales por técnico y por cliente');
    ok((await call('GET', '/api/expenses/summary?user=' + ana, undefined, t2)).json.categoria[0].total === 8000, 'el técnico solo ve totales propios (ignora ?user=)');
    r = await call('GET', '/api/expenses.csv?desde=2026-11-01', undefined, adm);
    const csv = r.buf.toString('utf8');
    ok(r.status === 200 && csv.charCodeAt(0) === 0xfeff && /Copec/.test(csv) && /aprobado/.test(csv) && csv.split('\r\n').length === 4, 'CSV con BOM, 2 filas y encabezado');
    ok((await call('GET', '/api/expenses.csv', undefined, t1)).status === 403, 'el técnico no descarga el CSV → 403');
    ok((await call('POST', '/api/expenses', { id: 'g-test-0003', fecha: '2026-11-05', monto: 100, categoria: 'otros', doc_tipo: 'sin_respaldo', proveedor: '=HYPERLINK("http://x")', justificacion: 'Prueba de inyección de fórmulas en CSV.' }, t1)).status === 201, 'gasto con texto tipo fórmula');
    ok(/"'=HYPERLINK/.test((await call('GET', '/api/expenses.csv', undefined, adm)).buf.toString('utf8')), 'el CSV neutraliza fórmulas');
    ok((await call('DELETE', '/api/expenses/g-test-0003', undefined, t1)).status === 200, 'el técnico elimina un gasto pendiente');
    ok(fs.readdirSync(path.join(dir, 'comprobantes')).length === 1, 'solo queda el comprobante del gasto aprobado en disco');
    ok((await call('GET', '/gastos')).status === 200, 'la página /gastos se sirve');

    console.log('Historial de equipos');
    function dvOf(n) { let s = 0, m = 2; for (const d of String(n).split('').reverse()) { s += +d * m; m = m === 7 ? 2 : m + 1; } const r = 11 - (s % 11); return r === 11 ? '0' : r === 10 ? 'K' : String(r); }
    const rep3 = Object.assign({}, rep, { id: '2026-11-10-eq1-1', fecha: '2026-11-10', modelo: 'Revolution CT', serie: 'SN-123', problema: 'Error en el tubo de rayos X', tipo: 'Reparación' });
    ok((await call('POST', '/api/reports', rep3, t1)).status === 201, 'informe con modelo, serie y problema');
    ok((await call('POST', '/api/reports', Object.assign({}, rep3, { id: '2026-11-20-eq1-2', fecha: '2026-11-20', problema: 'Mantención preventiva' }), t1)).status === 201, 'segundo informe del mismo equipo');
    r = await call('GET', '/api/reports?serie=SN-123', undefined, adm);
    ok(r.json.total === 2 && r.json.items[0].fecha === '2026-11-20' && r.json.items[0].modelo === 'Revolution CT', 'filtro por número de serie, más reciente primero');
    ok((await call('GET', '/api/reports?q=tubo', undefined, adm)).json.total === 1, 'búsqueda libre en el problema reportado');
    ok((await call('GET', '/api/reports?q=imaval', undefined, adm)).json.total === 1, 'búsqueda libre por cliente');
    r = await call('GET', '/api/equipos', undefined, adm);
    const g = r.json.items.find(x => x.serie === 'SN-123');
    ok(g && g.informes === 2 && g.ultimo === '2026-11-20' && g.cliente === 'Clinica Alemana Osorno', 'equipos agrupados por cliente, equipo y serie');
    ok((await call('GET', '/api/equipos', undefined, t2)).json.items.every(x => x.cliente === 'Imaval'), 'el técnico solo ve los equipos de sus informes');

    console.log('Portal de clientes');
    const crut = '76123456-' + dvOf(76123456);
    ok((await call('POST', '/api/users', { rut: crut, name: 'Clínica Alemana Osorno', role: 'cliente', password: 'ClaveCli#2026' }, adm)).status === 400, 'cuenta de cliente sin cliente asociado → 400');
    ok((await call('POST', '/api/users', { rut: crut, name: 'Clínica Alemana Osorno', role: 'cliente', cliente: 'Clinica Alemana Osorno', password: 'ClaveCli#2026' }, adm)).status === 201, 'el administrador crea la cuenta del cliente');
    r = await call('POST', '/api/login', { rut: crut, password: 'ClaveCli#2026' });
    ok(r.status === 200 && r.json.user.role === 'cliente' && r.json.user.cliente === 'Clinica Alemana Osorno' && r.json.user.mustChange, 'el cliente entra con clave temporal');
    r = await call('POST', '/api/password', { current: 'ClaveCli#2026', password: 'MiClave#Cliente1' }, r.cookie);
    const cli = r.cookie; ok(!!cli, 'el cliente cambia su clave');
    r = await call('GET', '/api/reports', undefined, cli);
    ok(r.json.total === 3 && r.json.items.every(x => x.cliente === 'Clinica Alemana Osorno' && x.subido_por === undefined), 'el cliente ve solo sus 3 informes, sin datos internos');
    ok((await call('GET', '/api/reports?cliente=Imaval', undefined, cli)).json.total === 3, 'el cliente no puede ver a otro cliente cambiando el filtro');
    ok((await call('GET', '/api/reports?q=imaval', undefined, cli)).json.total === 0, 'la búsqueda del cliente no sale de sus informes');
    ok((await call('GET', '/api/reports/' + rep.id + '/pdf', undefined, cli)).status === 200, 'el cliente descarga un informe suyo');
    ok((await call('GET', '/api/reports/2026-10-20-zzz999-1/pdf', undefined, cli)).status === 404, 'el cliente no descarga el informe de otro → 404');
    ok((await call('GET', '/api/equipos', undefined, cli)).json.items.every(x => x.cliente === 'Clinica Alemana Osorno'), 'el cliente ve solo sus equipos');
    ok((await call('POST', '/api/reports', rep3, cli)).status === 403, 'el cliente no puede subir informes → 403');
    ok((await call('GET', '/api/expenses', undefined, cli)).status === 403, 'el cliente no ve gastos → 403');
    ok((await call('GET', '/api/funds/balance', undefined, cli)).status === 403, 'el cliente no ve fondos → 403');
    ok((await call('GET', '/api/users', undefined, cli)).status === 403, 'el cliente no ve usuarios → 403');
    ok((await call('GET', '/api/reports.zip', undefined, cli)).status === 403, 'el cliente no descarga el ZIP → 403');
    const cliId = (await call('GET', '/api/users', undefined, adm)).json.items.find(u => u.role === 'cliente').id;
    ok((await call('PATCH', '/api/users/' + cliId, { cliente: 'Imaval' }, adm)).status === 200, 'el administrador cambia el cliente de la cuenta');
    ok((await call('GET', '/api/me', undefined, cli)).status === 401, 'al cambiarla se cierra la sesión del cliente');

    console.log('Fondos por rendir');
    const anaId = (await call('GET', '/api/users', undefined, adm)).json.items.find(u => u.name.startsWith('Ana')).id;
    ok((await call('POST', '/api/funds', { user_id: anaId, monto: 100000 }, t1)).status === 403, 'el técnico no entrega fondos → 403');
    ok((await call('POST', '/api/funds', { user_id: anaId, monto: -5 }, adm)).status === 400, 'monto negativo → 400');
    ok((await call('POST', '/api/funds', { user_id: cliId, monto: 5000 }, adm)).status === 400, 'no se entregan fondos a una cuenta de cliente');
    ok((await call('POST', '/api/funds', { user_id: anaId, monto: 100000, nota: 'Viaje a Osorno' }, adm)).status === 201, 'entrega de fondos de $100.000');
    ok((await call('POST', '/api/funds', { user_id: anaId, monto: 20000, tipo: 'devolucion' }, adm)).status === 201, 'devolución de $20.000');
    r = await call('GET', '/api/funds/balance', undefined, t1);
    ok(r.json.items.length === 1 && r.json.items[0].entregado === 100000 && r.json.items[0].devuelto === 20000 && r.json.items[0].gastado === 25990 && r.json.items[0].saldo === 54010, 'saldo del técnico: 100.000 − 20.000 − 25.990 = 54.010');
    r = await call('GET', '/api/funds/balance', undefined, adm);
    ok(r.json.items.length >= 2 && r.json.items.find(x => x.user_id === anaId).saldo === 54010, 'el administrador ve el saldo de todos');
    r = await call('GET', '/api/funds', undefined, t2);
    ok(r.json.items.length === 0, 'otro técnico no ve los movimientos de Ana');
    r = await call('GET', '/api/funds', undefined, t1);
    ok(r.json.items.length === 2 && r.json.items.some(x => x.monto === -20000), 'el técnico ve sus movimientos');
    ok((await call('DELETE', '/api/funds/' + r.json.items[0].id, undefined, t1)).status === 403, 'el técnico no borra movimientos → 403');
    ok((await call('DELETE', '/api/funds/' + r.json.items[0].id, undefined, adm)).status === 200, 'el administrador corrige un movimiento');

    console.log('Seguridad');
    ok((await call('POST', '/api/logout', undefined, adm, { Origin: 'https://sitio-malo.example' })).status === 403, 'petición con origen ajeno → 403 (CSRF)');
    ok((await call('GET', '/')).status === 200, 'la página principal se sirve');
    for (const p of ['/server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/data/soim.db', '/lib/security.js', '/package.json']) {
      const x = await call('GET', p); ok(x.status === 404 || x.status === 400, 'no se expone ' + p + ' (' + x.status + ')');
    }
    const h = (await call('GET', '/')).headers;
    ok(/frame-ancestors 'none'/.test(h.get('content-security-policy')) && h.get('x-content-type-options') === 'nosniff', 'cabeceras de seguridad presentes');
    ok((await call('PATCH', '/api/users/' + ana, { active: false }, adm)).status === 200, 'el administrador desactiva a un técnico');
    ok((await call('GET', '/api/me', undefined, t1)).status === 401, 'la sesión del técnico desactivado deja de valer');
    ok((await call('POST', '/api/login', { rut: '11111111-1', password: 'ClaveAna#2026' })).status === 401, 'el técnico desactivado no puede entrar');
    ok((await call('PATCH', '/api/users/' + ana, { active: true, password: 'Reset#Ana2026' }, adm)).status === 200, 'reactivar y restablecer clave');
    r = await call('POST', '/api/login', { rut: '11111111-1', password: 'Reset#Ana2026' });
    ok(r.status === 200 && r.json.user.mustChange, 'entra con la clave temporal y debe cambiarla');
    let last = 0; for (let i = 0; i < 12; i++) last = (await call('POST', '/api/login', { rut: '76543210-3', password: 'incorrecta' + i })).status;
    ok(last === 429, 'tras varios intentos fallidos se bloquea temporalmente (429)');
    ok((await call('POST', '/api/login', { rut: '76543210-3', password: 'ClaveBeto#2026' })).status === 429, 'incluso con la clave correcta, mientras dura el bloqueo');
  } catch (e) { fail++; console.log('  ✘ error inesperado:', e); }

  srv.kill('SIGTERM');
  console.log('\n' + pass + ' correctas, ' + fail + ' con fallo');
  if (fail) console.log('\nRegistro del servidor:\n' + log);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
