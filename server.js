'use strict';
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs'), crypto = require('crypto'), { createClient } = require('@libsql/client');
const { z } = require('zod'), path = require('path');

const PROD = process.env.NODE_ENV === 'production', TTL = 2 * 60 * 60 * 1000;

// Esquema incluido aquí (idempotente: se puede correr las veces que sea)
const SCHEMA = `
-- Base de datos "jabon" · esquema SQLite (tablas y columnas en español)

CREATE TABLE IF NOT EXISTS usuarios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  correo          TEXT NOT NULL COLLATE NOCASE,
  contrasena_hash TEXT NOT NULL,             -- bcrypt, nunca texto plano
  es_admin        INTEGER NOT NULL DEFAULT 0 CHECK (es_admin IN (0,1)),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS productos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  precio      REAL NOT NULL CHECK (precio >= 0),
  imagen_url  TEXT,
  activo      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS cupones (
  codigo     TEXT PRIMARY KEY COLLATE NOCASE,
  porcentaje INTEGER NOT NULL CHECK (porcentaje BETWEEN 1 AND 100),
  activo     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pedidos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id       INTEGER NOT NULL REFERENCES usuarios(id),
  estado           TEXT NOT NULL CHECK (estado IN ('pagada','pendiente')),
  subtotal         REAL NOT NULL,
  cupon_codigo     TEXT REFERENCES cupones(codigo),
  descuento        REAL NOT NULL DEFAULT 0,
  total            REAL NOT NULL,
  tarjeta_ultimos4 TEXT,                     -- solo últimos 4; NULL si está pendiente
  creado_en        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pedido_detalle (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id     INTEGER NOT NULL REFERENCES productos(id),
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario REAL NOT NULL              -- precio al momento de la compra
);

CREATE TABLE IF NOT EXISTS participantes_rifa (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  nombre     TEXT NOT NULL,
  correo     TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- una participación por correo
  creado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS resenas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  estrellas  INTEGER NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
  comentario TEXT NOT NULL,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sesiones (
  token      TEXT PRIMARY KEY,               -- guardado como hash SHA-256
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  expira     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pedidos_estado  ON pedidos(estado);
CREATE INDEX IF NOT EXISTS idx_pedidos_usuario ON pedidos(usuario_id);
CREATE INDEX IF NOT EXISTS idx_detalle_pedido  ON pedido_detalle(pedido_id);

-- ===== DATOS INICIALES =====
INSERT OR IGNORE INTO productos (nombre, descripcion, precio) VALUES
 ('Lavanda y Avena','Calmante, para piel sensible',65),
 ('Miel y Cúrcuma','Luminosidad y suavidad',70),
 ('Carbón Activado','Limpieza profunda de poros',75),
 ('Romero y Menta','Fresco y tonificante',65),
 ('Rosa Mosqueta','Hidratación y firmeza',85),
 ('Café y Canela','Exfoliante suave, aroma cálido',70),
 ('Aloe Vera y Pepino','Frescura para piel mixta',65),
 ('Leche de Cabra','Cremoso, ultra nutritivo',90),
 ('Naranja y Clavo','Cítrico y energizante',70),
 ('Arcilla Verde','Equilibra la piel grasa',75),
 ('Manzanilla y Caléndula','Suave, ideal para bebés',70),
 ('Coco y Vainilla','Dulce y humectante',80);

INSERT OR IGNORE INTO cupones (codigo, porcentaje) VALUES
 ('BIENVENIDA10',10),('ARTESANAL15',15),('JABONLOVER20',20);
`;

// Base de datos: en la nube (Turso) si hay variables, o el archivo local "jabon"
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:' + path.join(__dirname, 'jabon'),
  authToken: process.env.TURSO_AUTH_TOKEN
});
const q = async (sql, args = [], c = db) => {
  const r = await c.execute({ sql, args });
  return r.rows.map(row => Object.fromEntries(r.columns.map((k, i) => [k, row[i]])));
};
const one = async (sql, args, c) => (await q(sql, args, c))[0];

