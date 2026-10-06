// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PAGÁ RATÓN — Servidor principal v4.0                                    ║
// ║  Persistencia en Firestore (las salas NO se borran al reiniciar Render)  ║
// ║  No modificar este archivo directamente.                                ║
// ║  Toda la configuración va en el archivo .env (ver .env.example)         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

require("dotenv").config();

const express  = require("express");
const crypto   = require("crypto");
const path     = require("path");
const fetch    = require("node-fetch");
// API modular de firebase-admin (la única desde la v14).
const { initializeApp, cert } = require("firebase-admin/app");
const { getAuth }             = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

// Una promesa rechazada que nadie atrapó (por ejemplo, dentro de una librería
// de Google) cerraría el proceso y con él la app entera. Se registra y se sigue.
process.on("unhandledRejection", err => {
  console.error("Promesa rechazada sin manejar:", err?.message || err);
});

const app = express();
// Sin CORS a propósito: la app y la API viven en el mismo dominio, así que
// ningún otro sitio necesita leer estas respuestas.
app.disable("x-powered-by");

// ═══════════════════════════════════════════════════════════════════════════════
// CABECERAS DE SEGURIDAD
// - frame-ancestors / X-Frame-Options: ningún OTRO sitio puede meter la app en un iframe
//   (evita que engañen a alguien para tocar "Eliminar" o "Efectivo").
// - Content-Security-Policy: el navegador solo carga scripts, estilos,
//   iframes y conexiones de los orígenes de esta lista. Aunque se colara un
//   XSS, no podría traer código de otro dominio ni mandar datos afuera.
//   'unsafe-inline' sigue porque toda la app usa onclick en línea.
// - Las violaciones se registran en /api/csp-report (log de auditoría): si un
//   cambio de Google o Firebase bloqueara algo, queda asentado.
// - No se manda Cross-Origin-Opener-Policy: rompería el popup de Google.
// ═══════════════════════════════════════════════════════════════════════════════
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://*.googleusercontent.com",
  "connect-src 'self' https://*.googleapis.com https://apis.google.com https://www.google.com https://*.firebaseio.com https://*.firebaseapp.com",
  "frame-src 'self' https://*.firebaseapp.com https://accounts.google.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "upgrade-insecure-requests",
  "report-uri /api/csp-report",
].join("; ");
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// LÍMITE DE PEDIDOS POR IP (en memoria; alcanza para una sola instancia)
// Render está detrás de Cloudflare: la IP real viene en cf-connecting-ip.
// ═══════════════════════════════════════════════════════════════════════════════
function limitePorIp(maximo, ventanaMs) {
  const hits = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [ip, h] of hits) if (h.hasta <= ahora) hits.delete(ip);
  }, ventanaMs).unref();
  return (req, res, next) => {
    const ip = req.get("cf-connecting-ip") || req.ip || "?";
    const ahora = Date.now();
    let h = hits.get(ip);
    if (!h || h.hasta <= ahora) { h = { n: 0, hasta: ahora + ventanaMs }; hits.set(ip, h); }
    if (++h.n > maximo) {
      res.setHeader("Retry-After", Math.ceil((h.hasta - ahora) / 1000));
      return res.status(429).json({ error: "Demasiados pedidos. Esperá un minuto y volvé a intentar." });
    }
    next();
  };
}
app.use("/api/csp-report",        limitePorIp(30, 60_000));
app.use("/api/rooms/:roomId/pay", limitePorIp(30, 60_000));
app.use("/api/webhook",           limitePorIp(300, 60_000));
app.use("/api/",                  limitePorIp(600, 60_000));

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 0: PROXY DEL MANEJADOR DE AUTENTICACIÓN
//
// Firebase resuelve el login con Google en <proyecto>.firebaseapp.com. Como la
// app vive en otro dominio, ese intercambio es "de terceros", y los navegadores
// móviles (Safari siempre, Chrome cada vez más) particionan ese almacenamiento:
// la persona elige la cuenta, vuelve, y la credencial nunca llega. Falla igual
// con popup que con redirección.
//
// Reenviando /__/auth y /__/firebase desde nuestro propio dominio, todo el
// intercambio queda en un solo origen y el navegador deja de bloquearlo.
// El /api/config de más abajo informa nuestro dominio como authDomain para que
// el SDK apunte acá.
//
// 🔧 FIREBASE_AUTH_DOMAIN sigue siendo el dominio real de Firebase: es el
//    destino del reenvío, no lo que se le informa al navegador.
//
// 🔒 Solo existe con AUTH_HANDLER_PROPIO=true, solo acepta GET y nunca reenvía
//    cookies ni el token de sesión.
// ═══════════════════════════════════════════════════════════════════════════════
if (process.env.AUTH_HANDLER_PROPIO === "true") app.use(["/__/auth", "/__/firebase"], async (req, res) => {
  const upstream = process.env.FIREBASE_AUTH_DOMAIN || "";
  if (!upstream) return res.status(500).send("Falta FIREBASE_AUTH_DOMAIN");
  if (req.method !== "GET" && req.method !== "HEAD") return res.sendStatus(405);
  try {
    const cabeceras = {};
    for (const k of ["accept", "accept-language", "user-agent", "if-none-match", "if-modified-since"]) {
      if (req.headers[k]) cabeceras[k] = req.headers[k];
    }
    const respuesta = await fetch(`https://${upstream}${req.originalUrl}`, {
      method: req.method,
      headers: cabeceras,
      redirect: "manual",
    });
    res.status(respuesta.status);
    for (const [k, v] of Object.entries(respuesta.headers.raw())) {
      if (["content-encoding", "transfer-encoding", "content-length", "connection"].includes(k.toLowerCase())) continue;
      res.setHeader(k, v.length === 1 ? v[0] : v);
    }
    const cuerpo = await respuesta.buffer();
    res.send(cuerpo);
  } catch (err) {
    console.error("Error reenviando el manejador de auth:", err);
    res.status(502).send("No se pudo contactar a Firebase Auth");
  }
});

