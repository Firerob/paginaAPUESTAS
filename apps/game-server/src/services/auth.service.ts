import bcrypt from "bcryptjs";
import { pool, withTransaction } from "../db/pool";

/**
 * Registro e inicio de sesion con contrasena real, para usuarios de verdad —
 * en paralelo a `/api/auth/dev-login` (Ana/Beto), que sigue existiendo para
 * pruebas rapidas y nunca tiene `password_hash`.
 *
 * Regla de oro de `loginUser`: nunca se distingue "el correo no existe" de
 * "la contrasena esta mal". Un solo error generico para los dos casos, para
 * que el login no sirva para averiguar que correos estan registrados. El
 * registro es la excepcion a proposito: ahi SI hace falta decir "este correo
 * ya existe" para que alguien no se registre dos veces sin darse cuenta.
 */

const BCRYPT_ROUNDS = 10;
const USERNAME_MIN_LEN = 2;
const USERNAME_MAX_LEN = 32;
const PASSWORD_MIN_LEN = 8;

export class AuthServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "email_taken"
      | "username_taken"
      | "invalid_credentials"
      | "account_disabled"
      | "validation_error",
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AuthServiceError";
  }
}

export interface AuthUser {
  userId: string;
  displayName: string;
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function assertValidUsername(username: string): void {
  if (username.length < USERNAME_MIN_LEN || username.length > USERNAME_MAX_LEN) {
    throw new AuthServiceError(
      `el nombre de usuario debe tener entre ${USERNAME_MIN_LEN} y ${USERNAME_MAX_LEN} caracteres`,
      "validation_error",
      { field: "username" },
    );
  }
}

function assertValidEmail(email: string): void {
  // Chequeo liviano a proposito: no es un validador RFC completo, solo
  // rechaza lo obviamente mal formado antes de gastar una vuelta a la base.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthServiceError("correo invalido", "validation_error", { field: "email" });
  }
}

function assertValidPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LEN) {
    throw new AuthServiceError(
      `la contraseña debe tener al menos ${PASSWORD_MIN_LEN} caracteres`,
      "validation_error",
      { field: "password" },
    );
  }
}

/** `code` de Postgres para "unique_violation". */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): error is { code: string; constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

export async function registerUser(params: {
  username: string;
  email: string;
  password: string;
}): Promise<AuthUser> {
  const username = params.username.trim();
  const email = normalizeEmail(params.email);

  assertValidUsername(username);
  assertValidEmail(email);
  assertValidPassword(params.password);

  const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);

  try {
    return await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (email, display_name, password_hash, status, kyc_status)
         VALUES ($1, $2, $3, 'active', 'none')
         RETURNING id`,
        [email, username, passwordHash],
      );
      const userId = rows[0].id;

      // Arranca en $0: a diferencia de `ensureDevUser` (Ana/Beto), una cuenta
      // real no recibe saldo de bienvenida. Deposita por el Cajero como
      // cualquier otra.
      await client.query(
        `INSERT INTO wallets (user_id, available, locked, withdrawable)
         VALUES ($1, 0, 0, 0)`,
        [userId],
      );

      return { userId, displayName: username };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // El nombre del constraint/indice distingue cual de los dos campos
      // choco. `users_email_key` es el UNIQUE de columna que ya trae
      // `email CITEXT UNIQUE`; el otro es el indice de 008_username_unique.sql.
      if (error.constraint?.includes("email")) {
        throw new AuthServiceError("correo ya registrado", "email_taken", { email });
      }
      throw new AuthServiceError("nombre de usuario en uso", "username_taken", { username });
    }
    throw error;
  }
}

export async function loginUser(params: { identifier: string; password: string }): Promise<AuthUser> {
  const identifier = params.identifier.trim();
  if (!identifier || !params.password) {
    throw new AuthServiceError("credenciales incompletas", "invalid_credentials");
  }

  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    password_hash: string | null;
    status: string;
  }>(
    `SELECT id, display_name, password_hash, status
       FROM users
      WHERE role = 'player' AND (email = $1 OR lower(display_name) = lower($1))
      LIMIT 1`,
    [identifier],
  );
  const user = rows[0];

  // Sin fila, o cuenta dev-login (password_hash NULL, nunca tiene
  // contrasena): mismo error generico que una contrasena incorrecta, mas
  // abajo. Ningun camino revela si el identificador existe.
  if (!user || !user.password_hash) {
    throw new AuthServiceError("credenciales invalidas", "invalid_credentials");
  }

  const valid = await bcrypt.compare(params.password, user.password_hash);
  if (!valid) {
    throw new AuthServiceError("credenciales invalidas", "invalid_credentials");
  }

  if (user.status !== "active") {
    throw new AuthServiceError(`cuenta en estado ${user.status}`, "account_disabled", {
      status: user.status,
    });
  }

  return { userId: user.id, displayName: user.display_name };
}
