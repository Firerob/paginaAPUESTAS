/**
 * Paleta y tokens visuales — "Neon Cyber-Arcade".
 *
 * Una sola fuente de verdad para canvas y CSS. Los mismos valores estan
 * espejados en globals.css como custom properties; si cambias uno, cambia el
 * otro. Se mantienen aparte a proposito: el canvas necesita los componentes
 * sueltos para construir gradientes y alfas, y el CSS necesita las cadenas.
 */

export const NEON = {
  /** Fondo del vacio alrededor de la mesa. */
  void: "#04050d",
  /** Superficie de la mesa, cristal oscuro. */
  glassTop: "#0d1637",
  glassBottom: "#05081a",
  /** Estructura de la mesa. */
  rim: "#1b2a5e",
  grid: "#1a2c63",

  /** Cian de la marca: lineas, circulo central, brillo del disco. */
  cyan: "#22e8ff",
  cyanSoft: "rgba(34, 232, 255, 0.35)",

  /** Jugador local. */
  self: "#2bffb0",
  selfGlow: "rgba(43, 255, 176, 0.55)",

  /** Rival. */
  rival: "#ff2f8e",
  rivalGlow: "rgba(255, 47, 142, 0.55)",

  /** Arcos y todo lo que huele a dinero. */
  gold: "#ffcf5c",
  goldGlow: "rgba(255, 207, 92, 0.6)",

  puck: "#ffffff",
  text: "#e9f0ff",
  muted: "#8fa0cf",
  danger: "#ff5d73",
} as const;

/** Color de un asiento visto por el jugador local. */
export function seatColor(seat: number, mySeat: number): string {
  return seat === mySeat ? NEON.self : NEON.rival;
}

export function seatGlow(seat: number, mySeat: number): string {
  return seat === mySeat ? NEON.selfGlow : NEON.rivalGlow;
}

/**
 * Presupuesto de brillo por fotograma.
 *
 * `shadowBlur` obliga al motor a rasterizar la forma a un buffer aparte y
 * desenfocarlo. Es la operacion mas cara del Canvas 2D con diferencia, y a
 * 60 fps se paga 60 veces por segundo. Regla de esta capa:
 *
 *   - Todo lo ESTATICO (mesa, bordes, arcos, marcas) se dibuja una sola vez a
 *     una capa offscreen y se reutiliza hasta que cambie el tamaño.
 *   - Lo DINAMICO usa `globalCompositeOperation = "lighter"` con gradientes
 *     radiales, que da el mismo aspecto de neon a una fraccion del coste.
 *   - `shadowBlur` en el bucle vivo se reserva para estos pocos elementos.
 */
export const GLOW_BUDGET_PER_FRAME = 4;