const ready = (async () => {
  if (process.env.VERCEL && !process.env.TURSO_DATABASE_URL) throw new Error('Falta TURSO_DATABASE_URL (y TURSO_AUTH_TOKEN) en las variables de Vercel');
  if (!(await one("SELECT 1 x FROM sqlite_master WHERE name='usuarios'"))) await db.executeMultiple(SCHEMA);
  // una participación por usuario, a nivel de base de datos (además del correo único)
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_rifa_usuario ON participantes_rifa(usuario_id)').catch(e => console.warn('Índice de rifa no creado:', e.message));
  const ap = process.env.ADMIN_PASSWORD;
  if (ap) {   // crea al admin o actualiza su contraseña con la del entorno
    const a = await one("SELECT contrasena_hash h FROM usuarios WHERE nombre='admin'");
    if (!a || !(await bcrypt.compare(ap, a.h)))
      await q("INSERT INTO usuarios(nombre,correo,contrasena_hash,es_admin) VALUES('admin','admin@local',?,1) ON CONFLICT(nombre) DO UPDATE SET contrasena_hash=excluded.contrasena_hash, es_admin=1", [await bcrypt.hash(ap, 12)]);
    console.log('Admin listo → usuario: admin');
  } else if (!(await one('SELECT 1 x FROM usuarios WHERE es_admin=1'))) console.warn('⚠ No hay admin. Define ADMIN_PASSWORD');
})();
ready.catch(e => console.error('ERROR AL INICIAR:', e.message));

const DUMMY = bcrypt.hashSync('dummy-password', 12);           // iguala tiempos si el usuario no existe
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);   // errores async no tumban el server