// Reportes de violaciones de la CSP (los manda el navegador solo).
app.post("/api/csp-report",
  express.json({ type: ["application/csp-report", "application/reports+json", "application/json"], limit: "10kb" }),
  (req, res) => {
    const r = req.body?.["csp-report"] || req.body?.[0]?.body || req.body || {};
    const dato = v => String(v || "").slice(0, 300);
    console.warn("CSP bloqueó:", dato(r["violated-directive"] || r.effectiveDirective), dato(r["blocked-uri"] || r.blockedURL));
    audit("csp_violacion", {
      directiva: dato(r["violated-directive"] || r.effectiveDirective),
      bloqueado: dato(r["blocked-uri"] || r.blockedURL),
      pagina:    dato(r["document-uri"] || r.documentURL).split("?")[0],
    }, req);
    res.sendStatus(204);
  });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT       = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 1: FIREBASE ADMIN + FIRESTORE
// Firestore es donde se guardan TODAS las salas de forma permanente.
// A diferencia del disco de Render (que se borra al reiniciar), Firestore
// mantiene los datos para siempre, asociados a cada usuario.
//
// 🔧 Requiere FIREBASE_SERVICE_ACCOUNT_JSON en tu .env
// 🔧 Requiere tener Firestore habilitado en la consola de Firebase
//    (ver PASO en GUIA_DESPLIEGUE.txt — es un clic)
// ═══════════════════════════════════════════════════════════════════════════════
let db = null; // referencia a Firestore
try {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (b64) {
    // Hosting externo (Render, VPS, local): la clave viaja en una variable.
    const serviceAccount = JSON.parse(Buffer.from(b64, "base64").toString());
    initializeApp({ credential: cert(serviceAccount) });
    console.log("✅ Firebase Admin inicializado con la clave de servicio");
  } else {
    // Cloud Functions / Cloud Run: las credenciales las provee el entorno,
    // así que no hace falta guardar ninguna clave en ninguna variable.
    initializeApp();
    console.log("✅ Firebase Admin inicializado con las credenciales del entorno");
  }
  db = getFirestore();
} catch (e) {
  console.warn("⚠️  Firebase/Firestore NO configurado. La app necesita esto para guardar salas.");
  console.warn("    Detalle:", e.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 1b: CUENTA DE ADMINISTRADOR (panel de usuarios)
//
// 🔧 ESTE REPOSITORIO ES PÚBLICO. Nunca hardcodear acá la contraseña real.
//    ADMIN_SEED_PASSWORD solo se usa UNA VEZ, para crear la cuenta si todavía
//    no existe — después de eso Firebase ya tiene su propia contraseña y esta
//    variable no vuelve a tocarla. Cambiala por una fuerte con "¿Olvidaste la
//    clave?" apenas entres la primera vez. Si falta la variable, la cuenta
//    simplemente no se crea sola (ver el aviso en los logs).
// ═══════════════════════════════════════════════════════════════════════════════
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "infinitysolutions.arg@gmail.com").toLowerCase();
// Sin valor por defecto A PROPÓSITO: este repo es público, así que ninguna
// contraseña real puede vivir en el código. Se configura UNA SOLA VEZ como
// variable de entorno en Render (o en .env local) antes del primer arranque;
// si no está seteada, directamente no se crea la cuenta sola.
const ADMIN_SEED_PASSWORD = process.env.ADMIN_SEED_PASSWORD || "";

// Resultado del último arranque (solo queda en los logs).
let adminBootstrap = "pendiente";

// Mientras ADMIN_SEED_PASSWORD esté cargada, la cuenta admin queda con ESA
// contraseña en cada arranque: si no existe la crea, y si ya existía (por
// ejemplo porque alguna vez se registró ese email desde la app) le pisa la
// contraseña. Así el resultado es siempre predecible.
//
// ⚠️  Por eso, una vez que entres: cambiá la contraseña y BORRÁ la variable
//     de Render. Si la dejás, cada reinicio vuelve a ponerle la de la variable.
async function ensureAdminAccount() {
  if (!db) { adminBootstrap = "sin-firebase"; return; }
  if (!ADMIN_SEED_PASSWORD) {
    adminBootstrap = "sin-variable";
    console.warn("⚠️  Falta ADMIN_SEED_PASSWORD: no se toca la cuenta admin.");
    return;
  }
  try {
    let user = null;
    try { user = await getAuth().getUserByEmail(ADMIN_EMAIL); }
    catch (err) { if (err.code !== "auth/user-not-found") throw err; }

    if (user) {
      await getAuth().updateUser(user.uid, { password: ADMIN_SEED_PASSWORD, disabled: false, emailVerified: true });
      adminBootstrap = "contraseña-actualizada";
      console.log(`✅ Cuenta admin existente (${ADMIN_EMAIL}): contraseña puesta desde ADMIN_SEED_PASSWORD`);
    } else {
      await getAuth().createUser({ email: ADMIN_EMAIL, password: ADMIN_SEED_PASSWORD, emailVerified: true });
      adminBootstrap = "creada";
      console.log(`✅ Cuenta admin creada (${ADMIN_EMAIL})`);
    }
  } catch (err) {
    adminBootstrap = "error: " + (err.code || err.message);
    console.warn("⚠️  No se pudo preparar la cuenta admin:", err.message);
  }
}
ensureAdminAccount();

// Colecciones de Firestore
//   rooms/{roomId}       → cada sala (con su adminUid, participantes, etc.)
//   mpTokens/{uid}       → el token de Mercado Pago conectado por cada admin
//   oauthStates/{state}  → autorizaciones de MP en curso (un solo uso, 10 min)
//   auditLog/{auto}      → registro de acciones sensibles (solo lo escribe el servidor)
const roomsCol   = () => db.collection("rooms");
const tokensCol  = () => db.collection("mpTokens");
const statesCol  = () => db.collection("oauthStates");
const auditCol   = () => db.collection("auditLog");

// ID de sala aleatorio de verdad (crypto, no Math.random): 10 caracteres sin
// letras que se confundan (0/O, 1/I/L).
const ID_ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const makeRoomId = () => Array.from(crypto.randomBytes(10), b => ID_ALFABETO[b % ID_ALFABETO.length]).join("");

// IDs válidos en la URL. Corta de raíz cosas como "a%2Fb" (Express decodifica
// la barra y Firestore la tomaría como una subcolección).
const ID_VALIDO = /^[A-Za-z0-9]{1,32}$/;
for (const nombre of ["id", "roomId", "participantId"]) {
  app.param(nombre, (req, res, next, valor) =>
    ID_VALIDO.test(valor) ? next() : res.status(400).json({ error: "ID inválido" }));
}

// Registro de auditoría: quién hizo qué y desde dónde. Nunca bloquea la
// respuesta y nunca guarda tokens.
function audit(evento, datos = {}, req = null) {
  if (!db) return;
  const ip = req ? (req.get("cf-connecting-ip") || req.ip || "") : "";
  auditCol().add({ evento, ...datos, ip, fecha: new Date().toISOString() })
    .catch(err => console.error("No se pudo escribir el log de auditoría:", err.message));
}

// ─── Middleware: verificar token de Firebase del admin ────────────────────────
async function requireAdmin(req, res, next) {
  if (!db) return res.status(500).json({ error: "Firestore no configurado en el servidor" });
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autorizado — token faltante" });
  try {
    req.idToken = token;
    req.user = await getAuth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// Como requireAdmin, pero además exige que el email coincida con ADMIN_EMAIL.
// Se usa SOLO para el panel de usuarios: tener sesión no alcanza, hay que ser
// el admin del panel.
async function requireSuperAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase();
  // El email solo prueba identidad si está VERIFICADO. El registro con email y
  // contraseña no verifica nada: sin este chequeo, cualquiera podría crear una
  // cuenta con ADMIN_EMAIL (que es público, está en este repo) y ver todo.
  // Entrar con Google lo da por verificado; la cuenta que crea el servidor
  // también.
  if (email !== ADMIN_EMAIL || req.user?.email_verified !== true) {
    audit("panel_admin_denegado", { uid: req.user?.uid || "", email }, req);
    return res.status(403).json({ error: "No tenés permiso para ver esto" });
  }
  // Para el panel también se exige que la sesión no haya sido revocada
  // (cambio de contraseña, cuenta deshabilitada o "cerrar todas las sesiones").
  try {
    await getAuth().verifyIdToken(req.idToken, true);
  } catch {
    return res.status(401).json({ error: "Tu sesión ya no es válida. Volvé a ingresar." });
  }
  next();
}

// Sala para su organizador: todo menos el token de MP.
function safeRoom(room) {
  if (!room) return room;
  const { mpAccessToken, ...rest } = room;
  return rest;
}

// Sala para cualquiera que tenga el link: además se ocultan el uid del
// organizador y los IDs de los pagos.
function publicRoom(room) {
  if (!room) return room;
  const { mpAccessToken, adminUid, ...rest } = room;
  return { ...rest, participants: (rest.participants || []).map(({ paymentId, ...p }) => p) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOKENS DE MERCADO PAGO
// Viven SOLO en mpTokens/{uid}. MP los da con vencimiento (180 días) y un
// refresh_token: se renuevan solos cuando faltan menos de 15 días, sin que el
// organizador tenga que volver a conectar su cuenta.
// ═══════════════════════════════════════════════════════════════════════════════
const MP_TOKEN_VIDA_MS = 180 * 24 * 3600 * 1000;
const MP_RENOVAR_ANTES_MS = 15 * 24 * 3600 * 1000;

// Las conexiones viejas no guardaban expiresAt: se estima desde connectedAt.
const mpVenceEn = data => data.expiresAt || ((Date.parse(data.connectedAt || "") || 0) + MP_TOKEN_VIDA_MS);

async function renovarTokenMp(ref, data) {
  try {
    const r = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     process.env.MP_CLIENT_ID     || "",
        client_secret: process.env.MP_CLIENT_SECRET || "",
        grant_type:    "refresh_token",
        refresh_token: data.refreshToken,
      }),
    });
    const t = await r.json();
    if (!t.access_token) throw new Error(t.message || t.error || `respuesta ${r.status}`);
    const nuevo = {
      ...data,
      accessToken:  t.access_token,
      refreshToken: t.refresh_token || data.refreshToken,
      expiresAt:    Date.now() + (Number(t.expires_in) > 0 ? Number(t.expires_in) * 1000 : MP_TOKEN_VIDA_MS),
      renovadoEn:   new Date().toISOString(),
    };
    await ref.set(nuevo);
    audit("mp_token_renovado", { uid: ref.id, mpUserId: data.userId || "" });
    return nuevo;
  } catch (err) {
    // Se sigue con el token actual: si todavía no venció, cobra igual.
    console.error("No se pudo renovar el token de MP:", err.message);
    audit("mp_token_no_renovado", { uid: ref.id, error: String(err.message).slice(0, 200) });
    return data;
  }
}

