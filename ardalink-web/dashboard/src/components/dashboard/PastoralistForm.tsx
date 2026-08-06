import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Plus, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readToken } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";

const pastoralistSchema = z.object({
  name: z.string().min(1, "Required"),
  phone: z.string().min(1, "Required"),
  location: z.string().optional(),
  herdSize: z.coerce.number().min(0).optional(),
});

type PastoralistFormData = z.infer<typeof pastoralistSchema>;

/**
 * Pastoralist registration form.
 *
 * **Rewritten 2026-08-06**: this used to submit `cattle`/`goats`/`camels`/
 * `waterSource`/`alertsEnabled` — the local mirror's shape. The real
 * Supabase `pastoralists` table has one `herd_size` total and no
 * `waterSource`/`alertsEnabled` columns at all, so those fields were
 * silently discarded server-side even before this fix (the POST route
 * only ever wrote what the real table supports). Now a plain fetch POST,
 * matching the pattern already used by LeadsSection.tsx and the other
 * ops-panel action endpoints.
 */
export function PastoralistForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<PastoralistFormData>({
    resolver: zodResolver(pastoralistSchema),
    defaultValues: {
      name: "",
      phone: "",
      location: "",
      herdSize: 0,
    },
  });

  const createPastoralist = useMutation({
    mutationFn: async (data: PastoralistFormData) => {
      const tok = readToken();
      const r = await fetch("/api/pastoralists", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
        body: JSON.stringify({
          name: data.name,
          phone: data.phone,
          location: data.location,
          herdSize: data.herdSize,
        }),
      });
      if (!r.ok) throw new Error(`create pastoralist failed: ${r.status}`);
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Pastoralist registered successfully" });
      form.reset();
      queryClient.invalidateQueries({ queryKey: ["pastoralists"] });
    },
    onError: () => {
      toast({
        title: "Failed to register pastoralist",
        variant: "destructive",
      });
    },
  });

  const onSubmit = (data: PastoralistFormData) => {
    createPastoralist.mutate(data);
  };

  return (
    <div className="w-full md:w-80 md:shrink-0 bg-gray-900 border border-gray-800 rounded-2xl p-4 sm:p-5 h-fit">
      <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
        <Plus className="w-4 h-4" /> Register Herder
      </h3>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-300">Full Name</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    className="bg-gray-950 border-gray-700 text-white"
                    data-testid="input-name"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-300">Phone Number</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder="+254..."
                    className="bg-gray-950 border-gray-700 text-white"
                    data-testid="input-phone"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="location"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-300">Location / Area</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    className="bg-gray-950 border-gray-700 text-white"
                    data-testid="input-location"
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="herdSize"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-300">Herd Size</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min="0"
                    {...field}
                    className="bg-gray-950 border-gray-700 text-white"
                    data-testid="input-herd-size"
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <Button
            type="submit"
            disabled={createPastoralist.isPending}
            className="w-full bg-amber-600 hover:bg-amber-700 text-white"
            data-testid="btn-submit-pastoralist"
          >
            {createPastoralist.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              "Register"
            )}
          </Button>
        </form>
      </Form>
    </div>
  );
}
