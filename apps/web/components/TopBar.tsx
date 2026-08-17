"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, History, LogOut, Plus, Settings, UserRound, Zap } from "lucide-react";

interface TopBarProps {
  authenticated: boolean;
  name: string | null;
  balanceFormatted: string | null;
  onOpenCajero: () => void;
  onOpenHistory: () => void;
  onLogout: () => void;
  onRequestAuth: (mode: "login" | "register") => void;
}

/** Topbar fija con glassmorphism: logo, saldo y menu de cuenta. */
export function TopBar({
  authenticated,
  name,
  balanceFormatted,
  onOpenCajero,
  onOpenHistory,
  onLogout,
  onRequestAuth,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [menuOpen]);

  return (
    <div className="topbar">
      <span className="topbar-logo">
        <Zap size={18} strokeWidth={2.4} aria-hidden />
        NEON ARENA
      </span>

      {authenticated ? (
        <div className="topbar-right">
          <div className="topbar-balance">
            <span className="topbar-balance-amount">{balanceFormatted ?? "…"}</span>
            <button
              className="topbar-add-btn"
              onClick={onOpenCajero}
              aria-label="Recargar saldo"
              title="Recargar saldo"
            >
              <Plus size={14} strokeWidth={3} />
            </button>
          </div>

          <div className="topbar-account" ref={menuRef}>
            <button className="topbar-account-btn" onClick={() => setMenuOpen((v) => !v)}>
              <UserRound size={15} strokeWidth={2.2} aria-hidden />
              <span className="topbar-account-name">{name}</span>
              <ChevronDown size={14} strokeWidth={2.2} aria-hidden />
            </button>

            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  className="account-menu"
                  initial={{ opacity: 0, y: -6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.98 }}
                  transition={{ duration: 0.15, ease: "easeOut" }}
                >
                  <button
                    className="account-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenHistory();
                    }}
                  >
                    <History size={15} strokeWidth={2.2} />
                    Historial de partidas
                  </button>
                  <button className="account-menu-item" disabled title="Próximamente">
                    <Settings size={15} strokeWidth={2.2} />
                    Ajustes
                  </button>
                  <div className="account-menu-sep" />
                  <button
                    className="account-menu-item account-menu-item-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      onLogout();
                    }}
                  >
                    <LogOut size={15} strokeWidth={2.2} />
                    Cerrar sesión
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      ) : (
        <div className="topbar-right">
          <button className="btn btn-ghost topbar-auth-btn" onClick={() => onRequestAuth("login")}>
            Iniciar sesión
          </button>
          <button className="btn btn-gold topbar-auth-btn" onClick={() => onRequestAuth("register")}>
            Registrarse
          </button>
        </div>
      )}
    </div>
  );
}
