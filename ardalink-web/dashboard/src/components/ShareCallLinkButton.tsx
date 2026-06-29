import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Share2,
  Copy,
  Check,
  Smartphone,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Shield,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface MintResult {
  token: string;
  expiresAt: number;
  ttlSeconds: number;
}

async function mintToken(): Promise<MintResult> {
  const res = await fetch("/api/call-tokens", { method: "POST" });
  if (res.status === 429) {
    throw new Error(
      "Too many active call links — close some open share dialogs and try again.",
    );
  }
  if (!res.ok) throw new Error(`Could not generate link (HTTP ${res.status})`);
  return (await res.json()) as MintResult;
}

function buildShareUrl(token: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${window.location.origin}${base}/call/${token}`;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function ShareCallLinkButton() {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mint, setMint] = useState<MintResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const { toast } = useToast();

  const refresh = async () => {
    setLoading(true);
    setError(null);
    setCopied(false);
    try {
      const result = await mintToken();
      setMint(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate link");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && !mint && !loading) {
      void refresh();
    }
    if (!open) {
      // Clear minted token when modal closes so each open gets a fresh link.
      setMint(null);
      setError(null);
      setCopied(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open]);

  const url = mint ? buildShareUrl(mint.token) : "";
  const remainingMs = mint ? mint.expiresAt - now : 0;
  const expired = mint != null && remainingMs <= 0;

  const handleCopy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the link manually to copy.",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        variant="outline"
        className="border-amber-700/50 text-amber-300 hover:bg-amber-900/30 hover:text-amber-200"
        data-testid="btn-share-call-link"
      >
        <Share2 className="w-4 h-4 mr-2" />
        Share recipient link
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-gray-950 border-gray-800 text-gray-100 max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Smartphone className="w-5 h-5 text-amber-500" /> Send ArdaLink to
              a recipient
            </DialogTitle>
            <DialogDescription className="text-gray-400">
              Share this link with the herder. It works once and expires in 15
              minutes — no app install needed.
            </DialogDescription>
          </DialogHeader>

          {loading && (
            <div className="flex items-center justify-center gap-2 py-12 text-gray-400">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">Generating secure link…</span>
            </div>
          )}

          {error && !loading && (
            <div className="p-3 bg-red-950/40 border border-red-900/50 rounded-lg text-xs text-red-300 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {mint && !loading && (
            <>
              <div className="flex flex-col items-center gap-4 py-4">
                <div
                  className={`p-3 bg-white rounded-xl ${expired ? "opacity-30" : ""}`}
                >
                  <QRCodeSVG value={url} size={192} level="M" />
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <Shield
                    className={`w-3.5 h-3.5 ${expired ? "text-gray-600" : "text-green-500"}`}
                  />
                  <span className={expired ? "text-red-400" : "text-gray-400"}>
                    {expired
                      ? "This link has expired — generate a new one"
                      : `Single-use · expires in ${formatRemaining(remainingMs)}`}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div
                  className={`flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-xs font-mono truncate ${
                    expired ? "text-gray-600 line-through" : "text-gray-300"
                  }`}
                  data-testid="text-share-url"
                >
                  {url}
                </div>
                <Button
                  onClick={handleCopy}
                  variant="outline"
                  size="sm"
                  disabled={expired}
                  className="border-gray-700 text-gray-200 hover:bg-gray-800"
                  data-testid="btn-copy-share-url"
                >
                  {copied ? (
                    <Check className="w-4 h-4 text-green-400" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
                <Button
                  onClick={refresh}
                  variant="outline"
                  size="sm"
                  className="border-gray-700 text-gray-200 hover:bg-gray-800"
                  data-testid="btn-regenerate-share-url"
                  title="Generate a new link"
                >
                  <RefreshCw className="w-4 h-4" />
                </Button>
              </div>

              <div className="text-xs text-gray-500 leading-relaxed mt-2">
                Once the recipient taps Accept, the link is burned — it can't be
                reused or shared further. Generate a new one for each call.
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
