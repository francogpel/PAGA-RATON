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
// ═══════════════════════════════════════════════════════════════════════════════
app.use(["/__/auth", "/__/firebase"], async (req, res) => {
  const upstream = process.env.FIREBASE_AUTH_DOMAIN || "";
  if (!upstream) return res.status(500).send("Falta FIREBASE_AUTH_DOMAIN");
  try {
    const cabeceras = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (["host", "connection", "content-length", "accept-encoding"].includes(k)) continue;
      cabeceras[k] = v;
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
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ Firebase Admin inicializado con la clave de servicio");
  } else {
    // Cloud Functions / Cloud Run: las credenciales las provee el entorno,
    // así que no hace falta guardar ninguna clave en ninguna variable.
    admin.initializeApp();
    console.log("✅ Firebase Admin inicializado con las credenciales del entorno");
  }
  db = admin.firestore();
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

    // Una sala sin token quedaría sin forma de cobrar (y antes se colaba al
    // token del servidor). Se corta acá, que es donde se puede explicar.
    if (!mpToken) {
      return res.status(409).json({
        error: "Conectá tu cuenta de Mercado Pago antes de crear una sala: los pagos se acreditan directo en tu cuenta.",
      });
    }

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

    const amount = Math.round(room.total / room.participants.length);

    // ⚠️  Sin respaldo al token del servidor A PROPÓSITO. Si esta sala no tiene
    //     el token de su propio admin, cobrar con el del servidor mandaría la
    //     plata de estos invitados a la cuenta equivocada. Mejor fallar.
    const tokenToUse = room.mpAccessToken || "";
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
    console.log(`  MP Token:   ${process.env.MP_ACCESS_TOKEN ? "✅" : "❌ falta MP_ACCESS_TOKEN"}`);
    console.log(`  MP OAuth:   ${process.env.MP_CLIENT_ID ? "✅" : "❌ falta MP_CLIENT_ID"}\n`);
  });
}

module.exports = app;
