/**
 * Contrato de mensajes cliente <-> servidor (Socket.io).
 *
 * Regla de oro: el cliente solo puede expresar INTENCION. No envia posiciones
 * del disco, ni velocidades, ni goles, ni marcadores, ni timestamps, ni su
 * propio userId — ese sale del JWT verificado en el handshake. Cualquier
 * mensaje fuera de este contrato se descarta en el servidor.
 */

/** Eventos que el cliente puede emitir. Es la lista completa. */
export const ClientMessage = {
  /** Intencion de movimiento del mazo propio: posicion objetivo. */
  INPUT: "input",
  /** Abandono voluntario. Cuenta como derrota inmediata. */
  FORFEIT: "forfeit",
  /** Medicion de latencia. */
  PING: "ping",
} as const;

/** Eventos que emite el servidor. */
export const ServerMessage = {
  /** En cola esperando rival. */
  QUEUED: "queued",
  /** Emparejado: asiento asignado y datos de la partida. */
  JOINED: "joined",
  /** Instantanea de estado. Llega a PATCH_RATE_MS. */
  STATE: "state",
  /** Se anoto un gol. */
  GOAL: "goal",
  /** Resultado final y liquidacion. */
  MATCH_RESULT: "result",
  /** El escrow fallo: no se pudo bloquear el saldo. */
  ESCROW_FAILED: "escrow_failed",
  /** Cambio de estado de conexion del rival. */
  OPPONENT: "opponent",
  /** Un input fue rechazado por el validador. */
  INPUT_REJECTED: "input_rejected",
  /** Respuesta a PING. */
  PONG: "pong",
} as const;

/** Unico payload que el cliente puede enviar para mover su mazo. */
export interface InputPayload {
  /** Posicion objetivo X en unidades de mundo. */
  x: number;
  /** Posicion objetivo Y en unidades de mundo. */
  y: number;
}

export interface PingPayload {
  /** Reloj local del cliente; se devuelve tal cual. El servidor no lo usa. */
  t: number;
}

export interface PongPayload {
  t: number;
  serverTick: number;
}

/** Juegos disponibles en la plataforma. */
export type GameType = "air_hockey" | "mines" | "blackjack";

export interface JoinedPayload {
  matchId: string;
  /** Que juego es, para que el cliente sepa que interfaz montar. */
  gameType: GameType;
  seat: 0 | 1;
  stake: number;
  opponentName: string;
  /**
   * Credencial de reanudacion. Solo sirve para volver a ESTA partida y
   * expira con ella; no es una sesion ni permite suplantar a nadie.
   */
  resumeToken: string;
}

export type GamePhase =
  | "waiting"
  | "escrow"
  | "countdown"
  | "playing"
  | "goal"
  | "finished";

/**
 * Instantanea de estado. Nombres cortos a proposito: se emite 30 veces por
 * segundo por jugador y cada byte cuenta.
 */
export interface StatePayload {
  /** tick del servidor */
  t: number;
  /** fase */
  ph: GamePhase;
  /** milisegundos de cuenta regresiva restantes */
  cd: number;
  /** disco: [x, y, vx, vy] */
  p: [number, number, number, number];
  /** mazos por asiento: [[x0, y0], [x1, y1]] */
  m: [[number, number], [number, number]];
  /** marcador por asiento */
  s: [number, number];
  /** conectado por asiento */
  c: [boolean, boolean];
  /** ms restantes de ventana de reconexion por asiento */
  r: [number, number];
}

export interface InputRejectedPayload {
  reason: "malformed" | "rate_limited" | "not_playing" | "out_of_bounds";
}

export interface GoalPayload {
  scorerSeat: 0 | 1;
  scores: [number, number];
}

export interface OpponentPayload {
  connected: boolean;
  reconnectMs: number;
}

export type EndReason = "score" | "abandon" | "forfeit" | "timeout" | "error" | "cancelled";

export interface EscrowFailedPayload {
  reason: string;
  /** true si el que no pudo cubrir la apuesta fue este jugador. */
  isYou: boolean;
}

export interface MatchResultPayload {
  matchId: string;
  winnerUserId: string | null;
  /** true si gano quien recibe el mensaje. */
  youWon: boolean;
  endReason: EndReason;
  scores: [number, number];
  /** Monto acreditado al ganador, en COP enteros. Null si se anulo. */
  payout: number | null;
  /** Comision de la plataforma, en COP enteros. */
  rake: number | null;
  /** Saldo disponible de quien recibe el mensaje, tras la liquidacion. */
  balanceAfter: number;
}
