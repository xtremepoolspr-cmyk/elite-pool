# Elite Pool Service PR — PWA para Android

Misma app (7 pestañas) como **aplicación web instalable**: sin Play Store, sin compilar, sin dependencias. Son archivos estáticos.

## Instalar en tu Android (5 minutos)

Una PWA solo se puede instalar desde una dirección **HTTPS**. La forma más fácil es subir esta carpeta a un hosting estático gratuito:

- **Netlify Drop:** entra a `app.netlify.com/drop`, arrastra la carpeta `elite-pool-pwa` completa y te da un enlace `https://…netlify.app`.
- **Cloudflare Pages** o **GitHub Pages:** también sirven (sube los archivos tal cual).

Luego, en el teléfono:
1. Abre el enlace en **Chrome**.
2. Menú ⋮ → **Instalar app** (o «Añadir a la pantalla principal»).
3. Ábrela desde el ícono: se ve a pantalla completa y funciona **sin internet** después de la primera carga. También aparece un botón **📲 Instalar** dentro de la app.

Probar en tu computadora: `python3 -m http.server 8080` dentro de la carpeta y abre `http://localhost:8080` (localhost sí funciona sin HTTPS).

## Qué hace mejor que la versión nativa

- **El sello de las fotos (ANTES/DESPUÉS · fecha · hora · GPS) queda impreso dentro de la imagen.**
- **Los PDF se generan en el teléfono** (informes con fotos y facturas) y se envían con la hoja de compartir de Android: eliges WhatsApp o Gmail y el PDF va adjunto.
- Botón «atrás» de Android cierra hojas y detalles en vez de salir de la app.

## Envío en 1 toque

Lee el canal y el formato guardados en la ficha del cliente:

| Canal | Texto | PDF |
|---|---|---|
| WhatsApp | abre `wa.me/1787…` con el mensaje listo | hoja de compartir con el PDF (eliges el chat) |
| Email | correo con el texto | hoja de compartir con el PDF adjunto (eliges Gmail) |

Con «Ambos» quedan los pasos siguientes listos con un toque cada uno. Se puede cambiar canal/formato solo para ese envío.

## Límites (léelos antes de usarla con clientes)

- **Los datos viven solo en ese teléfono** (IndexedDB). Si borras los datos de Chrome/del sitio o desinstalas, se pierden. Cada teléfono tiene sus propios datos: no hay cuenta ni login.
- **La sincronización está simulada** (`API_URL = null` en `js/app.js`). La cola offline funciona y se vacía al volver la señal, pero no sube nada a ningún servidor hasta que tengas un backend: `POST {API_URL}/sync` con `{ ops }` que responda `{ acked: [ids] }`. Para tener los mismos datos en varios teléfonos se necesita ese backend.
- **No es envío automático silencioso.** Android exige que toques «enviar» en WhatsApp/Gmail. Con el PDF, WhatsApp pide elegir el chat (no se puede preseleccionar el número).
- **Dosis químicas = estimados de campo** (fórmulas en `js/lib.js`). Verifica la etiqueta del producto y vuelve a medir.
- **Mapa:** usa mosaicos públicos de OpenStreetMap (requiere internet; los mosaicos ya vistos quedan guardados y se ven sin conexión). Sin internet se muestran solo los marcadores numerados con un aviso. Es para uso ligero: si la app crece a muchos usuarios, cambia a un proveedor de mapas con llave propia (MapTiler, Mapbox). La navegación real abre Google Maps.
- **ATH Móvil:** se muestra el número 939-405-7458 y las instrucciones; no hay enlace/QR de cobro ni confirmación automática. Stripe/tarjeta son solo una etiqueta (sin integración). Las facturas no calculan IVU.
- Es una app de ruta personal, no un sistema multiusuario.
- Datos de ejemplo ficticios (teléfonos 555, correos example.com): usa «Restablecer datos de ejemplo» en la pestaña Mensajes, o crea tus clientes reales desde Clientes.

## Actualizar la app

Sube los archivos nuevos al hosting y **sube el número de `CACHE` en `sw.js` (ahora `elite-pool-v2`, pasa a `v3`)** en `sw.js`; en el teléfono se actualiza al abrir la app dos veces.

## Estructura

```
index.html · styles.css · manifest.webmanifest · sw.js   (shell PWA + modo offline)
icons/                       íconos 192/512 + maskable
js/lib.js                    dosis, facturas, rutas, generador de PDF, envío, fotos con sello
js/data.js                   datos de ejemplo de Puerto Rico
js/app.js                    estado (IndexedDB), cola de sincronización y las 7 pestañas
```
