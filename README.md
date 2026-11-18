# Informes de servicio SOIM Chile — versión con servidor

Los técnicos entran con su **RUT y contraseña**, llenan el informe en el teléfono y el PDF queda guardado en **un solo lugar**. El administrador ve, filtra y descarga todos los informes desde un panel web.

## Cómo queda

| Quién | Qué hace |
|---|---|
| **Técnico** | Entra en `https://SU-SERVIDOR/`, llena el informe, firma y toca *Exportar PDF* o *Enviar por WhatsApp*. El PDF se guarda en su teléfono **y** se envía al servidor. Su nombre queda fijo en el informe. |
| **Administrador** | Entra en `https://SU-SERVIDOR/admin`. Ve todos los informes, filtra por fecha, cliente, técnico o equipo, descarga PDF sueltos o un **ZIP** (una carpeta por cliente). Crea usuarios, desactiva técnicos y entrega claves temporales. |

- Sin internet, el informe queda pendiente en el teléfono y se envía solo al volver la conexión.
- Todos los técnicos pueden ver los informes de todos (lista y PDF). Solo el administrador accede al panel y al ZIP.
- Todo funciona con una sola aplicación Node.js (sin librerías externas) y una base SQLite. Los PDF se guardan en el disco del servidor.

---

## Opción A: Render (recomendada, la más simple)

Render mantiene el servidor, el HTTPS y los reinicios por usted. Necesita un **plan de pago** (los discos persistentes no existen en el plan gratis). Revise el precio vigente en render.com; ronda unos US$7 al mes más el disco.

Hágalo desde un **computador**.

1. **Subir el código a GitHub.** Cree un repositorio **privado** (por ejemplo `soim-informes`). Es gratis y mantiene el código fuera de la vista pública. Arrastre a la página del repositorio todo el contenido de esta carpeta (incluidas las carpetas `public`, `lib` y `tools`) y confirme con *Commit changes*. No suba la carpeta `data`, si existe.
2. **Crear el servicio.** En Render: **New + > Blueprint**, conecte su cuenta de GitHub y elija el repositorio. Render lee `render.yaml` y le pide dos datos:
   - `ADMIN_RUT`: el RUT del administrador, por ejemplo `12.345.678-5`.
   - `ADMIN_PASSWORD`: una contraseña temporal (mínimo 8 caracteres).
3. **Esperar** a que termine el despliegue. Render le entrega una dirección como `https://soim-informes.onrender.com`. Puede asignarle un dominio propio, por ejemplo `informes.soim.cl`, desde *Settings > Custom Domains*.
4. **Entrar al panel** (`/admin`) con ese RUT y la contraseña temporal. El sistema le pedirá crear una contraseña propia.
5. **Crear los usuarios** en la pestaña *Usuarios*: RUT, nombre completo (**igual a como aparece en la lista de técnicos de la app**), rol y una contraseña temporal. Entregue a cada técnico su RUT y su clave temporal; deberá cambiarla en su primer ingreso.
6. **Instalar en los teléfonos.** En Android, abra la dirección en Chrome y elija *Instalar app*. En iPhone, ábrala en Safari, toque *Compartir* y *Añadir a pantalla de inicio*. Abra la app una vez con internet.
7. **Limpieza.** Cuando ya haya entrado, borre la variable `ADMIN_PASSWORD` en Render (*Environment*). Solo se usa para crear al primer administrador.

### Actualizar la app
Suba los archivos cambiados al repositorio de GitHub (por ejemplo `public/index.html`). Render los despliega solo en uno o dos minutos. Los teléfonos toman la versión nueva al abrir la app con internet.

### Respaldos
- Los informes están en el disco de Render. Revise en su panel de Render si los *snapshots* del disco están activos y cuánto tiempo se conservan.
- Además, haga un respaldo propio cada cierto tiempo con el botón **Descargar ZIP** del panel y guárdelo en su repositorio (Drive, NAS, etc.).
- La lista de usuarios vive en la base de datos (`soim.db`) del mismo disco.

---

## Opción B: Vultr (servidor propio con Docker) — la elegida

Más barata y con más control, pero usted se encarga del servidor. **Esta opción no se probó en un servidor real**; las partes de la aplicación sí están probadas, pero la instalación en Vultr conviene revisarla con alguien de confianza técnica.

