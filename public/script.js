// Frontend conectado a la API. Aquí NO hay contraseñas, cupones ni precios de verdad: todo lo valida el servidor.
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Number(n).toFixed(2) + ' MXN';
const fdate = d => new Date(String(d).replace(' ', 'T') + 'Z').toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' });
const starTxt = n => '★'.repeat(n) + '☆'.repeat(5 - n);
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2500); }

let csrf = '', user = null, coupon = null, rating = 0, cart = [];   // todo en memoria: al recargar o cerrar, se pierde

async function api(path, method = 'GET', body) {
  let r;
  try {
    r = await fetch('/api/' + path, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch { throw new Error('No hay conexión con el servidor. ¿Está corriendo "node server.js"?'); }
  const d = await r.json().catch(() => null);
  if (!d) throw new Error('El servidor no respondió como API. Abre la página desde http://127.0.0.1:3000 (no como archivo ni con Live Server).');
  if (!r.ok) throw new Error(d.error || 'Error');
  return d;
}

// ===== LOGIN =====
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); const f = e.target;
  try {
    const d = await api('auth', 'POST', { name: f.elements.name.value, email: f.elements.mail.value, password: f.elements.pass.value });
    user = d.user; csrf = d.csrf; f.elements.pass.value = ''; $('#loginErr').textContent = ''; enter();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').onclick = async () => { try { await api('logout', 'POST'); } catch {} location.reload(); };

function enter() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#adminBtn').hidden = !user.is_admin;
  $('#rName').value = user.name; $('#rMail').value = user.email;
  renderCart(); loadReviews(); checkRaffle();
}

// ===== CARRITO =====
document.querySelectorAll('.card .add').forEach(b => b.onclick = () => {
  const c = b.closest('.card'), id = c.dataset.id, it = cart.find(x => x.id === id);
  if (it) it.qty = Math.min(20, it.qty + 1); else cart.push({ id, name: c.dataset.name, price: +c.dataset.price, qty: 1 });
  saveCart(); toast(c.dataset.name + ' agregado');
});
$('#cartBtn').onclick = () => $('#cart').classList.add('open');
$('#cartClose').onclick = () => $('#cart').classList.remove('open');
function saveCart() { renderCart(); }
function totals() {
  const sub = cart.reduce((s, i) => s + i.price * i.qty, 0), pct = coupon ? coupon.pct : 0;
  return { sub, pct, disc: sub * pct / 100, total: sub - sub * pct / 100 };
}
function renderCart() {
  $('#cartCount').textContent = cart.reduce((s, i) => s + i.qty, 0);
  $('#cartItems').innerHTML = cart.length ? cart.map(i => `
    <div class="ci"><div><b>${esc(i.name)}</b><br><span class="muted">${money(i.price)}</span></div>
    <div class="qty"><button data-id="${esc(i.id)}" data-d="-1" aria-label="Quitar uno">−</button>${i.qty}<button data-id="${esc(i.id)}" data-d="1" aria-label="Agregar uno">+</button></div></div>`).join('')
    : '<p class="muted">Tu carrito está vacío.</p>';
  const t = totals();
  $('#cartTotals').innerHTML = `<div>Subtotal: ${money(t.sub)}</div>` +
    (coupon ? `<div>Cupón ${esc(coupon.code)} (−${t.pct}%): −${money(t.disc)}</div>` : '') + `<div class="t">Total: ${money(t.total)}</div>`;
}
$('#cartItems').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const it = cart.find(x => x.id === b.dataset.id); if (!it) return;
  it.qty = Math.min(20, it.qty + +b.dataset.d);
  if (it.qty <= 0) cart = cart.filter(x => x !== it);
  saveCart();
};

