import { Pool, types, type PoolClient } from "pg";
import { env } from "../config/env";

// pg devuelve BIGINT (oid 20) como string para no perder precision. Nuestros
// montos caben de sobra en un Number seguro, asi que los parseamos a numero
// aqui y no en cada consulta — pero con guarda explicita.
types.setTypeParser(20, (value: string) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`BIGINT fuera del rango seguro de JS: ${value}`);
  }
  return parsed;
});

export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  // Un cliente idle que muere no debe tumbar el proceso.
  console.error("[db] error en cliente idle", err);
});

/**
 * Ejecuta `fn` dentro de una transaccion. Commit si resuelve, rollback si
 * lanza. El cliente siempre vuelve al pool.
 *
 * Todo movimiento de dinero de este servidor pasa por aqui. No hay una sola
 * escritura de saldo fuera de una transaccion.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("[db] fallo el rollback", rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