// Datos de MP del organizador (renovando el token si hace falta), o null.
const renovacionesEnCurso = new Map();
async function tokenDeOrganizador(uid) {
  const ref = tokensCol().doc(String(uid));
  const snap = await ref.get();
  if (!snap.exists || !snap.data().accessToken) return null;
  const data = snap.data();
  if (!data.refreshToken || mpVenceEn(data) - Date.now() > MP_RENOVAR_ANTES_MS) return data;
  // Una sola renovación a la vez por organizador: el refresh_token es de un uso.
  if (!renovacionesEnCurso.has(uid)) {
    renovacionesEnCurso.set(uid, renovarTokenMp(ref, data).finally(() => renovacionesEnCurso.delete(uid)));
  }
  return renovacionesEnCurso.get(uid);
}

// Credenciales con las que cobra una sala: las del organizador, hoy.
async function credencialesDeSala(room) {
  const data = await tokenDeOrganizador(room.adminUid);
  return data ? [{ accessToken: data.accessToken, userId: String(data.userId || "") }] : [];
}

// Las salas creadas antes de 41e8ce7 guardaban su propia copia del token. Se
// borran una sola vez (queda marcado en meta/migraciones): así "Desconectar"
// corta los cobros de todas las salas y el token no queda repetido.
async function migrarTokensDeSalas() {
  if (!db) return;
  try {
    const marca = db.collection("meta").doc("migraciones");
    const m = await marca.get();
    if (m.exists && m.data().tokensDeSalas) return;
    const snap = await roomsCol().get();
    const conCopia = snap.docs.filter(d => "mpAccessToken" in d.data());
    for (let i = 0; i < conCopia.length; i += 400) {
      const lote = db.batch();
      conCopia.slice(i, i + 400).forEach(d => lote.update(d.ref, { mpAccessToken: FieldValue.delete() }));
      await lote.commit();
    }
    await marca.set({ tokensDeSalas: new Date().toISOString(), salasLimpiadas: conCopia.length }, { merge: true });
    audit("migracion_tokens_de_salas", { salas: conCopia.length });
    console.log(`✅ Migración: se borró la copia del token de MP de ${conCopia.length} sala(s)`);
  } catch (err) {
    console.error("⚠️  Migración de tokens de salas pendiente:", err.message);
  }
}
migrarTokensDeSalas();

