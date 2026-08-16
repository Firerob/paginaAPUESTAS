import * as crypto from "node:crypto";
import type { Socket } from "socket.io";
import {
  BLACKJACK_LIVES,
  BLACKJACK_ROULETTE_MS,
  BLACKJACK_SHOWDOWN_MS,
  BLACKJACK_TURN_SECONDS,
  BlackjackClientMessage,
  BlackjackServerMessage,
  deriveShuffledDeck,
  handTotal,
  isNaturalBlackjack,
  type BlackjackFairnessPayload,
  type BlackjackPhase,
  type BlackjackState,
  type Card,
  type Seat,
} from "@ah/shared";
import { revealSeed, updateScore } from "../services/match.service";
import { BaseMatchRoom, type RoomPlayer } from "./BaseMatchRoom";

/** Como maximo cuantas jugadas por segundo acepta el servidor de un cliente. */
const ACTION_RATE_LIMIT_HZ = 6;

/** Cada cuanto se comprueba si expiro el turno. Ver el comentario igual en MinesRoom. */
const TURN_TICK_MS = 250;

interface BlackjackPlayerState {
  lives: number;
  timeouts: number;
  lastAction: number;
  actionTokens: number;
}

/**
 * Sala de Blackjack Arena 1v1.
 *
 * ---------------------------------------------------------------------------
 * Visibilidad asimetrica: la diferencia real con Minas
 * ---------------------------------------------------------------------------
 * En Minas el tablero oculto lo es para LOS DOS jugadores por igual — un
 * unico `emitAll(STATE, ...)` alcanza. Aca no: cada jugador ve sus propias
 * dos cartas completas, pero del rival solo ve la carta visible; la oculta
 * viaja como `null` HASTA que el servidor decide revelarla (bust, blackjack
 * natural o showdown). Por eso no existe un `broadcastState()` que mande el
 * mismo payload a los dos — `buildStateFor(player)` redacta la mano del
 * rival por separado para cada uno, y ESE es el unico lugar donde una carta
 * oculta podria filtrarse por error. Cualquier cambio a esta clase que toque
 * el reparto de cartas tiene que pasar por ahi.
 *
 * ---------------------------------------------------------------------------
 * Juego limpio demostrable
 * ---------------------------------------------------------------------------
 * Una semilla de 32 bytes (CSPRNG) por partida, comprometida con
 * sha256(seed) antes de la primera carta. Cada ronda baraja su propio mazo
 * de 52 cartas con `deriveShuffledDeck(seed, round)` — determinista, para
 * que la semilla revelada al final permita reconstruir y verificar cada
 * ronda jugada, exactamente como en Minas.
 */
export class BlackjackRoom extends BaseMatchRoom {
  private readonly seed: string;
  private readonly commit: string;

  private round = 0;
  private deck: Card[] = [];
  private deckCursor = 0;
  private hands: [Card[], Card[]] = [[], []];
  /** Esta ronda, ¿ya se revelo la carta oculta de los dos? */
  private holeRevealed = false;
  /** Ya no puede actuar esta ronda (se planto o se paso). */
  private done: [boolean, boolean] = [false, false];
  private busted: [boolean, boolean] = [false, false];

  private phase: BlackjackPhase = "waiting";
  private startingSeat: Seat = 0;
  /** Resultado del UNICO sorteo de la partida (ronda 1). Ver `startRound`. */
  private initialStartingSeat: Seat = 0;
  private currentTurnSeat: Seat = 0;
  private turnEndsAt = 0;
  private turnLoop: NodeJS.Timeout | null = null;
  /** Bloqueo durante la animacion de revelacion/showdown. */
  private locked = false;

  private own = new Map<string, BlackjackPlayerState>();

  constructor(stake: number, onDisposed: (room: BaseMatchRoom) => void) {
    super("blackjack", stake, onDisposed);
    this.seed = crypto.randomBytes(32).toString("hex");
    this.commit = crypto.createHash("sha256").update(this.seed).digest("hex");
  }

  // -------------------------------------------------------------------------
  // Contrato con la clase base
  // -------------------------------------------------------------------------

  protected gameConfig(): Record<string, unknown> {
    return {
      lives: BLACKJACK_LIVES,
      turnSeconds: BLACKJACK_TURN_SECONDS,
    };
  }

  protected commitHash(): string {
    return this.commit;
  }

