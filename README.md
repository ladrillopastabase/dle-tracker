# 🎮 DLE Games Tracker

Dashboard personal para registrar y seguir los juegos diarios tipo Wordle
(*-dle games*): qué jugaste hoy, qué tienes pendiente, tus resultados,
rachas, estadísticas y evolución. La interfaz imita una consola Unix
(prompts, paneles tipo TUI, barra de estado al estilo tmux) y la acompaña
**Bit**, una mascota de píxeles que te avisa cómo va tu día.

- **Dashboard**: resumen (juegos, jugados hoy, partidas, victorias, derrotas,
  % de victorias, racha actual y mejor racha), tarjetas por juego con botones
  **Jugar** y **Registrar**, resumen semanal comparado con la semana anterior y logros.
- **Ruleta**: si no sabes qué jugar, gírala y elige un juego al azar
  (solo los pendientes de hoy, o todos los activos).
- **Mis juegos**: agregar, editar, desactivar o eliminar (con confirmación).
- **Página de cada juego**: rachas, promedios, mejor/peor resultado, gráfico de
  evolución con media móvil, tendencia (mejorando/empeorando), distribución e
  historial reciente.
- **Historial**: tabla filtrable por juego, resultado y rango de fechas;
  orden por fecha; editar y eliminar partidas.
- **Estadísticas**: partidas por día, victorias/derrotas, evolución por juego y
  tabla comparativa.
- **Calendario**: días jugados del mes; al elegir un día se ven sus partidas.
- **Configuración**: temas *phosphor* (verde), *amber* y *paper* (claro), o
  según el sistema; efecto de scanlines; nombre de usuario del prompt;
  exportación de datos a JSON.
- **Atajos de teclado**: `1`–`7` navegan entre secciones, `r` gira la ruleta,
  `n` registra una partida, `Esc` cierra ventanas.
- Responsive: en móvil la navegación pasa a la barra de estado inferior.

## Tecnologías

| Capa | Tecnología |
|------|------------|
| Backend | Python 3.10+, FastAPI, Pydantic v2 |
| Persistencia | SQLite mediante SQLAlchemy 2 |
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

La primera vez se crea `data/dle_games.db` con cinco juegos de ejemplo
(Wordle, Connections, Framed, Worldle y Globle). Los datos persisten entre
reinicios. Variables de entorno opcionales:

- `DLE_DB_PATH`: ruta alternativa para la base de datos.
- `DLE_SKIP_SEED=1`: no crear los juegos de ejemplo.

> Las URLs de los juegos de ejemplo son sus direcciones públicas conocidas,
> pero no se pudieron comprobar desde el entorno de desarrollo (sin acceso a
> internet). Si alguna cambió, edítala desde **Mis juegos → Editar**.

## Tests

```bash
pytest
```

Cubren creación, edición, desactivación y eliminación de juegos; registro,
edición y borrado de partidas; filtros del historial; estadísticas; validación
de datos incorrectos; y, en `tests/test_streaks.py`, el cálculo de rachas
(días consecutivos, varios juegos el mismo día, huecos, cambios de mes/año,
años bisiestos, racha viva si se jugó ayer, etc.).

## Estructura

```text
app/
├── main.py            # App FastAPI, arranque (crea tablas + datos de ejemplo), errores legibles
├── database.py        # Motor SQLite (claves foráneas activadas) y sesión
├── models.py          # Tablas games y game_sessions
├── schemas.py         # Validación Pydantic
├── seed.py            # Juegos de ejemplo
├── routes/
│   ├── games.py       # /api/games
│   ├── sessions.py    # /api/sessions
│   └── stats.py       # /api/stats, /api/streaks, /api/calendar, /api/export
└── services/
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
```

## Base de datos

**games**

| Campo | Tipo | Notas |
|-------|------|-------|
| id | INTEGER PK | |
| name | TEXT | obligatorio, único |
| description, category | TEXT | |
| url | TEXT | opcional, http(s) |
| icon | TEXT | emoji, por defecto 🎮 |
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

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/games?include_inactive=true` | Lista de juegos |
| POST | `/api/games` | Crear juego |
| GET | `/api/games/{id}` | Detalle |
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
curl -X POST localhost:8000/api/sessions -H 'Content-Type: application/json' \
  -d '{"game_id": 1, "played_at": "2026-10-02", "result": "win", "attempts": 4}'
```

Los errores de validación devuelven `422` con un mensaje en español en `detail`;
los duplicados devuelven `409`.

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
- **"Hoy"** es la fecha local del servidor (la app está pensada para uso local).
- **Recordar valores**: al registrar, el formulario se rellena con el resultado y
  las métricas más frecuentes de tus últimas 20 partidas de ese juego, y la fecha de hoy.
- **Tendencia**: compara la media de la métrica principal de las últimas 10
  partidas con las 10 anteriores (margen del 2 % para "estable").
- **Desactivar vs. eliminar**: desactivar oculta el juego del dashboard y
  conserva sus estadísticas; eliminar borra el juego y sus partidas tras confirmar.
- No hay migraciones (Alembic): las tablas se crean al arrancar. Si el esquema
  cambia en el futuro, convendría añadirlas.
