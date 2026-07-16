import { useMemo, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DataTable, type Column } from '@/components/data-table';
import {
  useAccountMappings,
  useAccounts,
  useUpdateAccountMapping,
  type AccountMappingRow,
  type Account,
} from '@/features/accounting/api';
import { ACCOUNT_MAPPING_LABELS, PERMISSIONS } from '@erp/shared';
import { useAuthStore } from '@/stores/auth.store';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue',
  expense: 'Expense', cost_of_goods_sold: 'COGS', bank: 'Bank', cash: 'Cash',
  receivable: 'Receivable', payable: 'Payable', tax: 'Tax',
  contra_asset: 'Contra Asset', contra_liability: 'Contra Liability',
  mobile_money: 'Mobile Money', petty_cash: 'Petty Cash',
};

function AccountMappingsPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canRead = hasPermission(PERMISSIONS.accountMapping.read);
  const canUpdate = hasPermission(PERMISSIONS.accountMapping.update);

  if (!canRead) {
    return null;
  }
  const { data: mappings, isLoading: mappingsLoading } = useAccountMappings();
  const { data: accountsData, isLoading: accountsLoading } = useAccounts();
  const updateMutation = useUpdateAccountMapping();

  const allAccounts = (accountsData?.data ?? []) as Account[];
  const accountMap = useMemo(() => new Map(allAccounts.map(a => [a.id, a])), [allAccounts]);
  const postableAccounts = useMemo(
    () => allAccounts.filter(a => !a.isGroup && a.isActive),
    [allAccounts],
  );

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  const isLoading = mappingsLoading || accountsLoading;

  function handleOpenEdit(mapping: AccountMappingRow) {
    setEditingKey(mapping.key);
    setSelectedAccountId(mapping.accountId);
  }

  async function handleSave() {
    if (!editingKey || !selectedAccountId) return;
    await updateMutation.mutateAsync({ key: editingKey, accountId: selectedAccountId });
    const linked = accountMap.get(selectedAccountId);
    const label = ACCOUNT_MAPPING_LABELS[editingKey as keyof typeof ACCOUNT_MAPPING_LABELS] ?? editingKey;
    toast.success(`Mapped "${label}" \u2192 ${linked?.code} ${linked?.name}`);
    setEditingKey(null);
  }

  const columns: Column<AccountMappingRow>[] = [
    {
      key: 'key',
      header: 'Key',
      render: (m) => (
        <code className="text-xs bg-slate-100 px-2 py-0.5 rounded">{m.key}</code>
      ),
    },
    {
      key: 'label',
      header: 'Label',
      render: (m) => ACCOUNT_MAPPING_LABELS[m.key as keyof typeof ACCOUNT_MAPPING_LABELS] ?? m.key,
    },
    {
      key: 'account',
      header: 'Linked Account',
      render: (m) => {
        const acc = accountMap.get(m.accountId);
        if (!acc) return <span className="text-slate-400">—</span>;
        return (
          <span>
            <span className="font-mono text-sm">{acc.code}</span>
            {' — '}
            <span className={cn(acc.isActive ? '' : 'text-slate-400 line-through')}>{acc.name}</span>
          </span>
        );
      },
    },
    {
      key: 'accountType',
      header: 'Account Type',
      render: (m) => {
        const acc = accountMap.get(m.accountId);
        if (!acc) return <span className="text-slate-400">—</span>;
        return <Badge variant="secondary">{ACCOUNT_TYPE_LABELS[acc.accountType] ?? acc.accountType}</Badge>;
      },
    },
    {
      key: 'action',
      header: '',
      className: 'text-right',
      render: (m) => (
        <div className="flex justify-end">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => handleOpenEdit(m)}
              disabled={!canUpdate}
            >
              <Pencil className="h-4 w-4" />
            </Button>
        </div>
      ),
    },
  ];

  const editLabel = editingKey
    ? ACCOUNT_MAPPING_LABELS[editingKey as keyof typeof ACCOUNT_MAPPING_LABELS] ?? editingKey
    : '';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Account Mappings</h1>
        <p className="text-sm text-muted-foreground">
          Link posting keys to accounts in your chart of accounts.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={mappings ?? []}
        loading={isLoading}
        getRowId={(m) => m.key}
        emptyMessage="No account mappings found."
      />

      <Dialog open={!!editingKey} onOpenChange={(open) => !open && setEditingKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Linked Account</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Mapping</Label>
              <div className="text-sm font-medium">{editLabel}</div>
              <code className="text-xs text-slate-500">{editingKey}</code>
            </div>
            <div className="space-y-2">
              <Label>Linked Account</Label>
              <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select an account…" />
                </SelectTrigger>
                <SelectContent>
                  {postableAccounts.map((acc) => (
                    <SelectItem key={acc.id} value={acc.id}>
                      <span className="font-mono">{acc.code}</span>
                      {' — '}
                      <span>{acc.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-slate-400">
                Only postable (non-group, active) accounts are shown.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={!selectedAccountId || updateMutation.isPending}
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export { AccountMappingsPage };
