import { useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable, type Column } from '@/components/data-table';
import { useAccounts, type Account } from '@/features/accounting/api';
import { cn } from '@/lib/utils';

const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense', 'cost_of_goods_sold', 'bank', 'cash', 'receivable', 'payable', 'tax', 'contra_asset', 'contra_liability', 'mobile_money', 'petty_cash'] as const;

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue',
  expense: 'Expense', cost_of_goods_sold: 'COGS', bank: 'Bank', cash: 'Cash',
  receivable: 'Receivable', payable: 'Payable', tax: 'Tax',
  contra_asset: 'Contra Asset', contra_liability: 'Contra Liability',
  mobile_money: 'Mobile Money', petty_cash: 'Petty Cash',
};

export function ChartOfAccountsPage() {
  const { data, isLoading } = useAccounts();
  const allAccounts = (data?.data ?? []) as Account[];

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  const filtered = useMemo(() => {
    let list = allAccounts;
    if (typeFilter !== 'all') list = list.filter((a) => a.accountType === typeFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q)
      );
    }
    return list;
  }, [allAccounts, search, typeFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  const columns: Column<Account>[] = [
    { key: 'code', header: 'Code' },
    {
      key: 'name',
      header: 'Name',
      render: (a) => <span className={a.isGroup ? 'font-semibold' : ''}>{a.name}</span>,
    },
    {
      key: 'accountType',
      header: 'Type',
      render: (a) => <Badge variant="secondary">{ACCOUNT_TYPE_LABELS[a.accountType] ?? a.accountType.replace(/_/g, ' ')}</Badge>,
    },
    {
      key: 'isGroup',
      header: 'Postable',
      render: (a) => (a.isGroup ? <span className="text-muted-foreground">Group</span> : 'Yes'),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Chart of Accounts</h1>
          <p className="text-sm text-muted-foreground">The ledger accounts every module posts to.</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or code..."
            className="pl-9"
          />
        </div>
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="all">All Types</option>
          {ACCOUNT_TYPES.map(t => (
            <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>
          ))}
        </select>
      </div>

      <DataTable columns={columns} data={paged} loading={isLoading} getRowId={(a) => a.id}
        emptyMessage={search || typeFilter !== 'all' ? 'No accounts match your search.' : 'No accounts found.'}
      />

      {totalPages > 1 && (
        <div className="flex items-center justify-between bg-white rounded-lg border px-4 py-3">
          <span className="text-xs text-slate-500 font-medium">{filtered.length} account{filtered.length !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} className="h-8 w-8">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={cn(
                  'h-8 w-8 rounded-lg text-xs font-bold transition-colors',
                  p === page ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-50'
                )}
              >
                {p}
              </button>
            ))}
            <Button variant="ghost" size="icon" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))} className="h-8 w-8">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
