# Modelo de seguridad y anti-cheat

## Principio

El navegador es territorio hostil. Se asume que el jugador tiene DevTools
abierto, el runtime de JavaScript parcheado, un proxy interceptando el
WebSocket y todo el tiempo del mundo. Bajo ese supuesto, la unica pregunta que
importa es: **¿que puede afirmar el cliente que el servidor tenga que creer?**

Respuesta en este sistema: hacia donde quiere mover su mazo. Nada mas.

---

## 1. Fisica del lado del servidor

`apps/game-server/src/game/physics.ts` es la unica fisica que existe. Corre a
**60 ticks fijos por segundo** dentro de la sala.

- **Paso fijo, no delta real.** `dt` es siempre `1/60`. Si el proceso se
  atrasa, se ejecutan varios ticks cortos, nunca uno largo
  (`MAX_CATCHUP_TICKS` acota la recuperacion). Una fisica que dependiera de la
  carga del servidor no seria reproducible, y con dinero de por medio hay que
  poder reproducir una partida ante una disputa.
- **Subpasos de colision.** Cada tick se divide en 4 subpasos, de modo que un
  disco a 1.800 u/s no atraviese un mazo.
- **Reloj monotonico, no `setInterval`.** Los limites de tick se fijan en
  tiempo absoluto con `process.hrtime.bigint()`. Medido aqui, `setInterval`
  entregaba 27.3 ms de media pidiendo 16.67 — la simulacion avanzaba a
  tirones y regalaba latencia de entrada. Ver `game/FixedClock.ts`.
- **El cliente no tiene una copia de la fisica.** `apps/web` no importa nada
  de `game/physics.ts`: ni colisiones, ni disco, ni goles. Lo unico compartido
  es la cinematica del mazo (seccion 2 bis).

## 2. Como muere el teletransporte

Un cliente parcheado envia `{x: 50, y: 950}` estando en `{x: 300, y: 800}`.

1. `sanitizeTarget()` valida el tipo, descarta `NaN`/`Infinity` y recorta el
   objetivo a la mitad de cancha propia.
2. `integrateMallet()` mueve el mazo hacia ese objetivo **como maximo
   `MALLET_MAX_SPEED * dt`** — unas 23 unidades por tick.
3. La velocidad del mazo se calcula como `(posNueva - posVieja) / dt`, es decir
   **del desplazamiento que realmente ocurrio**, no de nada que mande el
   cliente.

El punto 3 es el que cierra el circulo. Aunque alguien encontrara la forma de
saltarse el recorte de posicion, la velocidad con la que puede golpear el disco
sigue derivandose del movimiento real, que esta acotado. **No existe camino por
el que un script local pegue mas fuerte que un humano.**

Cubierto por los tests `ANTI-CHEAT: el mazo no se teletransporta` y
`ANTI-CHEAT: la velocidad del mazo sale del desplazamiento real`.

## 2 bis. Prediccion local: por que no debilita el modelo

El mazo propio se dibuja de una prediccion local, no del estado que llega del
servidor. Eso da respuesta de 0 ms, y no cede ni un gramo de autoridad:

- La prediccion decide **pixeles**, no fisica. La posicion que entra en las
  colisiones, en el calculo del golpe y en los goles es siempre la del
  servidor.
- El cliente reaplica sus inputs pendientes sobre la posicion autoritativa en
  cada instantanea. Si el servidor recorto o rechazo un movimiento, la
  correccion aparece de inmediato y **gana el servidor**.
- El paso del mazo (`stepMalletToward`) vive una sola vez, en
  `packages/shared/src/simulation.ts`, y lo usan servidor y cliente. No hay dos
  implementaciones que puedan desincronizarse.
- Predecir mas rapido no sirve de nada: el limite de velocidad se aplica en el
  servidor, sobre el desplazamiento real. Un cliente que prediga un mazo
  volando solo consigue que su propia prediccion se corrija cada 16 ms.

### Por que NO hay lag compensation con rewind

El rewind clasico (rebobinar el estado del servidor a lo que veia el cliente
para validar un impacto) existe para proyectiles instantaneos. Aqui el mazo es
control directo, y aplicarlo tendria un efecto perverso: **un jugador que
añade latencia a proposito ganaria ventana de golpeo**, porque el servidor
retrocederia mas tiempo para complacerlo. En un juego con dinero real eso es
un vector de trampa, no una mejora.

La decision es explicita: prediccion + reconciliacion + suavizado, sin rewind.
El unico que decide donde estaba cada cosa es el servidor, en su propio
presente.

## 3. Que no puede tocar el cliente

