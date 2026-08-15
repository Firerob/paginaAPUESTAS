import type { Server as IOServer, Socket } from "socket.io";
import { MINES_SIZES, ServerMessage, type GameType, type MinesSize } from "@ah/shared";
import { pool } from "../db/pool";
import { hasFunds } from "../services/wallet.service";
import { setQueueSnapshot } from "../services/queue-stats";
import { AirHockeyRoom } from "./AirHockeyRoom";
import { MinesRoom } from "./MinesRoom";
import type { BaseMatchRoom, RoomPlayer } from "./BaseMatchRoom";

/** Apuestas permitidas. El cliente elige de esta lista; no propone montos. */
export const STAKE_TIERS = [1000, 5000, 10000, 20000, 50000, 100000] as const;

/** Juegos que aceptan conexiones. */
const GAME_TYPES: GameType[] = ["air_hockey", "mines"];

interface QueueEntry {
  socket: Socket;
  userId: string;
  displayName: string;
  gameType: GameType;
  stake: number;
  /** Solo para mines. */
  size: MinesSize;
}

/**
 * Emparejamiento y ciclo de vida de las salas.
 *
 * Una cola por combinacion de juego + apuesta (+ tamaño de tablero en Mines):
 * en cuanto hay dos jugadores esperando exactamente lo mismo, nace la sala y
 * arranca el escrow.
 */
export class MatchManager {
  private queues = new Map<string, QueueEntry[]>();
  private rooms = new Map<string, BaseMatchRoom>();
  /** userId -> sala, para poder reenganchar tras una caida. */
  private roomOfUser = new Map<string, BaseMatchRoom>();

  constructor(private readonly io: IOServer) {}

  get activeRooms(): BaseMatchRoom[] {
    return [...new Set(this.rooms.values())];
  }

  /**
   * Punto de entrada de un socket ya autenticado.
   *
   * `socket.data.userId` lo puso el middleware de autenticacion a partir del
   * JWT verificado. Nunca llega en un mensaje del cliente.
   */
  async handleConnection(socket: Socket): Promise<void> {
    const userId = socket.data.userId as string;
    const displayName = socket.data.displayName as string;

    // 1) Reanudacion: el jugador se cayo y vuelve a una partida en curso.
    const resumeToken = socket.handshake.auth?.resume;
    if (typeof resumeToken === "string" && resumeToken.length > 0) {
      const room = this.roomOfUser.get(userId);
      const player = room?.findByResumeToken(resumeToken);
      // El token tiene que corresponder a ESTE usuario en ESA sala: no basta
      // con tenerlo, hay que ser su dueño.
      if (room && player && player.userId === userId) {
        room.resume(player, socket);
        return;
      }
      this.rejectAndClose(socket, "resume_expired");
      return;
    }

    // 2) Partida nueva.
    const gameType = String(socket.handshake.auth?.game ?? "air_hockey") as GameType;
    if (!GAME_TYPES.includes(gameType)) {
      this.rejectAndClose(socket, "invalid_game");
      return;
    }

    const stake = Number(socket.handshake.auth?.stake);
    if (!STAKE_TIERS.includes(stake as (typeof STAKE_TIERS)[number])) {
      this.rejectAndClose(socket, "invalid_stake");
      return;
    }

    const size = Number(socket.handshake.auth?.size ?? 5) as MinesSize;
    if (gameType === "mines" && !MINES_SIZES.includes(size)) {
      this.rejectAndClose(socket, "invalid_size");
      return;
    }

    // Filtros tempranos con mensaje claro. La garantia dura la da la
    // transaccion de escrow, no estos chequeos.
    if (await this.hasOpenMatch(userId)) {
      this.rejectAndClose(socket, "already_in_match");
      return;
    }
    if (!(await hasFunds(userId, stake))) {
      this.rejectAndClose(socket, "insufficient_funds");
      return;
    }

    this.enqueue({ socket, userId, displayName, gameType, stake, size });
  }

  /** Clave de cola: dos jugadores solo se emparejan si piden lo MISMO. */
  private queueKey(entry: Pick<QueueEntry, "gameType" | "stake" | "size">): string {
    return entry.gameType === "mines"
      ? `mines:${entry.stake}:${entry.size}`
      : `air_hockey:${entry.stake}`;
  }

