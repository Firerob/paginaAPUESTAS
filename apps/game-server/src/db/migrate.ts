/**
 * Runner de migraciones minimalista.
 *
 * Aplica en orden los .sql de ./migrations que no esten registrados en
 * schema_migrations. Cada archivo corre dentro de su propia transaccion: o se
 * aplica entero o no se aplica.
 *
 * `runMigrations` se usa tanto desde la CLI (`npm run db:migrate`) como
 * automaticamente al arrancar el servidor (ver `src/index.ts`), asi que NO
 * cierra el pool compartido — eso queda a cargo de quien la llama.
 *
 *   npm run db:migrate
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { env } from "../config/env";
import { pool, withTransaction, closePool } from "./pool";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export async function runMigrations(): Promise<number> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map(
      (r) => r.name,
    ),
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    if (file.includes("seed_dev") && env.isProd) {
      console.log(`  saltando ${file} (NODE_ENV=production)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    });
    console.log(`  aplicada ${file}`);
    count++;
  }

  return count;
}

// Solo corre el CLI standalone cuando el archivo se ejecuta directamente
// (`npm run db:migrate`), no cuando `src/index.ts` importa `runMigrations`.
if (require.main === module) {
  runMigrations()
    .then((count) => {
      console.log(count === 0 ? "Sin migraciones pendientes." : `${count} migracion(es) aplicadas.`);
    })
    .then(closePool)
    .catch(async (error) => {
      console.error("Fallo la migracion:", error);
      await closePool();
      process.exit(1);
    });
}
