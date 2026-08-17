"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, EyeOff, X } from "lucide-react";

export type AuthTab = "login" | "register";

export interface AuthSession {
  token: string;
  name: string;
}

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  initialTab: AuthTab;
  apiBase: string;
  onAuthenticated: (session: AuthSession) => void;
}

const PASSWORD_MIN_LEN = 8;

/**
 * Login + Registro con cuenta real, separado de `/api/auth/dev-login`
 * (Ana/Beto — ver AuthInterceptModal y la tarjeta "usuarios de prueba" en
 * page.tsx, que se quedan tal cual para pruebas rapidas).
 *
 * Reusa la cromaria de CajeroModal (`.cajero-overlay`/`.cajero-modal`/
 * `.cajero-tabs`/etc.) para no romper la consistencia visual del resto del
 * sitio en vez de inventar un modal nuevo desde cero.
 */
export function AuthModal({ open, onClose, initialTab, apiBase, onAuthenticated }: AuthModalProps) {
  const [tab, setTab] = useState<AuthTab>(initialTab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateEmail, setDuplicateEmail] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const [identifier, setIdentifier] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setError(null);
    setDuplicateEmail(false);
  }, [open, initialTab]);

  const switchTab = (next: AuthTab): void => {
    setTab(next);
    setError(null);
    setDuplicateEmail(false);
  };

  if (!open) return null;

  const submitRegister = async (): Promise<void> => {
    if (busy || !acceptedTerms) return;
    setError(null);
    setDuplicateEmail(false);

    if (password !== confirmPassword) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    if (password.length < PASSWORD_MIN_LEN) {
      setError(`La contraseña debe tener al menos ${PASSWORD_MIN_LEN} caracteres.`);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, email, password }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 409 && typeof data.error === "string" && data.error.includes("correo")) {
          setDuplicateEmail(true);
        }
        throw new Error(data.error ?? "No se pudo completar el registro.");
      }
      onAuthenticated({ token: data.token, name: data.displayName });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier, password: loginPassword }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "No se pudo iniciar sesión.");
      onAuthenticated({ token: data.token, name: data.displayName });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="cajero-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cajero-modal auth-modal glass" role="dialog" aria-modal="true" aria-label="Cuenta">
        <div className="cajero-head">
          <h2 className="cajero-title auth-modal-title">Tu cuenta</h2>
          <button className="cajero-close" onClick={onClose} aria-label="Cerrar">
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <div className="cajero-tabs">
          <button
            className={`cajero-tab ${tab === "login" ? "cajero-tab-active" : ""}`}
            onClick={() => switchTab("login")}
          >
            Iniciar sesión
          </button>
          <button
            className={`cajero-tab ${tab === "register" ? "cajero-tab-active" : ""}`}
            onClick={() => switchTab("register")}
          >
            Registrarse
          </button>
        </div>

        <div className="cajero-body">
          {duplicateEmail && (
            <div className="auth-duplicate-banner">
              <AlertTriangle size={16} strokeWidth={2.4} aria-hidden />
              <span>Ese correo ya tiene una cuenta.</span>
              <button type="button" className="auth-duplicate-banner-btn" onClick={() => switchTab("login")}>
                Iniciar sesión
              </button>
            </div>
          )}

          {tab === "register" ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitRegister();
              }}
              className="auth-form"
            >
              <div>
                <label className="cajero-field-label" htmlFor="auth-username">
                  Nombre de usuario
                </label>
                <input
                  id="auth-username"
                  className="cajero-destination-input"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="cajero-field-label" htmlFor="auth-email">
                  Correo electrónico
                </label>
                <input
                  id="auth-email"
                  type="email"
                  className="cajero-destination-input"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="cajero-field-label" htmlFor="auth-password">
                  Contraseña
                </label>
                <div className="auth-password-wrap">
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    className="cajero-destination-input"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  >
                    {showPassword ? <EyeOff size={15} strokeWidth={2.2} /> : <Eye size={15} strokeWidth={2.2} />}
                  </button>
                </div>
              </div>

              <div>
                <label className="cajero-field-label" htmlFor="auth-confirm-password">
                  Confirmar contraseña
                </label>
                <input
                  id="auth-confirm-password"
                  type={showPassword ? "text" : "password"}
                  className="cajero-destination-input"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              <label className="terms-check">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                />
                <span>
                  He leído y acepto los{" "}
                  <Link href="/terminos" target="_blank" rel="noopener noreferrer">
                    Términos y Condiciones
                  </Link>{" "}
                  y reconozco el riesgo de juego 1v1.
                </span>
              </label>

              {error && <p className="cajero-hint cajero-hint-error">{error}</p>}

              <button
                type="submit"
                className="btn btn-gold"
                style={{ width: "100%" }}
                disabled={busy || !acceptedTerms}
              >
                {busy ? "Creando cuenta…" : "Registrarse"}
              </button>
            </form>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submitLogin();
              }}
              className="auth-form"
            >
              <div>
                <label className="cajero-field-label" htmlFor="auth-identifier">
                  Correo electrónico o nombre de usuario
                </label>
                <input
                  id="auth-identifier"
                  className="cajero-destination-input"
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="cajero-field-label" htmlFor="auth-login-password">
                  Contraseña
                </label>
                <div className="auth-password-wrap">
                  <input
                    id="auth-login-password"
                    type={showPassword ? "text" : "password"}
                    className="cajero-destination-input"
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  >
                    {showPassword ? <EyeOff size={15} strokeWidth={2.2} /> : <Eye size={15} strokeWidth={2.2} />}
                  </button>
                </div>
              </div>

              {error && <p className="cajero-hint cajero-hint-error">{error}</p>}

              <button type="submit" className="btn btn-gold" style={{ width: "100%" }} disabled={busy}>
                {busy ? "Ingresando…" : "Iniciar sesión"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