  private enqueue(entry: QueueEntry): void {
    const key = this.queueKey(entry);
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
    }

    // Una sola posicion en cola por usuario: dos pestañas no se emparejan
    // entre si ni ocupan dos lugares.
    const existing = queue.findIndex((q) => q.userId === entry.userId);
    if (existing >= 0) {
      queue[existing].socket.disconnect(true);
      queue.splice(existing, 1);
    }

    entry.socket.once("disconnect", () => {
      const index = queue!.findIndex((q) => q.socket.id === entry.socket.id);
      if (index >= 0) queue!.splice(index, 1);
      this.syncQueueStats();
    });

    queue.push(entry);
    entry.socket.emit(ServerMessage.QUEUED, {
      game: entry.gameType,
      stake: entry.stake,
      position: queue.length,
    });

    if (queue.length >= 2) {
      const a = queue.shift()!;
      const b = queue.shift()!;
      void this.createRoom(a, b);
    }

    this.syncQueueStats();
  }

  /**
   * Recalcula y publica cuanta gente hay en cola: por juego+apuesta, y para
   * Minas ademas por tablero (y por tablero+apuesta, para cuando el jugador
   * ya eligio un tamaño concreto). Air Hockey y Minas nunca se suman entre
   * si — son colas separadas y el lobby las tiene que mostrar separadas.
   */
  private syncQueueStats(): void {
    const byGameStake: Record<GameType, Record<number, number>> = { air_hockey: {}, mines: {} };
    const minesBySize: Record<number, number> = {};
    const minesBySizeStake: Record<number, Record<number, number>> = {};

    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        const perGame = byGameStake[entry.gameType];
        perGame[entry.stake] = (perGame[entry.stake] ?? 0) + 1;

        if (entry.gameType === "mines") {
          minesBySize[entry.size] = (minesBySize[entry.size] ?? 0) + 1;
          const perSize = (minesBySizeStake[entry.size] ??= {});
          perSize[entry.stake] = (perSize[entry.stake] ?? 0) + 1;
        }
      }
    }

    setQueueSnapshot({ byGameStake, minesBySize, minesBySizeStake });
  }

  private async createRoom(a: QueueEntry, b: QueueEntry): Promise<void> {
    // Un socket pudo caerse entre el emparejamiento y este punto.
    if (!a.socket.connected || !b.socket.connected) {
      const alive = a.socket.connected ? a : b.socket.connected ? b : null;
      if (alive) this.enqueue(alive);
      return;
    }

    const room: BaseMatchRoom =
      a.gameType === "mines"
        ? new MinesRoom(a.stake, a.size, (finished) => this.disposeRoom(finished))
        : new AirHockeyRoom(a.stake, (finished) => this.disposeRoom(finished));

    this.rooms.set(room.id, room);

    const players: RoomPlayer[] = [
      room.add(a.socket, a.userId, a.displayName),
      room.add(b.socket, b.userId, b.displayName),
    ];
    for (const player of players) this.roomOfUser.set(player.userId, room);

    try {
      await room.start();
    } catch (error) {
      console.error("[matchmaking] no se pudo iniciar la sala", error);
      await room.forceVoid("error");
    }
  }

  private disposeRoom(room: BaseMatchRoom): void {
    this.rooms.delete(room.id);
    for (const [userId, tracked] of this.roomOfUser) {
      if (tracked === room) this.roomOfUser.delete(userId);
    }
  }

  private rejectAndClose(socket: Socket, reason: string): void {
    socket.emit(ServerMessage.ESCROW_FAILED, { reason, isYou: true });
    socket.disconnect(true);
  }

  private async hasOpenMatch(userId: string): Promise<boolean> {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM match_players mp
         JOIN matches m ON m.id = mp.match_id
        WHERE mp.user_id = $1 AND mp.result IS NULL AND m.settled_at IS NULL
        LIMIT 1`,
      [userId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Apagado ordenado: devuelve el dinero de toda partida sin liquidar. */
  async shutdown(): Promise<void> {
    for (const queue of this.queues.values()) {
      for (const entry of queue) entry.socket.disconnect(true);
      queue.length = 0;
    }
    this.syncQueueStats();
    await Promise.allSettled(this.activeRooms.map((room) => room.forceVoid("error")));
  }
}