const app = express();
app.disable('x-powered-by');
if (process.env.VERCEL) app.set('trust proxy', 1);              // para ver la IP real detrás del proxy de Vercel
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'],
  fontSrc: ['https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
  objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: '10kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, message: { error: 'Demasiados intentos. Espera 15 minutos.' } });
const writeLimit = rateLimit({ windowMs: 60_000, limit: 20, message: { error: 'Demasiadas solicitudes.' } });

// ---- sesiones (cookie httpOnly + token guardado hasheado + CSRF) ----
const getCookie = (req, n) => ((req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(([k]) => k === n) || [])[1];
app.use('/api', ah(async (req, _res, next) => {
  await ready; req.s = null; const t = getCookie(req, 'sid');
  if (t && /^[a-f0-9]{64}$/.test(t)) {
    const r = await one('SELECT s.csrf,s.expira AS expires,u.id,u.nombre AS name,u.correo AS email,u.es_admin AS is_admin FROM sesiones s JOIN usuarios u ON u.id=s.usuario_id WHERE s.token=?', [sha(t)]);
    if (r && r.expires > Date.now()) req.s = r;
  }
  next();
}));
const need = (req, res, next) => req.s ? next() : res.status(401).json({ error: 'Inicia sesión' });
const csrf = (req, res, next) => safeEq(req.get('x-csrf-token') || '', req.s.csrf) ? next() : res.status(403).json({ error: 'Token inválido' });
const adminOnly = (req, res, next) => req.s.is_admin ? next() : res.status(403).json({ error: 'Solo administrador' });
const pub = u => ({ name: u.name, email: u.email, is_admin: !!u.is_admin });
async function startSession(res, uid) {
  const t = crypto.randomBytes(32).toString('hex'), c = crypto.randomBytes(24).toString('hex');
  await q('DELETE FROM sesiones WHERE expira<?', [Date.now()]);
  await q('DELETE FROM sesiones WHERE usuario_id=?', [uid]);          // una sola sesión por usuario
  await q('INSERT INTO sesiones(token,usuario_id,csrf,expira) VALUES(?,?,?,?)', [sha(t), uid, c, Date.now() + TTL]);
  res.cookie('sid', t, { httpOnly: true, sameSite: 'strict', secure: PROD, path: '/' });   // sin maxAge: se borra al cerrar el navegador
  return c;
}
const bad = (res, p) => res.status(400).json({ error: p.error.issues[0].message });

// ---- validación (zod) ----
const Name = z.string().trim().min(3, 'Usuario: mínimo 3 caracteres').max(30).regex(/^[\p{L}\p{N}_.\- ]+$/u, 'Usuario: solo letras, números, espacio, _ . -');
const Email = z.string().trim().toLowerCase().email('Correo inválido').max(100);
const Auth = z.object({ name: Name, email: Email, password: z.string().min(1).max(72) });
const Checkout = z.object({
  items: z.array(z.object({ id: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1).max(30),
  coupon: z.string().trim().max(30).nullable().optional(),
  status: z.enum(['pagada', 'pendiente']),
  card4: z.string().regex(/^\d{4}$/).optional()             // el cliente solo manda los últimos 4
}).refine(d => d.status !== 'pagada' || !!d.card4, { message: 'Datos de tarjeta inválidos' });
const Raffle = z.object({ name: z.string().trim().min(2).max(60), email: Email });
const Review = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().min(1, 'Escribe un comentario').max(500) });
const isDup = e => /UNIQUE|constraint/i.test(String(e && e.message));

// ---- rutas ----
app.post('/api/auth', authLimit, ah(async (req, res) => {
  const p = Auth.safeParse(req.body); if (!p.success) return bad(res, p);
  const { name, email, password } = p.data;
  const u = await one('SELECT id,nombre AS name,correo AS email,contrasena_hash AS password_hash,es_admin AS is_admin FROM usuarios WHERE nombre=?', [name]);
  if (u) {
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    return res.json({ user: pub(u), csrf: await startSession(res, u.id) });
  }
  if (name.toLowerCase() === 'admin') return res.status(403).json({ error: 'Ese nombre está reservado' });
  await bcrypt.compare(password, DUMMY);
  if (!/^(?=.*\p{L})(?=.*\d).{8,72}$/u.test(password)) return res.status(400).json({ error: 'Contraseña: 8+ caracteres con letras y números' });
  const hash = await bcrypt.hash(password, 12);
  let id;
  try { id = Number((await db.execute({ sql: 'INSERT INTO usuarios(nombre,correo,contrasena_hash) VALUES(?,?,?)', args: [name, email, hash] })).lastInsertRowid); }
  catch (e) { if (isDup(e)) return res.status(409).json({ error: 'Ese usuario ya existe' }); throw e; }
  res.json({ user: { name, email, is_admin: false }, csrf: await startSession(res, id) });
}));
app.get('/api/me', need, (req, res) => res.json({ user: pub(req.s), csrf: req.s.csrf }));
app.post('/api/logout', need, csrf, ah(async (req, res) => {
  await q('DELETE FROM sesiones WHERE token=?', [sha(getCookie(req, 'sid'))]);
  res.clearCookie('sid'); res.json({ ok: true });
}));
app.get('/api/products', need, ah(async (_req, res) => res.json(await q('SELECT id,nombre AS name,descripcion AS description,precio AS price FROM productos WHERE activo=1'))));
app.post('/api/coupon', need, csrf, writeLimit, ah(async (req, res) => {
  const code = String(req.body?.code || '').trim().slice(0, 30);
  const c = await one('SELECT codigo AS code,porcentaje AS percent_off FROM cupones WHERE codigo=? AND activo=1', [code]);
  c ? res.json({ code: c.code, pct: c.percent_off }) : res.status(404).json({ error: 'Cupón no válido' });
}));
app.post('/api/checkout', need, csrf, writeLimit, ah(async (req, res) => {
  const p = Checkout.safeParse(req.body); if (!p.success) return bad(res, p);
  const { items, coupon, status, card4 } = p.data;
  const merged = new Map(); items.forEach(i => merged.set(i.id, Math.min(20, (merged.get(i.id) || 0) + i.qty)));
  const ids = [...merged.keys()];
  const prods = await q(`SELECT id,precio AS price FROM productos WHERE activo=1 AND id IN (${ids.map(() => '?').join(',')})`, ids);
  if (prods.length !== ids.length) return res.status(400).json({ error: 'Producto inválido' });
  const rows = prods.map(pr => ({ prod: pr, qty: merged.get(pr.id) }));
  const subtotal = rows.reduce((s, r) => s + r.prod.price * r.qty, 0);     // el precio SIEMPRE lo decide el servidor
  let cp = null;
  if (coupon) { cp = await one('SELECT codigo AS code,porcentaje AS percent_off FROM cupones WHERE codigo=? AND activo=1', [coupon]); if (!cp) return res.status(400).json({ error: 'Cupón no válido' }); }
  const discount = cp ? +(subtotal * cp.percent_off / 100).toFixed(2) : 0, total = +(subtotal - discount).toFixed(2);
  const tx = await db.transaction('write');
  let id;
  try {
    const r = await tx.execute({ sql: 'INSERT INTO pedidos(usuario_id,estado,subtotal,cupon_codigo,descuento,total,tarjeta_ultimos4) VALUES(?,?,?,?,?,?,?)',
      args: [req.s.id, status, subtotal, cp ? cp.code : null, discount, total, status === 'pagada' ? (card4 || '0000') : null] });
    id = Number(r.lastInsertRowid);
    for (const x of rows) await tx.execute({ sql: 'INSERT INTO pedido_detalle(pedido_id,producto_id,cantidad,precio_unitario) VALUES(?,?,?,?)', args: [id, x.prod.id, x.qty, x.prod.price] });
    await tx.commit();
  } catch (e) { await tx.rollback().catch(() => {}); throw e; } finally { tx.close(); }
  res.json({ order: { id, status, total } });
}));
app.get('/api/raffle/mine', need, ah(async (req, res) => res.json({ joined: !!(await one('SELECT 1 x FROM participantes_rifa WHERE usuario_id=?', [req.s.id])) })));
app.post('/api/raffle', need, csrf, writeLimit, ah(async (req, res) => {
  const p = Raffle.safeParse(req.body); if (!p.success) return bad(res, p);
  const ya = await one('SELECT 1 x FROM participantes_rifa WHERE usuario_id=? OR correo=?', [req.s.id, p.data.email]);
  if (ya) return res.status(409).json({ error: 'Ya estás registrado en la rifa. Solo se permite una participación.' });
  try { await q('INSERT INTO participantes_rifa(usuario_id,nombre,correo) VALUES(?,?,?)', [req.s.id, p.data.name, p.data.email]); res.json({ ok: true }); }
  catch (e) { if (isDup(e)) return res.status(409).json({ error: 'Ya estás registrado en la rifa. Solo se permite una participación.' }); throw e; }
}));
app.get('/api/reviews', need, ah(async (_req, res) => res.json(await q('SELECT u.nombre AS name,r.estrellas AS stars,r.comentario AS comment,r.creado_en AS created_at FROM resenas r JOIN usuarios u ON u.id=r.usuario_id ORDER BY r.id DESC LIMIT 100'))));
app.post('/api/reviews', need, csrf, writeLimit, ah(async (req, res) => {
  const p = Review.safeParse(req.body); if (!p.success) return bad(res, p);
  await q('INSERT INTO resenas(usuario_id,estrellas,comentario) VALUES(?,?,?)', [req.s.id, p.data.stars, p.data.comment]); res.json({ ok: true });
}));
const orders = st => q(`SELECT o.id,u.nombre AS name,o.total,o.cupon_codigo AS coupon_code,o.tarjeta_ultimos4 AS card_last4,o.creado_en AS created_at,
  (SELECT group_concat(p.nombre||' x'||i.cantidad,', ') FROM pedido_detalle i JOIN productos p ON p.id=i.producto_id WHERE i.pedido_id=o.id) productos
  FROM pedidos o JOIN usuarios u ON u.id=o.usuario_id WHERE o.estado=? ORDER BY o.id DESC`, [st]);
const ADMIN_Q = {
  users: () => q('SELECT nombre AS name,correo AS email,creado_en AS created_at FROM usuarios ORDER BY id'),
  raffle: () => q('SELECT nombre AS name,correo AS email,creado_en AS created_at FROM participantes_rifa ORDER BY id'),
  reviews: () => q('SELECT u.nombre AS name,r.estrellas AS stars,r.comentario AS comment,r.creado_en AS created_at FROM resenas r JOIN usuarios u ON u.id=r.usuario_id ORDER BY r.id DESC'),
  paid: () => orders('pagada'), pending: () => orders('pendiente')
};
app.get('/api/admin/:k', need, adminOnly, ah(async (req, res) => Object.hasOwn(ADMIN_Q, req.params.k) ? res.json(await ADMIN_Q[req.params.k]()) : res.status(404).json({ error: 'No existe' })));

app.use(express.static(path.join(__dirname, 'public')));          // solo /public; la base y el código quedan fuera
app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(err.status === 400 ? 400 : 500).json({ error: 'Error del servidor' }); });
if (require.main === module) app.listen(process.env.PORT || 3000, process.env.HOST || '127.0.0.1', () => console.log('http://' + (process.env.HOST || '127.0.0.1') + ':' + (process.env.PORT || 3000)));
module.exports = app;