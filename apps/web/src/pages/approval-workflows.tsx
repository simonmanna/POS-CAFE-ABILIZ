import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ToggleLeft, ToggleRight, ArrowDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { ENTITY_TYPE_LABELS, entityTypeLabel } from '@/lib/approval-entity-types';

interface ApprovalStep {
  id: string;
  stepOrder: number;
  name: string;
  approverPermissions: string[] | null;
  requiredCount: number;
  minAmount: number | null;
  maxAmount: number | null;
}
interface ApprovalWorkflow {
  id: string;
  name: string;
  entityType: string;
  minAmount: number | null;
  enforceDistinctApprovers: boolean;
  isActive: boolean;
  steps: ApprovalStep[];
  createdAt: string;
}

type StepForm = {
  stepOrder: number;
  name: string;
  approverPermissions: string;
  requiredCount: string;
  minAmount: string;
  maxAmount: string;
};
const emptyStep = (order: number): StepForm => ({
  stepOrder: order,
  name: '',
  approverPermissions: '',
  requiredCount: '1',
  minAmount: '',
  maxAmount: '',
});
const emptyForm = () => ({
  name: '',
  entityType: '',
  minAmount: '',
  enforceDistinctApprovers: false,
  steps: [emptyStep(1)] as StepForm[],
});

function fmtBand(min: number | null, max: number | null): string {
  if (min == null && max == null) return 'any amount';
  if (min != null && max != null) return `${min} – ${max}`;
  if (min != null) return `≥ ${min}`;
  return `< ${max}`;
}

