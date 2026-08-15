import * as path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Falta la variable de entorno ${name}. Copia .env.example a .env`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} debe ser un entero`);
  return parsed;
}

const jwtSecret = required("JWT_SECRET");
if (process.env.NODE_ENV === "production" && jwtSecret.length < 32) {
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres en produccion");
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: process.env.NODE_ENV === "production",

  databaseUrl: required("DATABASE_URL"),

  jwtSecret,
  jwtIssuer: process.env.JWT_ISSUER ?? "airhockey-auth",
  jwtAudience: process.env.JWT_AUDIENCE ?? "airhockey-game",

  port: int("GAME_SERVER_PORT", 2567),
  corsOrigin: process.env.GAME_SERVER_ORIGIN ?? "http://localhost:3000",

  stakeCop: int("STAKE_COP", 1000),
  rakeBps: int("RAKE_BPS", 1000),
  houseUserId: process.env.HOUSE_USER_ID ?? "00000000-0000-0000-0000-0000000000ff",

  serverVersion: process.env.SERVER_VERSION ?? "dev",
} as const;
