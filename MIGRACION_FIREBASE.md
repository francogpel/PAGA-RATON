# Mudanza de Render a Firebase

La app pasa a vivir entera en el proyecto `paga-raton` de Firebase:

| Parte | Dónde queda | Quién la sirve |
|---|---|---|
| `public/` (HTML, imágenes) | Firebase Hosting | CDN de Google |
| `server.js` (las 12 rutas `/api/...`) | Cloud Functions v2 | Cloud Run por debajo |
| Login y salas | Firebase Auth + Firestore | ya estaban ahí |

URL nueva: **https://paga-raton.web.app** (también responde `paga-raton.firebaseapp.com`).

Firebase Hosting **solo sirve archivos estáticos**, no puede ejecutar Express.
Por eso el backend va a Cloud Functions y el Hosting redirige `/api/**` hacia
la función. Todo lo demás lo entrega el CDN sin tocar el servidor, que es más
rápido y más barato que como está hoy en Render.

---

## Antes de empezar

**Hace falta el plan Blaze (pago por uso).** No es opcional: el plan gratuito
Spark no permite Cloud Functions ni salidas de red hacia afuera, y esta app
necesita llamar a la API de Mercado Pago. Blaze pide una tarjeta pero mantiene
una capa gratuita mensual generosa (2 millones de invocaciones, entre otras
cosas). Para el volumen de esta app lo más probable es que la factura sea de
cero o centavos — pero **es una cuenta con tarjeta asociada, decidilo vos**.

Poné un **presupuesto con alerta** apenas actives Blaze:
Google Cloud Console → Facturación → Presupuestos y alertas → crear uno de,
por ejemplo, USD 5 con aviso por mail al 50%, 90% y 100%.

Ya está resuelto en el código: `maxInstances: 10` en `index.js` limita a diez
contenedores en paralelo, así un pico raro no se convierte en una sorpresa.

---

## Pasos

### 1. Activar Blaze
Consola de Firebase → proyecto `paga-raton` → engranaje → **Uso y facturación**
→ **Modificar plan** → Blaze.

### 2. Entrar con el CLI
```bash
firebase login
```

### 3. Guardar los dos secretos
Van a Secret Manager, no al repositorio. El CLI pide el valor por teclado:

```bash
firebase functions:secrets:set MP_ACCESS_TOKEN
```

```bash
firebase functions:secrets:set MP_CLIENT_SECRET
```

Son los mismos valores que hoy tenés cargados en Render → Environment.

### 4. Crear el archivo de configuración
En la raíz del proyecto, un archivo llamado **`.env.paga-raton`** (está en
`.gitignore`, no se sube a GitHub):

```
PUBLIC_URL=https://paga-raton.web.app
MP_CLIENT_ID=tu-client-id
FIREBASE_API_KEY=AIzaSyDZzztxf2V4qoe1MtdTJXxWbtoVdZbVe9s
FIREBASE_AUTH_DOMAIN=paga-raton.firebaseapp.com
FIREBASE_PROJECT_ID=paga-raton
```

**`FIREBASE_SERVICE_ACCOUNT_JSON` ya no hace falta.** Dentro de Cloud Functions
las credenciales de Firestore las provee el propio entorno; esa variable
larguísima en base64 desaparece. El código la sigue aceptando por si algún día
volvés a un hosting externo.

### 5. Desplegar
```bash
firebase deploy
```

La primera vez tarda unos minutos: habilita las APIs de Cloud Functions,
Cloud Build y Artifact Registry, y construye el contenedor.

### 6. Apuntar Mercado Pago a la URL nueva
Panel de Mercado Pago → tu aplicación → Credenciales OAuth → URLs de
redirección. **Agregá** (no borres todavía la de Render):

```
https://paga-raton.web.app/api/mp-oauth/callback
```

Tiene que coincidir letra por letra con `PUBLIC_URL` + `/api/mp-oauth/callback`.

### 7. Probar antes de dar de baja Render
En https://paga-raton.web.app:

1. Entrar con Google y con email.
2. Conectar Mercado Pago (verifica el OAuth con la URL nueva).
3. Crear una sala y abrir el link de invitación en otra pestaña.
4. Pagar con una [tarjeta de prueba](https://www.mercadopago.com.ar/developers/es/docs/checkout-pro/additional-content/your-integrations/test/cards)
   y confirmar que la porción se pone verde sola — eso valida el webhook.
5. Eliminar una sala abierta y comprobar que una cerrada no se pueda borrar.

Las salas y los tokens **no se migran**: ya viven en Firestore, y es el mismo
proyecto. No se pierde nada.

### 8. Recién ahí, apagar Render
Cuando todo lo anterior funcione: Render → el servicio → Settings → Suspend o
Delete. Y sacá la URL vieja de las redirecciones de Mercado Pago.

---

## Ver qué está pasando

```bash
firebase functions:log --only api
```

---

## Dos cosas para tener en cuenta

**El polling cuesta invocaciones.** Mientras alguien mira una sala abierta, el
frontend consulta `/api/rooms/:id` cada 3 segundos: son 1.200 invocaciones por
hora y por persona conectada. Con 2 millones gratis al mes hay lugar de sobra
para arrancar, pero si la app crece conviene subir ese intervalo o pasar a
escuchar Firestore en tiempo real desde el cliente, que evita el backend por
completo. Está en `startPolling()` dentro de `public/index.html`.

**Arranque en frío.** Con `minInstances: 0` la primera visita después de un rato
de inactividad espera entre uno y tres segundos. Es mucho mejor que el plan
gratuito de Render, donde la espera es de casi un minuto. Si querés que sea
instantáneo, `minInstances: 1` en `index.js` mantiene un contenedor prendido,
pero eso sí se paga todo el mes.