| Dato                       | Quien lo calcula | Como llega al cliente |
| -------------------------- | ---------------- | --------------------- |
| Posicion del disco         | Servidor         | Estado replicado      |
| Velocidad del disco        | Servidor         | Estado replicado      |
| Colisiones                 | Servidor         | —                     |
| Goles                      | Servidor         | Estado + mensaje      |
| Marcador                   | Servidor         | Estado replicado      |
| Fin de partida y ganador   | Servidor         | Mensaje               |
| Saldo y liquidacion        | Servidor (+ BD)  | Mensaje               |
| Posicion del mazo propio   | Servidor         | Instantanea `state` (la prediccion local solo dibuja) |
| **Objetivo del mazo propio** | **Cliente**    | ← unico canal de entrada |

El estado viaja en una sola direccion. El servidor emite `state` 60 veces por
segundo (paquete binario de 34 bytes) y no existe ningun evento por el que el
cliente escriba en el. Editar el marcador en la memoria del navegador solo se
sostiene hasta la siguiente instantanea, ~17 ms despues.

El formato binario no es una medida de seguridad — un atacante puede leer el
codec, que esta en el repositorio — pero si reduce la superficie: los campos
tienen tamaño fijo y los valores fuera de rango se recortan al codificar en
vez de envolverse.

El servidor acepta exactamente tres eventos del cliente — `input`, `ping` y
`forfeit` — y cualquier otro nombre de evento simplemente no tiene handler.

## 4. Autenticacion del socket

- El WebSocket se autentica en un middleware `io.use()` **antes** de que la
  conexion exista. Sin token valido no hay socket.
- El `userId` sale del `sub` del JWT verificado. **Nunca** de un mensaje.
- `algorithms: ["HS256"]` fijo al verificar: bloquea el ataque `alg: none`.
- Ademas de la firma se consulta la base: un token valido de una cuenta
  suspendida o autoexcluida no entra.
- `duplicate_user` impide que la misma cuenta ocupe los dos asientos.
- El indice parcial `match_players (user_id) WHERE result IS NULL` impide tener
  dinero bloqueado en dos partidas simultaneas.

## 5. Contra la inundacion de mensajes

- **Cubeta de tokens** por jugador a `INPUT_RATE_LIMIT_HZ` (90/s). Por encima
  de eso los inputs se descartan.
- `maxHttpBufferSize: 1024`: el unico mensaje legitimo es un input de 7 bytes,
  cualquier payload grande es basura o un intento de agotar memoria.
- El acuse de secuencia solo avanza (`seqDelta > 0`): un paquete reordenado o
  reenviado no puede hacer retroceder el estado del jugador.
- Solo transporte WebSocket (`transports: ["websocket"]`): sin long-polling.
- La telemetria de inputs rechazados se **agrupa** (maximo una fila cada 5 s
  por jugador). Escribir una fila por rechazo convertiria a un atacante en un
  ataque de escritura contra nuestra propia base.

## 6. Integridad del dinero

- Una transaccion por operacion; el escrow es todo-o-nada.
- `FOR UPDATE` sobre las wallets **siempre ordenadas por `user_id`**: orden
  global de bloqueo, sin deadlocks.
- `idempotency_key` unica por movimiento: un reintento revienta contra la
  restriccion UNIQUE y revierte la transaccion entera. Imposible pagar dos veces.
- `settleMatch` es idempotente por dos vias independientes: el chequeo de
  `settled_at` bajo `FOR UPDATE`, y las claves del diario.
- `this.settled = true` se marca **antes** del `await`, para que dos caminos
  simultaneos (gol y expiracion de reconexion en el mismo tick) no liquiden dos
  veces.
- El diario es inmutable a nivel de motor: triggers que abortan cualquier
  `UPDATE` o `DELETE` sobre `ledger_entries`. Ni siquiera un bug nuestro puede
  reescribir la historia contable.
- Si la liquidacion falla, **no se toca el dinero a ciegas**: la partida queda
  sin liquidar y la resuelve el sweeper. Perder una liquidacion es un incidente
  recuperable; pagar dos veces es un agujero.

## 7. Desconexiones y abandono

| Situacion                          | Resultado                                  |
| ---------------------------------- | ------------------------------------------ |
| Se cae la conexion                 | Partida **congelada** 15 s, ventana de reconexion |
| Vuelve dentro de la ventana        | Se retoma donde quedo                      |
| No vuelve                          | Derrota por abandono, el pozo al conectado |
| Sale voluntariamente (`leave`)     | Derrota inmediata por abandono             |
| Se caen los dos                    | Anulacion, devolucion integra              |
| Muere el proceso del servidor      | El **sweeper** anula y devuelve            |
| Empate al agotarse el tiempo       | Anulacion, devolucion integra              |

