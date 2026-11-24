'use strict';
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs'), crypto = require('crypto'), Database = require('better-sqlite3');
const { z } = require('zod'), fs = require('fs'), path = require('path');

const PROD = process.env.NODE_ENV === 'production', TTL = 2 * 60 * 60 * 1000;
// Esquema incluido aquí: ya no hace falta schema.sql para que el servidor arranque
const SCHEMA = `
-- Base de datos "jabon" · esquema SQLite (tablas y columnas en español)
PRAGMA foreign_keys = ON;

CREATE TABLE usuarios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  correo          TEXT NOT NULL COLLATE NOCASE,
  contrasena_hash TEXT NOT NULL,             -- bcrypt, nunca texto plano
  es_admin        INTEGER NOT NULL DEFAULT 0 CHECK (es_admin IN (0,1)),
  creado_en       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE productos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  precio      REAL NOT NULL CHECK (precio >= 0),
  imagen_url  TEXT,
  activo      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE cupones (
  codigo     TEXT PRIMARY KEY COLLATE NOCASE,
  porcentaje INTEGER NOT NULL CHECK (porcentaje BETWEEN 1 AND 100),
  activo     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE pedidos (
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

CREATE TABLE pedido_detalle (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id     INTEGER NOT NULL REFERENCES productos(id),
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0),
  precio_unitario REAL NOT NULL              -- precio al momento de la compra
);

CREATE TABLE participantes_rifa (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios(id),
  nombre     TEXT NOT NULL,
  correo     TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- una participación por correo
  creado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE resenas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
  estrellas  INTEGER NOT NULL CHECK (estrellas BETWEEN 1 AND 5),
  comentario TEXT NOT NULL,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sesiones (
  token      TEXT PRIMARY KEY,               -- guardado como hash SHA-256
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  expira     INTEGER NOT NULL
);

CREATE INDEX idx_pedidos_estado  ON pedidos(estado);
CREATE INDEX idx_pedidos_usuario ON pedidos(usuario_id);
CREATE INDEX idx_detalle_pedido  ON pedido_detalle(pedido_id);

-- ===== DATOS INICIALES =====
INSERT INTO productos (nombre, descripcion, precio) VALUES
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

INSERT INTO cupones (codigo, porcentaje) VALUES
 ('BIENVENIDA10',10),('ARTESANAL15',15),('JABONLOVER20',20);
`;
const db = new Database(path.join(__dirname, 'jabon'));
db.pragma('foreign_keys = ON');
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='usuarios'").get()) db.exec(SCHEMA);
db.exec(`CREATE TABLE IF NOT EXISTS sesiones(token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expira INTEGER NOT NULL)`);

// Admin: la contraseña viene del entorno, NUNCA del código
if (process.env.ADMIN_PASSWORD) {
  // crea al admin o, si ya existe, le actualiza la contraseña con la del entorno
  db.prepare("INSERT INTO usuarios(nombre,correo,contrasena_hash,es_admin) VALUES('admin','admin@local',?,1) ON CONFLICT(nombre) DO UPDATE SET contrasena_hash=excluded.contrasena_hash, es_admin=1").run(bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12));
  console.log('Admin listo → usuario: admin');
} else if (!db.prepare('SELECT 1 FROM usuarios WHERE es_admin=1').get()) console.warn('⚠ No hay admin. Arranca con ADMIN_PASSWORD="..." node server.js');

const DUMMY = bcrypt.hashSync('dummy-password', 12);           // iguala tiempos si el usuario no existe
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);   // errores async no tumban el server

