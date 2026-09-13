import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ArrowRightLeft, Loader2, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCashFlowTransactions, type CashFlowTransaction } from '@/features/accounting/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

type TxType = 'all' | 'deposit' | 'withdrawal' | 'transfer';

const TYPE_META: Record<
  CashFlowTransaction['type'],
  { label: string; icon: typeof ArrowDownToLine; cls: string }
> = {
  deposit: { label: 'Deposit', icon: ArrowDownToLine, cls: 'bg-emerald-100 text-emerald-800 border-none' },
  withdrawal: { label: 'Withdrawal', icon: ArrowUpFromLine, cls: 'bg-amber-100 text-amber-800 border-none' },
  transfer: { label: 'Transfer', icon: ArrowRightLeft, cls: 'bg-indigo-100 text-indigo-800 border-none' },
};

export function CashFlowTransactionsPage() {
  const [page, setPage] = useState(1);
  const pageSize = 20;
  const [typeFilter, setTypeFilter] = useState<TxType>('all');
  const [search, setSearch] = useState('');

  const { data, isLoading } = useCashFlowTransactions({
    page,
    pageSize,
    type: typeFilter === 'all' ? undefined : typeFilter,
    search: search.trim() || undefined,
  });

  const filtered = data?.data ?? [];

  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Treasury Movements</h1>
          <p className="text-sm text-muted-foreground">All deposits, withdrawals, and transfers across your accounts</p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by description, account, or entry #..."
            className="pl-9"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'deposit', 'withdrawal', 'transfer'] as const).map((t) => (
            <button
              key={t}
              onClick={() => { setTypeFilter(t); setPage(1); }}
              className={cn(
                'px-3 py-1.5 text-xs font-bold rounded-lg uppercase tracking-wider transition-colors',
                typeFilter === t
                  ? 'bg-slate-800 text-white'
                  : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50',
              )}
            >
              {t === 'all' ? 'All' : TYPE_META[t].label}
            </button>
          ))}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                      No treasury movements found
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((t) => {
                    const meta = TYPE_META[t.type];
                    const Icon = meta.icon;
                    return (
                      <TableRow key={t.id}>
                        <TableCell className="whitespace-nowrap text-sm">
                          {new Date(t.date).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary" className={meta.cls}>
                            <Icon className="h-3.5 w-3.5 mr-1" />
                            {meta.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[360px]">
                          <div className="truncate text-sm">{t.description || '—'}</div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {t.type === 'transfer' ? (
                              <span>
                                {t.fromName ?? '—'} <span className="mx-1">→</span> {t.toName ?? '—'}
                              </span>
                            ) : (
                              <span>{t.accountName}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{t.entryNumber}</TableCell>
                        <TableCell className="text-right">
                          <span className={cn('font-mono font-semibold', t.direction === 'in' ? 'text-emerald-600' : 'text-slate-800')}>
                            {t.direction === 'in' ? '+' : '−'}
                            {Number(t.amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}
                          </span>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {total} movement{total !== 1 ? 's' : ''}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button variant="ghost" size="icon" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