// ===== PAGO SIMULADO (al servidor solo van los últimos 4 dígitos) =====
async function checkout(status) {
  if (!cart.length) { $('#payMsg').textContent = 'Agrega productos al carrito primero.'; return; }
  if (status === 'pagada') { const err = validarTarjeta(); if (err) { $('#payMsg').textContent = err; return; } }
  try {
    const card4 = status === 'pagada' ? $('#cNum').value.replace(/\D/g, '').slice(-4) : undefined;   // solo los últimos 4 viajan al servidor
    const d = await api('checkout', 'POST', { items: cart.map(i => ({ id: +i.id, qty: i.qty })), coupon: coupon ? coupon.code : null, status, card4 });
    cart = []; coupon = null; $('#couponMsg').textContent = ''; saveCart();
    ['cName', 'cNum', 'cExp', 'cCvv'].forEach(i => $('#' + i).value = '');
    $('#payMsg').textContent = status === 'pagada' ? `¡Pago exitoso! Pedido #${d.order.id} · ${money(d.order.total)}` : `Pedido #${d.order.id} quedó pendiente.`;
  } catch (err) { $('#payMsg').textContent = err.message; }
}
$('#payBtn').onclick = () => checkout('pagada');
$('#pendBtn').onclick = () => checkout('pendiente');

// ===== CUPÓN =====
$('#couponForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const d = await api('coupon', 'POST', { code: $('#couponIn').value });
    coupon = d; $('#couponMsg').textContent = `Cupón ${d.code} aplicado: ${d.pct}% de descuento.`; renderCart();
  } catch (err) { $('#couponMsg').textContent = err.message; }
  $('#couponIn').value = '';
});

// ===== RIFA =====
$('#raffleForm').addEventListener('submit', async e => {
  e.preventDefault();
  try { await api('raffle', 'POST', { name: $('#rName').value, email: $('#rMail').value }); lockRaffle('¡Listo! Ya estás participando. Mucha suerte.'); }
  catch (err) { /^Ya est/.test(err.message) ? lockRaffle(err.message) : $('#raffleMsg').textContent = err.message; }
});
function lockRaffle(msg) { $('#raffleForm').querySelectorAll('input,button').forEach(el => el.disabled = true); $('#raffleMsg').textContent = msg; }
async function checkRaffle() { try { if ((await api('raffle/mine')).joined) lockRaffle('Ya estás registrado en la rifa. ¡Mucha suerte!'); } catch {} }

// ===== OPINIONES =====
const starsEl = $('#stars');
starsEl.innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" data-v="${n}" aria-label="${n} estrellas">★</button>`).join('');
starsEl.onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  rating = +b.dataset.v; [...starsEl.children].forEach((s, i) => s.classList.toggle('on', i < rating));
};
$('#reviewForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (!rating) return toast('Elige una calificación');
  try {
    await api('reviews', 'POST', { stars: rating, comment: $('#rvText').value });
    $('#rvText').value = ''; rating = 0; [...starsEl.children].forEach(s => s.classList.remove('on'));
    loadReviews(); toast('¡Gracias por tu opinión!');
  } catch (err) { toast(err.message); }
});
async function loadReviews() {
  try {
    const rv = await api('reviews');
    $('#avg').textContent = rv.length ? `Promedio: ${(rv.reduce((s, r) => s + r.stars, 0) / rv.length).toFixed(1)} / 5 (${rv.length} opiniones)` : 'Aún no hay opiniones. ¡Sé el primero!';
    $('#reviews').innerHTML = rv.map(r => `<div class="rv"><b>${esc(r.name)}</b><span class="s">${starTxt(r.stars)}</span><p>${esc(r.comment)}</p></div>`).join('');
  } catch {}
}