export function ApprovalWorkflowsPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm());

  const list = useQuery<ApprovalWorkflow[]>({
    queryKey: ['approval-workflows'],
    queryFn: async () => (await api.get<ApprovalWorkflow[]>('/approval-workflows')).data,
  });

  const toggle = useMutation({
    mutationFn: async (vars: { id: string; isActive: boolean }) =>
      api.patch(`/approval-workflows/${vars.id}`, { isActive: vars.isActive }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-workflows'] });
      notify.success('Workflow updated');
    },
    onError: (err: any) => notify.error(err?.response?.data?.message ?? 'Failed'),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!form.entityType) throw new Error('Select a feature');
      if (!form.steps.length) throw new Error('Add at least one step');
      return api.post('/approval-workflows', {
        name: form.name || form.entityType,
        entityType: form.entityType,
        minAmount: form.minAmount ? Number(form.minAmount) : null,
        enforceDistinctApprovers: form.enforceDistinctApprovers,
        isActive: true,
        steps: form.steps.map((s) => ({
          stepOrder: s.stepOrder,
          name: s.name || `Step ${s.stepOrder}`,
          approverPermissions: s.approverPermissions
            ? s.approverPermissions.split(',').map((p) => p.trim()).filter(Boolean)
            : [],
          requiredCount: Number(s.requiredCount) || 1,
          minAmount: s.minAmount ? Number(s.minAmount) : null,
          maxAmount: s.maxAmount ? Number(s.maxAmount) : null,
        })),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-workflows'] });
      setShowForm(false);
      setForm(emptyForm());
      notify.success('Workflow created');
    },
    onError: (err: any) => notify.error(err?.response?.data?.message ?? err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/approval-workflows/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-workflows'] });
      notify.success('Workflow deleted');
    },
    onError: (err: any) => notify.error(err?.response?.data?.message ?? 'Failed'),
  });

  const setStep = (idx: number, patch: Partial<StepForm>) =>
    setForm((f) => ({ ...f, steps: f.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) }));
  const addStep = () =>
    setForm((f) => ({ ...f, steps: [...f.steps, emptyStep(f.steps.length + 1)] }));
  const removeStep = (idx: number) =>
    setForm((f) => ({
      ...f,
      steps: f.steps.filter((_, i) => i !== idx).map((s, i) => ({ ...s, stepOrder: i + 1 })),
    }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Approval Workflows</h1>
          <p className="text-sm text-muted-foreground">
            Configure multi-step approval chains per document type. A request clears
            every step whose amount band matches, in order. No workflow = auto-approve.
          </p>
        </div>
        <Button onClick={() => setShowForm((s) => !s)}>
          <Plus className="mr-1 h-4 w-4" /> Add Workflow
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New Approval Workflow</CardTitle>
            <CardDescription>
              Each step needs its own approvers. Set amount bands to route by value
              (e.g. Supervisor 0–5,000, then Finance 5,000–20,000, then CEO 20,000+).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Feature *</Label>
                <select
                  value={form.entityType}
                  onChange={(e) => setForm((f) => ({ ...f, entityType: e.target.value }))}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">-- Select feature --</option>
                  {Object.entries(ENTITY_TYPE_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Workflow Name</Label>
                <Input
                  placeholder="e.g. PO Approval"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Min Amount (whole workflow, optional)</Label>
                <Input
                  type="number"
                  placeholder="applies only above this amount"
                  value={form.minAmount}
                  onChange={(e) => setForm((f) => ({ ...f, minAmount: e.target.value }))}
                />
              </div>
              <div className="flex items-end gap-2">
                <input
                  id="sod"
                  type="checkbox"
                  className="h-4 w-4"
                  checked={form.enforceDistinctApprovers}
                  onChange={(e) => setForm((f) => ({ ...f, enforceDistinctApprovers: e.target.checked }))}
                />
                <Label htmlFor="sod" className="cursor-pointer">
                  Segregation of duties (one approver can clear only one step)
                </Label>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Steps</Label>
                <Button variant="outline" size="sm" onClick={addStep}>
                  <Plus className="mr-1 h-4 w-4" /> Add Step
                </Button>
              </div>
              {form.steps.map((s, idx) => (
                <div key={idx} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Step {s.stepOrder}</span>
                    {form.steps.length > 1 && (
                      <Button variant="ghost" size="icon" onClick={() => removeStep(idx)}>
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Step Name</Label>
                      <Input
                        placeholder="e.g. Finance"
                        value={s.name}
                        onChange={(e) => setStep(idx, { name: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Required Approvals</Label>
                      <Input
                        type="number"
                        min={1}
                        value={s.requiredCount}
                        onChange={(e) => setStep(idx, { requiredCount: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label>Approver Permissions (comma-separated)</Label>
                      <Input
                        placeholder="finance:approve, purchase_order:approve"
                        value={s.approverPermissions}
                        onChange={(e) => setStep(idx, { approverPermissions: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Band Min (optional)</Label>
                      <Input
                        type="number"
                        placeholder="0"
                        value={s.minAmount}
                        onChange={(e) => setStep(idx, { minAmount: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Band Max (optional)</Label>
                      <Input
                        type="number"
                        placeholder="no upper bound"
                        value={s.maxAmount}
                        onChange={(e) => setStep(idx, { maxAmount: e.target.value })}
                      />
                    </div>
                  </div>
                  {idx < form.steps.length - 1 && (
                    <div className="mt-2 flex justify-center text-muted-foreground">
                      <ArrowDown className="h-4 w-4" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button disabled={create.isPending} onClick={() => create.mutate()}>Create Workflow</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {list.isLoading && <Skeleton className="h-48 w-full" />}

      {list.data && list.data.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-3 p-12 text-center">
            <p className="text-sm text-muted-foreground">No approval workflows configured.</p>
            <p className="text-xs text-muted-foreground">
              Document types without a workflow are auto-approved. Add one to gate them.
            </p>
            <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
              <Plus className="mr-1 h-4 w-4" /> Add your first workflow
            </Button>
          </CardContent>
        </Card>
      )}

      {list.data && list.data.length > 0 && (
        <div className="space-y-3">
          {list.data.map((w) => (
            <Card key={w.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{w.name}</span>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {entityTypeLabel(w.entityType)}
                      </span>
                      {w.minAmount != null && (
                        <span className="text-xs text-muted-foreground">≥ {w.minAmount}</span>
                      )}
                      {w.enforceDistinctApprovers && (
                        <span className="text-[10px] uppercase tracking-wide text-amber-600">SoD</span>
                      )}
                    </div>
                    <ol className="mt-2 space-y-1">
                      {[...w.steps]
                        .sort((a, b) => a.stepOrder - b.stepOrder)
                        .map((s) => (
                          <li key={s.id} className="text-sm text-muted-foreground">
                            <span className="font-medium text-foreground">{s.stepOrder}. {s.name}</span>{' '}
                            — {s.requiredCount} approval{s.requiredCount > 1 ? 's' : ''} ·{' '}
                            {fmtBand(s.minAmount, s.maxAmount)}
                            {s.approverPermissions && s.approverPermissions.length > 0 && (
                              <span className="ml-1 text-[10px] text-muted-foreground/60">
                                ({s.approverPermissions.join(', ')})
                              </span>
                            )}
                          </li>
                        ))}
                    </ol>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: w.id, isActive: !w.isActive })}
                      title={w.isActive ? 'Active — click to disable' : 'Inactive — click to enable'}
                    >
                      {w.isActive
                        ? <ToggleRight className="h-5 w-5 text-emerald-500" />
                        : <ToggleLeft className="h-5 w-5 text-muted-foreground" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (confirm('Delete this workflow?')) remove.mutate(w.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
