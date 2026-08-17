/**
 * Dos sesiones separadas, a proposito, no una sola migrada.
 *
 * `sessionStorage` (dev-login, "Entrar como Ana/Beto") es lo que permite
 * abrir Ana en una pestana y Beto en otra del mismo navegador y jugar un 1v1
 * completo vos solo — cada pestana tiene su propio `sessionStorage`.
 *
 * `localStorage` (login/registro real) persiste entre cierres del
 * navegador, como corresponde a una cuenta real. Si las dos sesiones
 * compartieran la misma clave, iniciar sesion real en la pestana 2 pisaria
 * la sesion de la pestana 1 — por eso quedan en storages distintos y
 * `readActiveSession` decide cual gana cuando hay una de cada una.
 */

const DEV_TOKEN_KEY = "ah:token";
const DEV_NAME_KEY = "ah:name";
const REAL_TOKEN_KEY = "ah:real:token";
const REAL_NAME_KEY = "ah:real:name";

export interface StoredSession {
  token: string;
  name: string;
}

export function saveDevSession(session: StoredSession): void {
  sessionStorage.setItem(DEV_TOKEN_KEY, session.token);
  sessionStorage.setItem(DEV_NAME_KEY, session.name);
}

export function readDevSession(): StoredSession | null {
  const token = sessionStorage.getItem(DEV_TOKEN_KEY);
  if (!token) return null;
  return { token, name: sessionStorage.getItem(DEV_NAME_KEY) ?? "" };
}

export function clearDevSession(): void {
  sessionStorage.removeItem(DEV_TOKEN_KEY);
  sessionStorage.removeItem(DEV_NAME_KEY);
}

export function saveRealSession(session: StoredSession): void {
  localStorage.setItem(REAL_TOKEN_KEY, session.token);
  localStorage.setItem(REAL_NAME_KEY, session.name);
}

export function readRealSession(): StoredSession | null {
  const token = localStorage.getItem(REAL_TOKEN_KEY);
  if (!token) return null;
  return { token, name: localStorage.getItem(REAL_NAME_KEY) ?? "" };
}

export function clearRealSession(): void {
  localStorage.removeItem(REAL_TOKEN_KEY);
  localStorage.removeItem(REAL_NAME_KEY);
}

/**
 * Prioriza la sesion dev-login de ESTA pestana (explicita, recien elegida)
 * por sobre una sesion real persistida — si alguien probo con Ana en una
 * pestana que despues tambien tiene una sesion real vieja en localStorage,
 * gana lo que esa pestana eligio activamente.
 */
export function readActiveSession(): StoredSession | null {
  return readDevSession() ?? readRealSession();
}

export function clearAllSessions(): void {
  clearDevSession();
  clearRealSession();
}
