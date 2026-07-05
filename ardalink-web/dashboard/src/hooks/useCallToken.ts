import { useRef, useEffect, useState } from "react";
import { useMintCallToken } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

/**
 * Custom hook for handling call token minting and tab opening.
 *
 * Pre-fetches tokens in the background so the "Hear ArdaLink call you" button
 * can open the call screen instantly without network latency.
 */
export function useCallToken() {
  const [mintingCall, setMintCall] = useState(false);
  const prefetchedToken = useRef<{ token: string; expiresAt: number } | null>(
    null,
  );
  const mintMutation = useMintCallToken();
  const { toast } = useToast();

  // Mint a token in the background and stash it for the next click.
  const refreshPrefetchedToken = async () => {
    try {
      const data = await mintMutation.mutateAsync(undefined);
      prefetchedToken.current = {
        token: data.token,
        expiresAt: data.expiresAt,
      };
    } catch {
      /* offline / blocked — fallback path handles it */
    }
  };

  // Pre-mint one on mount so the first click is fast.
  useEffect(() => {
    void refreshPrefetchedToken();
  }, []);

  // Demo flow: open the herder-side incoming-call screen in a new tab.
  // Fast path: token pre-minted on mount → open the URL directly (instant)
  // and silently refresh for next time.
  // Slow path: pre-mint missed or expired → fall back to the about:blank
  // splash + synchronous mint.
  const handleHearTheCall = async () => {
    // Always open the tab SYNCHRONOUSLY inside the click handler so popup
    // blockers treat it as a user gesture, and always paint the "Dialling…"
    // splash for theatre.
    const win = window.open("about:blank", "_blank");
    if (!win) {
      toast({
        title: "Pop-up blocked",
        description: "Allow pop-ups for this site so ArdaLink can call you.",
        variant: "destructive",
      });
      return;
    }
    try {
      win.document.write(
        "<!doctype html><html><head><title>ArdaLink — dialling…</title>" +
          "<style>html,body{margin:0;height:100%;background:#0a0a0a;color:#fbbf24;" +
          "font-family:system-ui,sans-serif;display:flex;align-items:center;" +
          "justify-content:center;font-size:18px;letter-spacing:0.02em}" +
          ".dot{display:inline-block;width:8px;height:8px;border-radius:50%;" +
          "background:#fbbf24;margin:0 4px;animation:p 1.2s infinite ease-in-out}" +
          ".dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}" +
          "@keyframes p{0%,80%,100%{opacity:.2}40%{opacity:1}}</style>" +
          '</head><body><div>📡 Dialling your phone<span class="dot"></span>' +
          '<span class="dot"></span><span class="dot"></span></div></body></html>',
      );
      win.document.close();
    } catch {
      /* cross-origin write may fail — harmless */
    }
    setMintCall(true);
    // Minimum splash time so the "📡 Dialling…" animation is always
    // perceptible — even on the fast path where the token is already in
    // hand and the URL could be set in a few milliseconds.
    const SPLASH_MIN_MS = 750;
    const splashUntil = Date.now() + SPLASH_MIN_MS;
    try {
      // Fast path: a pre-minted token is ready → skip the network call.
      // Slow path: pre-mint missed/expired → mint synchronously now.
      const pre = prefetchedToken.current;
      const FRESH_MS = 60_000;
      let token: string;
      if (pre && pre.expiresAt - Date.now() > FRESH_MS) {
        prefetchedToken.current = null; // consume — never reuse
        token = pre.token;
        void refreshPrefetchedToken(); // ready for next click
      } else {
        // Slow path: synchronous mint with the Bearer token attached.
        const data = await mintMutation.mutateAsync(undefined);
        token = data.token;
      }
      // Hold the splash until SPLASH_MIN_MS has elapsed so the dialling
      // animation is always visible, even on the fast path.
      const remaining = splashUntil - Date.now();
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      // Absolute URL is essential — relative paths break from about:blank.
      const url = new URL(`/call/${token}`, window.location.origin).href;
      try {
        win.location.replace(url);
      } catch {
        // If the win.location setter is blocked (rare cross-origin edge case),
        // fall back to opening a fresh tab on the same gesture chain.
        window.open(url, "_blank");
        try {
          win.close();
        } catch {
          /* ignore */
        }
      }
      toast({
        title: "Your phone is ringing →",
        description: "Switch to the new tab and tap Accept to take the call.",
      });
    } catch (err) {
      try {
        win.close();
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : "Failed to start";
      toast({
        title: "Could not start the call",
        description: message,
        variant: "destructive",
      });
    } finally {
      setMintCall(false);
    }
  };

  return { handleHearTheCall, mintingCall };
}
