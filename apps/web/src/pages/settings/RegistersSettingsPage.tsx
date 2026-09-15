import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Banknote, ChevronDown, Loader2, Pencil, Plus, Power, PowerOff } from 'lucide-react';
import { toast } from 'sonner';
import { PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { locationsApi } from '@/lib/api/locations';
import { apiErrorMessage } from '@/lib/api-error';
import { useCashAccounts, type CashAccount } from '@/features/accounting/api';
import { useRegisterConfigs, useSaveRegister, type RegisterConfig } from '@/features/money/api';
import { EmptyState, MoneyPageHeader } from '@/components/money/money-ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SearchableSelect } from '@/components/ui/searchable-select';

type RegisterRow = RegisterConfig & { defaultAccount?: { id: string; code: string; name: string } | null; location?: { id: string; name: string } | null };

function useBranches() {
  return useQuery({
    queryKey: ['branches-switch'],
    queryFn: async () => (await api.get<{ data: { id: string; code: string; name: string }[] }>('/branches', { params: { pageSize: 200 } })).data,
  });
}

function RegisterDialog({ open, onClose, editing }: { open: boolean; onClose: () => void; editing: RegisterRow | null }) {
  const save = useSaveRegister();
  const { data: branches } = useBranches();
  const { data: locations } = useQuery({ queryKey: ['locations-for-registers'], queryFn: () => locationsApi.list({ pageSize: 200 }), enabled: open });
  const { data: accounts = [] } = useCashAccounts();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [branchId, setBranchId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [drawerId, setDrawerId] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? ''); setCode(editing?.code ?? '');
    setBranchId(editing?.branchId ?? ''); setLocationId(editing?.locationId ?? '');
    setDrawerId(editing?.defaultAccountId ?? ''); setAdvanced(false);
  }, [open, editing]);

  // Eligible existing drawers: active cash / petty-cash accounts not used by another register.
  const eligibleDrawers = useMemo(() => (accounts as CashAccount[]).filter((a) =>
    ['cash', 'petty_cash'].includes(a.accountType) && !(a.registers ?? []).some((r) => r.isActive && r.id !== editing?.id),
  ), [accounts, editing]);

  const suggestedCode = code.trim() ? `DRW-${code.trim().toUpperCase()}` : 'DRW-<code>';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !code.trim()) { toast.error('Name and code are required'); return; }
    try {
      await save.mutateAsync({
        id: editing?.id,
        ...(editing ? {} : { code: code.trim().toUpperCase() }),
        name: name.trim(),
        branchId: branchId || undefined,
        locationId: locationId || undefined,
        defaultAccountId: advanced && drawerId && drawerId !== editing?.defaultAccountId ? drawerId : undefined,
      });
      toast.success(editing ? 'Register updated' : 'Register created with its drawer account');
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The register was not saved'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !save.isPending) onClose(); }}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : 'Add a register'}</DialogTitle>
          <DialogDescription>A till where cashiers open shifts and take cash. Each register has its own drawer account.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <div className="space-y-1.5">
              <Label htmlFor="reg-name">Name</Label>
              <Input id="reg-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Main Counter" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-code">Code</Label>
              <Input id="reg-code" required disabled={!!editing} className="font-mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="MAIN" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Branch <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <SearchableSelect
              value={branchId}
              onValueChange={setBranchId}
              placeholder="Choose branch"
              options={(branches?.data ?? []).map((b) => ({ value: b.id, label: `${b.name} · ${b.code}` }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Stock location <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <SearchableSelect
              value={locationId}
              onValueChange={setLocationId}
              placeholder="Choose where sold stock is taken from"
              options={(locations?.data ?? []).filter((l) => l.isActive).map((l) => ({ value: l.id, label: `${l.name} · ${l.code}` }))}
            />
          </div>

          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium"><Banknote className="h-4 w-4" aria-hidden /> Drawer account</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {editing
                ? <>Currently <strong>{editing.defaultAccount?.name ?? 'set'}</strong>{editing.defaultAccount?.code ? ` (${editing.defaultAccount.code})` : ''}.</>
                : <>Created automatically as <strong className="font-mono">{suggestedCode}</strong>. Cash sales on this register are booked there.</>}
            </p>
            <button type="button" onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced} className="mt-2 inline-flex min-h-[36px] items-center gap-1 text-xs font-medium text-primary">
              Advanced: use an existing cash account <ChevronDown className={`h-3.5 w-3.5 transition-transform ${advanced ? 'rotate-180' : ''}`} aria-hidden />
            </button>
            {advanced ? (
              <div className="mt-2 space-y-1">
                <select aria-label="Existing drawer account" className="min-h-[40px] w-full rounded-md border bg-background px-3 text-sm" value={drawerId} onChange={(e) => setDrawerId(e.target.value)}>
                  <option value="">{editing ? 'Keep current account' : 'Create automatically'}</option>
                  {eligibleDrawers.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.code}</option>)}
                </select>
                <p className="text-[11px] text-muted-foreground">Only unused cash or petty-cash accounts are listed. The account cannot change while a shift is open.</p>
              </div>
            ) : null}
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}{editing ? 'Save changes' : 'Add register'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RegistersSettingsPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canEdit = hasPermission(PERMISSIONS.cashRegister.update);
  const { data = [], isLoading } = useRegisterConfigs();
  const save = useSaveRegister();
  const [dialog, setDialog] = useState<{ editing: RegisterRow | null } | null>(null);
  const rows = data as RegisterRow[];

  const toggle = async (r: RegisterRow) => {
    try {
      await save.mutateAsync({ id: r.id, isActive: !r.isActive });
      toast.success(r.isActive ? `${r.name} deactivated` : `${r.name} activated`);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'The register was not changed'));
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 md:p-6">
      <MoneyPageHeader
        title="Registers"
        description="Tills where cashiers open shifts. Day-to-day shifts, cash in/out and banking happen on the register page."
        actions={(
          <>
            <Button asChild variant="outline" className="min-h-[44px]"><Link to="/pos/cash-registers">Open register page</Link></Button>
            {hasPermission(PERMISSIONS.cashRegister.create) ? (
              <Button className="min-h-[44px]" onClick={() => setDialog({ editing: null })}><Plus className="mr-2 h-4 w-4" /> Add register</Button>
            ) : null}
          </>
        )}
      />
      {isLoading ? (
        <div className="flex h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Banknote} title="No registers yet">Add a register so the POS can take cash.</EmptyState>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-sm">
                <p className="font-medium text-foreground">{r.name} <span className="font-mono text-xs text-muted-foreground">{r.code}</span></p>
                <p className="text-xs text-muted-foreground">
                  Drawer: {r.defaultAccount ? `${r.defaultAccount.name} (${r.defaultAccount.code})` : '—'}
                  {r.location ? ` · Stock from ${r.location.name}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${r.isActive ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
                  {r.isActive ? 'Active' : 'Inactive'}
                </span>
                {canEdit ? (
                  <>
                    <Button variant="outline" size="sm" className="min-h-[40px]" onClick={() => setDialog({ editing: r })}><Pencil className="mr-1 h-3.5 w-3.5" aria-hidden /> Edit</Button>
                    <Button variant="ghost" size="sm" className="min-h-[40px]" onClick={() => toggle(r)} disabled={save.isPending}>
                      {r.isActive ? <><PowerOff className="mr-1 h-3.5 w-3.5 text-destructive" aria-hidden /> Deactivate</> : <><Power className="mr-1 h-3.5 w-3.5 text-emerald-600" aria-hidden /> Activate</>}
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <RegisterDialog open={!!dialog} onClose={() => setDialog(null)} editing={dialog?.editing ?? null} />
    </div>
  );
}
