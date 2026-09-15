import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Download,
  FileText,
  Loader2,
  Scale,
  Search,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { date as fmtDate, money, useOrgCurrency } from '@/lib/format';
import { exportCSV } from '@/lib/export-csv';
import { exportPDF } from '@/lib/export-pdf';
import {
  useCashFlowReport,
  type CashFlowReportFilters,
  type CashMovementGrouping,
  type CashMovementRow,
} from '@/features/accounting/api';

const PAGE_SIZE = 50;

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank',
  mobile_money: 'Mobile Money',
  petty_cash: 'Petty Cash',
};

/** Named ranges — the ones a café manager actually asks for. */
function presetRange(key: string): { from: string; to: string } {
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (key) {
    case 'today':
      return { from: iso(now), to: iso(now) };
    case 'yesterday': {
      const d = new Date(y, m, now.getDate() - 1);
      return { from: iso(d), to: iso(d) };
    }
    case 'last7':
      return { from: iso(new Date(y, m, now.getDate() - 6)), to: iso(now) };
    case 'last30':
      return { from: iso(new Date(y, m, now.getDate() - 29)), to: iso(now) };
    case 'this_month':
      return { from: iso(new Date(y, m, 1)), to: iso(now) };
    case 'last_month':
      return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    case 'this_quarter':
      return { from: iso(new Date(y, Math.floor(m / 3) * 3, 1)), to: iso(now) };
    case 'this_year':
      return { from: iso(new Date(y, 0, 1)), to: iso(now) };
    default:
      return { from: iso(new Date(y, m, 1)), to: iso(now) };
  }
}

const PRESETS: { key: string; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_quarter', label: 'This quarter' },
  { key: 'this_year', label: 'This year' },
];

/** One column definition drives the screen table, the CSV and the PDF. */
const COLUMNS: { header: string; cell: (r: CashMovementRow) => string }[] = [
  { header: 'Date', cell: (r) => fmtDate(r.date) },
  { header: 'Entry #', cell: (r) => r.entryNumber },
  { header: 'Account', cell: (r) => `${r.accountCode} — ${r.accountName}` },
  { header: 'Type', cell: (r) => ACCOUNT_TYPE_LABELS[r.accountType ?? ''] ?? r.accountType ?? '' },
  { header: 'Category', cell: (r) => r.categoryLabel },
  { header: 'Description', cell: (r) => r.description ?? '' },
  { header: 'Counterparty', cell: (r) => r.counterparties.map((c) => c.name).join('; ') },
  { header: 'Cash In', cell: (r) => (Number(r.inflow) ? Number(r.inflow).toFixed(2) : '') },
  { header: 'Cash Out', cell: (r) => (Number(r.outflow) ? Number(r.outflow).toFixed(2) : '') },
];

