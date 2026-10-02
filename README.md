# 🎮 DLE Games Tracker

Dashboard personal para registrar y seguir los juegos diarios tipo Wordle
(*-dle games*): qué jugaste hoy, qué tienes pendiente, tus resultados,
rachas, estadísticas y evolución. La interfaz imita una consola Unix
(prompts, paneles tipo TUI, barra de estado al estilo tmux) y la acompaña
**Bit**, una mascota de píxeles que te avisa cómo va tu día.

Es multiusuario: cada persona crea su cuenta y ve solo sus propios juegos,
partidas y rachas, así que se puede publicar en internet
(ver [Publicar online gratis](#publicar-online-gratis)).

- **Dashboard**: resumen (juegos, jugados hoy, partidas, victorias, derrotas,
  % de victorias, racha actual y mejor racha), tarjetas por juego con botones
  **Jugar** y **Registrar**, resumen semanal comparado con la semana anterior y logros.
- **Ruleta**: si no sabes qué jugar, gírala y elige un juego al azar
  (solo los pendientes de hoy, o todos los activos).
- **Mis juegos**: agregar, editar, desactivar o eliminar (con confirmación).
  Al agregar un juego (o cambiar su URL) se descarga automáticamente el
  **icono de mejor calidad** de su página; si no hay, se usa el emoji.
- **Página de cada juego**: rachas, promedios, mejor/peor resultado, gráfico de
  evolución con media móvil, tendencia (mejorando/empeorando), distribución e
  historial reciente.
- **Historial**: tabla filtrable por juego, resultado y rango de fechas;
  orden por fecha; editar y eliminar partidas.
- **Estadísticas**: partidas por día, victorias/derrotas, evolución por juego y
  tabla comparativa.
- **Calendario**: días jugados del mes; al elegir un día se ven sus partidas.
- **Cuentas**: registro e inicio de sesión; cada cuenta nueva recibe los
  juegos de ejemplo. Las rachas usan la zona horaria de tu navegador.
- **Configuración**: temas *phosphor* (verde), *amber* y *paper* (claro), o
  según el sistema; efecto de scanlines; exportación de datos a JSON; cerrar
  sesión y eliminar la cuenta con todos sus datos.
- **Atajos de teclado**: `1`–`7` navegan entre secciones, `r` gira la ruleta,
  `n` registra una partida, `Esc` cierra ventanas.
- Responsive: en móvil la navegación pasa a la barra de estado inferior.

## Tecnologías

| Capa | Tecnología |
|------|------------|
| Backend | Python 3.10+, FastAPI, Pydantic v2 |
| Persistencia | SQLite en local o PostgreSQL en la nube, mediante SQLAlchemy 2 |
| Frontend | HTML + CSS + JavaScript vanilla (sin build, sin Node) |
| Gráficos | Chart.js 4 (incluido en `static/vendor/`, funciona sin internet) |
| Tipografía | JetBrains Mono (incluida en `static/vendor/fonts/`, licencia OFL) |
| Tests | pytest + TestClient de FastAPI |

## Instalación y ejecución

Con **conda** (recomendado si ya usas Anaconda/Miniconda):

```bash
conda env create -f environment.yml
conda activate dle-tracker
uvicorn app.main:app --reload
```

Para actualizar el entorno si cambia `environment.yml`:
`conda env update -f environment.yml --prune`.

Con **pip**:

```bash
python -m venv .venv && source .venv/bin/activate   # opcional
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Abre <http://127.0.0.1:8000>. La documentación interactiva de la API está en
<http://127.0.0.1:8000/docs>.

Crea una cuenta en la pantalla de inicio: recibirá cinco juegos de ejemplo
(Wordle, Connections, Framed, Worldle y Globle). Los datos se guardan en
`data/dle_games.db` y persisten entre reinicios.

> **¿Vienes de la versión sin cuentas?** No pierdes nada: al arrancar se migra
> la base de datos y la **primera cuenta que crees** se queda con todos los
> juegos, partidas e iconos existentes.

Variables de entorno opcionales:

| Variable | Para qué |
|----------|----------|
| `DATABASE_URL` | Usar PostgreSQL (p. ej. la URL de Neon) en vez de SQLite. |
| `DLE_DB_PATH` | Ruta alternativa del archivo SQLite. |
| `DLE_SKIP_SEED=1` | Las cuentas nuevas empiezan sin juegos de ejemplo. |
| `DLE_DISABLE_ICON_FETCH=1` | No descargar iconos automáticamente. |
| `DLE_ALLOW_PRIVATE_FETCH=1` | Permite descargar iconos de direcciones locales (solo para pruebas). |

> Las URLs de los juegos de ejemplo son sus direcciones públicas conocidas,
> pero no se pudieron comprobar desde el entorno de desarrollo (sin acceso a
> internet). Si alguna cambió, edítala desde **Mis juegos → Editar**.

## Publicar online gratis

La combinación recomendada, sin coste, es **Render** (ejecuta la app) +
**Neon** (base de datos PostgreSQL). La base de datos va aparte porque el disco
del plan gratuito de Render se borra en cada reinicio; por eso también los
iconos se guardan dentro de la base de datos.

1. **Base de datos (Neon)**: crea una cuenta en <https://neon.tech>, crea un
   proyecto y copia la *connection string* (empieza por `postgresql://` o
   `postgres://`).
2. **App (Render)**: crea una cuenta en <https://render.com> con tu GitHub,
   ve a **New → Blueprint** y elige este repositorio (y la rama que tenga
   este código). Render lee `render.yaml`, crea el servicio y te pide
   `DATABASE_URL`: pega la URL de Neon.
3. Espera a que termine el despliegue y abre la URL `https://<nombre>.onrender.com`.
   Las tablas se crean solas al arrancar. Comparte el enlace: cada persona
   crea su cuenta.

Lo que conviene saber de los planes gratuitos (pueden cambiar; revísalos):

- Render apaga el servicio gratuito tras un rato sin visitas; la primera
  visita después tarda un poco más mientras arranca.
- Neon también suspende la base de datos inactiva y la reactiva sola; tiene
  un límite de almacenamiento de sobra para esta app.
- Si prefieres otro hosting con contenedores (Koyeb, Fly.io, Cloud Run, un
  VPS…), usa el `Dockerfile` y define `DATABASE_URL`.

Seguridad incluida para uso público: contraseñas con *scrypt*, sesiones en
cookie `HttpOnly`/`SameSite=Lax` (y `Secure` con HTTPS), límite de intentos de
inicio de sesión, rechazo de peticiones de otros orígenes, cabeceras de
seguridad, datos aislados por cuenta y descarga de iconos restringida a
direcciones públicas de internet (protección SSRF).

## Tests

```bash
pytest
# también contra PostgreSQL:
DATABASE_URL=postgresql://usuario@localhost/dle_test pytest
```

Cubren cuentas (registro, login, límite de intentos, borrado de cuenta),
aislamiento entre usuarios, zona horaria, protección SSRF, migración desde la
versión sin cuentas, creación, edición, desactivación y eliminación de juegos; registro,
edición y borrado de partidas; filtros del historial; estadísticas; validación
de datos incorrectos; y, en `tests/test_streaks.py`, el cálculo de rachas
(días consecutivos, varios juegos el mismo día, huecos, cambios de mes/año,
años bisiestos, racha viva si se jugó ayer, etc.).

## Estructura

```text
app/
├── main.py            # App FastAPI, arranque, seguridad, errores legibles
├── auth.py            # Contraseñas, sesiones por cookie, límite de intentos, fecha local
├── database.py        # SQLite o PostgreSQL, sesión y migraciones ligeras
├── models.py          # Tablas users, auth_tokens, games y game_sessions
├── schemas.py         # Validación Pydantic
├── seed.py            # Juegos de ejemplo
├── routes/
│   ├── auth.py        # /api/auth (registro, login, logout, cuenta)
│   ├── games.py       # /api/games
│   ├── sessions.py    # /api/sessions
│   └── stats.py       # /api/stats, /api/streaks, /api/calendar, /api/export
└── services/
    ├── favicon.py     # Búsqueda del mejor icono (con protección SSRF)
    ├── streaks.py     # Rachas (funciones puras)
    └── stats.py       # Estadísticas, semana, logros, sugerencias
static/
├── css/styles.css
├── js/app.js          # SPA con rutas por hash (#/dashboard, #/roulette, #/game/1, …)
├── js/mascot.js       # Bit, la mascota en pixel art (SVG)
└── vendor/            # Chart.js y la fuente JetBrains Mono
templates/index.html
tests/
data/                  # dle_games.db (ignorado por git)
render.yaml            # Despliegue en Render
Dockerfile             # Despliegue en cualquier hosting con contenedores
```

## Base de datos

**users** (`id`, `username` único, `password_hash`, `created_at`) y
**auth_tokens** (sesiones: hash del token, `user_id`, `expires_at`).

**games**

| Campo | Tipo | Notas |
|-------|------|-------|
| id | INTEGER PK | |
| user_id | FK → users.id | dueño; `ON DELETE CASCADE` |
| name | TEXT | obligatorio, único por usuario |
| description, category | TEXT | |
| url | TEXT | opcional, http(s) |
| icon | TEXT | emoji de respaldo, por defecto 🎮 |
| icon_file, icon_data | TEXT, BLOB | favicon descargado (nombre con hash y bytes) |
| active | BOOL | los inactivos no aparecen en el dashboard pero conservan su historial |
| track_attempts, track_errors, track_score, track_time | BOOL | métricas que usa el juego |
| primary_metric | TEXT | `attempts` \| `errors` \| `score` \| `time_seconds` |
| lower_is_better | BOOL | sentido de la métrica principal |
| created_at | DATETIME | |

**game_sessions**

| Campo | Tipo | Notas |
|-------|------|-------|
| id | INTEGER PK | |
| game_id | FK → games.id | `ON DELETE CASCADE` |
| played_at | DATE | día de la partida, no futuro |
| result | TEXT | `win` \| `loss` |
| score | REAL | opcional |
| attempts, errors | INTEGER | opcionales, ≥ 0 |
| time_seconds | INTEGER | opcional, ≥ 0 |
| notes | TEXT | |
| created_at | DATETIME | |

Restricciones: `UNIQUE(game_id, played_at)` y `CHECK` sobre resultado y
valores no negativos, además de la validación Pydantic.

## API

Todo requiere sesión iniciada (cookie) salvo `/api/auth/*` y `/api/health`, y
solo devuelve datos del usuario. La cabecera opcional `X-Timezone`
(p. ej. `America/Santiago`) define qué día es "hoy" para las rachas.

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/auth/register` | Crear cuenta `{username, password}` e iniciar sesión |
| POST | `/api/auth/login` | Iniciar sesión |
| POST | `/api/auth/logout` | Cerrar sesión |
| GET | `/api/auth/me` | Usuario actual |
| DELETE | `/api/auth/me` | Eliminar la cuenta y sus datos `{password}` |
| GET | `/api/health` | Estado del servicio y de la base de datos |
| GET | `/api/games?include_inactive=true` | Lista de juegos |
| POST | `/api/games` | Crear juego |
| GET | `/api/games/{id}` | Detalle |
| GET | `/api/games/{id}/icon` | Favicon descargado del juego |
| POST | `/api/games/{id}/icon` | Volver a descargar el icono desde la URL |
| DELETE | `/api/games/{id}/icon` | Quitar el icono (vuelve al emoji) |
| POST | `/api/games/icons/fetch-missing` | Descargar iconos de los juegos que no tienen |
| PUT | `/api/games/{id}` | Actualizar (admite cambios parciales, p. ej. `{"active": false}`) |
| DELETE | `/api/games/{id}` | Eliminar juego y sus partidas |
| GET | `/api/sessions?game_id=&result=&date_from=&date_to=&order=desc&limit=` | Historial filtrado |
| POST | `/api/sessions` | Registrar partida |
| GET / PUT / DELETE | `/api/sessions/{id}` | Ver / editar / eliminar partida |
| GET | `/api/stats` | Resumen global, resumen semanal, logros y datos de cada tarjeta |
| GET | `/api/stats/{game_id}` | Estadísticas de un juego (promedios, mejor/peor, evolución, tendencia, distribución) |
| GET | `/api/streaks` | Racha actual y mejor, global y por juego |
| GET | `/api/calendar?year=&month=` | Partidas por día del mes |
| GET | `/api/export` | Copia de seguridad en JSON |

Ejemplo:

```bash
curl -c cookies -X POST localhost:8000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username": "isidora", "password": "mi-clave-secreta"}'
curl -b cookies -X POST localhost:8000/api/sessions -H 'Content-Type: application/json' \
  -d '{"game_id": 1, "played_at": "2026-10-02", "result": "win", "attempts": 4}'
```

Los errores de validación devuelven `422` con un mensaje en español en `detail`;
los duplicados devuelven `409`; sin sesión, `401`; los recursos de otra cuenta
responden `404` (no se revela que existen).

## Cómo agregar juegos

Desde **Dashboard** o **Mis juegos → Agregar juego**: nombre, icono, URL,
categoría, descripción y las métricas que quieres registrar. Por ejemplo:

- Wordle → *Intentos*, métrica principal intentos, menor es mejor.
- Connections → *Errores*, menor es mejor.
- Un juego contrarreloj → *Tiempo* (se escribe como `1:30` o `90`).
- Un juego de puntos → *Puntaje*, mayor es mejor.

El formulario de **Registrar resultado** muestra solo esas métricas.

## Decisiones de diseño

- **Métricas flexibles sin EAV**: cada partida tiene columnas opcionales para
  las cuatro métricas típicas y cada juego declara cuáles usa. Es simple,
  validable y suficiente para los juegos diarios habituales.
- **Una partida por juego y día**: son juegos diarios; si registras de nuevo el
  mismo día, el formulario abre la partida existente para editarla.
- **Rachas por días de calendario**: varios juegos el mismo día cuentan como un
  día. La racha actual sigue viva si jugaste ayer y aún no hoy (todavía puedes
  mantenerla); se rompe si el último día jugado fue anteayer o antes.
- **"Hoy"** es la fecha en la zona horaria del navegador de cada usuario
  (cabecera `X-Timezone`); si no llega, la del servidor.
- **Recordar valores**: al registrar, el formulario se rellena con el resultado y
  las métricas más frecuentes de tus últimas 20 partidas de ese juego, y la fecha de hoy.
- **Tendencia**: compara la media de la métrica principal de las últimas 10
  partidas con las 10 anteriores (margen del 2 % para "estable").
- **Desactivar vs. eliminar**: desactivar oculta el juego del dashboard y
  conserva sus estadísticas; eliminar borra el juego y sus partidas tras confirmar.
- **Iconos**: el servidor lee el HTML de la URL del juego y reúne los
  candidatos (`<link rel="icon">`, `apple-touch-icon`, iconos del web manifest
  y `/favicon.ico`). Prefiere SVG y luego el tamaño mayor, comprueba por sus
  bytes que el archivo sea realmente una imagen y lo guarda en la base de
  datos (así sobrevive en hostings sin disco persistente). Solo visita
  direcciones públicas, validando cada redirección. Los SVG se sirven con una
  CSP *sandbox*.
- **Sesiones en servidor**: la cookie lleva un token aleatorio y en la base de
  datos solo se guarda su hash; cerrar sesión lo invalida de inmediato.
- No hay Alembic: al arrancar se crean las tablas y `ensure_schema` agrega
  columnas nuevas y migra la base de datos de la versión sin cuentas, así que
  actualizar no borra tus datos.
