"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquare, Send, X } from "lucide-react";

type Badge = "PRO" | "VIP" | "WHALE";

interface ChatMessage {
  id: string;
  name: string;
  badge?: Badge;
  text: string;
  at: number;
  self?: boolean;
}

const BADGE_STYLE: Record<Badge, string> = {
  PRO: "border-cyan-400/50 bg-cyan-400/10 text-cyan-300",
  VIP: "border-purple-400/50 bg-purple-400/10 text-purple-300",
  WHALE: "border-amber-400/50 bg-amber-400/10 text-amber-300",
};

const AVATAR_GRADIENTS = [
  "from-cyan-400 to-blue-600",
  "from-fuchsia-500 to-purple-700",
  "from-emerald-400 to-teal-600",
  "from-amber-400 to-orange-600",
  "from-pink-500 to-rose-700",
];

function avatarGradient(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return "ahora";
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  return `hace ${Math.floor(m / 60)}h`;
}

/**
 * Seed de demostracion visual: esta sala NO esta conectada a un backend de
 * chat en tiempo real todavia. Los mensajes de otros usuarios de aqui abajo
 * son estaticos, solo para mostrar el look del feed; lo unico "en vivo" es
 * lo que el propio usuario escribe (se agrega al estado local). Conectar un
 * canal real (Socket.IO, ya usado en el resto de la app) es trabajo aparte.
 * El componente entero se monta solo en cliente (ver el dynamic() en
 * page.tsx) porque estos timestamps se calculan contra Date.now(): si esto
 * se renderizara en el servidor, el reloj del server y el del navegador casi
 * nunca coincidirian y React tiraria un error de hidratacion.
 */
const SEED_MESSAGES: ChatMessage[] = [
  { id: "seed-1", name: "Carlos23", badge: "PRO", text: "GG esa ronda de Mines estuvo brava 🔥", at: Date.now() - 9 * 60_000 },
  { id: "seed-2", name: "Ana_Gomez", badge: "VIP", text: "¿alguien para Air Hockey a 10k?", at: Date.now() - 6 * 60_000 },
  { id: "seed-3", name: "ElPatron", badge: "WHALE", text: "acabo de meter 100k al pozo 💎", at: Date.now() - 3 * 60_000 },
  { id: "seed-4", name: "Lupe.cr", text: "suerte a todos 🍀", at: Date.now() - 60_000 },
];

const MAX_LEN = 120;

interface LiveChatSidebarProps {
  /** Nombre del usuario autenticado, o null si no hay sesion (input queda deshabilitado). */
  userName: string | null;
  /** Jugadores conectados ahora mismo, dato real si el padre lo tiene. */
  onlineCount?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Chat lateral estilo Duel/Stake: panel flotante e independiente del flujo
 * del documento (`fixed`), nunca empuja el contenido del lobby — el lobby
 * es quien le deja espacio con `lg:pl-80` cuando esta abierto (ver page.tsx).
 */
export function LiveChatSidebar({ userName, onlineCount, open, onOpenChange }: LiveChatSidebarProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(SEED_MESSAGES);
  const [draft, setDraft] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = (): void => {
    const text = draft.trim();
    if (!text || !userName) return;
    setMessages((prev) => [
      ...prev,
      { id: `self-${Date.now()}`, name: userName, text, at: Date.now(), self: true },
    ]);
    setDraft("");
  };

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.aside
            className="fixed left-0 top-0 h-screen w-80 z-50 bg-slate-950/90 backdrop-blur-xl border-r border-slate-800 flex flex-col shadow-2xl"
            initial={{ x: -320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -320, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3.5 shrink-0">
              <div>
                <h2 className="font-[var(--font-display)] text-xs font-extrabold tracking-[0.16em] text-white">
                  CHAT EN VIVO
                </h2>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                  </span>
                  {onlineCount ?? 142} online
                </div>
              </div>
              <button
                className="rounded-lg border border-slate-800 p-1.5 text-slate-400 transition hover:border-cyan-400/40 hover:text-white"
                onClick={() => onOpenChange(false)}
                aria-label="Cerrar chat"
              >
                <X size={15} strokeWidth={2.4} />
              </button>
            </div>

            {/* Feed */}
            <div ref={feedRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-2.5 bg-slate-900/60 p-2.5 rounded-xl border border-slate-800/50"
                >
                  <div
                    className={`w-8 h-8 rounded-lg shrink-0 flex items-center justify-center font-bold text-xs bg-gradient-to-br ${avatarGradient(m.name)} text-white shadow-[0_0_12px_rgba(34,232,255,0.25)]`}
                  >
                    {initials(m.name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-semibold text-white">{m.name}</span>
                      {m.badge && (
                        <span
                          className={`rounded-full border px-1.5 py-[1px] text-[9px] font-bold tracking-wide ${BADGE_STYLE[m.badge]}`}
                        >
                          {m.badge}
                        </span>
                      )}
                      <span className="text-[10px] text-slate-500">{timeAgo(m.at)}</span>
                    </div>
                    <p
                      className={`mt-1 break-words text-[13px] leading-snug ${
                        m.self ? "text-cyan-50" : "text-slate-200"
                      }`}
                    >
                      {m.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Input */}
            <form
              className="p-3 border-t border-slate-800 bg-slate-900/40 shrink-0"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-white/[0.04] px-3 py-2 focus-within:border-cyan-400/40">
                <input
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-slate-500 focus:outline-none"
                  placeholder={userName ? "Escribe un mensaje…" : "Inicia sesión para chatear"}
                  value={draft}
                  maxLength={MAX_LEN}
                  disabled={!userName}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <button
                  type="submit"
                  disabled={!userName || draft.trim() === ""}
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-cyan-400/15 text-cyan-300 transition hover:bg-cyan-400/25 disabled:opacity-30 disabled:hover:bg-cyan-400/15"
                  aria-label="Enviar mensaje"
                >
                  <Send size={13} strokeWidth={2.4} />
                </button>
              </div>
              <div className="mt-1 text-right text-[10px] text-slate-600">
                {draft.length}/{MAX_LEN}
              </div>
            </form>
          </motion.aside>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {!open && (
          <motion.button
            className="fixed bottom-5 left-5 z-50 flex h-12 w-12 items-center justify-center rounded-full border border-cyan-400/40 bg-slate-950/90 text-cyan-300 shadow-[0_0_24px_rgba(34,232,255,0.35)]"
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            whileHover={{ scale: 1.08 }}
            onClick={() => onOpenChange(true)}
            aria-label="Abrir chat en vivo"
          >
            <MessageSquare size={20} strokeWidth={2.2} />
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
