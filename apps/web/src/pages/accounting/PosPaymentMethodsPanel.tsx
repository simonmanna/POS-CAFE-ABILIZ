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
import { Plus, Pencil, Trash2, Loader2, Check, X } from 'lucide-react';
import {
  useCashAccounts, usePosPaymentMethodConfig, useCreatePosPaymentMethod,
  useUpdatePosPaymentMethod, useDeletePosPaymentMethod,
  POS_METHOD_ACCOUNT_TYPES, type PosPaymentMethodConfig,
} from '@/features/accounting/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const KINDS = ['cash', 'mobile_money', 'card', 'bank'] as const;
type Kind = typeof KINDS[number];

const KIND_LABEL: Record<string, string> = {
  cash: 'Cash', mobile_money: 'Mobile Money', card: 'Card', bank: 'Bank', store_credit: 'Store Credit',
};
const KIND_ICON: Record<string, string> = {
  cash: '💵', mobile_money: '📱', card: '💳', bank: '🏦', store_credit: '🎁',
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const emptyForm = {
  code: '', label: '', kind: 'mobile_money' as Kind, provider: '', accountId: '',
  requiresReference: false, trackInShift: true, isActive: true, sortOrder: 0,
};

export function PosPaymentMethodsPanel() {
  const { data: methods = [], isLoading } = usePosPaymentMethodConfig();
  const { data: cashAccounts = [] } = useCashAccounts();
  const create = useCreatePosPaymentMethod();
  const update = useUpdatePosPaymentMethod();
  const remove = useDeletePosPaymentMethod();

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

  const retire = async (m: PosPaymentMethodConfig) => {
    try {
      await remove.mutateAsync(m.id);
      toast.success(`${m.label} removed from the terminal`);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? 'Could not remove the payment method');
    }
  };

  return (
    <details className="rounded border bg-white p-4" open={!isLoading && methods.length === 0}>
      <summary className="cursor-pointer font-semibold">POS payment methods</summary>
      <p className="my-3 text-sm text-slate-500">
        What the cashier sees in the Charge dialog, and where each mode's money is booked.
        The cashier never picks an account — these bindings decide it.
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-400">
                <th className="py-2 pr-3 font-bold">Mode</th>
                <th className="py-2 pr-3 font-bold">Kind</th>
                <th className="py-2 pr-3 font-bold">Provider</th>
                <th className="py-2 pr-3 font-bold">Receiving account</th>
                <th className="py-2 pr-3 font-bold">Reference</th>
                <th className="py-2 pr-3 font-bold">Shift count</th>
                <th className="py-2 pr-3 font-bold">Status</th>
                <th className="py-2 font-bold" />
              </tr>
            </thead>
            <tbody>
              {methods.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="py-2 pr-3 font-semibold text-slate-800">
                    <span className="mr-1.5">{KIND_ICON[m.kind] ?? '📄'}</span>{m.label}
                    <span className="block text-[10px] font-normal text-slate-400">{m.code}</span>
                  </td>
                  <td className="py-2 pr-3 text-slate-600">{KIND_LABEL[m.kind] ?? m.kind}</td>
                  <td className="py-2 pr-3 text-slate-600">{m.provider ?? '—'}</td>
                  <td className="py-2 pr-3 text-slate-600">
                    {m.kind === 'cash'
                      ? <span className="text-slate-400">Register drawer</span>
                      : m.accountName
                        ? <>{m.accountName} <span className="text-slate-400">· {m.accountCode}</span></>
                        : <span className="text-rose-600">Not set</span>}
                  </td>
                  <td className="py-2 pr-3">{m.requiresReference ? <Check className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-slate-300" />}</td>
                  <td className="py-2 pr-3">{m.trackInShift ? <Check className="h-4 w-4 text-emerald-600" /> : <X className="h-4 w-4 text-slate-300" />}</td>
                  <td className="py-2 pr-3">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${m.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      {m.isActive ? 'Active' : 'Hidden'}
                    </span>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${m.label}`} onClick={() => openEdit(m)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Remove ${m.label}`} onClick={() => retire(m)}>
                      <Trash2 className="h-4 w-4 text-rose-500" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!methods.length ? (
                <tr>
                  <td colSpan={8} className="py-4 text-sm text-slate-500">
                    Nothing configured yet — the terminal is falling back to whatever cash, wallet and
                    bank accounts exist. Add methods here to control the tiles the cashier sees.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}

      <Button onClick={openCreate} className="mt-3" variant="outline">
        <Plus className="mr-1 h-4 w-4" /> Add payment method
      </Button>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.label}` : 'Add payment method'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Kind</Label>
                <select
                  aria-label="Kind"
                  className="w-full rounded border p-2 text-sm"
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as Kind, accountId: '' })}
                >
                  {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
                <p className="mt-1 text-[11px] text-slate-500">
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
                <p className="mt-1 text-[11px] text-slate-500">
                  Shown as the second-step pill when a kind has several methods.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
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
              <p className="rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                Cash always books to the register's own drawer account, so there is nothing to bind here.
              </p>
            ) : (
              <div>
                <Label>Receiving account</Label>
                <select
                  aria-label="Receiving account"
                  className="w-full rounded border p-2 text-sm"
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
                    No {KIND_LABEL[form.kind].toLowerCase()} account exists yet. Create one above first.
                    {form.kind === 'card' ? ' A card method must use the account mapped as card_clearing.' : ''}
                  </p>
                ) : null}
              </div>
            )}

            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.requiresReference}
                  onChange={(e) => setForm({ ...form, requiresReference: e.target.checked })}
                />
                Require a transaction id (prompts only — never blocks a sale)
              </label>
              {form.kind !== 'cash' ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.trackInShift}
                    onChange={(e) => setForm({ ...form, trackInShift: e.target.checked })}
                  />
                  Count at shift open/close
                </label>
              ) : null}
              <label className="flex items-center gap-2">
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
    </details>
  );
}
