"use client";

import { X } from "lucide-react";

interface AuthInterceptModalProps {
  open: boolean;
  onClose: () => void;
  onCreateAccount: () => void;
  onLogin: () => void;
}

/**
 * Intercepta "¡Buscar rival ahora!" cuando no hay sesión: el invitado puede
 * explorar juegos y apuestas libremente, pero para entrar de verdad a la
 * cola necesita autenticarse. "Crear cuenta" abre `AuthModal` en la pestaña
 * de registro, "Iniciar sesión" en la de login — page.tsx es quien decide
 * eso, este componente solo expone las dos intenciones por separado.
 */
export function AuthInterceptModal({ open, onClose, onCreateAccount, onLogin }: AuthInterceptModalProps) {
  if (!open) return null;

  return (
    <div
      className="cajero-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="cajero-modal auth-modal glass"
        role="dialog"
        aria-modal="true"
        aria-label="Inicia sesión para jugar"
      >
        <div className="cajero-head">
          <h2 className="cajero-title auth-modal-title">¡Casi listo para competir!</h2>
          <button className="cajero-close" onClick={onClose} aria-label="Cerrar">
            <X size={16} strokeWidth={2.4} />
          </button>
        </div>

        <div className="cajero-body">
          <p className="auth-modal-message">
            Para entrar a la arena y disputar el pozo en dinero real necesitas iniciar sesión o
            crear tu cuenta.
          </p>

          <div className="auth-modal-actions">
            <button className="btn btn-gold" onClick={onCreateAccount}>
              Crear cuenta
            </button>
            <button className="btn btn-ghost" onClick={onLogin}>
              Iniciar sesión
            </button>
          </div>

          <button type="button" className="auth-modal-guest" onClick={onClose}>
            Seguir explorando como invitado
          </button>
        </div>
      </div>
    </div>
  );
}
