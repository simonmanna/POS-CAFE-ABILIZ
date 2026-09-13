import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Eye, Download, ChevronLeft, ChevronRight } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/data-table';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { money, date, useOrgCurrency } from '@/lib/format';
import { useReceipts } from '@/pages/pos/api';
import type { Receipt } from '@/pages/pos/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const settlementColor: Record<string, string> = {
  unsettled: 'bg-slate-100 text-slate-600',
  partially_settled: 'bg-amber-50 text-amber-700',
  settled: 'bg-emerald-50 text-emerald-700',
  written_off: 'bg-rose-50 text-rose-700',
};

const methodLabel: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  mobile_money: 'Mobile Money',
  mixed: 'Mixed',
  credit: 'Credit',
};

const settlementLabel: Record<string, string> = {
  unsettled: 'Unsettled',
  partially_settled: 'Partially Paid',
  settled: 'Settled',
  written_off: 'Written Off',
};

const selectClass = 'h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function ReceiptsPage() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [filterMethod, setFilterMethod] = useState('');
  const [filterSettlement, setFilterSettlement] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const hasActiveFilters = filterMethod || filterSettlement || dateFrom || dateTo;

  useEffect(() => setPage(1), [search, filterMethod, filterSettlement, dateFrom, dateTo]);

  const { data, isLoading } = useReceipts({ page, pageSize: 20, search: search || undefined });
  const currency = useOrgCurrency();

  const columns: Column<Receipt>[] = [
    {
      key: 'invoiceNumber',
      header: 'Receipt #',
      render: (r) => (
        <span className="font-medium text-primary">{r.documentNumber}</span>
      ),
    },
    { key: 'partner', header: 'Customer', render: (r) => r.partner?.name ?? '-' },
    { key: 'issueDate', header: 'Date', render: (r) => date(r.issueDate) },
    {
      key: 'paymentMode',
      header: 'Method',
      className: 'text-center',
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {r.paymentMode ? methodLabel[r.paymentMode] ?? r.paymentMode : '—'}
        </span>
      ),
    },
    { key: 'totalAmount', header: 'Total', className: 'text-right', render: (r) => money(r.totalAmount, currency) },
    {
      key: 'settlementStatus',
      header: 'Settlement',
      className: 'text-center',
      render: (r) => (
        <span
          className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
            settlementColor[r.settlementStatus] ?? ''
          }`}
        >
          {settlementLabel[r.settlementStatus] ?? r.settlementStatus}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-24 text-center',
      render: (r) => (
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(`/pos/receipts/${r.id}`)}>
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  const meta = data?.meta;

  const handleExport = () => {
    if (!data?.data?.length) return;
    const headers = ['Receipt #', 'Customer', 'Date', 'Method', 'Total', 'Settlement'];
    const rows = data.data.map((r) => [
      r.documentNumber,
      r.partner?.name ?? '',
      date(r.issueDate),
      r.paymentMode ? methodLabel[r.paymentMode] ?? r.paymentMode : '—',
      money(r.totalAmount, currency),
      settlementLabel[r.settlementStatus] ?? r.settlementStatus,
    ]);
    const csv = [headers, ...rows].map((row) => row.map((c) => `"${c}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `receipts-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Receipts</h1>
          <p className="text-sm text-muted-foreground">
            POS transaction receipts. Click the eye icon to view any receipt's full detail.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={!data?.data?.length}>
            <Download className="mr-1.5 h-4 w-4" /> Export CSV
          </Button>
        </div>
      </div>

      {/* Filter bar — enhanced with Select components */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search by receipt # or customer…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <Select value={filterMethod} onValueChange={setFilterMethod}>
          <SelectTrigger className={selectClass + ' w-[150px]'}><SelectValue placeholder="All methods" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All methods</SelectItem>
            <SelectItem value="cash">Cash</SelectItem>
            <SelectItem value="card">Card</SelectItem>
            <SelectItem value="mobile_money">Mobile Money</SelectItem>
            <SelectItem value="mixed">Mixed</SelectItem>
            <SelectItem value="credit">Credit</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filterSettlement} onValueChange={setFilterSettlement}>
          <SelectTrigger className={selectClass + ' w-[160px]'}><SelectValue placeholder="All settlements" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">All settlements</SelectItem>
            <SelectItem value="unsettled">Unsettled</SelectItem>
            <SelectItem value="partially_settled">Partially Paid</SelectItem>
            <SelectItem value="settled">Settled</SelectItem>
            <SelectItem value="written_off">Written Off</SelectItem>
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          className="h-9 w-40"
          title="From date"
        />
        <span className="text-xs text-muted-foreground">—</span>
        <Input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          className="h-9 w-40"
          title="To date"
        />
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={() => {
            setFilterMethod('');
            setFilterSettlement('');
            setDateFrom('');
            setDateTo('');
          }}>
            Clear
          </Button>
        )}
      </div>

      <div className="rounded-md border">
        <DataTable columns={columns} data={data?.data ?? []} loading={isLoading} getRowId={(r) => r.id} compact />
      </div>

      {meta && (
        <div className="flex flex-wrap items-center justify-between gap-4 text-sm text-muted-foreground">
          <span>{meta.total} receipt(s)</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
            </Button>
            <span className="px-2">Page {meta.page} of {meta.totalPages}</span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
