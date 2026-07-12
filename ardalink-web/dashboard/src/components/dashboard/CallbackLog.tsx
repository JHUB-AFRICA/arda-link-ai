import { Radio, Phone, MessageSquare, MessageCircle } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Real-time (30 s poll) log of every AT surface hit — USSD dial,
 * SMS keyword, voice call stage. Powered by lead_interactions rows
 * that every AT route writes on every hit (see A5).
 */
interface InteractionRow {
  interaction_id: string;
  phone_number: string;
  tier: "verified" | "lead" | "unknown";
  channel: "ussd" | "sms" | "voice" | "voice_event";
  session_id: string | null;
  keyword: string | null;
  input_text: string | null;
  reply_text: string | null;
  ward_id: string | null;
  occurred_at: string;
}

interface InteractionsResponse {
  ready: boolean;
  count: number;
  interactions: InteractionRow[];
  reason?: string;
}

export default function CallbackLog() {
  const [channel, setChannel] = useState<string>("");

  const intQ = useQuery<InteractionsResponse>({
    queryKey: ["ops-interactions", channel],
    queryFn: async () => {
      const tok = readToken();
      const qs = new URLSearchParams({ limit: "100" });
      if (channel) qs.set("channel", channel);
      const r = await fetch(`/api/ops/interactions?${qs.toString()}`, {
        headers: tok ? { Authorization: `Bearer ${tok}` } : {},
      });
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const rows = intQ.data?.interactions ?? [];

  return (
    <section className="rounded-2xl border border-border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Radio className="h-5 w-5 text-primary" />
          <div>
            <h2 className="text-lg font-semibold">Callback log</h2>
            <p className="text-xs text-muted-foreground">
              Live tail of every USSD / SMS / voice interaction. Auto-refreshes.
            </p>
          </div>
        </div>
        <div className="flex gap-1">
          {["", "sms", "ussd", "voice"].map((c) => (
            <button
              key={c || "all"}
              onClick={() => setChannel(c)}
              className={`rounded px-2 py-1 text-xs ${
                channel === c
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {c || "all"}
            </button>
          ))}
        </div>
      </div>

      {intQ.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !intQ.data?.ready ? (
        <p className="text-sm text-muted-foreground">
          Not ready:{" "}
          <span className="font-mono">
            {intQ.data?.reason ?? "unknown"}
          </span>
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No interactions logged yet in this filter.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-24">When</TableHead>
              <TableHead className="w-20">Chan</TableHead>
              <TableHead className="w-20">Tier</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Reply</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.interaction_id}>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRel(r.occurred_at)}
                </TableCell>
                <TableCell>
                  <ChannelChip channel={r.channel} />
                </TableCell>
                <TableCell>
                  <TierChip tier={r.tier} />
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {r.phone_number}
                </TableCell>
                <TableCell className="max-w-[10rem] truncate text-xs">
                  {r.keyword ? (
                    <>
                      <span className="mr-1 rounded bg-muted px-1 text-xs uppercase">
                        {r.keyword}
                      </span>
                    </>
                  ) : null}
                  {r.input_text ?? "—"}
                </TableCell>
                <TableCell className="max-w-[24rem] truncate text-xs text-muted-foreground">
                  {r.reply_text ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

function ChannelChip({ channel }: { channel: InteractionRow["channel"] }) {
  const map = {
    sms: { icon: MessageSquare, color: "text-sky-600" },
    ussd: { icon: MessageCircle, color: "text-emerald-600" },
    voice: { icon: Phone, color: "text-purple-600" },
    voice_event: { icon: Radio, color: "text-purple-400" },
  };
  const { icon: Icon, color } = map[channel];
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${color}`}>
      <Icon className="h-3 w-3" />
      {channel}
    </span>
  );
}

function TierChip({ tier }: { tier: InteractionRow["tier"] }) {
  const map: Record<InteractionRow["tier"], string> = {
    verified: "bg-emerald-100 text-emerald-800",
    lead: "bg-amber-100 text-amber-800",
    unknown: "bg-slate-100 text-slate-600",
  };
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs ${map[tier]}`}>{tier}</span>
  );
}

function formatRel(ts: string): string {
  const d = new Date(ts).getTime();
  const diffMs = Date.now() - d;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}
