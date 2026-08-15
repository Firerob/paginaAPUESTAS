import { NextResponse } from "next/server";
import jwt from "jsonwebtoken";

/**
 * Emisor de tokens SOLO para desarrollo.
 *
 * En produccion esto lo reemplaza un servicio de autenticacion real con
 * contraseña/OTP, verificacion de identidad (KYC) y firma asimetrica RS256,
 * de modo que el game server valide con la llave publica y nunca tenga la
 * capacidad de emitir tokens.
 *
 * La ruta se apaga sola fuera de desarrollo: dejar un emisor de sesiones sin
 * credenciales expuesto en produccion seria entregar todas las cuentas.
 */

const DEV_USERS: Record<string, { id: string; name: string }> = {
  ana: { id: "00000000-0000-0000-0000-000000000001", name: "Ana" },
  beto: { id: "00000000-0000-0000-0000-000000000002", name: "Beto" },
};

export async function POST(request: Request): Promise<NextResponse> {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not_available" }, { status: 404 });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "JWT_SECRET no configurado" }, { status: 500 });
  }

  const body = (await request.json().catch(() => ({}))) as { user?: string };
  const user = DEV_USERS[body.user ?? "ana"];
  if (!user) {
    return NextResponse.json({ error: "usuario de prueba desconocido" }, { status: 400 });
  }

  const token = jwt.sign({ name: user.name }, secret, {
    subject: user.id,
    issuer: process.env.JWT_ISSUER ?? "airhockey-auth",
    audience: process.env.JWT_AUDIENCE ?? "airhockey-game",
    expiresIn: 3600,
    jwtid: `${user.id}:${Date.now()}`,
    algorithm: "HS256",
  });

  return NextResponse.json({ token, userId: user.id, displayName: user.name });
}
