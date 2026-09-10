import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACCOUNT_CLASSIFICATIONS } from '@erp/shared';
import { ChevronDown, ChevronRight, Download, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { money, useOrgCurrency } from '@/lib/format';
import { exportCSV } from '@/lib/export-csv';
import {
  useDetailedAccountingReport,
  useCostCenters,
  useJournals,
  type DetailedReportAccount,
} from '@/features/accounting/api';

const ANY = '__any__';

/** Keys come straight from `ACCOUNT_CLASSIFICATIONS` in @erp/shared. */
const CLASSIFICATION_LABEL: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expenses',
  off_balance: 'Off Balance Sheet',
  unclassified: 'Unclassified',
};

const CLASSIFICATIONS = ACCOUNT_CLASSIFICATIONS.map((value) => ({
  value,
  label: CLASSIFICATION_LABEL[value] ?? value,
}));

/** First and last day of the current month, as yyyy-mm-dd. */
function defaultRange() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: iso(first), to: iso(last) };
}

/**
 * The API reports every balance debit-positive. Presenting a credit-normal
 * account that way shows revenue as a negative number, so flip the sign for
 * display — the underlying value is never mutated.
 */
function signed(value: string, normalBalance: string): number {
  const n = Number(value);
  const flipped = normalBalance === 'credit' ? -n : n;
  // Avoid rendering "-0.00" for a credit-normal account that nets to nothing.
  return flipped === 0 ? 0 : flipped;
}

