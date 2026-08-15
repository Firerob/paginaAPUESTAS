# Neon Arena — duelos 1v1 con apuestas

Plataforma de juegos de habilidad 1v1 por dinero real, con arquitectura **server-authoritative
estricta**: el navegador no simula nada, no decide nada y no puede ganar nada
mintiendo.

---

## 1. Estructura del proyecto

```
JUEGOAPUESTAS/
├── package.json                    workspaces npm (cliente + servidor + shared)
├── docker-compose.yml              PostgreSQL 16 y Redis
├── .env.example                    plantilla de configuracion
│
├── packages/shared/                contrato comun cliente <-> servidor
│   └── src/
│       ├── constants.ts            geometria de la mesa, reglas, limites
│       ├── messages.ts             contrato de eventos del socket
│       ├── protocol.ts             codec binario de estado e input
│       ├── mines.ts                reglas de Minas + derivacion del tablero
│       ├── simulation.ts           cinematica del mazo (unica fuente)
│       ├── netcode.ts              interpolacion, prediccion, reconciliacion
│       └── money.ts                calculo de liquidacion (enteros, sin float)
│
├── apps/game-server/               Node + Socket.io. La unica fuente de verdad.
│   ├── src/
│   │   ├── index.ts                arranque HTTP + WebSocket + auth del socket
│   │   ├── config/env.ts           configuracion validada al arrancar
│   │   ├── auth/jwt.ts             verificacion de token del socket
│   │   ├── db/
│   │   │   ├── pool.ts             pool de Postgres + helper de transacciones
│   │   │   ├── migrate.ts          runner de migraciones
│   │   │   └── migrations/         001_init.sql, 002_seed_dev.sql
│   │   ├── game/
│   │   │   ├── constants.ts        coeficientes de simulacion (solo servidor)
│   │   │   ├── physics.ts          fisica 2D + validacion de input
│   │   │   └── FixedClock.ts       reloj monotonico de paso fijo (60 Hz)
│   │   ├── rooms/
│   │   │   ├── BaseMatchRoom.ts    dinero y ciclo de vida, comun a todo juego
│   │   │   ├── AirHockeyRoom.ts    fisica, goles, anti-cheat
│   │   │   ├── MinesRoom.ts        tablero oculto, vidas, turnos, juego limpio
│   │   │   └── MatchManager.ts     colas por juego + apuesta
│   │   ├── services/
│   │   │   ├── wallet.service.ts   escrow, liquidacion, devolucion (ACID)
│   │   │   ├── match.service.ts    ciclo de vida de la partida + bitacora
│   │   │   └── sweeper.ts          rescate de dinero de salas huerfanas
│   │   └── http/routes.ts          saldo, historial, extracto contable
│   └── test/
│       ├── physics.test.ts         anti-cheat y cuadre contable (sin red)
│       ├── protocol.test.ts        codec binario
│       ├── netcode.test.ts         prediccion, reconciliacion, interpolacion
│       ├── mines.test.ts           tablero, uniformidad, juego limpio
│       ├── e2e.money.ts            Air Hockey: escrow -> liquidacion real
│       ├── e2e.mines.ts            Minas: ocultacion, turnos, vidas, verificacion
│       ├── e2e.mines-afk.ts        Minas: penalizacion por tiempo y abandono
│       └── bench.latency.ts        banco de latencia y ancho de banda
│
└── apps/web/                       Next.js 14 + Canvas 2D
    ├── app/
    │   ├── page.tsx                lobby: saldo y seleccion de apuesta
    │   ├── play/page.tsx           pantalla de Air Hockey
    │   ├── mines/page.tsx          pantalla de Mines
    │   ├── globals.css             sistema visual neon + glassmorphism
    │   └── api/auth/dev-login/     emisor de tokens SOLO para desarrollo
    ├── components/
    │   ├── GameCanvas.tsx          Air Hockey: socket, input, HUD
    │   ├── MinesBoard.tsx          Minas: tablero, vidas, turnos, verificacion
    │   └── VictoryScreen.tsx       pantalla "jackpot" al ganar, compartida
    ├── lib/
    │   ├── gameSocket.ts           conexion y reanudacion
    │   ├── render.ts               renderer neon con capa estatica cacheada
    │   ├── theme.ts                paleta compartida con el CSS
    │   ├── particles.ts            estela, chispas y explosiones (gameplay)
    │   ├── confetti.ts             monedas y confeti (pantalla de victoria)
    │   ├── impacts.ts              deteccion de rebotes (solo efectos)
    │   └── audio.ts                sonido sintetizado con WebAudio
    └── test/
        ├── impacts.test.ts         deteccion de impactos y particulas
        └── confetti.test.ts        ciclo de vida del confeti (nace/cae/muere)
```

El netcode del cliente (interpolacion, prediccion, reconciliacion) vive en
`packages/shared/src/netcode.ts`, junto al codec binario y a la cinematica del
mazo: son las piezas que cliente y servidor tienen que entender igual.