const app = express();
app.disable('x-powered-by');
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
app.use('/api', (req, _res, next) => {
  req.s = null; const t = getCookie(req, 'sid');
  if (t && /^[a-f0-9]{64}$/.test(t)) {
    const r = db.prepare('SELECT s.csrf,s.expira AS expires,u.id,u.nombre AS name,u.correo AS email,u.es_admin AS is_admin FROM sesiones s JOIN usuarios u ON u.id=s.usuario_id WHERE s.token=?').get(sha(t));
    if (r && r.expires > Date.now()) req.s = r;
  }
  next();
});
const need = (req, res, next) => req.s ? next() : res.status(401).json({ error: 'Inicia sesión' });
const csrf = (req, res, next) => safeEq(req.get('x-csrf-token') || '', req.s.csrf) ? next() : res.status(403).json({ error: 'Token inválido' });
const adminOnly = (req, res, next) => req.s.is_admin ? next() : res.status(403).json({ error: 'Solo administrador' });
const pub = u => ({ name: u.name, email: u.email, is_admin: !!u.is_admin });
function startSession(res, uid) {
  const t = crypto.randomBytes(32).toString('hex'), c = crypto.randomBytes(24).toString('hex');
  db.prepare('DELETE FROM sesiones WHERE expira<?').run(Date.now());
  db.prepare('DELETE FROM sesiones WHERE usuario_id=?').run(uid);          // una sola sesión por usuario
  db.prepare('INSERT INTO sesiones VALUES(?,?,?,?)').run(sha(t), uid, c, Date.now() + TTL);
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
  card4: z.string().regex(/^\d{0,4}$/).optional()           // el cliente solo manda los últimos 4
});
const Raffle = z.object({ name: z.string().trim().min(2).max(60), email: Email });
const Review = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().trim().min(1, 'Escribe un comentario').max(500) });

