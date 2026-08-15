import { io, type Socket } from "socket.io-client";

const SERVER_URL = process.env.NEXT_PUBLIC_GAME_SERVER_HTTP ?? "http://localhost:2567";
const RESUME_KEY = "ah:resumeToken";

/**
 * Conexion al servidor de juego.
 *
 * El token de sesion viaja en `auth` del handshake y lo verifica el middleware
 * del servidor ANTES de que la conexion exista. Sin token valido no hay socket.
 */
export interface ConnectOptions {
  stake: number;
  /** Juego al que se quiere entrar. */
  game?: "air_hockey" | "mines";
  /** Solo para mines: lado del tablero. */
  size?: number;
}

export function connect(token: string, options: ConnectOptions): Socket {
  const resume = readResumeToken();

  return io(SERVER_URL, {
    transports: ["websocket"],
    // Al reanudar solo hace falta el token de reanudacion: la sala ya sabe
    // que juego es y con que parametros.
    auth: resume
      ? { token, resume }
      : { token, stake: options.stake, game: options.game ?? "air_hockey", size: options.size },
    // La reconexion la maneja socket.io; el servidor guarda el asiento
    // durante la ventana de gracia y el token de reanudacion lo reengancha.
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    timeout: 8000,
  });
}

export function saveResumeToken(token: string): void {
  try {
    sessionStorage.setItem(RESUME_KEY, token);
  } catch {
    /* sessionStorage puede no existir (modo privado) */
  }
}

export function readResumeToken(): string | null {
  try {
    return sessionStorage.getItem(RESUME_KEY);
  } catch {
    return null;
  }
}

export function clearResumeToken(): void {
  try {
    sessionStorage.removeItem(RESUME_KEY);
  } catch {
    /* ignorado */
  }
}
