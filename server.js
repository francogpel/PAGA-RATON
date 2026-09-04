// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  PAGÁ RATÓN — Servidor principal v4.0                                    ║
// ║  Persistencia en Firestore (las salas NO se borran al reiniciar Render)  ║
// ║  No modificar este archivo directamente.                                ║
// ║  Toda la configuración va en el archivo .env (ver .env.example)         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

require("dotenv").config();

const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fetch    = require("node-fetch");
const admin    = require("firebase-admin");
const { MercadoPagoConfig, Preference, Payment } = require("mercadopago");

const app = express();
app.use(cors());
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
  const raw            = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "", "base64").toString();
  const serviceAccount = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log("✅ Firebase Admin + Firestore inicializados");
} catch (e) {
  console.warn("⚠️  Firebase/Firestore NO configurado. La app necesita esto para guardar salas.");
  console.warn("    Detalle:", e.message);
}

// Colecciones de Firestore
//   rooms/{roomId}     → cada sala (con su adminUid, participantes, etc.)
//   mpTokens/{uid}     → el token de Mercado Pago conectado por cada admin
const roomsCol   = () => db.collection("rooms");
const tokensCol  = () => db.collection("mpTokens");
const makeRoomId = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 2: MERCADO PAGO (token del servidor — fallback)
// 🔧 MP_ACCESS_TOKEN: token de tu cuenta de MP (credenciales en el panel de MP)
// ═══════════════════════════════════════════════════════════════════════════════
const defaultMpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN || ""
});