La separacion no es estetica: **`apps/web` no importa nada de
`apps/game-server`**. Lo unico compartido es `packages/shared`, que contiene
geometria y tipos de mensaje — datos publicos que no dan ninguna ventaja a
quien los lea.

---

## 2. Puesta en marcha

```bash
cp .env.example .env           # ajusta JWT_SECRET
npm install
npm run db:up                  # levanta PostgreSQL en Docker
npm run db:migrate             # crea el esquema y siembra 2 usuarios de prueba
npm run dev                    # game server (:2567) + Next.js (:3000)
```

Abre `http://localhost:3000` en dos ventanas separadas (una en incognito),
entra como **Ana** en una y como **Beto** en la otra, y elige la misma apuesta
en ambas. El matchmaking las empareja.

Si ya tienes otro Postgres en el 5432, pon `POSTGRES_PORT=5433` en `.env` y
cambia el puerto de `DATABASE_URL` a juego.

Pruebas:

```bash
npm test -w @ah/game-server         # 37 unitarias: anti-cheat, codec, netcode
npm test -w @ah/web                 # 11 unitarias: impactos y particulas
npm run test:e2e -w @ah/game-server  # end-to-end Air Hockey
npm run test:mines -w @ah/game-server # end-to-end Minas
npm run test:afk -w @ah/game-server   # Minas: penalizacion por tiempo
npm run bench -w @ah/game-server    # latencia, cadencia y ancho de banda
npm run typecheck -w @ah/web        # build de verificacion aislada del dev
```

Las pruebas piden un puerto libre al sistema, asi que se pueden correr con el
juego levantado. `typecheck` escribe en `.next-check` para no pisar los
artefactos del servidor de desarrollo.

La e2e levanta el servidor, conecta dos clientes por WebSocket, juega, y
comprueba contra la base que el dinero se movio exactamente como debia —
incluido que el diario reconstruye cada saldo y que el premio se pago una
sola vez.

---

## 3. Modelo de datos

| Tabla             | Para que                                                                 |
| ----------------- | ------------------------------------------------------------------------ |
| `users`           | Cuentas. Incluye `status` (con `self_excluded`) y `kyc_status`.           |
| `wallets`         | Saldo por usuario: `available` (apostable), `locked` (en escrow), `withdrawable` (retirable) y `bonus` (promociones, reservado). |
| `ledger_entries`  | Diario contable append-only. La verdad auditable de cada peso.            |
| `matches`         | Partida: apuesta, estado, marcador, pozo, comision, ganador, semilla.     |
| `match_players`   | Los dos participantes, su asiento, cuanto bloquearon y su resultado.      |
| `match_events`    | Bitacora: goles, desconexiones, inputs rechazados. Para disputas.         |
| `cashier_transactions` | Cajero: intentos de deposito/retiro con Nequi, DaviPlata, PSE o tarjeta, antes de volverse un movimiento de saldo. |

Garantias que impone el motor, no el codigo de aplicacion:

- `CHECK (available >= 0)` y `CHECK (locked >= 0)` — un saldo negativo es
  imposible por construccion.
- `ledger_entries.idempotency_key UNIQUE` — un reintento no puede pagar dos
  veces.
- Triggers que bloquean `UPDATE` y `DELETE` sobre el diario — es inmutable.
- Indice parcial `match_players (user_id) WHERE result IS NULL` — un usuario no
  puede tener dinero bloqueado en dos partidas a la vez. Esto cierra el truco de
  apostar el mismo saldo en dos pestañas.

Todos los montos son **BIGINT en pesos enteros**. Nunca float.

---

## 4. Flujo del dinero

```
  MATCHMAKING          ESCROW               PARTIDA            LIQUIDACION
 ┌──────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
 │ cola por     │──▶│ 1 transaccion │──▶│ fisica 60 Hz  │──▶│ 1 transaccion │
 │ monto de     │   │ los 2 o nadie │   │ en el servidor│   │ idempotente   │
 │ apuesta      │   └───────────────┘   └───────────────┘   └───────────────┘
 └──────────────┘
```

**1. Matchmaking.** El cliente abre el socket con `{ token, stake }`. Un
middleware verifica el JWT antes de que la conexion exista; despues
`MatchManager` comprueba que la cuenta este habilitada, que no haya otra
partida abierta y que alcance el saldo, y lo pone en la cola de ese monto. Con
dos en cola, nace la sala.

**2. Escrow.** Con los dos jugadores dentro, la sala se cierra y corre **una
sola transaccion**:

```
BEGIN
  SELECT ... FROM matches WHERE id = $1 FOR UPDATE
  SELECT ... FROM wallets WHERE user_id = ANY($1) ORDER BY user_id FOR UPDATE
  -- verifica saldo de LOS DOS antes de tocar nada
  INSERT match_players  (x2)
  UPDATE wallets SET available -= 1000, locked += 1000   (x2)
  INSERT ledger_entries kind='BET_HOLD'                  (x2)
  UPDATE matches SET status='escrowed', pot=2000
COMMIT
```