La partida se **congela** mientras alguien esta caido. Seguir simulando le
regalaria goles al que sigue conectado — un incentivo perverso a provocar
desconexiones en el rival.

Que el jugador pierda por un crash **nuestro** seria inaceptable, por eso la
resolucion automatica ante fallo de infraestructura es siempre devolucion,
nunca derrota.

## 7 bis. Minas: informacion oculta y juego limpio

El riesgo aqui es distinto al de Air Hockey. No hay fisica que falsear: hay
**informacion que no puede filtrarse**.

- La matriz de minas vive solo en memoria de `MinesRoom`. El estado publico
  (`buildState`) arranca con todas las casillas en `TILE_HIDDEN` y solo se
  rellena la que alguien acaba de destapar.
- Los arreglos se **copian** al construir el payload: devolver la referencia
  interna dejaria que un cambio posterior se colara en un mensaje ya emitido.
- **No se calculan ni se envian conteos de minas adyacentes.** Esa informacion
  ni siquiera se deriva en el servidor: no existe en ningun momento, asi que
  no hay nada que pueda filtrarse por error.
- La semilla se genera con `crypto.randomBytes(32)`, no con `Math.random()`.
  Un PRNG no criptografico es predecible desde unas pocas salidas observadas,
  y aqui eso significa poder leer el tablero.
- La semilla se revela **solo** al terminar (`publishFairness`), y la columna
  `matches.revealed_at` deja constancia de cuando.
- Quien empieza sale de la semilla, no del orden de llegada. Si empezara
  siempre el asiento 0, entrar primero seria una ventaja medible.

Validacion de cada jugada, en este orden y sin que ninguna confie en la
anterior: fase valida, cuota de mensajes, es tu turno, no hay animacion en
curso, el indice es un entero dentro del tablero, y la casilla sigue oculta.

**El reloj se congela con un jugador caido.** La ventana de reconexion ya
cubre ese caso; dejar correr el turno le quitaria vidas a alguien que no puede
jugar — castigarlo dos veces por la misma desconexion.

**Por que dos ausencias son abandono.** Sin ese limite, un jugador podria
dejar la partida colgada gastando sus tres vidas muy despacio, con 2.000 COP
bloqueados todo el rato. Dos ausencias seguidas cierran la partida y liberan
el dinero.

**Invariante de vidas.** Una vida solo se pierde por pisar una mina o por
ausencia. `test/e2e.mines.ts` lo comprueba: minas explotadas + ausencias tiene
que ser exactamente igual a las vidas perdidas por los dos jugadores. Si esa
cuenta no cuadrara, el servidor estaria restando vidas por un camino que no
anuncia — y las vidas deciden quien se lleva el pozo.

## 8. Lo que este diseño NO cubre

Honestidad sobre los limites:

- **Colusion.** Dos personas de acuerdo repartiendose partidas. Necesita
  analisis de patrones sobre `matches` y `match_events`, no defensa en tiempo
  real.
- **Multi-cuenta.** Un mismo dueño con dos cuentas. Necesita KYC y
  correlacion de dispositivo/pago.
- **Bots / aim assist.** Un script que mueve el mazo optimamente respeta todos
  los limites fisicos y es indistinguible de un jugador excepcional a nivel de
  protocolo. Se detecta por estadistica de comportamiento (varianza del
  movimiento, tiempos de reaccion sobrehumanamente consistentes), no por
  validacion de input. La bitacora `match_events` esta pensada para alimentar
  eso mas adelante.
- **Colusion en Minas.** Dos jugadores de acuerdo pueden dejar que uno agote
  sus vidas a proposito y transferirse saldo menos el rake. Es la misma
  familia de problema que la colusion en Air Hockey y se detecta igual: por
  estadistica sobre `match_events`, no en tiempo real.
- **Minas es azar puro, no habilidad.** Al no haber numeros adyacentes no hay
  deduccion posible, asi que ningun jugador puede ser mejor que otro. Eso no
  es un fallo del diseño —es lo pedido— pero cambia como se clasifica el juego
  ante el regulador y conviene que conste.
- **Ventaja por latencia.** Un jugador con 20 ms tiene ventaja real sobre uno
  con 150 ms. Se mitiga emparejando por region y por rango de ping.
- **DDoS y abuso de infraestructura.** Corresponde a la capa de red (WAF,
  rate limiting por IP), no a la sala.