  protected gameEventNames(): string[] {
    return [BlackjackClientMessage.HIT, BlackjackClientMessage.STAND];
  }

  protected bindGameEvents(player: RoomPlayer, socket: Socket): void {
    if (!this.own.has(player.userId)) {
      this.own.set(player.userId, {
        lives: BLACKJACK_LIVES,
        timeouts: 0,
        lastAction: Date.now(),
        actionTokens: ACTION_RATE_LIMIT_HZ,
      });
    }
    socket.on(BlackjackClientMessage.HIT, () => this.hit(player));
    socket.on(BlackjackClientMessage.STAND, () => this.stand(player, false));
  }

  protected onMatchStart(): void {
    this.turnLoop = setInterval(() => this.checkTurnExpiry(), TURN_TICK_MS);
    this.startRound();
  }

  protected onMatchStop(): void {
    if (this.turnLoop) clearInterval(this.turnLoop);
    this.turnLoop = null;
  }

  /** Lo que se persiste como marcador son las VIDAS restantes, igual que en Minas. */
  protected currentScores(): [number, number] {
    return [this.livesOf(0), this.livesOf(1)];
  }

  protected sendSnapshot(player: RoomPlayer): void {
    player.socket?.emit(BlackjackServerMessage.STATE, this.buildStateFor(player));
  }

  protected onConnectionChange(): void {
    this.broadcastState();
  }

  // -------------------------------------------------------------------------
  // Ronda: reparto y sorteo
  // -------------------------------------------------------------------------

  /**
   * Arranca la ronda. El sorteo (ruleta) solo pasa en la RONDA 1: decide
   * quien arranca la partida y de ahi en adelante el turno de salida se
   * alterna solo entre los dos, ronda a ronda, sin volver a sortear ni a
   * mostrar la ruleta otra vez.
   *
   * En la ronda 1 el reparto NO pasa aca: se dispara despues de
   * `BLACKJACK_ROULETTE_MS` en `dealCards()`, para dejarle tiempo a la
   * cuenta regresiva + el giro de la ruleta del cliente a jugarse completos
   * antes de que aparezcan las cartas. Los dos jugadores reciben el mismo
   * evento al mismo tiempo, asi que la ruleta que ven es la misma y termina
   * en el mismo resultado — no es cosmetica de un solo lado.
   */
  private startRound(): void {
    this.round += 1;
    this.deck = deriveShuffledDeck(this.seed, this.round);
    this.deckCursor = 0;
    this.hands = [[], []];
    this.holeRevealed = false;
    this.done = [false, false];
    this.busted = [false, false];
    this.locked = true;
    this.phase = "dealing";

    if (this.round === 1) {
      // La primera carta del mazo ya barajado (determinista y verificable
      // desde `seed` + `round`) decide quien arranca. No hace falta una
      // fuente de azar aparte para el sorteo.
      this.initialStartingSeat = (this.deck[0] % 2) as Seat;
      this.startingSeat = this.initialStartingSeat;
      this.currentTurnSeat = this.startingSeat;
      void this.record("roulette", { round: this.round, startingSeat: this.startingSeat });
      this.emitAll(BlackjackServerMessage.ROULETTE, {
        round: this.round,
        startingSeat: this.startingSeat,
      });
      // Mesa limpia (manos vacias) mientras gira la ruleta.
      this.broadcastState();

      setTimeout(() => {
        // La sala se pudo haber cerrado durante la pausa (forfeit, caida sin
        // reconexion, apagado del servidor): no repartir en una sala muerta.
        if (this.settled || this.disposed) return;
        this.dealCards();
      }, BLACKJACK_ROULETTE_MS).unref();
      return;
    }

    // Rondas siguientes: sin sorteo ni pausa nueva. Si en la ronda 1 arranco
    // el asiento A, en la ronda 2 arranca el B, en la 3 otra vez A... Se
    // reparte de una, la pausa entre rondas ya la dio `afterRoundPause`.
    this.startingSeat = ((this.initialStartingSeat + (this.round - 1)) % 2) as Seat;
    this.currentTurnSeat = this.startingSeat;
    this.dealCards();
  }

