import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Plus, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreatePastoralist,
  getListPastoralistsQueryKey,
} from "@workspace/api-client-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const pastoralistSchema = z.object({
  name: z.string().min(1, "Required"),
  phone: z.string().min(1, "Required"),
  location: z.string().optional(),
  cattle: z.coerce.number().optional(),
  goats: z.coerce.number().optional(),
  camels: z.coerce.number().optional(),
  waterSource: z.string().optional(),
  alertsEnabled: z.boolean().default(true),
});

type PastoralistFormData = z.infer<typeof pastoralistSchema>;

/** Pastoralist registration form with validation and CRUD operations */
export function PastoralistForm() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const form = useForm<PastoralistFormData>({
    resolver: zodResolver(pastoralistSchema),
    defaultValues: {
      name: "",
      phone: "",
      location: "",
      cattle: 0,
      goats: 0,
      camels: 0,
      waterSource: "Borehole",
      alertsEnabled: true,
    },
  });

  const createPastoralist = useCreatePastoralist();

  const onSubmit = (data: PastoralistFormData) => {
    createPastoralist.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: "Pastoralist registered successfully" });
          form.reset();
          queryClient.invalidateQueries({
            queryKey: getListPastoralistsQueryKey(),
          });
        },
        onError: () => {
          toast({
            title: "Failed to register pastoralist",
            variant: "destructive",
          });
        },
      },
    );
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
          <div className="grid grid-cols-3 gap-2">
            <FormField
              control={form.control}
              name="cattle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-gray-400">Cattle</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      className="bg-gray-950 border-gray-700 text-white h-8"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="goats"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-gray-400">
                    Goats/Sheep
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      className="bg-gray-950 border-gray-700 text-white h-8"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="camels"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-gray-400">Camels</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      {...field}
                      className="bg-gray-950 border-gray-700 text-white h-8"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
          <FormField
            control={form.control}
            name="waterSource"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-gray-300">
                  Primary Water Source
                </FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger className="bg-gray-950 border-gray-700 text-white">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="bg-gray-900 border-gray-700 text-white">
                    <SelectItem value="Borehole">Borehole</SelectItem>
                    <SelectItem value="River">River</SelectItem>
                    <SelectItem value="Dam">Dam / Pan</SelectItem>
                    <SelectItem value="Berkad">Berkad</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="alertsEnabled"
            render={({ field }) => (
              <FormItem className="flex items-center justify-between rounded-lg border border-gray-800 p-3 bg-gray-950/50">
                <div className="space-y-0.5">
                  <FormLabel className="text-gray-300 text-sm">
                    SMS Alerts
                  </FormLabel>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    data-testid="switch-alerts"
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
