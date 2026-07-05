import { useState, useRef, useEffect } from "react";
import { MessageSquare, Send, Loader2, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useChatWithLand } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

interface ChatModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatModal({ open, onOpenChange }: ChatModalProps) {
  const [chatInput, setChatInput] = useState("");
  const [chatHistory, setChatHistory] = useState<
    { role: "user" | "assistant" | "system"; content: string; context?: any }[]
  >([
    {
      role: "system",
      content: "ArdaLink is ready. Ask me anything about your land.",
    },
  ]);
  const chatMutation = useChatWithLand();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatHistory, chatMutation.isPending, open]);

  const handleSendChat = (messageText?: string) => {
    const msg = messageText ?? chatInput;
    if (!msg.trim() || chatMutation.isPending) return;

    setChatInput("");
    setChatHistory((prev) => [...prev, { role: "user", content: msg.trim() }]);

    const historyForApi = chatHistory
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    chatMutation.mutate(
      { data: { message: msg.trim(), history: historyForApi } },
      {
        onSuccess: (reply: { ok?: boolean; message?: string; reply?: string; context?: any }) => {
          setChatHistory((prev) => [
            ...prev,
            {
              role: "assistant",
              content: reply.reply || reply.message || "No response",
              context: reply.context,
            },
          ]);
        },
        onError: () => {
          toast({ title: "Failed to send message", variant: "destructive" });
          setChatHistory((prev) => prev.slice(0, -1));
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl h-[80vh] flex flex-col p-0 gap-0 bg-gray-900 border-gray-800">
        <DialogHeader className="px-6 py-4 border-b border-gray-800">
          <DialogTitle className="flex items-center gap-2 text-white">
            <Radio className="w-5 h-5 text-green-400" />
            Chat with your Land
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {chatHistory.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
                  msg.role === "system"
                    ? "bg-blue-900/20 border border-blue-800/40 text-blue-200"
                    : msg.role === "user"
                      ? "bg-amber-600/20 border border-amber-600/30 text-amber-100 rounded-tr-sm"
                      : "bg-gray-800 border border-gray-700 text-gray-200 rounded-tl-sm flex gap-3 items-start"
                }`}
              >
                {msg.role === "assistant" && (
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-green-600 to-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                    <Radio className="w-3 h-3 text-green-100" />
                  </div>
                )}
                <div>
                  {msg.role === "system" && (
                    <span className="font-semibold text-blue-400 mr-2">
                      System:
                    </span>
                  )}
                  {msg.content}
                  {msg.context && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {msg.context.riskLevel && (
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-gray-900 text-gray-400 border border-gray-700">
                          Risk: {msg.context.riskLevel}
                        </span>
                      )}
                      {msg.context.worstQuadrant && (
                        <span className="px-2 py-0.5 text-[10px] rounded-full bg-gray-900 text-gray-400 border border-gray-700">
                          Worst: {msg.context.worstQuadrant}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}

          {chatMutation.isPending && (
            <div className="flex justify-start">
              <div className="max-w-[80%] bg-gray-800 border border-gray-700 text-gray-400 rounded-2xl rounded-tl-sm px-4 py-3 text-sm flex items-center gap-3">
                <Loader2 className="w-4 h-4 animate-spin text-amber-500" />
                Analyzing satellite + climate data...
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="p-4 bg-gray-950 border-t border-gray-800 shrink-0">
          <div className="flex flex-wrap gap-2 mb-3">
            {[
              "Je, mvua inakuja lini?",
              "Where is the best pasture now?",
              "Should I move my cattle from SE?",
              "Hali ya maji Bula Pesa?",
            ].map((q, i) => (
              <button
                key={i}
                onClick={() => handleSendChat(q)}
                className="px-3 py-1.5 bg-gray-900 hover:bg-gray-800 border border-gray-800 rounded-full text-xs text-gray-400 transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChat();
            }}
            className="flex items-end gap-3"
          >
            <div className="flex-1 relative">
              <Input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Ask about conditions, forecast, or recommendations..."
                className="w-full bg-gray-900 border-gray-700 text-white h-12 pl-4 pr-12 rounded-xl focus-visible:ring-amber-500"
                disabled={chatMutation.isPending}
              />
            </div>
            <Button
              type="submit"
              disabled={!chatInput.trim() || chatMutation.isPending}
              size="icon"
              className="h-12 w-12 rounded-xl bg-amber-600 hover:bg-amber-700 shrink-0"
            >
              <Send className="w-5 h-5 text-white" />
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ChatFloatingButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-amber-600 hover:bg-amber-700 text-white shadow-lg shadow-amber-900/40 flex items-center justify-center transition-all hover:scale-105"
      title="Chat with your Land"
    >
      <MessageSquare className="w-6 h-6" />
    </button>
  );
}