// Marca un participante como pagado dentro de una transacción: si llegan dos
// pagos juntos, ninguno pisa al otro.
async function marcarPagado(ref, participantId, paymentId) {
  return db.runTransaction(async t => {
    const snap = await t.get(ref);
    if (!snap.exists) return null;
    const room = snap.data();
    const participants = room.participants.map(p =>
      p.id === participantId && !p.paid
        ? { ...p, paid: true, paymentId, paidAt: new Date().toISOString() } : p);
    t.update(ref, { participants });
    return { ...room, participants };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 3: CONFIG PÚBLICA + OBTENER SALA (rutas públicas)
// ═══════════════════════════════════════════════════════════════════════════════

// Config pública de Firebase para el frontend (login)
app.get("/api/config", (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || "",
    // Con AUTH_HANDLER_PROPIO=true informamos NUESTRO dominio y el login con
    // Google queda en un solo origen (lo sirve el proxy de más arriba), que es
    // lo que necesitan los navegadores móviles.
    //
    // ⚠️  Requiere haber agregado antes, en Google Cloud → Credenciales →
    //     el cliente OAuth web del proyecto, este URI de redirección:
    //         https://<nuestro-dominio>/__/auth/handler
    //     Sin eso Google responde 400 redirect_uri_mismatch y NADIE entra.
    authDomain: process.env.AUTH_HANDLER_PROPIO === "true"
      ? (req.get("host") || process.env.FIREBASE_AUTH_DOMAIN || "")
      : (process.env.FIREBASE_AUTH_DOMAIN || ""),
    projectId:  process.env.FIREBASE_PROJECT_ID  || "",
  });
});

// Obtener una sala por su ID (público — los participantes la usan sin login)
app.get("/api/rooms/:id", async (req, res) => {
  try {
    const doc = await roomsCol().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });
    res.json(publicRoom(doc.data()));
  } catch (err) {
    console.error("Error obteniendo sala:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 4: MERCADO PAGO OAUTH (conectar la cuenta del admin)
// 🔧 Requiere MP_CLIENT_ID y MP_CLIENT_SECRET en .env
// ═══════════════════════════════════════════════════════════════════════════════

// Genera la URL de autorización de MP.
//
// 🔒 El "state" es un valor aleatorio de un solo uso guardado en el servidor,
//    NO el uid. Antes era el uid (que además era público), y cualquiera podía
//    terminar una autorización con SU cuenta de MP poniendo el uid de otro
//    organizador: los cobros de esa persona pasaban a su cuenta.
const STATE_VIGENCIA_MS = 10 * 60 * 1000;
app.get("/api/mp-oauth/url", requireAdmin, async (req, res) => {
  const clientId = process.env.MP_CLIENT_ID || "";
  if (!clientId) return res.status(500).json({ error: "MP_CLIENT_ID no configurado en .env" });
  try {
    const state = crypto.randomBytes(32).toString("hex");
    await statesCol().doc(state).set({ uid: req.user.uid, expiresAt: Date.now() + STATE_VIGENCIA_MS });
    // Pedimos los permisos necesarios para cobrar en nombre del admin.
    // offline_access → devuelve un refresh_token para que la conexión no expire.
    const params = new URLSearchParams({
      client_id: clientId, response_type: "code", platform_id: "mp",
      scope: "offline_access read write",
      redirect_uri: `${PUBLIC_URL}/api/mp-oauth/callback`,
      state,
    });
    res.json({ url: `https://auth.mercadopago.com/authorization?${params}` });
  } catch (err) {
    console.error("Error preparando OAuth MP:", err);
    res.status(500).json({ error: "No se pudo iniciar la conexión con Mercado Pago" });
  }
});

// Toma el state y lo borra en la misma transacción: sirve una sola vez.
// Devuelve el uid que lo pidió, o null si no existe o venció.
async function consumirState(state) {
  if (typeof state !== "string" || !/^[a-f0-9]{64}$/.test(state)) return null;
  try {
    return await db.runTransaction(async t => {
      const ref = statesCol().doc(state);
      const snap = await t.get(ref);
      if (!snap.exists) return null;
      t.delete(ref);
      const { uid, expiresAt } = snap.data();
      return expiresAt > Date.now() ? uid : null;
    });
  } catch { return null; }
}

// Callback de MP: intercambia el código por el token del admin y lo guarda en Firestore
app.get("/api/mp-oauth/callback", async (req, res) => {
  const { code } = req.query;
  if (typeof code !== "string" || !code) return res.redirect(`/?mp_error=no_code`);
  // El uid sale del state guardado por NOSOTROS, nunca de la URL.
  const adminUid = db ? await consumirState(req.query.state) : null;
  if (!adminUid) {
    audit("oauth_state_invalido", {}, req);
    return res.redirect(`/?mp_error=state_invalido`);
  }
  try {
    const response = await fetch("https://api.mercadopago.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     process.env.MP_CLIENT_ID     || "",
        client_secret: process.env.MP_CLIENT_SECRET || "",
        code,
        grant_type:    "authorization_code",
        redirect_uri:  `${PUBLIC_URL}/api/mp-oauth/callback`,
      }),
    });
    const tokenData = await response.json();
    if (!tokenData.access_token) throw new Error("Token inválido de MP");

    const userRes  = await fetch(`https://api.mercadopago.com/users/me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    // Si ya había otra cuenta de MP conectada, queda registrado el cambio.
    const anterior = await tokensCol().doc(String(adminUid)).get();
    const userIdAnterior = anterior.exists ? String(anterior.data().userId || "") : "";
    const userId = String(tokenData.user_id || "");

    // Guardamos el token del admin en Firestore (persistente)
    await tokensCol().doc(String(adminUid)).set({
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token || null, // para renovar sin re-autorizar
      expiresAt:    Date.now() + (Number(tokenData.expires_in) > 0 ? Number(tokenData.expires_in) * 1000 : MP_TOKEN_VIDA_MS),
      userId,
      // Nunca el email como respaldo: este nombre se muestra a los invitados.
      nickname:     userData.nickname || "tu cuenta",
      connectedAt:  new Date().toISOString(),
    });
    audit(userIdAnterior && userIdAnterior !== userId ? "mp_cuenta_cambiada" : "mp_conectado",
      { uid: adminUid, mpUserId: userId, mpUserIdAnterior: userIdAnterior, nickname: userData.nickname || "" }, req);

    res.redirect(`/?mp_connected=true`);
  } catch (err) {
    console.error("Error en OAuth MP:", err);
    res.redirect(`/?mp_error=oauth_failed`);
  }
});

// Estado de conexión con MP del admin autenticado
app.get("/api/mp-oauth/status", requireAdmin, async (req, res) => {
  try {
    // Cada vez que el organizador abre la app se aprovecha para renovar el
    // token si está por vencer.
    const data = await tokenDeOrganizador(req.user.uid);
    if (data) res.json({ connected: true, nickname: data.nickname });
    else      res.json({ connected: false });
  } catch {
    res.json({ connected: false });
  }
});

// Desconectar MP
app.post("/api/mp-oauth/disconnect", requireAdmin, async (req, res) => {
  try { await tokensCol().doc(req.user.uid).delete(); } catch {}
  audit("mp_desconectado", { uid: req.user.uid }, req);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 5: SALAS DEL ADMIN (rutas protegidas)
// ═══════════════════════════════════════════════════════════════════════════════

// Listar TODAS las salas del admin autenticado (persisten para siempre en Firestore)
// ═══════════════════════════════════════════════════════════════════════════════
// PANEL ADMIN: todas las personas que se registraron en la app.
// Junta Firebase Auth (identidad) con Firestore (cuántas salas armó cada una
// y si conectó su Mercado Pago), para que el panel diga algo útil y no solo
// una lista de emails.
// ═══════════════════════════════════════════════════════════════════════════════
app.get("/api/admin/users", requireAdmin, requireSuperAdmin, async (req, res) => {
  audit("panel_admin", { uid: req.user.uid, email: req.user.email }, req);
  try {
    // listUsers pagina de a 1000; juntamos varias páginas por si hiciera falta.
    let users = [], pageToken;
    for (let i = 0; i < 10; i++) {
      const page = await getAuth().listUsers(1000, pageToken);
      users = users.concat(page.users);
      pageToken = page.pageToken;
      if (!pageToken) break;
    }

    const [roomsSnap, tokensSnap] = await Promise.all([roomsCol().get(), tokensCol().get()]);
    const roomsByUid = {};
    roomsSnap.forEach(doc => {
      const uid = doc.data().adminUid;
      if (uid) roomsByUid[uid] = (roomsByUid[uid] || 0) + 1;
    });
    const mpByUid = {};
    tokensSnap.forEach(doc => { mpByUid[doc.id] = doc.data().nickname || ""; });

    const data = users
      .map(u => ({
        uid: u.uid,
        email: u.email || "",
        displayName: u.displayName || "",
        photoURL: u.photoURL || "",
        provider: u.providerData.map(p =>
          p.providerId === "google.com" ? "Google" : p.providerId === "password" ? "Email" : p.providerId
        ).join(" + ") || "—",
        createdAt: u.metadata.creationTime,
        lastSignIn: u.metadata.lastSignInTime || null,
        disabled: !!u.disabled,
        roomsCreated: roomsByUid[u.uid] || 0,
        mpConnected: Object.prototype.hasOwnProperty.call(mpByUid, u.uid),
        mpNickname: mpByUid[u.uid] || "",
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(data);
  } catch (err) {
    console.error("Error listando usuarios:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

app.get("/api/rooms", requireAdmin, async (req, res) => {
  try {
    const snap = await roomsCol().where("adminUid", "==", req.user.uid).get();
    const rooms = snap.docs
      .map(d => safeRoom(d.data()))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(rooms);
  } catch (err) {
    console.error("Error listando salas:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Valida lo que llega para crear una sala. Devuelve { sala } o { error }.
// Los límites coinciden con los del formulario (60 y 30 caracteres).
function validarSala(body) {
  const { title, total, participants } = body || {};
  const titulo = typeof title === "string" ? title.trim() : "";
  const monto  = Number(total);
  const nombres = Array.isArray(participants)
    ? participants.map(n => typeof n === "string" ? n.trim() : "") : [];
  if (!titulo || titulo.length > 60) return { error: "El nombre de la sala tiene que tener entre 1 y 60 caracteres." };
  if (!Number.isInteger(monto) || monto < 1 || monto > 100_000_000) return { error: "El total tiene que ser un número entero válido." };
  if (nombres.length < 2 || nombres.length > 100) return { error: "Tiene que haber entre 2 y 100 personas." };
  if (nombres.some(n => !n || n.length > 30)) return { error: "Hay un nombre vacío o de más de 30 caracteres." };
  if (new Set(nombres).size !== nombres.length) return { error: "Hay nombres repetidos." };
  if (Math.round(monto / nombres.length) < 1) return { error: "El total es muy chico para dividirlo entre tantas personas." };
  return { sala: { title: titulo, total: monto, participants: nombres } };
}

// Crear sala (queda guardada en Firestore, asociada al admin)
app.post("/api/rooms", requireAdmin, async (req, res) => {
  const { sala, error } = validarSala(req.body);
  if (error) return res.status(400).json({ error });
  const { title, total, participants } = sala;
  try {
    const uid = req.user.uid;
    const id  = makeRoomId();

    // Recuperamos el token de MP del admin (si conectó su cuenta)
    const tokenDoc = await tokensCol().doc(uid).get();
    const mpToken  = tokenDoc.exists ? tokenDoc.data().accessToken : null;
    const mpAlias  = tokenDoc.exists ? tokenDoc.data().nickname    : "";

    // Una sala sin token quedaría sin forma de cobrar (y antes se colaba al
    // token del servidor). Se corta acá, que es donde se puede explicar.
    if (!mpToken) {
      return res.status(409).json({
        error: "Conectá tu cuenta de Mercado Pago antes de crear una sala: los pagos se acreditan directo en tu cuenta.",
      });
    }

    // El token de MP NO se copia a la sala: vive solo en mpTokens/{uid} y se
    // busca al cobrar. Así "Desconectar" desconecta de verdad.
    const room = {
      id, title, total,
      mpAlias,
      adminUid:      uid,
      createdAt:     new Date().toISOString(),
      participants:  participants.map((name, i) => ({
        id: String(i + 1), name, paid: false, paymentId: null, paidAt: null,
      })),
    };
    // create() falla si el ID ya existe, en vez de pisar la sala de otro.
    await roomsCol().doc(id).create(room);
    audit("sala_creada", { uid, sala: id }, req);
    res.json({ ...safeRoom(room), shareUrl: `${PUBLIC_URL}/?room=${id}` });
  } catch (err) {
    console.error("Error creando sala:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Actualizar alias mostrado de la sala
app.patch("/api/rooms/:id/alias", requireAdmin, async (req, res) => {
  try {
    const ref = roomsCol().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });
    if (doc.data().adminUid !== req.user.uid) return res.status(403).json({ error: "No autorizado" });
    const alias = typeof req.body.alias === "string" ? req.body.alias.trim() : "";
    if (alias.length > 60) return res.status(400).json({ error: "El alias es muy largo" });
    await ref.update({ mpAlias: alias });
    const updated = (await ref.get()).data();
    res.json(safeRoom(updated));
  } catch (err) {
    console.error("Error actualizando alias:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// Marcar participante como pagado en efectivo (solo admin)
// ═══════════════════════════════════════════════════════════════════════════════
// Eliminar una sala.
// Solo la puede borrar el admin que la creó, y solo mientras NADIE haya pagado:
// en cuanto entra un pago, la sala queda como constancia de ese cobro.
// ═══════════════════════════════════════════════════════════════════════════════
app.delete("/api/rooms/:id", requireAdmin, async (req, res) => {
  try {
    const ref = roomsCol().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });

    const room = doc.data();
    if (room.adminUid !== req.user.uid)
      return res.status(403).json({ error: "Esta sala no es tuya" });

    const conPagos = Array.isArray(room.participants) && room.participants.some(p => p.paid);
    if (conPagos)
      return res.status(409).json({
        error: "Esta sala ya tiene pagos registrados: queda como constancia y no se puede eliminar.",
      });

    await ref.delete();
    audit("sala_borrada", { uid: req.user.uid, sala: req.params.id, titulo: room.title }, req);
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    console.error("Error eliminando sala:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

app.post("/api/rooms/:roomId/mark-paid/:participantId", requireAdmin, async (req, res) => {
  try {
    const ref = roomsCol().doc(req.params.roomId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });
    if (doc.data().adminUid !== req.user.uid) return res.status(403).json({ error: "No autorizado" });
    const room = await marcarPagado(ref, req.params.participantId, "efectivo");
    if (!room) return res.status(404).json({ error: "Sala no encontrada" });
    audit("pago_efectivo", { uid: req.user.uid, sala: req.params.roomId, participante: req.params.participantId }, req);
    res.json(safeRoom(room));
  } catch (err) {
    console.error("Error marcando pago:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 6: PAGO CON MERCADO PAGO (público — lo llama el participante)
// El pago va directo a la cuenta del admin (su token guardado en la sala).
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/rooms/:roomId/pay/:participantId", async (req, res) => {
  try {
    const doc = await roomsCol().doc(req.params.roomId).get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });
    const room = doc.data();
    const p = room.participants.find(x => x.id === req.params.participantId);
    if (!p)     return res.status(404).json({ error: "Participante no encontrado" });
    if (p.paid) return res.status(400).json({ error: "Ya pagó" });

    const amount = Math.round(room.total / room.participants.length);

    // ⚠️  Sin respaldo al token del servidor A PROPÓSITO. Si el organizador no
    //     tiene su Mercado Pago conectado, cobrar con el del servidor mandaría
    //     la plata de estos invitados a la cuenta equivocada. Mejor fallar.
    const [cred] = await credencialesDeSala(room);
    const tokenToUse = cred?.accessToken || "";
    if (!tokenToUse) {
      return res.status(409).json({
        error: "El organizador de esta sala todavía no conectó su Mercado Pago. Pedile que lo haga y volvé a intentar.",
      });
    }
    const mpClient = new MercadoPagoConfig({ accessToken: tokenToUse });

    const preference = new Preference(mpClient);
    const result     = await preference.create({
      body: {
        items: [{
          title: `${room.title} — parte de ${p.name}`,
          quantity: 1, unit_price: amount, currency_id: "ARS",
        }],
        external_reference: `${room.id}:${p.id}`,
        // 📡 WEBHOOK: incluimos el roomId en la URL para que la verificación
        // use el token del admin de ESA sala (crítico para multi-usuario)
        notification_url: `${PUBLIC_URL}/api/webhook?roomId=${encodeURIComponent(room.id)}`,
        back_urls: {
          success: `${PUBLIC_URL}/?room=${room.id}&pago=ok`,
          failure: `${PUBLIC_URL}/?room=${room.id}&pago=error`,
          pending: `${PUBLIC_URL}/?room=${room.id}&pago=pendiente`,
        },
        auto_return: "approved",
      },
    });
    res.json({ init_point: result.init_point });
  } catch (err) {
    console.error("Error creando preferencia MP:", err);
    res.status(500).json({ error: "No se pudo generar el link de pago" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 7: WEBHOOK DE MERCADO PAGO (confirma pagos automáticamente)
// Actualiza la sala en Firestore cuando MP confirma un pago.
//
// 🔒 Reglas (antes no existían y se podía marcar como pagado a alguien de
//    OTRA sala pagándose a uno mismo):
//    - La sala es la de la URL y la referencia del pago tiene que ser ESA sala.
//    - El pago se consulta solo con el token del organizador de esa sala
//      (nunca con el del servidor).
//    - El cobro tiene que haber ido a la cuenta de MP de ese organizador, en
//      pesos y por el monto de la cuota.
//    - Firma x-signature (panel de MP → Webhooks → clave secreta), en dos pasos:
//        1. MP_WEBHOOK_SECRET sola: se verifica y se anota en auditLog
//           ("webhook_firma", valida true/false), pero NO se rechaza nada.
//           Sirve para confirmar que MP firma los avisos de la notification_url
//           de cada pago antes de depender de eso.
//        2. Además MP_WEBHOOK_FIRMA_OBLIGATORIA=true: sin firma válida → 401.
//      Las otras reglas de arriba ya frenan los pagos falsos; la firma suma
//      que nadie más que MP pueda siquiera disparar el webhook.
// ═══════════════════════════════════════════════════════════════════════════════
function firmaWebhookValida(req, secreto) {
  const partes = {};
  for (const p of String(req.get("x-signature") || "").split(",")) {
    const [k, v] = p.split("=").map(s => (s || "").trim());
    if (k && v) partes[k] = v;
  }
  if (!partes.ts || !partes.v1) return false;
  // Formato de MP: id:<data.id>;request-id:<x-request-id>;ts:<ts>; (se omite lo que no venga)
  const dataId = String(req.query["data.id"] || "").toLowerCase();
  const reqId  = req.get("x-request-id") || "";
  const manifest = (dataId ? `id:${dataId};` : "") + (reqId ? `request-id:${reqId};` : "") + `ts:${partes.ts};`;
  const esperado = Buffer.from(crypto.createHmac("sha256", secreto).update(manifest).digest("hex"));
  const recibido = Buffer.from(partes.v1);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

app.post("/api/webhook", async (req, res) => {
  const secreto = process.env.MP_WEBHOOK_SECRET || "";
  if (secreto) {
    const valida = firmaWebhookValida(req, secreto);
    audit("webhook_firma", {
      valida, conFirma: !!req.get("x-signature"),
      tipo: String(req.query.type || req.query.topic || req.body?.type || "").slice(0, 40),
      conSala: !!req.query.roomId,
    }, req);
    if (!valida && process.env.MP_WEBHOOK_FIRMA_OBLIGATORIA === "true") return res.sendStatus(401);
  }
  try {
    const topic     = req.query.topic || req.query.type || req.body?.type;
    const paymentId = String(req.query["data.id"] || req.body?.data?.id || "");
    const roomId    = String(req.query.roomId || "");
    // Avisos que no son de pagos (o sin sala) no tienen nada que hacer acá.
    if (topic !== "payment" || !/^\d{1,24}$/.test(paymentId) || !ID_VALIDO.test(roomId))
      return res.sendStatus(200);

    const ref  = roomsCol().doc(roomId);
    const snap = await ref.get();
    if (!snap.exists) return res.sendStatus(200);
    const room = snap.data();

    // Consultamos el pago con el token de ESTE organizador (y nada más).
    let info = null, cred = null;
    for (const c of await credencialesDeSala(room)) {
      try { info = await new Payment(new MercadoPagoConfig({ accessToken: c.accessToken })).get({ id: paymentId }); cred = c; break; }
      catch { /* probar con la siguiente credencial del mismo organizador */ }
    }
    if (!info) {
      audit("webhook_rechazado", { motivo: "pago_no_visible_para_el_organizador", sala: roomId, pago: paymentId }, req);
      return res.sendStatus(200);
    }
    if (info.status !== "approved") return res.sendStatus(200);

    const [refRoom, participantId] = String(info.external_reference || "").split(":");
    const participante = room.participants.find(p => p.id === participantId);
    const cuota = Math.round(room.total / room.participants.length);
    const motivo =
        refRoom !== room.id                                   ? "referencia_de_otra_sala"
      : !participante                                         ? "participante_inexistente"
      : cred.userId && info.collector_id != null && String(info.collector_id) !== cred.userId
                                                              ? "cobro_a_otra_cuenta"
      : info.currency_id !== "ARS"                            ? "moneda"
      : !(Number(info.transaction_amount) >= cuota)           ? "monto_menor"
      : null;
    if (motivo) {
      audit("webhook_rechazado", { motivo, sala: roomId, pago: paymentId, referencia: String(info.external_reference || "") }, req);
      return res.sendStatus(200);
    }

    await marcarPagado(ref, participantId, paymentId);
    audit("pago_confirmado", { sala: roomId, participante: participantId, pago: paymentId, monto: info.transaction_amount }, req);
    console.log(`✅ Pago confirmado en Firestore: sala ${roomId} — participante ${participantId}`);
    res.sendStatus(200);
  } catch (err) {
    // 500 → Mercado Pago reintenta más tarde (antes se respondía 200 de entrada
    // y un error dejaba el pago sin marcar para siempre).
    console.error("Error en webhook MP:", err.message);
    res.sendStatus(500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ARRANQUE
// Ejecutado directo (`node server.js` en Render, en un VPS o en local) levanta
// el servidor. Importado desde index.js (Cloud Functions) NO llama a listen():
// de escuchar se encarga el runtime.
// ═══════════════════════════════════════════════════════════════════════════════
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 Pagá Ratón corriendo en puerto ${PORT}`);
    console.log(`🌐 URL: ${PUBLIC_URL}`);
    console.log(`\nEstado de configuración:`);
    console.log(`  Firestore:  ${db ? "✅ conectado (salas persistentes)" : "❌ FALTA — las salas no se guardarán"}`);
    console.log(`  MP OAuth:   ${process.env.MP_CLIENT_ID ? "✅" : "❌ falta MP_CLIENT_ID"}`);
    console.log(`  Firma MP:   ${!process.env.MP_WEBHOOK_SECRET ? "⚠️  falta MP_WEBHOOK_SECRET (no se verifica)"
      : process.env.MP_WEBHOOK_FIRMA_OBLIGATORIA === "true" ? "✅ se exige x-signature" : "👀 se verifica y se anota, sin rechazar"}\n`);
  });
}

module.exports = app;