  private dealCards(): void {
    this.locked = false;

    // Reparto en orden: 1 visible a cada uno, despues 1 oculta a cada uno.
    this.hands[0].push(this.draw());
    this.hands[1].push(this.draw());
    this.hands[0].push(this.draw());
    this.hands[1].push(this.draw());

    void this.record("deal", { round: this.round, startingSeat: this.startingSeat });
    this.broadcastState();

    const nat0 = isNaturalBlackjack(this.hands[0]);
    const nat1 = isNaturalBlackjack(this.hands[1]);
    if (nat0 || nat1) {
      this.resolveNatural(nat0, nat1);
      return;
    }

    this.phase = "playing";
    this.resetTurnClock();
    this.broadcastState();
  }

  private draw(): Card {
    if (this.deckCursor >= this.deck.length) {
      // No deberia pasar nunca en una mano real (52 cartas alcanzan de
      // sobra), pero si pasara es mas seguro devolver la ultima carta que
      // salirse del arreglo.
      return this.deck[this.deck.length - 1];
    }
    const card = this.deck[this.deckCursor];
    this.deckCursor += 1;
    return card;
  }

  // -------------------------------------------------------------------------
  // Jugadas: pedir carta / plantarse
  // -------------------------------------------------------------------------

  private hit(player: RoomPlayer): void {
    const own = this.own.get(player.userId);
    if (!own) return;

    if (this.phase !== "playing") return this.reject(player, "not_playing");
    if (!this.consumeAction(own)) return this.reject(player, "rate_limited");
    if (player.seat !== this.currentTurnSeat || this.done[player.seat] || this.locked) {
      return this.reject(player, "not_your_turn");
    }

    own.timeouts = 0;

    if (this.deckCursor >= this.deck.length) {
      this.stand(player, true);
      return;
    }

    const card = this.draw();
    this.hands[player.seat].push(card);
    const total = handTotal(this.hands[player.seat]);
    void this.record("hit", { round: this.round, seat: player.seat, card, total }, player);

    if (total > 21) {
      this.busted[player.seat] = true;
      this.done[player.seat] = true;
      this.resolveBust(player.seat);
      return;
    }

    this.broadcastState();

    // 21 a fuerza de pedir no es blackjack natural, pero no tiene sentido
    // pedir otra: se planta en automatico.
    if (total === 21) this.stand(player, true);
  }

  private stand(player: RoomPlayer, auto: boolean): void {
    const own = this.own.get(player.userId);
    if (!own) return;

    if (!auto) {
      if (this.phase !== "playing") return this.reject(player, "not_playing");
      if (!this.consumeAction(own)) return this.reject(player, "rate_limited");
      if (player.seat !== this.currentTurnSeat || this.done[player.seat] || this.locked) {
        return this.reject(player, "not_your_turn");
      }
      own.timeouts = 0;
    }

    this.done[player.seat] = true;
    void this.record(
      "stand",
      { round: this.round, seat: player.seat, total: handTotal(this.hands[player.seat]), auto },
      player,
    );

    const rival = this.opponentOf(player);
    if (rival && !this.done[rival.seat]) {
      this.currentTurnSeat = rival.seat;
      this.resetTurnClock();
      this.broadcastState();
      return;
    }

    // Si el rival se hubiera pasado de 21, la ronda ya habria terminado en
    // `resolveBust` antes de llegar aca: los dos "done" sin bust significa
    // que los dos se plantaron limpio.
    this.showdown();
  }

  // -------------------------------------------------------------------------
  // Finales de ronda
  // -------------------------------------------------------------------------

  private resolveNatural(nat0: boolean, nat1: boolean): void {
    this.holeRevealed = true;
    this.phase = "showdown";
    this.locked = true;
    this.broadcastState();

    const loserSeat: Seat | null = nat0 && !nat1 ? 1 : nat1 && !nat0 ? 0 : null;
    const livesAfter = loserSeat !== null ? this.applyLifeLoss(loserSeat, "natural_blackjack") : this.currentScores();

    this.emitAll(BlackjackServerMessage.NATURAL, {
      round: this.round,
      seat0Blackjack: nat0,
      seat1Blackjack: nat1,
      hands: [this.hands[0], this.hands[1]],
      loserSeat,
      livesAfter,
    });

    this.afterRoundPause();
  }

