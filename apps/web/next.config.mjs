import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Next solo lee el .env de su propio directorio. En un monorepo eso obligaria
// a duplicar el JWT_SECRET en apps/web, y un secreto duplicado es un secreto
// que tarde o temprano se desincroniza. Cargamos el .env de la raiz para que
// haya una sola fuente de verdad compartida con el game server.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: path.join(rootDir, ".env") });

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next build` y `next dev` comparten .next por defecto, asi que una build
  // de verificacion mientras el dev server corre le sobreescribe los
  // artefactos y lo deja sirviendo 500. Con esto, la verificacion escribe en
  // otro directorio y el dev server no se entera.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // El paquete compartido se publica como TS/CJS del workspace; Next lo
  // transpila en lugar de exigir un build previo en dev.
  transpilePackages: ["@ah/shared"],
  env: {
    // Se inyecta explicitamente porque las NEXT_PUBLIC_* se inlinean en el
    // bundle del cliente durante el build, antes de que corra el codigo de
    // arriba en un proceso distinto.
    NEXT_PUBLIC_GAME_SERVER_HTTP:
      process.env.NEXT_PUBLIC_GAME_SERVER_HTTP ?? "http://localhost:2567",
  },
};

export default nextConfig;
