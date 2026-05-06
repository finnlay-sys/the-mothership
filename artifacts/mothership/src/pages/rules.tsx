import { Layout } from "@/components/layout";
import { useListRules, useCreateRule } from "@workspace/api-client-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, Plus } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const schema = z.object({
  name: z.string().min(3).max(100),
  description: z.string().min(10).max(500),
  severity: z.enum(["low", "medium", "high", "critical"]),
});

export function Rules() {
  const { data: rules, isLoading, refetch } = useListRules();
  const createRule = useCreateRule();
  const [isCreating, setIsCreating] = useState(false);

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      description: "",
      severity: "medium",
    },
  });

  const onSubmit = (data: z.infer<typeof schema>) => {
    createRule.mutate(
      { data },
      {
        onSuccess: () => {
          setIsCreating(false);
          form.reset();
          refetch();
        },
      }
    );
  };

  return (
    <Layout>
      <div className="p-6 h-full flex flex-col">
        <header className="mb-6 flex justify-between items-end border-b border-border pb-4 shrink-0">
          <div>
            <h1 className="text-2xl font-mono font-bold text-primary tracking-widest uppercase flex items-center">
              <Shield className="w-6 h-6 mr-3" />
              Governance Rules
            </h1>
            <p className="text-muted-foreground font-mono text-sm mt-2">OBSERVER EVALUATION CONSTRAINTS</p>
          </div>
          <Button 
            onClick={() => setIsCreating(!isCreating)}
            variant={isCreating ? "secondary" : "default"}
            className="font-mono rounded-sm"
          >
            {isCreating ? "CANCEL" : <><Plus className="w-4 h-4 mr-2" /> ADD RULE</>}
          </Button>
        </header>

        <div className="flex-1 overflow-auto space-y-6">
          {isCreating && (
            <Card className="bg-card border-primary/50 shadow-[0_0_15px_hsl(var(--primary)/0.1)] rounded-sm">
              <CardHeader className="border-b border-border">
                <CardTitle className="font-mono text-sm text-primary tracking-widest">ENFORCE NEW CONSTRAINT</CardTitle>
              </CardHeader>
              <CardContent className="p-6">
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <FormField
                        control={form.control}
                        name="name"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono text-xs">IDENTIFIER</FormLabel>
                            <FormControl>
                              <Input {...field} className="font-mono bg-secondary/50 rounded-sm" placeholder="e.g. NO_EXTERNAL_COMMS" />
                            </FormControl>
                            <FormMessage className="text-xs" />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="severity"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="font-mono text-xs">SEVERITY</FormLabel>
                            <Select onValueChange={field.onChange} defaultValue={field.value}>
                              <FormControl>
                                <SelectTrigger className="font-mono bg-secondary/50 rounded-sm">
                                  <SelectValue placeholder="Select severity" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="low" className="font-mono">LOW</SelectItem>
                                <SelectItem value="medium" className="font-mono text-chart-4">MEDIUM</SelectItem>
                                <SelectItem value="high" className="font-mono text-chart-2">HIGH</SelectItem>
                                <SelectItem value="critical" className="font-mono text-destructive font-bold">CRITICAL</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage className="text-xs" />
                          </FormItem>
                        )}
                      />
                    </div>
                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="font-mono text-xs">CONSTRAINT LOGIC</FormLabel>
                          <FormControl>
                            <Textarea {...field} className="font-mono bg-secondary/50 rounded-sm resize-none" placeholder="Describe the exact behavior forbidden..." />
                          </FormControl>
                          <FormMessage className="text-xs" />
                        </FormItem>
                      )}
                    />
                    <div className="flex justify-end pt-2">
                      <Button type="submit" disabled={createRule.isPending} className="font-mono rounded-sm">
                        {createRule.isPending ? "COMMITTING..." : "COMMIT RULE"}
                      </Button>
                    </div>
                  </form>
                </Form>
              </CardContent>
            </Card>
          )}

          <div className="grid grid-cols-1 gap-4">
            {isLoading ? (
              <Skeleton className="h-32 w-full bg-secondary rounded-sm" />
            ) : rules?.length === 0 ? (
              <div className="text-center py-12 font-mono text-muted-foreground border border-dashed border-border rounded-sm">
                NO ACTIVE RULES. SYSTEM IS UNCONSTRAINED.
              </div>
            ) : (
              rules?.map(rule => (
                <div key={rule.id} className="border border-border bg-card p-4 rounded-sm flex items-start gap-4 relative overflow-hidden group hover:border-primary/30 transition-colors">
                  <div className={`w-1 absolute left-0 top-0 bottom-0 ${
                    rule.severity === 'critical' ? 'bg-destructive shadow-[0_0_8px_hsl(var(--destructive))]' :
                    rule.severity === 'high' ? 'bg-chart-2' :
                    rule.severity === 'medium' ? 'bg-chart-4' : 'bg-muted'
                  }`}></div>
                  
                  <div className="flex-1 pl-2">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-mono font-bold text-foreground">{rule.name}</h3>
                      <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded-sm border uppercase ${
                        rule.severity === 'critical' ? 'border-destructive text-destructive bg-destructive/10' :
                        rule.severity === 'high' ? 'border-chart-2 text-chart-2 bg-chart-2/10' :
                        rule.severity === 'medium' ? 'border-chart-4 text-chart-4 bg-chart-4/10' : 'border-muted text-muted-foreground'
                      }`}>
                        {rule.severity}
                      </span>
                    </div>
                    <p className="font-mono text-sm text-muted-foreground">{rule.description}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