Si a cualquiera le falta saldo, **rollback completo**: nadie queda con dinero
retenido y la partida no arranca. El `ORDER BY user_id` en el `FOR UPDATE` fija
un orden global de bloqueo y elimina los deadlocks entre partidas simultaneas.

**3. Partida.** El servidor simula. El cliente manda `{x, y}` y recibe estado.

**4. Liquidacion** — apuesta 1.000 COP, comision 5% (`RAKE_BPS=500`):

| Cuenta   | Movimiento                     | `available` | `locked` |
| -------- | ------------------------------ | ----------- | -------- |
| Ganador  | `BET_RELEASE` (recupera lo suyo) | +1.000    | −1.000   |
| Ganador  | `BET_WIN` (gana lo del rival)    | +900      | 0        |
| Perdedor | `BET_LOSS`                       | 0         | −1.000   |
| Casa     | `RAKE`                           | +100      | 0        |

Suma de `amount` = +2.000. Suma de `locked_delta` = −2.000. **El sistema
cuadra al peso.** El ganador recibe 1.900 y termina +900 respecto de antes de
apostar.

El redondeo del rake es `Math.floor`, asi que cuando no da exacto el resto se
lo queda el jugador, nunca la casa.

**Anulacion.** Si la partida no llega a jugarse (fallo de escrow, caida de los
dos jugadores, crash del servidor), se devuelve la apuesta **intacta y sin
comision**: si no hubo juego, la casa no cobra.

---

## 4 bis. Minas 1v1

Juego **a ciegas** por turnos, sobre el mismo escrow.

**Reglas.** Tablero N x N (5, 6 u 8) con ~20% de minas. Cada jugador arranca
con **3 vidas**. Turnos estrictos: **una casilla por turno** — al destaparla,
sea lo que sea, el turno pasa inmediatamente al rival.

- Casilla **segura**: aparece una gema y no pasa nada mas.
- **Mina**: explota, el jugador pierde 1 vida, y la casilla queda visible para
  los dos.
- **10 segundos** por turno. Si se agotan, ese jugador pierde 1 vida por
  ausencia y pasa el turno. **Dos ausencias seguidas y pierde por abandono.**

**Final.** Quien llega a 0 vidas pierde y el pozo es del rival. Si se despejan
todas las casillas seguras antes, gana quien conserve **mas vidas**; empate a
vidas se anula y se devuelven las apuestas.

**No hay numeros adyacentes.** Destapar una casilla no dice absolutamente nada
de sus vecinas: no existe deduccion posible y cada eleccion es una apuesta a
ciegas contra la proporcion de minas que queda. Es azar puro por diseño — lo
que conviene tener presente, porque **un juego sin componente de habilidad se
clasifica distinto ante el regulador** que uno de destreza como Air Hockey.

**Donde vive el tablero.** La matriz de minas existe SOLO en la memoria de
`MinesRoom`. El cliente recibe `revealedTiles`, donde todo lo no destapado
vale `TILE_HIDDEN`: no hay forma de leer una mina desde el navegador, ni
parcheando el JavaScript, ni inspeccionando el trafico.

**Juego limpio demostrable.** La semilla se genera con
`crypto.randomBytes(32)`. Pero un CSPRNG solo prueba que el tablero es
impredecible; no le prueba nada *al jugador*. Por eso:

1. antes de la primera jugada el servidor publica `commit = sha256(semilla)`;
2. al terminar revela la semilla;
3. el jugador comprueba el hash y **recalcula el tablero** con
   `deriveMinePositions`, verificando que las minas estuvieron donde
   estuvieron desde el principio.

La pantalla de fin de partida trae un boton **"Verificar tablero"** que hace
exactamente eso en el navegador. En un juego que es puro azar esto no es un
adorno: es lo unico que separa "el tablero es aleatorio" de una promesa.

---

## 5. Anti-cheat

Ver [`SECURITY.md`](./SECURITY.md) para el detalle. En una linea: el navegador
solo puede expresar hacia donde quiere mover su mazo, y el servidor decide si
eso es fisicamente posible.

---

## 6. Antes de operar con dinero real

Esta es la base tecnica, no un producto listo para produccion. Falta:

- **Licencia de Coljuegos.** En Colombia el juego con dinero real requiere
  autorizacion; operar sin ella expone a bloqueo de dominio y sancion.
- Autenticacion real (contraseña/OTP), KYC y verificacion de edad.
- Pasarela de pagos para depositos y retiros (hoy `DEPOSIT` solo existe en la
  semilla de desarrollo).
- Limites de juego responsable: tope de perdida diaria, autoexclusion efectiva,
  pausas obligadas.
- Deteccion de colusion y de multi-cuenta (dos cuentas del mismo dueño
  repartiendose el rake).
- Emparejamiento compartido si corres mas de una instancia del game server: hoy
  las colas viven en memoria del proceso, asi que dos instancias no se emparejan
  entre si. Se resuelve con el adaptador de Redis de Socket.io y una cola en
  Redis (el contenedor ya esta en `docker-compose.yml`).
- Observabilidad: metricas de tick, alertas sobre `settlement_failed`.