  private resolveBust(seat: Seat): void {
    this.holeRevealed = true;
    this.phase = "showdown";
    this.locked = true;
    this.broadcastState();

    const total = handTotal(this.hands[seat]);
    const livesAfter = this.applyLifeLoss(seat, "bust");

    this.emitAll(BlackjackServerMessage.BUST, {
      round: this.round,
      seat,
      total,
      hands: [this.hands[0], this.hands[1]],
      livesAfter,
    });

    this.afterRoundPause();
  }

  /**
   * Se le acabo el tiempo del turno: pierde la ronda en el acto, igual que
   * un bust. Esta es la UNICA consecuencia de quedarse sin tiempo — nunca
   * abandono ni fin de partida instantaneo, eso solo pasa por una
   * desconexion real (ver `disconnectedPlayer` arriba y `BaseMatchRoom`).
   */
  private resolveTimeout(seat: Seat, strikes: number): void {
    this.holeRevealed = true;
    this.phase = "showdown";
    this.locked = true;
    this.broadcastState();

    const livesAfter = this.applyLifeLoss(seat, "timeout");

    this.emitAll(BlackjackServerMessage.TIMEOUT, {
      round: this.round,
      seat,
      strikes,
      hands: [this.hands[0], this.hands[1]],
      livesAfter,
    });

    this.afterRoundPause();
  }

  private showdown(): void {
    this.holeRevealed = true;
    this.phase = "showdown";
    this.locked = true;

    const total0 = handTotal(this.hands[0]);
    const total1 = handTotal(this.hands[1]);
    this.broadcastState();

    const loserSeat: Seat | null = total0 === total1 ? null : total0 < total1 ? 0 : 1;
    const livesAfter = loserSeat !== null ? this.applyLifeLoss(loserSeat, "showdown") : this.currentScores();

    void this.record("showdown", { round: this.round, total0, total1, loserSeat });

    this.emitAll(BlackjackServerMessage.SHOWDOWN, {
      round: this.round,
      hands: [this.hands[0], this.hands[1]],
      totals: [total0, total1],
      loserSeat,
      livesAfter,
    });

    this.afterRoundPause();
  }

  /** Resta 1 vida y devuelve el marcador actualizado. */
  private applyLifeLoss(seat: Seat, cause: string): [number, number] {
    const player = this.playerAt(seat);
    const own = player ? this.own.get(player.userId) : undefined;
    if (player && own) {
      own.lives -= 1;
      void this.record("life_lost", { round: this.round, seat, cause, livesLeft: own.lives }, player);
      if (this.matchId) {
        const [home, away] = this.currentScores();
        void updateScore(this.matchId, home, away);
      }
    }
    return this.currentScores();
  }

  /** Deja las cartas y los totales a la vista 3s, despues limpia y sigue o cierra la partida. */
  private afterRoundPause(): void {
    setTimeout(() => {
      // La sala se pudo haber cerrado mientras tanto (forfeit, caida sin
      // reconexion, apagado del servidor): no seguir jugando una sala muerta.
      if (this.phase !== "showdown") return;

      const [lives0, lives1] = this.currentScores();
      if (lives0 <= 0 || lives1 <= 0) {
        this.finishByLives(lives0 <= 0 ? 1 : 0);
        return;
      }
      this.startRound();
    }, BLACKJACK_SHOWDOWN_MS).unref();
  }

  private finishByLives(winnerSeat: Seat): void {
    this.phase = "finished";
    // Sin esto el cliente se queda leyendo el ultimo STATE que le llego
    // (phase="showdown"), mostrando "REVELANDO CARTAS..." indefinidamente
    // hasta que llegue MATCH_RESULT — que puede tardar (o, si la liquidacion
    // fallara, no llegar nunca por este camino). Un broadcast mas resuelve
    // el HUD de inmediato, antes de que la liquidacion siquiera empiece.
    this.broadcastState();
    this.publishFairness();
    void this.record("out_of_lives", { winnerSeat });

    const winner = this.playerAt(winnerSeat);
    if (winner) void this.endMatch(winner, "score");
    else void this.abortMatch("error");
  }

  // -------------------------------------------------------------------------
  // Turnos y temporizador
  // -------------------------------------------------------------------------

  private resetTurnClock(): void {
    this.turnEndsAt = Date.now() + BLACKJACK_TURN_SECONDS * 1000;
  }

