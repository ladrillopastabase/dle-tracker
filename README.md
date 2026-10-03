# 🎮 DLE Games Tracker

Dashboard personal para registrar y seguir los juegos diarios tipo Wordle
(*-dle games*): qué jugaste hoy, qué tienes pendiente, tus resultados,
rachas, estadísticas y evolución. La interfaz imita una consola Unix
(prompts, paneles tipo TUI, barra de estado al estilo tmux) y la acompaña
**Bit**, una mascota de píxeles que te avisa cómo va tu día.

Es una web **100 % estática**: no necesita servidor ni base de datos. Los
datos se guardan en el navegador (`localStorage`), así que funciona en
**GitHub Pages** y cada persona que la abre tiene sus propios datos.

**👉 https://ladrillopastabase.github.io/dle-tracker/**

## Funciones

- **Dashboard**: juegos, jugados hoy, partidas, victorias, derrotas,
  % de victorias, racha actual y mejor racha; tarjetas por juego con
  **Jugar** y **Registrar**; resumen semanal comparado con la semana anterior y logros.
  Botón **▶ siguiente** (abre el próximo pendiente), **⧉ compartir día**
  (copia un resumen con ✅/❌ para pegar en un chat), **★ favoritos** y orden
  configurable (pendientes, favoritos, nombre o racha).