// ---- rutas ----
app.post('/api/auth', authLimit, ah(async (req, res) => {
  const p = Auth.safeParse(req.body); if (!p.success) return bad(res, p);
  const { name, email, password } = p.data;
  const u = db.prepare('SELECT id,nombre AS name,correo AS email,contrasena_hash AS password_hash,es_admin AS is_admin FROM usuarios WHERE nombre=?').get(name);
  if (u) {
    if (!(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    return res.json({ user: pub(u), csrf: startSession(res, u.id) });
  }
  if (name.toLowerCase() === 'admin') return res.status(403).json({ error: 'Ese nombre está reservado' });
  await bcrypt.compare(password, DUMMY);
  if (!/^(?=.*\p{L})(?=.*\d).{8,72}$/u.test(password)) return res.status(400).json({ error: 'Contraseña: 8+ caracteres con letras y números' });
  const hash = await bcrypt.hash(password, 12);
  try {
    const id = db.prepare('INSERT INTO usuarios(nombre,correo,contrasena_hash) VALUES(?,?,?)').run(name, email, hash).lastInsertRowid;
    res.json({ user: { name, email, is_admin: false }, csrf: startSession(res, id) });
  } catch { res.status(409).json({ error: 'Ese usuario ya existe' }); }
}));
app.get('/api/me', need, (req, res) => res.json({ user: pub(req.s), csrf: req.s.csrf }));
app.post('/api/logout', need, csrf, (req, res) => {
  db.prepare('DELETE FROM sesiones WHERE token=?').run(sha(getCookie(req, 'sid')));
  res.clearCookie('sid'); res.json({ ok: true });
});
app.get('/api/products', need, (_req, res) => res.json(db.prepare('SELECT id,nombre AS name,descripcion AS description,precio AS price FROM productos WHERE activo=1').all()));
app.post('/api/coupon', need, csrf, writeLimit, (req, res) => {
  const code = String(req.body?.code || '').trim().slice(0, 30);
  const c = db.prepare('SELECT codigo AS code,porcentaje AS percent_off FROM cupones WHERE codigo=? AND activo=1').get(code);
  c ? res.json({ code: c.code, pct: c.percent_off }) : res.status(404).json({ error: 'Cupón no válido' });
});
app.post('/api/checkout', need, csrf, writeLimit, (req, res) => {
  const p = Checkout.safeParse(req.body); if (!p.success) return bad(res, p);
  const { items, coupon, status, card4 } = p.data;
  const merged = new Map(); items.forEach(i => merged.set(i.id, Math.min(20, (merged.get(i.id) || 0) + i.qty)));
  const rows = [...merged].map(([id, qty]) => ({ prod: db.prepare('SELECT id,precio AS price FROM productos WHERE id=? AND activo=1').get(id), qty }));
  if (rows.some(r => !r.prod)) return res.status(400).json({ error: 'Producto inválido' });
  const subtotal = rows.reduce((s, r) => s + r.prod.price * r.qty, 0);     // el precio SIEMPRE lo decide el servidor
  let cp = null; if (coupon) { cp = db.prepare('SELECT codigo AS code,porcentaje AS percent_off FROM cupones WHERE codigo=? AND activo=1').get(coupon); if (!cp) return res.status(400).json({ error: 'Cupón no válido' }); }
  const discount = cp ? +(subtotal * cp.percent_off / 100).toFixed(2) : 0, total = +(subtotal - discount).toFixed(2);
  const id = db.transaction(() => {
    const oid = db.prepare('INSERT INTO pedidos(usuario_id,estado,subtotal,cupon_codigo,descuento,total,tarjeta_ultimos4) VALUES(?,?,?,?,?,?,?)')
      .run(req.s.id, status, subtotal, cp?.code ?? null, discount, total, status === 'pagada' ? (card4 || '0000') : null).lastInsertRowid;
    const ins = db.prepare('INSERT INTO pedido_detalle(pedido_id,producto_id,cantidad,precio_unitario) VALUES(?,?,?,?)');
    rows.forEach(r => ins.run(oid, r.prod.id, r.qty, r.prod.price)); return oid;
  })();
  res.json({ order: { id, status, total } });
});
app.post('/api/raffle', need, csrf, writeLimit, (req, res) => {
  const p = Raffle.safeParse(req.body); if (!p.success) return bad(res, p);
  try { db.prepare('INSERT INTO participantes_rifa(usuario_id,nombre,correo) VALUES(?,?,?)').run(req.s.id, p.data.name, p.data.email); res.json({ ok: true }); }
  catch { res.status(409).json({ error: 'Ese correo ya está registrado en la rifa.' }); }
});
app.get('/api/reviews', need, (_req, res) => res.json(db.prepare('SELECT u.nombre AS name,r.estrellas AS stars,r.comentario AS comment,r.creado_en AS created_at FROM resenas r JOIN usuarios u ON u.id=r.usuario_id ORDER BY r.id DESC LIMIT 100').all()));
app.post('/api/reviews', need, csrf, writeLimit, (req, res) => {
  const p = Review.safeParse(req.body); if (!p.success) return bad(res, p);
  db.prepare('INSERT INTO resenas(usuario_id,estrellas,comentario) VALUES(?,?,?)').run(req.s.id, p.data.stars, p.data.comment); res.json({ ok: true });
});
const orders = st => db.prepare(`SELECT o.id,u.nombre AS name,o.total,o.cupon_codigo AS coupon_code,o.tarjeta_ultimos4 AS card_last4,o.creado_en AS created_at,
  (SELECT group_concat(p.nombre||' x'||i.cantidad,', ') FROM pedido_detalle i JOIN productos p ON p.id=i.producto_id WHERE i.pedido_id=o.id) productos
  FROM pedidos o JOIN usuarios u ON u.id=o.usuario_id WHERE o.estado=? ORDER BY o.id DESC`).all(st);
const ADMIN_Q = {
  users: () => db.prepare('SELECT nombre AS name,correo AS email,creado_en AS created_at FROM usuarios ORDER BY id').all(),
  raffle: () => db.prepare('SELECT nombre AS name,correo AS email,creado_en AS created_at FROM participantes_rifa ORDER BY id').all(),
  reviews: () => db.prepare('SELECT u.nombre AS name,r.estrellas AS stars,r.comentario AS comment,r.creado_en AS created_at FROM resenas r JOIN usuarios u ON u.id=r.usuario_id ORDER BY r.id DESC').all(),
  paid: () => orders('pagada'), pending: () => orders('pendiente')
};
app.get('/api/admin/:k', need, adminOnly, (req, res) => Object.hasOwn(ADMIN_Q, req.params.k) ? res.json(ADMIN_Q[req.params.k]()) : res.status(404).json({ error: 'No existe' }));

app.use(express.static(path.join(__dirname, 'public')));          // solo /public; el .db y el código quedan fuera
app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(err.status === 400 ? 400 : 500).json({ error: 'Error del servidor' }); });
app.listen(process.env.PORT || 3000, process.env.HOST || '127.0.0.1', () => console.log('http://' + (process.env.HOST || '127.0.0.1') + ':' + (process.env.PORT || 3000)));