1. En Vultr, cree un servidor **Ubuntu 24.04** (Cloud Compute, 1 GB de memoria alcanza; 25 GB de disco dan para miles de PDF y boletas). Active los **respaldos automáticos de Vultr**.
2. En el DNS de su dominio cree un registro **A** (por ejemplo `informes.soim.cl`) que apunte a la IP del servidor. Espere unos minutos a que se propague.
3. Entre por SSH e instale Docker: `curl -fsSL https://get.docker.com | sh`. En el firewall de Vultr deje abiertos solo los puertos 22, 80 y 443.
4. Copie esta carpeta al servidor (`scp -r soim-servidor usuario@IP:~/` o `git clone` de un repositorio **privado**).
5. Dentro de la carpeta, copie `.env.example` como `.env` y complete `DOMAIN`, `SESSION_SECRET` (una frase larga y aleatoria), `ADMIN_RUT` y `ADMIN_PASSWORD`. Proteja el archivo: `chmod 600 .env`.
6. Ejecute `docker compose up -d --build`. Caddy obtiene el certificado HTTPS solo.
7. Entre a `https://SU-DOMINIO/admin` con el RUT y la clave del `.env`; el sistema le pide cambiarla. Cree a los técnicos desde la pestaña *Usuarios*.

**Actualizar:** `git pull && docker compose up -d --build` (los datos están en un volumen y no se pierden).

**Respaldo propio:** `sh tools/backup.sh` genera un `.tar.gz` con la base de datos, todos los PDF y todos los comprobantes. Prográmelo a diario con `crontab -e`:
`15 3 * * * cd /home/USUARIO/soim-servidor && sh tools/backup.sh /home/USUARIO/respaldos`
Descargue de vez en cuando uno de esos archivos a su computador o súbalo a otro lugar: un respaldo que vive en el mismo servidor no sirve si el servidor se pierde.

---

## Módulo de gastos y justificación

Disponible en `https://SU-DOMINIO/gastos` (hay un enlace *Gastos* en la app y en el panel).

- **Técnico:** registra fecha, monto en pesos, categoría, tipo de documento (boleta, factura o sin respaldo), N° de documento y proveedor (opcionales), cliente e informe de servicio asociados (opcionales), **justificación obligatoria** y **foto del comprobante** (se comprime sola). Si el gasto es *sin respaldo* no se exige foto, pero sí la justificación.
- **Aprobación:** cada gasto queda *pendiente*. El administrador lo **aprueba** o lo **rechaza indicando el motivo**. El técnico ve el motivo, puede **corregir** el gasto (vuelve a pendiente) o eliminarlo. Un gasto aprobado ya no se puede editar ni borrar. Si hay más de un administrador, nadie aprueba sus propios gastos.
- **Totales** en pantalla por categoría, técnico, cliente y estado (sin contar rechazados), con los mismos filtros (fechas, estado, categoría, técnico, cliente).
- **Excel:** botón *Descargar Excel (CSV)* para el administrador; abre directo en Excel con tildes y ñ correctas.
- Cada técnico solo ve sus gastos y sus comprobantes; el administrador ve todos.
- Los gastos necesitan conexión a internet (a diferencia de los informes, no se guardan en cola sin señal). Si falla el envío, los datos siguen en el formulario.


---

## Lectura automática de informes (gratis)

Al subir un PDF ya elaborado, el servidor lee su texto y rellena fecha, cliente, equipo, modelo, serie, tipo, técnico y resumen; el técnico revisa antes de subir. Es local (sin costo ni envío a terceros) y funciona con PDF que tengan texto: los hechos en esta app, Word/LibreOffice/ReportLab, etc. Reconoce etiquetas como Cliente, Fecha, Equipo, Marca/Modelo, N° de serie, Técnico, Tipo de servicio, Problema/Falla, ya sea "Etiqueta: valor", en tabla o con la etiqueta encima del valor. Los PDF escaneados (imagen) no se pueden leer así.

Opcional: si algún día se quiere cubrir también los escaneados o formatos raros, se puede agregar `ANTHROPIC_API_KEY=...` en `/opt/soim/.env` y se usará solo cuando la lectura local no reconozca el documento (tiene costo y envía el PDF a Anthropic). Sin esa clave no se cobra nada.

## Subir informes anteriores

En la app, la tarjeta "Subir informe ya elaborado" permite cargar un PDF existente con fecha, cliente y datos del equipo. Queda guardado como cualquier otro informe (admin, historial de equipo y portal del cliente).

## Portal de clientes

Cada cliente puede tener su propia cuenta para ver sus informes anteriores en `https://SU-DOMINIO/portal.html`.

