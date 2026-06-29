import { useEffect, useRef, useState } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  at: number;
}

interface ChatReply {
  reply: string;
  remaining: number;
  limit: number;
  maxMessageLength?: number;
  context?: {
    stressedPixelPct: number | null;
    worstQuadrant: string | null;
    riskLevel: string | null;
    dataDate: string | null;
  };
}

interface ChatError {
  error: string;
  message?: string;
  retryAfterSeconds?: number;
  limit?: number;
  maxLength?: number;
}

const STORAGE_KEY = "ardalink_talk_chat_history_v1";
const PHONE_STORAGE_KEY = "ardalink_talk_phone";
const SESSION_STORAGE_KEY = "ardalink_talk_chat_session_id_v1";
const MAX_PERSISTED = 20;

function generateSessionId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  // Fallback for older browsers
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadOrCreateSessionId(): string {
  try {
    const existing = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    const fresh = generateSessionId();
    sessionStorage.setItem(SESSION_STORAGE_KEY, fresh);
    return fresh;
  } catch {
    return generateSessionId();
  }
}

function loadPhone(): string | null {
  try {
    const raw = localStorage.getItem(PHONE_STORAGE_KEY);
    if (!raw) return null;
    return /^\+\d{6,15}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-MAX_PERSISTED);
  } catch {
    return [];
  }
}

function saveHistory(msgs: ChatMessage[]): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(msgs.slice(-MAX_PERSISTED)),
    );
  } catch {
    // ignore quota
  }
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadHistory());
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sessionIdRef = useRef<string>(loadOrCreateSessionId());

  useEffect(() => {
    saveHistory(messages);
    // Auto-scroll to bottom on new message
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [messages]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    if (text.length > 500) {
      setError(
        "Ujumbe ni mrefu sana (zaidi ya herufi 500). · Message too long (>500 chars).",
      );
      return;
    }

    setError("");
    const userMsg: ChatMessage = {
      role: "user",
      content: text,
      at: Date.now(),
    };
    const nextMsgs = [...messages, userMsg];
    setMessages(nextMsgs);
    setInput("");
    setSending(true);

    try {
      const phone = loadPhone();
      const res = await fetch("/api/talk-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
          sessionId: sessionIdRef.current,
          ...(phone ? { phone } : {}),
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as ChatError;
        if (res.status === 429 && err.error === "cooldown") {
          setError(
            `Tafadhali subiri sekunde ${err.retryAfterSeconds ?? 3}. · Please wait ${err.retryAfterSeconds ?? 3}s.`,
          );
        } else if (res.status === 429 && err.error === "daily_cap") {
          setError(
            `Umefika kikomo cha ujumbe kwa siku (${err.limit ?? 30}). Rudi kesho. · Daily chat limit reached (${err.limit ?? 30}). Come back tomorrow.`,
          );
        } else {
          setError(
            err.message ??
              `Tatizo la mtandao (HTTP ${res.status}). · Network error.`,
          );
        }
        // Roll back the user message so they can retry without polluting history
        setMessages(messages);
        return;
      }

      const data = (await res.json()) as ChatReply;
      setRemaining(data.remaining);
      setMessages([
        ...nextMsgs,
        { role: "assistant", content: data.reply, at: Date.now() },
      ]);
    } catch (err) {
      setError(
        `Hali ya mtandao imekatika. · Network dropped. ${err instanceof Error ? err.message : ""}`,
      );
      setMessages(messages);
    } finally {
      setSending(false);
    }
  };

  const handleClear = () => {
    setMessages([]);
    setError("");
    // Mint a fresh session id so the next thread doesn't overwrite the
    // previous ground-truth report — each cleared conversation is its
    // own report.
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
    sessionIdRef.current = loadOrCreateSessionId();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  return (
    <div className="flex flex-col h-[60vh] min-h-[420px] bg-white rounded-2xl border border-stone-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between bg-stone-50">
        <div>
          <p className="text-sm font-semibold text-stone-900">
            Andika na ardhi yako
          </p>
          <p className="text-[11px] text-stone-500">
            Chat with your land — uliza kuhusu malisho, maji, hali ya hewa
          </p>
        </div>
        {remaining != null && (
          <span className="text-[10px] uppercase tracking-wider text-stone-500 bg-white border border-stone-200 rounded-full px-2 py-0.5">
            {remaining} left
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3 bg-stone-50/40"
      >
        {messages.length === 0 && (
          <div className="text-center py-8 text-sm text-stone-500 leading-relaxed">
            <p className="text-2xl mb-2">🌾</p>
            <p>Anza mazungumzo — uliza chochote kuhusu hali ya malisho.</p>
            <p className="text-xs text-stone-400 mt-1">
              Start the conversation — ask anything about pasture conditions.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-amber-600 text-white rounded-br-sm"
                  : "bg-white text-stone-900 border border-stone-200 rounded-bl-sm"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {sending && (
          <div className="flex justify-start">
            <div className="bg-white border border-stone-200 rounded-2xl rounded-bl-sm px-3.5 py-2.5">
              <span className="inline-flex gap-1">
                <span
                  className="w-1.5 h-1.5 rounded-full bg-stone-400 animate-bounce"
                  style={{ animationDelay: "0ms" }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-stone-400 animate-bounce"
                  style={{ animationDelay: "150ms" }}
                />
                <span
                  className="w-1.5 h-1.5 rounded-full bg-stone-400 animate-bounce"
                  style={{ animationDelay: "300ms" }}
                />
              </span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-red-700 bg-red-50 border-t border-red-200">
          {error}
        </div>
      )}

      <form
        onSubmit={handleSend}
        className="border-t border-stone-200 p-3 bg-white"
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend(e as unknown as React.FormEvent);
              }
            }}
            placeholder="Andika hapa… · Type here…"
            rows={2}
            maxLength={500}
            disabled={sending}
            className="flex-1 resize-none rounded-xl border border-stone-300 px-3 py-2 text-sm text-stone-900 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500 disabled:bg-stone-50"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="rounded-xl bg-amber-600 hover:bg-amber-700 disabled:bg-stone-300 text-white font-semibold px-4 py-2.5 text-sm transition-colors"
          >
            Tuma
          </button>
        </div>
        <div className="flex items-center justify-between mt-1.5">
          <p className="text-[10px] text-stone-400">{input.length}/500</p>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              className="text-[10px] text-stone-400 hover:text-stone-700 underline"
            >
              Futa mazungumzo · Clear
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