export function DetailedAccountingReportPage() {
  const initial = useMemo(defaultRange, []);
  const currency = useOrgCurrency();

  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [classification, setClassification] = useState(ANY);
  const [branchId, setBranchId] = useState(ANY);
  const [costCenterId, setCostCenterId] = useState(ANY);
  const [journalId, setJournalId] = useState(ANY);
  const [includeZero, setIncludeZero] = useState(false);
  const [summaryOnly, setSummaryOnly] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const branches = useQuery({
    queryKey: ['branches', 'detailed-report'],
    queryFn: async () => (await api.get('/branches', { params: { pageSize: 200 } })).data,
  });
  const costCenters = useCostCenters();
  const journals = useJournals();

  const params = {
    from,
    to,
    classification: classification === ANY ? undefined : classification,
    branchId: branchId === ANY ? undefined : branchId,
    costCenterId: costCenterId === ANY ? undefined : costCenterId,
    journalId: journalId === ANY ? undefined : journalId,
    includeZero,
    summaryOnly,
  };
  const { data, isLoading, isFetching } = useDetailedAccountingReport(params);

  const toggle = (accountId: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });

  const expandAll = () =>
    setExpanded(new Set((data?.accounts ?? []).filter((a) => a.lines.length > 0).map((a) => a.accountId)));
  const collapseAll = () => setExpanded(new Set());

  /** Group accounts by classification so the report reads as a statement. */
  const groups = useMemo(() => {
    const out = new Map<string, DetailedReportAccount[]>();
    for (const account of data?.accounts ?? []) {
      const key = account.classification ?? 'unclassified';
      const bucket = out.get(key);
      if (bucket) bucket.push(account);
      else out.set(key, [account]);
    }
    return [...out.entries()];
  }, [data]);

  /** CSV mirrors what is on screen: an account row, then its lines. */
  const downloadCSV = () => {
    if (!data) return;
    const rows: string[][] = [];
    for (const account of data.accounts) {
      rows.push([
        'ACCOUNT',
        account.code,
        account.name,
        CLASSIFICATION_LABEL[account.classification ?? 'unclassified'] ?? '',
        '',
        '',
        '',
        account.opening,
        account.debit,
        account.credit,
        account.closing,
      ]);
      for (const line of account.lines) {
        rows.push([
          'LINE',
          account.code,
          new Date(line.date).toISOString().slice(0, 10),
          line.entryNumber,
          line.journalCode ?? '',
          line.partnerName ?? '',
          line.description ?? '',
          '',
          line.debit,
          line.credit,
          line.balance,
        ]);
      }
    }
    exportCSV(
      `detailed-accounting-report_${from}_${to}.csv`,
      ['Row', 'Account', 'Date / Name', 'Entry', 'Journal', 'Partner', 'Description', 'Opening', 'Debit', 'Credit', 'Balance'],
      rows,
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="border-l-4 border-[#3b82f6] pl-4 space-y-1">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">Detailed Accounting Report</h1>
          <p className="text-sm text-gray-500">
            Opening balance, every posted transaction and the closing balance, per account.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <Badge variant={data.balanced ? 'default' : data.filtered ? 'secondary' : 'destructive'}>
              {data.balanced ? 'Balanced' : data.filtered ? 'Filtered subset' : 'Out of balance'}
            </Badge>
          )}
          <Button variant="outline" onClick={downloadCSV} disabled={!data}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
        <div className="space-y-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-[150px]" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Classification</Label>
          <Select value={classification} onValueChange={setClassification}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All</SelectItem>
              {CLASSIFICATIONS.map((c) => (
                <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Branch</Label>
          <Select value={branchId} onValueChange={setBranchId}>
            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All branches</SelectItem>
              {(branches.data?.data ?? []).map((b: any) => (
                <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Cost Center</Label>
          <Select value={costCenterId} onValueChange={setCostCenterId}>
            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All cost centers</SelectItem>
              {(costCenters.data?.data ?? []).map((c: any) => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Journal</Label>
          <Select value={journalId} onValueChange={setJournalId}>
            <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All journals</SelectItem>
              {(journals.data?.data ?? []).map((j: any) => (
                <SelectItem key={j.id} value={j.id}>{j.code} — {j.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
          Include zero-activity accounts
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={summaryOnly} onChange={(e) => setSummaryOnly(e.target.checked)} />
          Summary only
        </label>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={expandAll} disabled={summaryOnly || !data}>Expand all</Button>
          <Button size="sm" variant="ghost" onClick={collapseAll} disabled={!data}>Collapse all</Button>
        </div>
      </div>

      {data?.truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            {data.totals.lineCount.toLocaleString()} lines match this period but only the first{' '}
            {data.maxLines.toLocaleString()} are shown. Account totals below remain complete — narrow
            the date range or filter by account to see every line.
          </span>
        </div>
      )}

      {data && (
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: 'Opening', value: data.totals.opening },
            { label: 'Period Debit', value: data.totals.debit },
            { label: 'Period Credit', value: data.totals.credit },
            { label: 'Closing', value: data.totals.closing },
          ].map((tile) => (
            <div key={tile.label} className="rounded-lg border bg-card p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{tile.label}</p>
              <p className="text-lg font-semibold tabular-nums">{money(tile.value, currency)}</p>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-24">Code</TableHead>
              <TableHead>Account</TableHead>
              <TableHead className="text-right">Opening</TableHead>
              <TableHead className="text-right">Debit</TableHead>
              <TableHead className="text-right">Credit</TableHead>
              <TableHead className="text-right">Closing</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={7}><Skeleton className="h-4 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.accounts.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No posted activity in this period.
                </TableCell>
              </TableRow>
            ) : (
              groups.map(([key, accounts]) => (
                <Fragment key={`group-${key}`}>
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableCell colSpan={7} className="py-1.5 text-xs font-semibold uppercase tracking-wide">
                      {CLASSIFICATION_LABEL[key] ?? key}
                    </TableCell>
                  </TableRow>
                  {accounts.map((account) => {
                    const isOpen = expanded.has(account.accountId);
                    return (
                      <Fragment key={account.accountId}>
                        <TableRow
                          className={account.lines.length > 0 ? 'cursor-pointer' : undefined}
                          onClick={account.lines.length > 0 ? () => toggle(account.accountId) : undefined}
                        >
                          <TableCell className="py-1.5">
                            {account.lines.length > 0 &&
                              (isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}
                          </TableCell>
                          <TableCell className="py-1.5 font-mono text-xs">{account.code}</TableCell>
                          <TableCell className="py-1.5">
                            {account.name}
                            {account.lineCount > 0 && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {account.lineCount} line{account.lineCount === 1 ? '' : 's'}
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums">
                            {money(signed(account.opening, account.normalBalance), currency)}
                          </TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums">{money(account.debit, currency)}</TableCell>
                          <TableCell className="py-1.5 text-right tabular-nums">{money(account.credit, currency)}</TableCell>
                          <TableCell className="py-1.5 text-right font-medium tabular-nums">
                            {money(signed(account.closing, account.normalBalance), currency)}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="hover:bg-transparent">
                            <TableCell colSpan={7} className="bg-muted/20 p-0">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="w-28 text-xs">Date</TableHead>
                                    <TableHead className="w-40 text-xs">Entry</TableHead>
                                    <TableHead className="w-24 text-xs">Journal</TableHead>
                                    <TableHead className="text-xs">Description</TableHead>
                                    <TableHead className="w-36 text-xs">Partner</TableHead>
                                    <TableHead className="w-28 text-right text-xs">Debit</TableHead>
                                    <TableHead className="w-28 text-right text-xs">Credit</TableHead>
                                    <TableHead className="w-32 text-right text-xs">Balance</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {account.lines.map((line) => (
                                    <TableRow key={line.id}>
                                      <TableCell className="py-1 text-xs">
                                        {new Date(line.date).toLocaleDateString()}
                                      </TableCell>
                                      <TableCell className="py-1 font-mono text-xs">{line.entryNumber}</TableCell>
                                      <TableCell className="py-1 text-xs">{line.journalCode ?? '—'}</TableCell>
                                      <TableCell className="py-1 text-xs">{line.description ?? '—'}</TableCell>
                                      <TableCell className="py-1 text-xs">{line.partnerName ?? '—'}</TableCell>
                                      <TableCell className="py-1 text-right text-xs tabular-nums">
                                        {Number(line.debit) === 0 ? '—' : money(line.debit, currency)}
                                      </TableCell>
                                      <TableCell className="py-1 text-right text-xs tabular-nums">
                                        {Number(line.credit) === 0 ? '—' : money(line.credit, currency)}
                                      </TableCell>
                                      <TableCell className="py-1 text-right text-xs tabular-nums">
                                        {money(signed(line.balance, account.normalBalance), currency)}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Posted and reversed entries only; drafts are excluded.
        {isFetching && ' Refreshing…'}
      </p>
    </div>
  );
}