// ─── Middleware: verificar token de Firebase del admin ────────────────────────
async function requireAdmin(req, res, next) {
  if (!db) return res.status(500).json({ error: "Firestore no configurado en el servidor" });
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No autorizado — token faltante" });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

// Quita el token de MP antes de mandar la sala al cliente (seguridad)
function safeRoom(room) {
  if (!room) return room;
  const { mpAccessToken, ...rest } = room;
  return rest;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 3: CONFIG PÚBLICA + OBTENER SALA (rutas públicas)
// ═══════════════════════════════════════════════════════════════════════════════

// Config pública de Firebase para el frontend (login)
app.get("/api/config", (req, res) => {
  res.json({
    apiKey:     process.env.FIREBASE_API_KEY     || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId:  process.env.FIREBASE_PROJECT_ID  || "",
  });
});

// Obtener una sala por su ID (público — los participantes la usan sin login)
app.get("/api/rooms/:id", async (req, res) => {
  try {
    const doc = await roomsCol().doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });
    res.json(safeRoom(doc.data()));
  } catch (err) {
    console.error("Error obteniendo sala:", err);
    res.status(500).json({ error: "Error del servidor" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 4: MERCADO PAGO OAUTH (conectar la cuenta del admin)
// 🔧 Requiere MP_CLIENT_ID y MP_CLIENT_SECRET en .env
// ═══════════════════════════════════════════════════════════════════════════════

// Genera la URL de autorización de MP
app.get("/api/mp-oauth/url", requireAdmin, (req, res) => {
  const clientId    = process.env.MP_CLIENT_ID || "";
  const redirectUri = encodeURIComponent(`${PUBLIC_URL}/api/mp-oauth/callback`);
  const state       = req.user.uid; // para saber a qué admin guardar el token
  if (!clientId) return res.status(500).json({ error: "MP_CLIENT_ID no configurado en .env" });
  // Pedimos los permisos necesarios para cobrar en nombre del admin.
  // offline_access → devuelve un refresh_token para que la conexión no expire.
  const scope = encodeURIComponent("offline_access read write");
  const url = `https://auth.mercadopago.com/authorization?` +
    `client_id=${clientId}&response_type=code&platform_id=mp` +
    `&scope=${scope}` +
    `&redirect_uri=${redirectUri}&state=${state}`;
  res.json({ url });
});

// Callback de MP: intercambia el código por el token del admin y lo guarda en Firestore
app.get("/api/mp-oauth/callback", async (req, res) => {
  const { code, state: adminUid } = req.query;
  if (!code || !adminUid) return res.redirect(`/?mp_error=no_code`);
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

    // Guardamos el token del admin en Firestore (persistente)
    await tokensCol().doc(String(adminUid)).set({
      accessToken:  tokenData.access_token,
      refreshToken: tokenData.refresh_token || null, // para renovar sin re-autorizar
      userId:       String(tokenData.user_id || ""),
      nickname:     userData.nickname || userData.email || "tu cuenta",
      connectedAt:  new Date().toISOString(),
    });

    res.redirect(`/?mp_connected=true`);
  } catch (err) {
    console.error("Error en OAuth MP:", err);
    res.redirect(`/?mp_error=oauth_failed`);
  }
});

// Estado de conexión con MP del admin autenticado
app.get("/api/mp-oauth/status", requireAdmin, async (req, res) => {
  try {
    const doc = await tokensCol().doc(req.user.uid).get();
    if (doc.exists) res.json({ connected: true, nickname: doc.data().nickname });
    else            res.json({ connected: false });
  } catch {
    res.json({ connected: false });
  }
});

// Desconectar MP
app.post("/api/mp-oauth/disconnect", requireAdmin, async (req, res) => {
  try { await tokensCol().doc(req.user.uid).delete(); } catch {}
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLOQUE 5: SALAS DEL ADMIN (rutas protegidas)
// ═══════════════════════════════════════════════════════════════════════════════

// Listar TODAS las salas del admin autenticado (persisten para siempre en Firestore)
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

// Crear sala (queda guardada en Firestore, asociada al admin)
app.post("/api/rooms", requireAdmin, async (req, res) => {
  const { title, total, participants } = req.body;
  if (!title || !total || !Array.isArray(participants) || participants.length < 2)
    return res.status(400).json({ error: "Datos incompletos" });
  try {
    const uid = req.user.uid;
    const id  = makeRoomId();

    // Recuperamos el token de MP del admin (si conectó su cuenta)
    const tokenDoc = await tokensCol().doc(uid).get();
    const mpToken  = tokenDoc.exists ? tokenDoc.data().accessToken : null;
    const mpAlias  = tokenDoc.exists ? tokenDoc.data().nickname    : "";

    const room = {
      id, title, total,
      mpAlias,
      mpAccessToken: mpToken || null, // guardado pero nunca enviado al cliente
      adminUid:      uid,
      createdAt:     new Date().toISOString(),
      participants:  participants.map((name, i) => ({
        id: String(i + 1), name, paid: false, paymentId: null, paidAt: null,
      })),
    };
    await roomsCol().doc(id).set(room);
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
    await ref.update({ mpAlias: (req.body.alias || "").trim() });
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
// Solo la puede borrar el admin que la creó, y solo mientras siga ABIERTA:
// una vez que pagaron todos, la sala queda como constancia y no se elimina.
// ═══════════════════════════════════════════════════════════════════════════════
app.delete("/api/rooms/:id", requireAdmin, async (req, res) => {
  try {
    const ref = roomsCol().doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Sala no encontrada" });

    const room = doc.data();
    if (room.adminUid !== req.user.uid)
      return res.status(403).json({ error: "Esta sala no es tuya" });

    const cerrada = Array.isArray(room.participants) && room.participants.length > 0
      && room.participants.every(p => p.paid);
    if (cerrada)
      return res.status(409).json({
        error: "La sala está cerrada: queda como constancia de que pagaron todos.",
      });

    await ref.delete();
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
    const room = doc.data();
    if (room.adminUid !== req.user.uid) return res.status(403).json({ error: "No autorizado" });
    const participants = room.participants.map(p =>
      p.id === req.params.participantId
        ? { ...p, paid: true, paymentId: "efectivo", paidAt: new Date().toISOString() }
        : p
    );
    await ref.update({ participants });
    res.json(safeRoom({ ...room, participants }));
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

    const amount     = Math.round(room.total / room.participants.length);
    const tokenToUse = room.mpAccessToken || process.env.MP_ACCESS_TOKEN || "";
    const mpClient   = new MercadoPagoConfig({ accessToken: tokenToUse });

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
        notification_url: `${PUBLIC_URL}/api/webhook?roomId=${room.id}`,
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
// ═══════════════════════════════════════════════════════════════════════════════
app.post("/api/webhook", async (req, res) => {
  res.sendStatus(200); // responder rápido siempre
  try {
    const topic     = req.query.topic || req.query.type || req.body?.type;
    const paymentId = req.query["data.id"] || req.body?.data?.id;
    if (topic !== "payment" || !paymentId) return;

    // El roomId viene en la URL del webhook (lo pusimos al crear la preferencia).
    // Lo necesitamos ANTES de verificar, para usar el token del admin correcto.
    const roomIdFromQuery = req.query.roomId || null;

    // Función que verifica el pago con un token dado
    async function getPaymentInfo(accessToken) {
      const client  = accessToken ? new MercadoPagoConfig({ accessToken }) : defaultMpClient;
      const payment = new Payment(client);
      return payment.get({ id: paymentId });
    }

    let info = null;
    let room = null;
    let ref  = null;

    if (roomIdFromQuery) {
      // Camino principal: cargamos la sala y verificamos con SU token
      ref = roomsCol().doc(roomIdFromQuery);
      const doc = await ref.get();
      if (doc.exists) {
        room = doc.data();
        try {
          info = await getPaymentInfo(room.mpAccessToken || process.env.MP_ACCESS_TOKEN);
        } catch (e) {
          // fallback: intentar con el token del servidor
          info = await getPaymentInfo(process.env.MP_ACCESS_TOKEN);
        }
      }
    }
    if (!info) {
      // Camino de respaldo (webhooks viejos sin roomId): token del servidor
      info = await getPaymentInfo(process.env.MP_ACCESS_TOKEN);
    }
    if (!info || info.status !== "approved") return;

    // Identificar sala y participante desde la referencia del pago
    const [roomId, participantId] = (info.external_reference || "").split(":");
    if (!room || room.id !== roomId) {
      ref = roomsCol().doc(roomId);
      const doc = await ref.get();
      if (!doc.exists) return;
      room = doc.data();
    }

    const participants = room.participants.map(p =>
      p.id === participantId && !p.paid
        ? { ...p, paid: true, paymentId: String(paymentId), paidAt: new Date().toISOString() }
        : p
    );
    await ref.update({ participants });
    console.log(`✅ Pago confirmado en Firestore: ${room.title} — participante ${participantId}`);
  } catch (err) {
    console.error("Error en webhook MP:", err);
  }
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Pagá Ratón corriendo en puerto ${PORT}`);
  console.log(`🌐 URL: ${PUBLIC_URL}`);
  console.log(`\nEstado de configuración:`);
  console.log(`  Firestore:  ${db ? "✅ conectado (salas persistentes)" : "❌ FALTA — las salas no se guardarán"}`);
  console.log(`  MP Token:   ${process.env.MP_ACCESS_TOKEN ? "✅" : "❌ falta MP_ACCESS_TOKEN"}`);
  console.log(`  MP OAuth:   ${process.env.MP_CLIENT_ID ? "✅" : "❌ falta MP_CLIENT_ID"}\n`);
});
