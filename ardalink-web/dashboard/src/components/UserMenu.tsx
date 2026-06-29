import { useState, useRef, useEffect } from "react";
import { LogOut, ChevronDown, ShieldCheck, User } from "lucide-react";
import { performLogout, type SessionInfo } from "./AuthGate";

interface UserMenuProps {
  session: SessionInfo;
}

/**
 * UserMenu — visible chip in the top bar that surfaces the logged-in
 * operator's email + role and offers a logout action.
 *
 * Click the chip → dropdown with email, role, tenant, token expiry,
 * and a logout button. Logout clears localStorage, fires a
 * window event so AuthGate re-renders the LoginPage, and best-
 * effort POSTs /api/auth/logout.
 */
export function UserMenu({ session }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function handleLogout() {
    setOpen(false);
    performLogout();
    // Tell AuthGate to swap back to LoginPage.
    window.dispatchEvent(new Event("ardalink:logout"));
  }

  const roleLabel = session.role || "viewer";
  const initials = (session.email || "?")
    .split(/[@.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");

  const expiresPretty = session.expires_at
    ? new Date(session.expires_at).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "unknown";

  return (
    <div ref={ref} className="relative" data-testid="user-menu">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="user-menu-trigger"
        className="inline-flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-md bg-gray-900 border border-gray-700 hover:border-amber-700/60 text-gray-200 hover:text-amber-200 text-xs font-medium transition-colors"
      >
        <span
          aria-hidden
          className="w-5 h-5 rounded-full bg-amber-600/30 border border-amber-700/50 text-amber-200 text-[10px] font-bold inline-flex items-center justify-center"
        >
          {initials || <User className="w-3 h-3" />}
        </span>
        <span className="hidden sm:inline truncate max-w-[12rem]">
          {session.email}
        </span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>

      {open && (
        <div
          role="menu"
          data-testid="user-menu-panel"
          className="absolute right-0 mt-2 w-72 rounded-lg bg-gray-900 border border-gray-700 shadow-2xl shadow-black/40 z-50 overflow-hidden"
        >
          <div className="px-3 py-2 bg-gray-950/60 border-b border-gray-800">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0" />
              <div className="min-w-0">
                <div
                  className="text-xs font-semibold text-white truncate"
                  data-testid="user-menu-email"
                >
                  {session.email}
                </div>
                <div className="text-[10px] text-gray-500 truncate">
                  role · <span className="font-mono text-amber-300">{roleLabel}</span>
                </div>
              </div>
            </div>
          </div>
          <dl className="px-3 py-2 space-y-1.5 text-[11px]">
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Tenant</dt>
              <dd className="font-mono text-gray-200 truncate" data-testid="user-menu-tenant">
                {session.tenant_id || "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Display name</dt>
              <dd className="text-gray-200 truncate max-w-[10rem]" title={session.display_name}>
                {session.display_name || "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Session expires</dt>
              <dd className="font-mono text-gray-300">{expiresPretty}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={handleLogout}
            data-testid="user-menu-logout"
            role="menuitem"
            className="w-full px-3 py-2 text-xs flex items-center gap-2 bg-red-950/30 hover:bg-red-900/40 text-red-200 border-t border-gray-800 transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log out
          </button>
        </div>
      )}
    </div>
  );
}

export default UserMenu;