// ===== PANEL ADMIN =====
const table = (h, rows) => rows.length
  ? `<table><thead><tr>${h.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="muted">Sin registros.</p>';
const STEPS = [
  ['Usuarios', 'users', d => table(['Nombre', 'Correo', 'Registro'], d.map(u => [u.name, u.email, fdate(u.created_at)]))],
  ['Registro de rifa', 'raffle', d => table(['Nombre', 'Correo', 'Fecha'], d.map(r => [r.name, r.email, fdate(r.created_at)]))],
  ['Calificaciones y comentarios', 'reviews', d => table(['Usuario', 'Calificación', 'Comentario', 'Fecha'], d.map(r => [r.name, starTxt(r.stars), r.comment, fdate(r.created_at)]))],
  ['Compras realizadas', 'paid', d => table(['Pedido', 'Usuario', 'Productos', 'Total', 'Cupón', 'Tarjeta', 'Fecha'], d.map(o => ['#' + o.id, o.name, o.productos, money(o.total), o.coupon_code || '—', '•••• ' + o.card_last4, fdate(o.created_at)]))],
  ['Compras pendientes', 'pending', d => table(['Pedido', 'Usuario', 'Productos', 'Total', 'Cupón', 'Fecha'], d.map(o => ['#' + o.id, o.name, o.productos, money(o.total), o.coupon_code || '—', fdate(o.created_at)]))]
];
let step = 0;
async function renderAdmin() {
  $('#admTitle').textContent = STEPS[step][0];
  $('#admStep').textContent = `${step + 1} / ${STEPS.length}`;
  $('#admPrev').disabled = step === 0; $('#admNext').disabled = step === STEPS.length - 1;
  try { $('#admBody').innerHTML = STEPS[step][2](await api('admin/' + STEPS[step][1])); }
  catch (err) { $('#admBody').textContent = err.message; }
}
$('#adminBtn').onclick = () => { step = 0; renderAdmin(); $('#admin').hidden = false; };
$('#admClose').onclick = () => $('#admin').hidden = true;
$('#admPrev').onclick = () => { step--; renderAdmin(); };
$('#admNext').onclick = () => { step++; renderAdmin(); };

// ===== VALIDACIÓN DE FORMULARIOS =====
// Tarjeta: solo formato. Los datos completos NUNCA se envían al servidor (solo los últimos 4 dígitos).
const mask = (el, fn, max) => { el.maxLength = max; el.inputMode = el.id === 'cName' ? 'text' : 'numeric'; el.addEventListener('input', () => { el.value = fn(el.value); }); };
mask($('#cName'), v => { v = v.replace(/[^\p{L} ]/gu, '').replace(/^ +/, '').replace(/ {2,}/g, ' '); const w = v.split(' '); return w.length > 2 ? w.slice(0, 2).join(' ') : v; }, 40);   // máx. 2 palabras
mask($('#cNum'), v => v.replace(/\D/g, '').slice(0, 16).replace(/(.{4})/g, '$1 ').trim(), 19);                                                 // 16 dígitos
mask($('#cExp'), v => { const d = v.replace(/\D/g, '').slice(0, 4); return d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; }, 5);       // MM/AA = 4 dígitos
mask($('#cCvv'), v => v.replace(/\D/g, '').slice(0, 3), 3);                                                                                    // CVV = 3 dígitos
function validarTarjeta() {
  const nombre = $('#cName').value.trim(), num = $('#cNum').value.replace(/\D/g, ''), exp = $('#cExp').value, cvv = $('#cCvv').value, mes = +exp.slice(0, 2);
  if (!/^\p{L}+( \p{L}+)?$/u.test(nombre)) return 'Nombre: una o dos palabras, solo letras.';
  if (num.length !== 16) return 'El número de tarjeta debe tener 16 dígitos.';
  if (!/^\d{2}\/\d{2}$/.test(exp) || mes < 1 || mes > 12) return 'Fecha inválida: usa MM/AA (4 dígitos, mes 01 a 12).';
  if (!/^\d{3}$/.test(cvv)) return 'El CVV debe tener 3 dígitos.';
  return '';
}
// Límites de longitud en los demás campos (el servidor los vuelve a validar)
$('#loginForm').elements.name.maxLength = 30; $('#loginForm').elements.mail.maxLength = 100;
$('#rName').maxLength = 60; $('#rMail').maxLength = 100; $('#rvText').maxLength = 500; $('#couponIn').maxLength = 30;