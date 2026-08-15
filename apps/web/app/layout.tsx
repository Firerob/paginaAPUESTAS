import type { Metadata, Viewport } from "next";
import { Orbitron } from "next/font/google";
import "./globals.css";

/**
 * Orbitron: geometrica, tecnologica, con numeros muy legibles — que es lo que
 * importa en un marcador y en una cifra de dinero.
 *
 * Se carga con next/font, que la descarga en tiempo de BUILD y la sirve desde
 * nuestro propio dominio. Nada de peticiones a Google en runtime: menos
 * latencia, sin dependencia de terceros y sin fuga de datos del jugador.
 */
const orbitron = Orbitron({
  subsets: ["latin"],
  weight: ["400", "700", "900"],
  variable: "--font-orbitron",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Air Hockey 1v1 · Neon Arena",
  description: "Air Hockey 1v1 con apuestas. Física y arbitraje del lado del servidor.",
};

export const viewport: Viewport = {
  themeColor: "#04050d",
  // El juego se controla arrastrando: el zoom por pellizco solo estorba.
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={orbitron.variable}>
      <body>{children}</body>
    </html>
  );
}
