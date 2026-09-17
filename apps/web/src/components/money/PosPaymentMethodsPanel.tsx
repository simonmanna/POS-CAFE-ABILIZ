/**
 * Bind each POS payment mode to the finance account its money lands in.
 *
 * This is the configuration the Charge dialog runs on: the cashier picks a mode
 * (and a provider when a mode has several), and these rows decide the account.
 * The account picker only offers categories the posting engine accepts for the
 * chosen kind, so a saved method can never produce a tender that is later
 * rejected at settle time.
 */
import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, Loader2, ArrowRight, Banknote, Smartphone, CreditCard, Landmark, Gift, Lock, type LucideIcon } from 'lucide-react';
import { PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import {
  useCashAccounts, usePosPaymentMethodConfig, useCreatePosPaymentMethod,
  useUpdatePosPaymentMethod, useDeletePosPaymentMethod,
  POS_METHOD_ACCOUNT_TYPES, type PosPaymentMethodConfig,
} from '@/features/accounting/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { LoadError } from './money-ui';

const KINDS = ['cash', 'mobile_money', 'card', 'bank'] as const;
type Kind = typeof KINDS[number];

const KIND_LABEL: Record<string, string> = {
  cash: 'Cash', mobile_money: 'Mobile Money', card: 'Card', bank: 'Bank', store_credit: 'Store Credit',
};
const KIND_ICON: Record<string, LucideIcon> = {
  cash: Banknote, mobile_money: Smartphone, card: CreditCard, bank: Landmark, store_credit: Gift,
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const emptyForm = {
  code: '', label: '', kind: 'mobile_money' as Kind, provider: '', accountId: '',
  requiresReference: false, trackInShift: true, isActive: true, sortOrder: 0,
};

export function PosPaymentMethodsPanel() {
  const { data: methods = [], isLoading, isError, refetch, isFetching } = usePosPaymentMethodConfig();
  const { data: cashAccounts = [] } = useCashAccounts();
  const create = useCreatePosPaymentMethod();
  const update = useUpdatePosPaymentMethod();
  const remove = useDeletePosPaymentMethod();
  // Each action is gated by the permission its endpoint enforces, so a
  // read-only manager never sees a button that can only answer "forbidden".
  const hasPermission = useAuthStore((st) => st.hasPermission);
  const canCreate = hasPermission(PERMISSIONS.account.create);
  const canUpdate = hasPermission(PERMISSIONS.account.update);
  const canDelete = hasPermission(PERMISSIONS.account.delete);
  const readOnly = !canCreate && !canUpdate && !canDelete;
  const [retiring, setRetiring] = useState<PosPaymentMethodConfig | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PosPaymentMethodConfig | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  // Only accounts the posting engine will accept for this kind. Card clearing
  // lives outside the cash-equivalent list, so a card method may have nothing to
  // offer until the card_clearing mapping is set — the server says so on save.
  const eligibleAccounts = useMemo(() => {
    const allowed = POS_METHOD_ACCOUNT_TYPES[form.kind] ?? [];
    return (cashAccounts as any[]).filter((a) => allowed.includes(a.accountType));
  }, [cashAccounts, form.kind]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (m: PosPaymentMethodConfig) => {
    setEditing(m);
    setForm({
      code: m.code, label: m.label, kind: m.kind as Kind, provider: m.provider ?? '',
      accountId: m.accountId ?? '', requiresReference: m.requiresReference,
      trackInShift: m.trackInShift, isActive: m.isActive, sortOrder: m.sortOrder,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    const body = {
      code: form.code.trim() || slug(form.label),
      label: form.label.trim(),
      kind: form.kind,
      provider: form.provider.trim() || undefined,
      accountId: form.kind === 'cash' ? undefined : form.accountId || undefined,
      requiresReference: form.requiresReference,
      trackInShift: form.kind === 'cash' ? false : form.trackInShift,
      isActive: form.isActive,
      sortOrder: Number(form.sortOrder) || 0,
    };
    if (!body.label) { toast.error('A cashier-facing label is required'); return; }
    setSaving(true);
    try {
      if (editing) await update.mutateAsync({ id: editing.id, ...body });
      else await create.mutateAsync(body);
      toast.success(editing ? 'Payment method updated' : 'Payment method added');
      setDialogOpen(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not save the payment method');
    } finally {
      setSaving(false);
    }
  };

  const retire = async () => {
    const m = retiring;
    if (!m || remove.isPending) return;
    try {
      await remove.mutateAsync(m.id);
      toast.success(`${m.label} removed from the terminal`);
      setRetiring(null);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not remove the payment method');
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Each tile the cashier sees in the Charge dialog, and the account its money lands in.
          The cashier never picks an account — these links decide it.
        </p>
        {canCreate ? (
          <Button onClick={openCreate} className="min-h-[44px] w-full sm:w-auto">
            <Plus className="mr-1 h-4 w-4" aria-hidden /> Add payment method
          </Button>
        ) : null}
      </div>
      {readOnly ? (
        <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          You can view these links. Ask an administrator to add, change or remove payment methods.
        </p>
      ) : null}

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : isError ? (
        <LoadError message="Payment methods could not be loaded." onRetry={() => refetch()} retrying={isFetching} />
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {methods.map((m) => {
            const Icon = KIND_ICON[m.kind] ?? Banknote;
            const connected = m.kind === 'cash' || m.kind === 'store_credit' || !!m.accountName;
            return (
              <li key={m.id} className="flex flex-col gap-3 p-3 md:flex-row md:items-center">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-muted" aria-hidden><Icon className="h-4 w-4" /></span>
                  <span className="min-w-[140px]">
                    <span className="block font-medium text-foreground">{m.label}</span>
                    <span className="block text-xs text-muted-foreground">{KIND_LABEL[m.kind] ?? m.kind}{m.provider ? ` · ${m.provider}` : ''} · {m.code}</span>
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" aria-label="goes to" />
                  <span className={connected ? 'text-foreground' : 'font-medium text-destructive'}>
                    {m.kind === 'cash'
                      ? 'Drawer of the register taking the sale'
                      : m.kind === 'store_credit'
                        ? 'Customer store credit'
                        : m.accountName ? <>{m.accountName} <span className="text-muted-foreground">· {m.accountCode}</span></> : 'Not connected to an account'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${connected ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300'}`}>
                    {connected ? 'Connected' : 'Not connected'}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                    {m.isActive ? 'Shown at till' : 'Hidden at till'}
                  </span>
                  {m.requiresReference ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">Asks for reference</span> : null}
                  {m.trackInShift ? <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]">Counted at shift close</span> : null}
                  {canUpdate || canDelete ? (
                    <span className="ml-auto flex gap-2 md:ml-0">
                      {canUpdate ? (
                        <Button variant="outline" className="min-h-[44px]" onClick={() => openEdit(m)} aria-label={`Edit ${m.label}`}>
                          <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden /> Edit
                        </Button>
                      ) : null}
                      {canDelete ? (
                        <Button variant="ghost" className="min-h-[44px] min-w-[44px]" aria-label={`Remove ${m.label}`} onClick={() => setRetiring(m)}>
                          <Trash2 className="h-4 w-4 text-destructive" aria-hidden />
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
          {!methods.length ? (
            <li className="p-4 text-sm text-muted-foreground">
              Nothing configured yet — the terminal is falling back to whatever cash, wallet and
              bank accounts exist.{canCreate ? ' Add methods here to control the tiles the cashier sees.' : ''}
            </li>
          ) : null}
        </ul>
      )}

      <AlertDialog open={!!retiring} onOpenChange={(v) => { if (!v && !remove.isPending) setRetiring(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {retiring?.label} from the terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              Cashiers will no longer see the {retiring?.label} tile in the Charge dialog. Payments already
              taken with it stay in the books and in {retiring?.accountName ?? 'their account'}. To pause it
              without removing it, edit the method and turn off “Show in the terminal” instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-[44px]" disabled={remove.isPending}>Keep it</AlertDialogCancel>
            <Button variant="destructive" className="min-h-[44px]" onClick={retire} disabled={remove.isPending}>
              {remove.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
              Remove method
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.label}` : 'Add payment method'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Kind</Label>
                <select
                  aria-label="Kind"
                  className="min-h-[44px] w-full rounded-md border bg-background px-3 text-sm"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as Kind, accountId: '' })}
                >
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Decides the journal and the drawer rules. Stored on every payment.
                </p>
              </div>
              <div>
                <Label>Provider / brand</Label>
                <Input
                  value={form.provider}
                  placeholder="MTN"
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Shown as the second-step pill when a kind has several methods.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Label the cashier sees</Label>
                <Input
                  value={form.label}
                  placeholder="MTN MoMo"
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                />
              </div>
              <div>
                <Label>Code</Label>
                <Input
                  value={form.code}
                  placeholder={slug(form.label) || 'momo_mtn'}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </div>
            </div>

            {form.kind === 'cash' ? (
              <p className="rounded border bg-muted/50 p-3 text-xs text-muted-foreground">
                Cash always books to the register's own drawer account, so there is nothing to bind here.
              </p>
            ) : (
              <div>
                <Label>Receiving account</Label>
                <select
                  aria-label="Receiving account"
                  className="min-h-[44px] w-full rounded-md border bg-background px-3 text-sm"
                  value={form.accountId}
                  onChange={(e) => setForm({ ...form, accountId: e.target.value })}
                >
                  <option value="">Choose account</option>
                  {eligibleAccounts.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.name} · {a.code}</option>
                  ))}
                </select>
                {!eligibleAccounts.length ? (
                  <p className="mt-1 text-[11px] text-amber-700">
                    No {KIND_LABEL[form.kind].toLowerCase()} account exists yet. Add one under Money &amp; Accounts → Accounts first.
                    {form.kind === 'card' ? ' A card method must use the account mapped as card_clearing.' : ''}
                  </p>
                ) : null}
              </div>
            )}

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex min-h-[44px] items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.requiresReference}
                  onChange={(e) => setForm({ ...form, requiresReference: e.target.checked })}
                />
                Require a transaction id (prompts only — never blocks a sale)
              </label>
              {form.kind !== 'cash' ? (
                <label className="flex min-h-[44px] items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.trackInShift}
                    onChange={(e) => setForm({ ...form, trackInShift: e.target.checked })}
                  />
                  Count at shift open/close
                </label>
              ) : null}
              <label className="flex min-h-[44px] items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                />
                Show in the terminal
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {editing ? 'Save changes' : 'Add method'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
