// ═══════════════════════════════════════════════════════════════════════════════
//  PUNTO DE ENTRADA PARA CLOUD FUNCTIONS
//  Envuelve el mismo Express de server.js en una función HTTP de 2ª generación
//  (que por debajo corre sobre Cloud Run). Firebase Hosting redirige acá todo
//  lo que empieza con /api/ — el resto de los archivos los sirve el CDN.
//
//  En Render este archivo no se usa: ahí se ejecuta `node server.js` directo.
// ═══════════════════════════════════════════════════════════════════════════════
const { onRequest } = require("firebase-functions/v2/https");
const app = require("./server");

exports.api = onRequest(
  {
    region: "southamerica-east1", // mismo continente que Firestore, menos latencia
    memory: "256MiB",
    timeoutSeconds: 60,
    maxInstances: 10,             // techo de gasto: nunca más de 10 contenedores
    // Los dos valores realmente secretos viven en Secret Manager, no en el
    // repo ni en variables comunes. Se cargan como variables de entorno.
    secrets: ["MP_ACCESS_TOKEN", "MP_CLIENT_SECRET"],
  },
  app
);