  /**
   * Vigila el reloj del turno. Igual que en Minas: se congela con un
   * jugador caido, para no penalizar una desconexion dos veces (eso lo
   * resuelve `BaseMatchRoom` por su cuenta, con su propio plazo de
   * reconexion). Quedarse sin tiempo estando conectado, en cambio, pierde la
   * ronda en el acto: la unica consecuencia es perder 1 vida, nunca el
   * abandono de la partida completa.
   */
  private checkTurnExpiry(): void {
    if (this.phase !== "playing" || this.locked) return;
    if (this.disconnectedPlayer()) {
      this.resetTurnClock();
      return;
    }
    if (Date.now() < this.turnEndsAt) return;

    const player = this.playerAt(this.currentTurnSeat);
    const own = player ? this.own.get(player.userId) : undefined;
    if (!player || !own) return;

    own.timeouts += 1;
    void this.record("timeout", { round: this.round, seat: player.seat, strikes: own.timeouts }, player);
    this.resolveTimeout(player.seat, own.timeouts);
  }

  // -------------------------------------------------------------------------
  // Estado publico — redactado por jugador
  // -------------------------------------------------------------------------

  /**
   * Construye el estado que le toca a ESTE jugador. La carta oculta del
   * rival (indice 1 de su mano) viaja como `null` mientras `holeRevealed`
   * sea falso: es el unico punto de toda la clase donde esa carta podria
   * filtrarse, y aca se corta.
   */
  private buildStateFor(player: RoomPlayer): BlackjackState {
    const mySeat = player.seat;
    const rivalSeat: Seat = mySeat === 0 ? 1 : 0;
    const myHand = [...this.hands[mySeat]];
    const opponentHand: (Card | null)[] = this.hands[rivalSeat].map((card, i) =>
      i === 1 && !this.holeRevealed ? null : card,
    );
    const opponentVisible = opponentHand.filter((c): c is Card => c !== null);

    return {
      phase: this.phase,
      round: this.round,
      lives: this.currentScores(),
      timeouts: [this.timeoutsOf(0), this.timeoutsOf(1)],
      currentTurnSeat: this.currentTurnSeat,
      turnMs: Math.max(0, this.turnEndsAt - Date.now()),
      startingSeat: this.startingSeat,
      myHand,
      opponentHand,
      myTotal: handTotal(myHand),
      opponentTotal: opponentVisible.length ? handTotal(opponentVisible) : 0,
      myStood: this.done[mySeat] && !this.busted[mySeat],
      opponentStood: this.done[rivalSeat] && !this.busted[rivalSeat],
      myBusted: this.busted[mySeat],
      opponentBusted: this.busted[rivalSeat],
      commit: this.commit,
    };
  }

  private broadcastState(): void {
    for (const player of this.players) {
      player.socket?.emit(BlackjackServerMessage.STATE, this.buildStateFor(player));
    }
  }

  /** Revela la semilla. Solo cuando la partida ya termino. */
  private publishFairness(): void {
    const payload: BlackjackFairnessPayload = {
      commit: this.commit,
      seed: this.seed,
      roundsPlayed: this.round,
    };
    this.emitAll(BlackjackServerMessage.FAIRNESS, payload);
    if (this.matchId) void revealSeed(this.matchId);
  }

  // -------------------------------------------------------------------------
  // Validacion y utilidades
  // -------------------------------------------------------------------------

  /** Cubeta de tokens: igual que en Minas, un cliente automatizado no inunda el turno. */
  private consumeAction(own: BlackjackPlayerState): boolean {
    const now = Date.now();
    const elapsed = (now - own.lastAction) / 1000;
    own.lastAction = now;
    own.actionTokens = Math.min(
      ACTION_RATE_LIMIT_HZ,
      own.actionTokens + elapsed * ACTION_RATE_LIMIT_HZ,
    );
    if (own.actionTokens < 1) return false;
    own.actionTokens -= 1;
    return true;
  }

  private reject(player: RoomPlayer, reason: string): void {
    player.socket?.emit(BlackjackServerMessage.REJECTED, { reason });
  }

  private livesOf(seat: Seat): number {
    const player = this.playerAt(seat);
    return player ? (this.own.get(player.userId)?.lives ?? BLACKJACK_LIVES) : BLACKJACK_LIVES;
  }

  private timeoutsOf(seat: Seat): number {
    const player = this.playerAt(seat);
    return player ? (this.own.get(player.userId)?.timeouts ?? 0) : 0;
  }
}