- **Crear la cuenta:** en el panel, pestaña *Usuarios*, rol **Cliente (portal de informes)**, y elija el cliente de la lista. El RUT es el de la persona o empresa que va a entrar; la contraseña temporal se la entrega usted y el sistema le obliga a cambiarla al primer ingreso.
- **Qué ve:** solo los informes cuyo cliente coincide **exactamente** con el cliente de su cuenta (buscar por texto, fechas, equipo o serie, ver y descargar el PDF, e historial por equipo). No ve gastos, técnicos internos, otros clientes ni el panel.
- Si un mismo cliente figura con dos nombres en la lista (por ejemplo "Centro de Salud San Rafael" y "San Rafael Centro de Salud"), hay que crear una cuenta para cada nombre.
- Para dar de baja a un cliente, desactive su cuenta en *Usuarios*.

## Historial de equipos

Los técnicos ya escriben marca/modelo y número de serie en cada informe; el sistema los guarda. En el panel, pestaña **Equipos**, se ve cada equipo (por cliente, tipo y serie) con su cantidad de informes y la fecha del último servicio, y *Ver informes* abre todos sus informes. En la app, el técnico tiene **Mis informes enviados** con buscador y ve cuáles quedaron **sin enviar** por falta de señal.

## Gastos: fondos, rendición mensual y sin conexión

- **Fondos por rendir:** en *Gastos → Fondos* el administrador registra entregas de dinero y devoluciones por técnico. Saldo = recibido − devuelto − gastos aprobados o pendientes. El técnico ve su propio saldo arriba del formulario de gastos.
- **Rendición mensual en PDF:** en *Gastos registrados* → *Rendición mensual*: elija el mes (y el técnico si es administrador). El PDF trae el resumen de fondos, el detalle, totales por categoría, líneas de firma y las fotos de los comprobantes. Se arma en el navegador con la misma librería de PDF de los informes (necesita internet para cargarla la primera vez).
- **Sin señal:** si un gasto nuevo no se puede enviar, queda guardado en el teléfono ("Gastos sin enviar") y se envía solo al volver la conexión. Corregir un gasto ya enviado sí requiere internet.

---

## Seguridad: lo que ya está hecho y lo que depende de usted

Ya incluido:
- Contraseñas guardadas con scrypt y sal; nunca en texto plano.
- Sesión en una cookie `HttpOnly` y `SameSite=Lax` (así los enlaces "Ver PDF" funcionan al abrirse desde la app instalada; los cambios siguen protegidos por la verificación de origen), solo por HTTPS en producción. Dura 30 días.
- Bloqueo temporal tras varios intentos fallidos (por RUT y por IP).
- Al cambiar una clave o desactivar a un usuario, sus sesiones abiertas dejan de valer de inmediato.
- Los técnicos ven todos los informes; los clientes solo los suyos; el panel y el ZIP exigen rol de administrador.
- Validación de RUT (dígito verificador), de PDF (formato y tamaño máximo de 25 MB) y protección contra envíos desde otros sitios.

Depende de usted:
- Use contraseñas largas y propias, sobre todo la del administrador.
- Los informes tienen datos de clientes y firmas. Dé el rol de administrador solo a quien deba ver todo.
- Si alguien pierde su clave, use *Nueva clave temporal* en el panel.
- Si el administrador queda sin acceso: en la consola (*Shell*) de Render ejecute
  `node tools/reset-password.js 12.345.678-5 "NuevaClaveTemporal1"`.
- Si un teléfono se pierde, desactive a ese usuario en el panel.

## Cosas que conviene saber

- El generador de PDF (jsPDF) se carga desde `cdnjs.cloudflare.com`. La app necesita internet **una vez** para guardarlo; después funciona sin conexión. Si quiere eliminar esa dependencia, descargue `jspdf.umd.min.js` (versión 2.5.1), póngalo en `public/vendor/` y cambie la etiqueta `<script>` de `public/index.html`.
- Los borradores se guardan en el teléfono, no en el servidor. Si dos técnicos comparten un teléfono, verán los borradores del otro.
- Las listas de clientes, direcciones, tipos de equipo y checklists están en `public/index.html`. Para cambiarlas, edite ese archivo y súbalo.
- Hay que ejecutar **una sola copia** del servidor, porque usa un archivo SQLite en disco.
- La app antigua en GitHub Pages sigue funcionando por separado, pero no envía nada a este servidor.

## Probar en su computador

Requiere Node.js 22.13 o superior.

```
ADMIN_RUT=12.345.678-5 ADMIN_PASSWORD=ClaveTemporal1 node server.js
```
Abra `http://localhost:3000`. Para correr la prueba automática del servidor: `node tools/selftest.js`.