- **Descubrir**: explora los ~770 juegos del catálogo de
  [dles.aukspot.com](https://dles.aukspot.com/): búsqueda, filtros por
  categoría, destacados de la semana, novedades, botón **🎲 sorpréndeme** y
  **+ agregar** con un clic (ver [Catálogo](#catálogo)).
- **Jugar y anotar**: al pulsar **▶ jugar** el juego se abre en otra pestaña y
  aparece la barra «▶ jugando» con un cronómetro; al volver a la pestaña del
  tracker se abre solo el registro de ese juego (y, si el navegador lo permite,
  lee el resultado que copiaste al compartir). En juegos de tiempo puedes usar
  el cronómetro como tiempo.
- **Registro en un toque**: cada tarjeta pendiente tiene botones
  1·2·3·4·5·6·✗ (o 0…4·✗ para errores) que guardan al instante, con
  **deshacer**. El formulario completo tiene fechas rápidas (hoy / ayer / otra),
  «📋 pegar del portapapeles» y se guarda con Enter.
- **Categorías e iconos a tu gusto**: al crear o editar un juego eliges la
  categoría en una cuadrícula con iconos (las del catálogo, las tuyas o
  «＋ otra») y el icono en una paleta de emojis; la categoría sugiere su icono.
- **Pegar resultado**: al registrar, pega el texto que comparte el juego
  («Wordle 1.234 4/6», la cuadrícula de Connections, la fila de Framed, un
  tiempo «1:23», «Score: 85»…) y el formulario se rellena solo.
- **Ruleta tragamonedas**: una tira de tarjetas que gira y frena bajo el
  marcador (sirve igual con 3 que con 300 juegos), con confeti y sonido
  opcional; elige entre pendientes, todos o favoritos. **Cola del día**:
  baraja tus pendientes y juégalos en ese orden.
- **Paleta de comandos** (`:` o `Ctrl+K`): escribe «jugar wordle»,
  «registrar connections», «tema amber», «ir stats»… y Enter.
- **Días de la semana por juego**: marca qué días juegas cada uno (p. ej. solo
  laborables); los demás días aparece como «descansa hoy» y no cuenta como pendiente.
- **Días perfectos**: los días en que jugaste todo lo que tocaba, con su racha.
- **Juegos**: agregar, editar, desactivar o eliminar (con confirmación). Cada
  juego elige qué métricas registra (intentos, errores, puntaje, tiempo).
- **Iconos automáticos**: al poner la URL de un juego se usa el icono de su
  web (ver [Iconos](#iconos)); si no hay, el emoji.
- **Página de cada juego**: rachas, promedios, mejor/peor resultado, gráfico de
  evolución con media móvil, tendencia, distribución e historial reciente.
- **Historial**: filtros por juego, resultado y fechas; orden; editar y eliminar.
- **Estadísticas**: partidas por día, victorias/derrotas, **mapa de actividad
  del último año** (estilo GitHub, ocupa todo el ancho) con días jugados, racha
  más larga, día de la semana favorito y mes más activo; evolución por juego y
  tabla comparativa. **11 logros** (días perfectos, coleccionista, explorador…).
- **Calendario**: días jugados del mes; al elegir un día se ven sus partidas.
- **Personalización**: temas *phosphor*, *amber* y *paper* (claro) o según el
  sistema; **color de acento** (8 predefinidos o cualquiera); scanlines;
  mostrar u ocultar a Bit; tarjetas completas o compactas; nombre del prompt.
- **Sincronizar dispositivos** (gratis, sin servidor propio): vinculando tus
  dispositivos con un solo QR (o un código en el PC), que luego se reconectan
  solos (WebRTC), o con un gist secreto de tu cuenta de GitHub (ver [Sincronizar](#sincronizar-entre-dispositivos)).
- **Datos**: exportar / importar JSON y borrar todo.
- **Atajos de teclado**: `:` o `Ctrl+K` comandos, `1`–`8` navegan, `/` busca
  juegos nuevos, `r` gira la ruleta, `n` registra una partida, `Esc` cierra.
- **App instalable (PWA)**: en el móvil, «Añadir a pantalla de inicio»; funciona
  sin conexión gracias a un *service worker*. Responsive.

## Publicar en GitHub Pages

El sitio se sirve directamente desde la raíz del repositorio (no hay build):

1. En GitHub, abre el repositorio → **Settings** → **Pages**.
2. En **Build and deployment → Source** elige **Deploy from a branch**.
3. En **Branch** elige la rama con este código (hoy `claude/lucid-thompson-cn46wv`)
   y la carpeta **`/ (root)`**, y pulsa **Save**.
4. En uno o dos minutos estará en `https://ladrillopastabase.github.io/dle-tracker/`.
   Cada `git push` a esa rama actualiza la web.

El archivo `.nojekyll` evita que GitHub procese el sitio con Jekyll. Todas las
rutas son relativas, así que funciona bajo `/dle-tracker/` o en cualquier dominio.

## Probar en local

Cualquier servidor de archivos estáticos sirve, por ejemplo:

```bash
python3 -m http.server 8000
# y abre http://localhost:8000
```

Por el *service worker*, tras publicar cambios la primera visita muestra la
versión guardada y la siguiente ya la nueva (o recarga con `Ctrl+Shift+R`).

## Tus datos

- Se guardan **solo en tu navegador**, en la clave `dle-tracker:data` de
  `localStorage`. Nadie más los ve y no se envían a ningún servidor.
- Son por navegador y dispositivo: para tenerlos en otro, usa
  [Sincronizar](#sincronizar-entre-dispositivos) o **exporta** el JSON en
  Configuración e **impórtalo** allí. Exporta de vez en cuando como copia de
  seguridad: si borras los datos del sitio en el navegador, se pierden.
- La importación valida todo antes de reemplazar nada y acepta también las
  copias de la versión anterior con servidor (FastAPI).
- La primera visita crea cinco juegos de ejemplo (Wordle, Connections, Framed,
  Worldle y Globle). Sus URLs son las públicas conocidas; si alguna cambió,
  edítala desde **juegos → editar**.

## Sincronizar entre dispositivos

Hay dos formas, ambas gratis, en **config**; se pueden usar a la vez.

### Vincular con un QR (WebRTC)

Los dispositivos se conectan **directamente** entre sí: tus datos no pasan por
ningún servidor y no necesitas cuenta.

1. En el PC: **config → 📡 vincular un dispositivo**. Aparece un QR y un código
   como `K7P2Q-X9M4R`.
2. En el celular: **escanea el QR con la cámara**. Se abre la app y se conectan
   solos. En otro PC (sin cámara): **⌨ tengo un código** y escribe el código.
3. Listo: quedan **vinculados**. Cada vez que dos de ellos tienen la app abierta
   se reconectan solos, sin volver a escanear, y cada cambio llega al instante
   (la barra de estado muestra `⇄ 1`, `⇄ 2`…). Se pueden vincular varios
   dispositivos al mismo grupo.

Cómo funciona: del código salen (con PBKDF2) el nombre de una sala y una clave
AES-GCM. Para encontrarse, los dispositivos se dejan mensajes en esa sala de
[ntfy.sh](https://ntfy.sh) (servicio público y gratuito de mensajes): solo los
datos de conexión WebRTC, **cifrados**; ntfy no ve tus juegos ni puede leer
nada sin el código. Luego se conectan directamente y combinan sus datos. Los
servidores STUN públicos (Google, Cloudflare) solo sirven para descubrir la
dirección de red.

Límites: ambos deben tener la app abierta a la vez (los celulares cortan la
conexión en segundo plano; al volver a la pestaña se reconecta). Funciona mejor
en la **misma red Wi-Fi**; entre redes distintas puede fallar tras NAT estrictos
(datos móviles o redes corporativas), porque no hay servidor TURN de relevo. En
ese caso usa el gist. Guarda el código en privado: quien lo tenga puede
vincularse; **desvincular este** lo olvida en ese dispositivo.

### Gist de GitHub

Sincroniza en segundo plano sin tener los dispositivos abiertos a la vez:

1. Crea un token clásico con solo el permiso **gist** (el enlace de la app ya
   lo trae marcado) y pégalo en **conectar**.
2. La app crea un gist **secreto** `dle-tracker.json` en tu cuenta y lo usa
   desde todos los dispositivos donde pegues el mismo token.
3. Sincroniza al abrir la app, al volver a la pestaña y unos segundos después
   de cada cambio.

El token se guarda solo en ese navegador y únicamente puede leer y escribir
tus gists. Puedes revocarlo cuando quieras en GitHub.

### Cómo se combinan los datos

Cada juego tiene un `uid` estable y cada partida se identifica por juego + día.
Si un registro cambió en los dos lados gana el más reciente (`updated_at`), y
los borrados viajan como «lápidas» (se guardan 180 días) para que no
reaparezcan. Juegos con el mismo nombre creados por separado se unen, y un
dispositivo recién estrenado (solo con los juegos de ejemplo) adopta los datos
del otro sin duplicarlos.

## Catálogo

La sección **descubrir** usa el listado público de
[dles.aukspot.com](https://dles.aukspot.com/), cuyo código y datos están en
[aukspot/dles](https://github.com/aukspot/dles) bajo licencia GPL-3.0. Este
repositorio **no copia** esos datos: el navegador descarga los JSON
(`dles.json`, `new_dles.json`, `dles_of_the_week.json`) desde
`raw.githubusercontent.com`, los guarda en `localStorage` un día y, sin
conexión, usa la última copia. Las categorías se traducen al español; las
descripciones se muestran tal cual (en inglés). Al agregar un juego se copian
nombre, URL, descripción y categoría a tus juegos, y desde ahí puedes editarlos.

## Iconos

Una web estática no puede leer el HTML de otra página (el navegador lo bloquea
por CORS), así que el icono se elige probando imágenes, de mejor a peor calidad:

1. `https://<dominio>/apple-touch-icon.png` (normalmente 180 px),
2. el servicio de favicons de Google a 256 px
   (`https://www.google.com/s2/favicons?domain=<dominio>&sz=256`),
3. `https://<dominio>/favicon.ico`,
4. y si ninguno carga, el emoji del juego.

Al mostrar el icono, el navegador consulta esas direcciones (incluido Google
para el paso 2). Si prefieres no hacerlo, quita el icono del juego desde
**editar → quitar** y se usará solo el emoji.

## Tests

La lógica (rachas, estadísticas) y la capa de datos tienen tests con el runner
de Node (≥ 18), sin dependencias:

```bash
npm test        # o: node --test tests/*.test.js
```

Cubren las rachas (días consecutivos, varios juegos el mismo día, huecos,
cambios de mes/año, bisiestos, racha viva si se jugó ayer), el lector de
resultados compartidos, el catálogo (caché, sin conexión), la combinación de
datos al sincronizar, la sincronización con gist (GitHub simulado), la
vinculación por QR (códigos, cifrado, señalización y protocolo simulados), estadísticas,
tendencia, semana, calendario, CRUD de juegos y partidas, validaciones,
persistencia al recargar, datos corruptos, exportar/importar e iconos.

## Estructura

```text
index.html             # La app (una sola página)
static/
├── css/styles.css     # Estilo consola, temas
├── js/logic.js        # Rachas y estadísticas (funciones puras)
├── js/store.js        # Datos en localStorage + mini API con validación
├── js/catalog.js      # Catálogo de dles.aukspot.com (descarga y caché)
├── js/sync.js         # Combinar datos + sincronización con gist de GitHub
├── js/pair.js         # Vincular dispositivos por QR (WebRTC + ntfy cifrado)
├── js/mascot.js       # Bit, la mascota en pixel art (SVG)
├── js/app.js          # Interfaz: rutas por hash (#/dashboard, #/game/1, …)
├── icons/             # Iconos de la app (PWA)
└── vendor/            # Chart.js, qrcode-generator (MIT) y JetBrains Mono (OFL)
manifest.webmanifest   # App instalable
sw.js                  # Service worker (sin conexión)
tests/                 # node --test
.nojekyll              # GitHub Pages sin Jekyll
```

## Modelo de datos

Un único objeto JSON en `localStorage`:

```json
{
  "version": 1,
  "seq": { "game": 5, "session": 12 },
  "games": [{ "id": 1, "name": "Wordle", "url": "https://…", "category": "Palabras",
              "icon": "🟩", "icon_url": "https://…/apple-touch-icon.png", "active": true, "favorite": false,
              "days": null,
              "track_attempts": true, "track_errors": false, "track_score": false, "track_time": false,
              "primary_metric": "attempts", "lower_is_better": true, "created_at": "…" }],
  "sessions": [{ "id": 1, "game_id": 1, "played_at": "2026-10-02", "result": "win",
                 "attempts": 4, "errors": null, "score": null, "time_seconds": null,
                 "notes": "", "created_at": "…" }]
}
```

Para sincronizar, cada juego lleva además `uid` y `updated_at`, cada partida
`updated_at`, y el objeto guarda `tombstones` (borrados recientes).

Reglas: nombre de juego obligatorio y único (sin distinguir mayúsculas); URL
`http(s)`; la métrica principal debe estar entre las registradas; una partida
por juego y día; fechas válidas y no futuras; intentos, errores y tiempo
enteros ≥ 0; puntaje numérico. Borrar un juego borra sus partidas.

## Decisiones de diseño

- **Sin servidor**: `store.js` expone las mismas rutas que tenía la antigua API
  (`/api/games`, `/api/sessions`, `/api/stats`…), pero resueltas en el
  navegador; por eso la interfaz apenas cambió. La versión con FastAPI,
  cuentas y PostgreSQL sigue en el historial de git (commit `616f3a3`).
- **Rachas por días de calendario** en la zona horaria del dispositivo: varios
  juegos el mismo día cuentan como un día; la racha sigue viva si jugaste ayer
  y aún no hoy, y se rompe si el último día jugado fue anteayer o antes.
- **Recordar valores**: el formulario se rellena con el resultado y las
  métricas más frecuentes de tus últimas 20 partidas de ese juego.
- **Tendencia**: media de las últimas 10 partidas frente a las 10 anteriores
  (margen del 2 % para "estable").
