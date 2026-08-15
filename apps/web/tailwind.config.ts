import type { Config } from "tailwindcss";

/**
 * Tailwind conviviendo con el sistema de CSS a mano de globals.css.
 *
 * `preflight` queda apagado a proposito: globals.css ya trae su propio
 * reset (box-sizing, margin/padding, tipografia base) y el de Tailwind
 * reescribiria botones/inputs/etc. en TODA la app, no solo en los
 * componentes nuevos que lo piden. Con preflight apagado, Tailwind solo
 * aporta utilidades (bg-*, blur-*, w-80...) y no toca nada existente.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