export function CashFlowReportPage() {
  const navigate = useNavigate();
  const currency = useOrgCurrency();
  const defaults = useMemo(() => presetRange('this_month'), []);

  const [preset, setPreset] = useState('this_month');
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [accountTypes, setAccountTypes] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [direction, setDirection] = useState<'all' | 'in' | 'out'>('all');
  const [search, setSearch] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [groupBy, setGroupBy] = useState<CashMovementGrouping>('day');
  const [page, setPage] = useState(1);

  const filters: CashFlowReportFilters = {
    from,
    to,
    accountIds,
    accountTypes,
    categories,
    direction,
    search,
    minAmount: minAmount ? Number(minAmount) : undefined,
    groupBy,
    page,
    pageSize: PAGE_SIZE,
  };

  const { data, isLoading, isFetching } = useCashFlowReport(filters);

  const rows = data?.data ?? [];
  const summary = data?.summary;
  const accountOptions = data?.accountOptions ?? [];
  const categoryOptions = data?.categoryOptions ?? [];

  const filtersDirty =
    from !== defaults.from ||
    to !== defaults.to ||
    accountIds.length > 0 ||
    accountTypes.length > 0 ||
    categories.length > 0 ||
    direction !== 'all' ||
    !!search ||
    !!minAmount;

  const reset = () => {
    setPreset('this_month');
    setFrom(defaults.from);
    setTo(defaults.to);
    setAccountIds([]);
    setAccountTypes([]);
    setCategories([]);
    setDirection('all');
    setSearch('');
    setMinAmount('');
    setPage(1);
  };

  const applyPreset = (key: string) => {
    const r = presetRange(key);
    setPreset(key);
    setFrom(r.from);
    setTo(r.to);
    setPage(1);
  };

  const toggle = (list: string[], setList: (v: string[]) => void, value: string) => {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
    setPage(1);
  };

  const exportRows = () => rows.map((r) => COLUMNS.map((c) => c.cell(r)));
  const stamp = `${from}_${to}`;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="border-l-4 border-[#3b82f6] pl-4 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Money Reports</h1>
          <p className="text-sm text-gray-500">
            Every cash movement in and out of your payment accounts — receipts, payments, transfers
            and drawer operations, with the ledger entry behind each one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs gap-1"
            disabled={rows.length === 0}
            onClick={() =>
              exportCSV(
                `cash-flow-report_${stamp}.csv`,
                COLUMNS.map((c) => c.header),
                exportRows(),
              )
            }
          >
            <Download className="h-3.5 w-3.5" /> CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs gap-1"
            disabled={rows.length === 0}
            onClick={() =>
              exportPDF(
                `cash-flow-report_${stamp}.pdf`,
                `Money Report — ${from} to ${to}`,
                COLUMNS.map((c) => c.header),
                exportRows(),
              )
            }
          >
            <FileText className="h-3.5 w-3.5" /> PDF
          </Button>
        </div>
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => applyPreset(p.key)}
            className={cn(
              'px-3 py-1.5 text-[11px] font-bold rounded-lg uppercase tracking-wider transition-colors',
              preset === p.key
                ? 'bg-slate-800 text-white'
                : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 p-3 bg-white border rounded-lg shadow-sm">
        <div className="space-y-1 min-w-[140px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">From</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPreset('custom'); setPage(1); }}
            className="h-9 text-xs"
          />
        </div>
        <div className="space-y-1 min-w-[140px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">To</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPreset('custom'); setPage(1); }}
            className="h-9 text-xs"
          />
        </div>

        {/* Accounts (multi) */}
        <div className="space-y-1 min-w-[190px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Accounts</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 w-full justify-between text-xs font-normal">
                <span className="truncate">
                  {accountIds.length === 0
                    ? 'All accounts'
                    : accountIds.length === 1
                      ? accountOptions.find((a) => a.id === accountIds[0])?.name ?? '1 selected'
                      : `${accountIds.length} accounts`}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-64">
              <DropdownMenuLabel className="text-[10px] uppercase">Payment accounts</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {accountOptions.map((a) => (
                <DropdownMenuCheckboxItem
                  key={a.id}
                  checked={accountIds.includes(a.id)}
                  onCheckedChange={() => toggle(accountIds, setAccountIds, a.id)}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {a.code} — {a.name}
                </DropdownMenuCheckboxItem>
              ))}
              {accountOptions.length === 0 && (
                <div className="px-2 py-3 text-xs text-muted-foreground">No payment accounts</div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Account type (multi) */}
        <div className="space-y-1 min-w-[160px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Account Type</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 w-full justify-between text-xs font-normal">
                <span className="truncate">
                  {accountTypes.length === 0 ? 'All types' : `${accountTypes.length} selected`}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {Object.entries(ACCOUNT_TYPE_LABELS).map(([key, label]) => (
                <DropdownMenuCheckboxItem
                  key={key}
                  checked={accountTypes.includes(key)}
                  onCheckedChange={() => toggle(accountTypes, setAccountTypes, key)}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Movement category (multi) */}
        <div className="space-y-1 min-w-[190px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Movement Type</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="h-9 w-full justify-between text-xs font-normal">
                <span className="truncate">
                  {categories.length === 0
                    ? 'All movements'
                    : categories.length === 1
                      ? categoryOptions.find((c) => c.key === categories[0])?.label ?? '1 selected'
                      : `${categories.length} selected`}
                </span>
                <ChevronDown className="h-3.5 w-3.5 opacity-50 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-60">
              <DropdownMenuLabel className="text-[10px] uppercase">What moved the cash</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {categoryOptions.map((c) => (
                <DropdownMenuCheckboxItem
                  key={c.key}
                  checked={categories.includes(c.key)}
                  onCheckedChange={() => toggle(categories, setCategories, c.key)}
                  onSelect={(e) => e.preventDefault()}
                  className="text-xs"
                >
                  {c.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Direction */}
        <div className="space-y-1 min-w-[130px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Direction</Label>
          <Select value={direction} onValueChange={(v) => { setDirection(v as typeof direction); setPage(1); }}>
            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">In &amp; Out</SelectItem>
              <SelectItem value="in">Cash In only</SelectItem>
              <SelectItem value="out">Cash Out only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Min amount */}
        <div className="space-y-1 min-w-[120px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Min Amount</Label>
          <Input
            type="number"
            min={0}
            value={minAmount}
            onChange={(e) => { setMinAmount(e.target.value); setPage(1); }}
            placeholder="0"
            className="h-9 text-xs"
          />
        </div>

        {/* Search */}
        <div className="space-y-1 flex-1 min-w-[200px]">
          <Label className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Search</Label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Entry #, description, account…"
              className="h-9 text-xs pl-9"
            />
          </div>
        </div>

        {filtersDirty && (
          <Button variant="ghost" size="sm" onClick={reset} className="h-9 text-xs gap-1">
            <X className="h-3 w-3" /> Clear
          </Button>
        )}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard
          label="Opening Balance"
          value={summary?.openingBalance}
          currency={currency}
          icon={Wallet}
          loading={isLoading}
        />
        <SummaryCard
          label="Money In"
          value={summary?.externalIn ?? summary?.cashIn}
          currency={currency}
          icon={TrendingUp}
          tone="in"
          sub={summary ? (Number(summary.internalMoved ?? 0) > 0
            ? `Excludes ${money(summary.internalMoved, currency)} moved between your accounts`
            : `${summary.inflowCount} movement${summary.inflowCount !== 1 ? 's' : ''}`) : undefined}
          loading={isLoading}
        />
        <SummaryCard
          label="Money Out"
          value={summary?.externalOut ?? summary?.cashOut}
          currency={currency}
          icon={TrendingDown}
          tone="out"
          sub={summary ? `${summary.outflowCount} movement${summary.outflowCount !== 1 ? 's' : ''}` : undefined}
          loading={isLoading}
        />
        <SummaryCard
          label="Net Change"
          value={summary?.netChange}
          currency={currency}
          icon={Scale}
          tone={summary && Number(summary.netChange) < 0 ? 'out' : 'in'}
          loading={isLoading}
        />
        <SummaryCard
          label="Closing Balance"
          value={summary?.closingBalance}
          currency={currency}
          icon={Wallet}
          emphasis
          loading={isLoading}
        />
      </div>

      <Tabs defaultValue="movements" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="movements" className="text-xs">Movements</TabsTrigger>
            <TabsTrigger value="accounts" className="text-xs">By Account</TabsTrigger>
            <TabsTrigger value="categories" className="text-xs">By Movement Type</TabsTrigger>
            <TabsTrigger value="trend" className="text-xs">Trend</TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-2">
            {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <span className="text-xs text-muted-foreground">
              {data?.total ?? 0} movement{(data?.total ?? 0) !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {/* ── Movements ─────────────────────────────────────────────────────── */}
        <TabsContent value="movements">
          <Card>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="flex items-center justify-center h-56">
                  <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/30">
                        <TableHead className="text-[10px] font-bold uppercase">Date</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Account</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Movement</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Details</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase">Entry #</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase text-right">Cash In</TableHead>
                        <TableHead className="text-[10px] font-bold uppercase text-right">Cash Out</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-12">
                            No cash movements match these filters
                          </TableCell>
                        </TableRow>
                      ) : (
                        rows.map((r) => (
                          <TableRow
                            key={r.id}
                            className="cursor-pointer"
                            onClick={() => navigate(`/journal-entries/${r.journalEntryId}`)}
                          >
                            <TableCell className="whitespace-nowrap text-xs">{fmtDate(r.date)}</TableCell>
                            <TableCell className="text-xs">
                              <div className="font-medium">{r.accountName}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {r.accountCode}
                                {r.accountType ? ` · ${ACCOUNT_TYPE_LABELS[r.accountType] ?? r.accountType}` : ''}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className={cn(
                                  'border-none text-[10px] font-bold uppercase tracking-wide',
                                  r.category === 'transfers'
                                    ? 'bg-indigo-100 text-indigo-800'
                                    : r.direction === 'in'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-amber-100 text-amber-800',
                                )}
                              >
                                {r.category === 'transfers' ? (
                                  <ArrowRightLeft className="h-3 w-3 mr-1" />
                                ) : r.direction === 'in' ? (
                                  <ArrowDownToLine className="h-3 w-3 mr-1" />
                                ) : (
                                  <ArrowUpFromLine className="h-3 w-3 mr-1" />
                                )}
                                {r.categoryLabel}
                              </Badge>
                            </TableCell>
                            <TableCell className="max-w-[340px]">
                              <div className="truncate text-xs">{r.description || '—'}</div>
                              {r.counterparties.length > 0 && (
                                <div className="text-[10px] text-muted-foreground truncate">
                                  {r.direction === 'in' ? 'from ' : 'to '}
                                  {r.counterparties.map((c) => c.name).join(', ')}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="font-mono text-[10px] text-muted-foreground whitespace-nowrap">
                              {r.entryNumber}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-emerald-600 font-semibold">
                              {Number(r.inflow) ? money(r.inflow) : ''}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-rose-600 font-semibold">
                              {Number(r.outflow) ? money(r.outflow) : ''}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center justify-between pt-3">
            <p className="text-xs text-muted-foreground">
              Page {data?.page ?? 1} of {data?.totalPages ?? 1} · showing {rows.length} of {data?.total ?? 0}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={page >= (data?.totalPages ?? 1)}
                onClick={() => setPage((p) => p + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </TabsContent>

        {/* ── By account ────────────────────────────────────────────────────── */}
        <TabsContent value="accounts">
          <RollupCard
            title="Cash movement per payment account"
            firstHeader="Account"
            rows={(data?.byAccount ?? []).map((a) => ({
              key: a.accountId,
              primary: a.name,
              secondary: `${a.code}${a.accountType ? ` · ${ACCOUNT_TYPE_LABELS[a.accountType] ?? a.accountType}` : ''}`,
              cashIn: a.cashIn,
              cashOut: a.cashOut,
              net: a.net,
              count: a.movementCount,
              onClick: () => { setAccountIds([a.accountId]); setPage(1); },
            }))}
            loading={isLoading}
          />
        </TabsContent>

        {/* ── By category ───────────────────────────────────────────────────── */}
        <TabsContent value="categories">
          <RollupCard
            title="Cash movement by what drove it"
            firstHeader="Movement Type"
            rows={(data?.byCategory ?? []).map((c) => ({
              key: c.category,
              primary: c.label,
              secondary: null,
              cashIn: c.cashIn,
              cashOut: c.cashOut,
              net: c.net,
              count: c.movementCount,
              onClick: () => { setCategories([c.category]); setPage(1); },
            }))}
            loading={isLoading}
          />
        </TabsContent>

        {/* ── Trend ─────────────────────────────────────────────────────────── */}
        <TabsContent value="trend">
          <Card>
            <CardHeader className="pb-2 pt-4 px-5 bg-muted/30 border-b rounded-t-lg flex-row items-center justify-between">
              <CardTitle className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                Cash in / out over time
              </CardTitle>
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as CashMovementGrouping)}>
                <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Daily</SelectItem>
                  <SelectItem value="week">Weekly</SelectItem>
                  <SelectItem value="month">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-5 space-y-2">
                  {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
                </div>
              ) : (
                <TrendTable series={data?.series ?? []} />
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ─────────────────────────────── pieces ─────────────────────────────────── */

function SummaryCard({
  label,
  value,
  currency,
  icon: Icon,
  tone,
  sub,
  emphasis,
  loading,
}: {
  label: string;
  value?: string;
  currency: string;
  icon: typeof Wallet;
  tone?: 'in' | 'out';
  sub?: string;
  emphasis?: boolean;
  loading?: boolean;
}) {
  return (
    <Card className={cn(emphasis && 'border-slate-800')}>
      <CardHeader className="p-3 pb-1">
        <div className="flex items-center gap-1.5">
          <Icon
            className={cn(
              'h-3.5 w-3.5',
              tone === 'in' ? 'text-emerald-600' : tone === 'out' ? 'text-rose-600' : 'text-slate-400',
            )}
          />
          <CardTitle className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
            {label}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="p-3 pt-0">
        {loading ? (
          <Skeleton className="h-7 w-28" />
        ) : (
          <span
            className={cn(
              'text-xl font-bold tabular-nums',
              tone === 'in' ? 'text-emerald-700' : tone === 'out' ? 'text-rose-700' : 'text-slate-900',
            )}
          >
            {value !== undefined ? money(value, currency) : '—'}
          </span>
        )}
        {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

interface RollupRow {
  key: string;
  primary: string;
  secondary: string | null;
  cashIn: string;
  cashOut: string;
  net: string;
  count: number;
  onClick: () => void;
}

function RollupCard({
  title,
  firstHeader,
  rows,
  loading,
}: {
  title: string;
  firstHeader: string;
  rows: RollupRow[];
  loading?: boolean;
}) {
  const totals = rows.reduce(
    (acc, r) => ({
      cashIn: acc.cashIn + Number(r.cashIn),
      cashOut: acc.cashOut + Number(r.cashOut),
      count: acc.count + r.count,
    }),
    { cashIn: 0, cashOut: 0, count: 0 },
  );

  return (
    <Card>
      <CardHeader className="pb-2 pt-4 px-5 bg-muted/30 border-b rounded-t-lg">
        <CardTitle className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-5 space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30">
                <TableHead className="text-[10px] font-bold uppercase">{firstHeader}</TableHead>
                <TableHead className="text-[10px] font-bold uppercase text-right">Movements</TableHead>
                <TableHead className="text-[10px] font-bold uppercase text-right">Cash In</TableHead>
                <TableHead className="text-[10px] font-bold uppercase text-right">Cash Out</TableHead>
                <TableHead className="text-[10px] font-bold uppercase text-right">Net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-10">
                    Nothing in this period
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.key} className="cursor-pointer" onClick={r.onClick}>
                    <TableCell className="text-xs">
                      <div className="font-medium">{r.primary}</div>
                      {r.secondary && (
                        <div className="text-[10px] text-muted-foreground">{r.secondary}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {r.count}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-emerald-600">
                      {Number(r.cashIn) ? money(r.cashIn) : '—'}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-rose-600">
                      {Number(r.cashOut) ? money(r.cashOut) : '—'}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-right font-mono text-xs font-semibold',
                        Number(r.net) < 0 ? 'text-rose-700' : 'text-emerald-700',
                      )}
                    >
                      {money(r.net)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
            {rows.length > 0 && (
              <TableBody>
                <TableRow className="bg-muted/40 font-semibold">
                  <TableCell className="text-xs">Total</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{totals.count}</TableCell>
                  <TableCell className="text-right font-mono text-xs text-emerald-700">
                    {money(totals.cashIn.toFixed(2))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-rose-700">
                    {money(totals.cashOut.toFixed(2))}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {money((totals.cashIn - totals.cashOut).toFixed(2))}
                  </TableCell>
                </TableRow>
              </TableBody>
            )}
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TrendTable({
  series,
}: {
  series: {
    period: string;
    cashIn: string;
    cashOut: string;
    net: string;
    runningBalance: string;
    movementCount: number;
  }[];
}) {
  // Bars are scaled against the biggest single-period gross so the shape of the
  // period is readable without pulling in a chart library.
  const peak = Math.max(1, ...series.map((s) => Math.max(Number(s.cashIn), Number(s.cashOut))));

  if (series.length === 0) {
    return <div className="text-center text-muted-foreground py-12 text-sm">Nothing in this period</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="bg-muted/30">
          <TableHead className="text-[10px] font-bold uppercase">Period</TableHead>
          <TableHead className="text-[10px] font-bold uppercase w-[38%]">In / Out</TableHead>
          <TableHead className="text-[10px] font-bold uppercase text-right">Cash In</TableHead>
          <TableHead className="text-[10px] font-bold uppercase text-right">Cash Out</TableHead>
          <TableHead className="text-[10px] font-bold uppercase text-right">Net</TableHead>
          <TableHead className="text-[10px] font-bold uppercase text-right">Running Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {series.map((s) => (
          <TableRow key={s.period}>
            <TableCell className="text-xs whitespace-nowrap">{fmtDate(s.period)}</TableCell>
            <TableCell>
              <div className="space-y-1">
                <div className="h-1.5 rounded bg-emerald-500" style={{ width: `${(Number(s.cashIn) / peak) * 100}%` }} />
                <div className="h-1.5 rounded bg-rose-500" style={{ width: `${(Number(s.cashOut) / peak) * 100}%` }} />
              </div>
            </TableCell>
            <TableCell className="text-right font-mono text-xs text-emerald-600">
              {Number(s.cashIn) ? money(s.cashIn) : '—'}
            </TableCell>
            <TableCell className="text-right font-mono text-xs text-rose-600">
              {Number(s.cashOut) ? money(s.cashOut) : '—'}
            </TableCell>
            <TableCell
              className={cn(
                'text-right font-mono text-xs font-semibold',
                Number(s.net) < 0 ? 'text-rose-700' : 'text-emerald-700',
              )}
            >
              {money(s.net)}
            </TableCell>
            <TableCell className="text-right font-mono text-xs">{money(s.runningBalance)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
