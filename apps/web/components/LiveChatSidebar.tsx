"use client";

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquare, Send, X } from "lucide-react";
import {
  CHAT_MAX_LEN,
  ChatClientMessage,
  ChatServerMessage,
  type ChatMessagePayload,
  type ChatRejectedPayload,
} from "@ah/shared";

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

const REJECT_MESSAGE: Record<ChatRejectedPayload["reason"], string> = {
  not_authenticated: "Inicia sesión para chatear.",
  empty: "Escribe algo primero.",
  too_long: `Máximo ${CHAT_MAX_LEN} caracteres.`,
  rate_limited: "Espera un momento antes de mandar otro mensaje.",
};

interface LiveChatSidebarProps {
  /** Nombre del usuario autenticado, o null si no hay sesion (input queda deshabilitado). */
  userName: string | null;
  /** JWT de la sesion actual. Sin token, el socket se conecta igual pero solo puede leer. */
  token: string | null;
  /** Origen del game-server (mismo que el resto de la app usa para HTTP y sockets de partida). */
  apiBase: string;
  /** Jugadores conectados ahora mismo, dato real que ya trae el padre de /api/activity/stats. */
  onlineCount?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Chat lateral estilo Duel/Stake, conectado de verdad al namespace `/chat`
 * del game-server (ver `chatNamespace.ts`): cualquiera que entre a la
 * pagina se conecta y ve el canal en vivo, con o sin sesion. Solo escribir
 * exige JWT valido, y eso lo re-valida el servidor en cada mensaje — el
 * `disabled` del input de aqui abajo es cortesia de UX, no la garantia real.
 */
export function LiveChatSidebar({
  userName,
  token,
  apiBase,
  onlineCount,
  open,
  onOpenChange,
}: LiveChatSidebarProps) {
  const [messages, setMessages] = useState<ChatMessagePayload[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    const socket = io(`${apiBase}/chat`, {
      transports: ["websocket"],
      auth: token ? { token } : {},
    });
    socketRef.current = socket;

    socket.on(ChatServerMessage.HISTORY, (history: ChatMessagePayload[]) => setMessages(history));
    socket.on(ChatServerMessage.MESSAGE_RECEIVED, (message: ChatMessagePayload) =>
      setMessages((prev) => [...prev.slice(-99), message]),
    );
    socket.on(ChatServerMessage.REJECTED, (payload: ChatRejectedPayload) => {
      setNotice(REJECT_MESSAGE[payload.reason] ?? "No se pudo enviar el mensaje.");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // Reconecta con el token nuevo en login/logout — misma sesion, misma sala.
  }, [apiBase, token]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = (): void => {
    const text = draft.trim();
    if (!text || !userName) return;
    socketRef.current?.emit(ChatClientMessage.SEND_MESSAGE, text);
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
                  {onlineCount ?? "…"} online
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
              {messages.length === 0 && (
                <p className="text-center text-[12px] text-slate-500">
                  Todavía no hay mensajes. ¡Sé el primero!
                </p>
              )}
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
                      <span className="text-[10px] text-slate-500">{timeAgo(m.at)}</span>
                    </div>
                    <p
                      className={`mt-1 break-words text-[13px] leading-snug ${
                        m.name === userName ? "text-cyan-50" : "text-slate-200"
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
              {notice && <div className="mb-2 text-[11px] text-amber-300">{notice}</div>}
              <div className="flex items-center gap-2 rounded-xl border border-slate-800 bg-white/[0.04] px-3 py-2 focus-within:border-cyan-400/40">
                <input
                  className="min-w-0 flex-1 bg-transparent text-[13px] text-white placeholder:text-slate-500 focus:outline-none"
                  placeholder={userName ? "Escribe un mensaje…" : "Inicia sesión para chatear"}
                  value={draft}
                  maxLength={CHAT_MAX_LEN}
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
                {draft.length}/{CHAT_MAX_LEN}
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
