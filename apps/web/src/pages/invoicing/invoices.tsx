import { Link, useNavigate } from 'react-router-dom';
import { Eye, Plus, Receipt as ReceiptIcon } from 'lucide-react';
import { PERMISSIONS, type PaginatedResult } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/data-table';
import {
  DataTablePagination, DateRangeFilter, ExportMenu, FilterChips, FilterSelect, ListCard,
  ListPageHeader, ListToolbar, SearchInput, StatusPill, dateRangeLabel, describeFilters,
  useListState, type ActiveChip, type Tone,
} from '@/components/list';
import { api } from '@/lib/api';
import { fetchAllPages, type ExportColumn } from '@/lib/export-list';
import { money, date, statusLabel } from '@/lib/format';
import { useAuthStore } from '@/stores/auth.store';
import { useInvoices, type Invoice } from '@/features/invoicing/api';

const statusTone: Record<string, Tone> = {
  draft: 'neutral',
  posted: 'info',
  paid: 'success',
  cancelled: 'danger',
};

const statusOptions: Record<string, string> = {
  draft: 'Draft',
  posted: 'Posted',
  paid: 'Paid',
  cancelled: 'Cancelled',
};

const paymentStatusOptions: Record<string, string> = {
  unpaid: 'Unpaid',
  partially_paid: 'Partially Paid',
  paid: 'Paid',
};

const paymentStatusTone: Record<string, Tone> = {
  unpaid: 'warning',
  partially_paid: 'accent',
  paid: 'success',
};

const paymentLabel: Record<string, string> = {
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

const settlementTone: Record<string, Tone> = {
  unsettled: 'neutral',
  partially_settled: 'warning',
  settled: 'success',
  written_off: 'danger',
};

const toOptions = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

const FILTERS = { status: '', paymentStatus: '', settlementStatus: '', dateFrom: '', dateTo: '' };

const sumOf = (rows: Invoice[], pick: (i: Invoice) => string) => rows.reduce((s, i) => s + Number(pick(i) || 0), 0);

export function InvoicesPage() {
  const navigate = useNavigate();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const list = useListState(FILTERS);
  const { status, paymentStatus, settlementStatus, dateFrom, dateTo } = list.filters;

  const query = {
    search: list.search || undefined,
    status: status || undefined,
    paymentStatus: paymentStatus || undefined,
    settlementStatus: settlementStatus || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading, isFetching } = useInvoices({ page: list.page, pageSize: list.pageSize, ...query });
  const rows = data?.data ?? [];
  const meta = data?.meta;

  const chips: ActiveChip[] = [
    ...(list.search ? [{ key: 'q', label: `“${list.search}”`, onRemove: () => list.setSearchInput('') }] : []),
    ...(status ? [{ key: 'status', label: statusOptions[status] ?? status, onRemove: () => list.setFilter('status', '') }] : []),
    ...(paymentStatus ? [{ key: 'payment', label: paymentStatusOptions[paymentStatus] ?? paymentStatus, onRemove: () => list.setFilter('paymentStatus', '') }] : []),
    ...(settlementStatus ? [{ key: 'settlement', label: `Settlement: ${settlementLabel[settlementStatus] ?? settlementStatus}`, onRemove: () => list.setFilter('settlementStatus', '') }] : []),
    ...(dateFrom || dateTo ? [{ key: 'date', label: dateRangeLabel(dateFrom, dateTo), onRemove: () => list.setFilters({ dateFrom: '', dateTo: '' }) }] : []),
  ];

  const method = (inv: Invoice) => (inv.paymentMode ? paymentLabel[inv.paymentMode] ?? inv.paymentMode : '—');

  const columns: Column<Invoice>[] = [
    {
      key: 'documentNumber',
      header: 'Invoice #',
      render: (inv) => (
        <Link to={`/invoices/${inv.id}`} className="font-medium text-primary hover:underline">
          {inv.documentNumber}
        </Link>
      ),
    },
    { key: 'partner', header: 'Customer', render: (inv) => inv.partner?.name ?? <span className="text-muted-foreground">—</span> },
    { key: 'paymentTerm', header: 'Terms', render: (inv) => <span className="text-sm text-muted-foreground">{inv.paymentTermName ?? '—'}</span> },
    { key: 'issueDate', header: 'Date', render: (inv) => <span className="whitespace-nowrap text-muted-foreground">{date(inv.issueDate)}</span> },
    { key: 'totalAmount', header: 'Total', className: 'text-right', render: (inv) => <span className="font-semibold tabular-nums">{money(inv.totalAmount)}</span> },
    {
      key: 'amountResidual',
      header: 'Due',
      className: 'text-right',
      render: (inv) =>
        Number(inv.amountResidual) > 0
          ? <span className="font-medium tabular-nums text-amber-700 dark:text-amber-400">{money(inv.amountResidual)}</span>
          : <span className="tabular-nums text-muted-foreground">{money(0)}</span>,
    },
    {
      key: 'discount',
      header: 'Discount',
      className: 'text-right',
      render: (inv) => {
        if (!(Number(inv.discountTotal) > 0)) return <span className="text-muted-foreground/50">—</span>;
        const typeLabel = inv.discountType === 'fixed_amount'
          ? 'fixed'
          : Number(inv.discountValue) > 0 ? `${Number(inv.discountValue).toFixed(1)}%` : '';
        return (
          <div className="text-right">
            <div className="font-medium tabular-nums text-amber-700 dark:text-amber-400">-{money(inv.discountTotal)}</div>
            {(inv.discountReason || typeLabel) && (
              <div className="text-[10px] text-muted-foreground">{[typeLabel, inv.discountReason].filter(Boolean).join(' · ')}</div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (inv) => <StatusPill tone={statusTone[inv.status] ?? 'neutral'}>{statusOptions[inv.status] ?? statusLabel(inv.status)}</StatusPill>,
    },
    {
      key: 'paymentStatus',
      header: 'Payment',
      render: (inv) => (
        <div className="flex flex-col items-start gap-1">
          <StatusPill tone={paymentStatusTone[inv.paymentStatus] ?? 'neutral'} dot={false}>{statusLabel(inv.paymentStatus)}</StatusPill>
          <span className="text-[11px] text-muted-foreground">{method(inv)}</span>
        </div>
      ),
    },
    {
      key: 'settlementStatus',
      header: 'Settlement',
      render: (inv) => (
        <StatusPill tone={settlementTone[inv.settlementStatus] ?? 'neutral'}>
          {settlementLabel[inv.settlementStatus] ?? inv.settlementStatus}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      render: (inv) => (
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(`/invoices/${inv.id}`)} aria-label="View invoice">
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  const exportColumns: ExportColumn<Invoice>[] = [
    { header: 'Invoice #', value: (i) => i.documentNumber },
    { header: 'Customer', value: (i) => i.partner?.name ?? '' },
    { header: 'Terms', value: (i) => i.paymentTermName ?? '' },
    { header: 'Date', value: (i) => date(i.issueDate) },
    { header: 'Total', value: (i) => money(i.totalAmount), align: 'right' },
    { header: 'Due', value: (i) => money(i.amountResidual), align: 'right' },
    { header: 'Discount', value: (i) => (Number(i.discountTotal) > 0 ? money(i.discountTotal) : ''), align: 'right' },
    { header: 'Status', value: (i) => statusOptions[i.status] ?? i.status },
    { header: 'Payment', value: (i) => statusLabel(i.paymentStatus) },
    { header: 'Method', value: method },
    { header: 'Settlement', value: (i) => settlementLabel[i.settlementStatus] ?? i.settlementStatus },
  ];

  const fetchAll = () =>
    fetchAllPages<Invoice>(async (page, pageSize) => {
      const res = (await api.get<PaginatedResult<Invoice>>('/invoices', { params: { ...query, page, pageSize } })).data;
      return { rows: res.data, totalPages: res.meta.totalPages };
    }, { pageSize: 200 });

  return (
    <div className="space-y-4">
      <ListPageHeader
        icon={ReceiptIcon}
        title="Sales / Invoices"
        description="Sales invoices — post to the ledger and collect payment."
        actions={
          <>
            <ExportMenu
              basename="sales-invoices"
              title="Sales / Invoices"
              subtitle={describeFilters(chips)}
              columns={exportColumns}
              pageRows={rows}
              total={meta?.total}
              fetchAll={fetchAll}
              totals={(r) => [
                'Total', '', '', '',
                money(sumOf(r, (i) => i.totalAmount)),
                money(sumOf(r, (i) => i.amountResidual)),
                money(sumOf(r, (i) => i.discountTotal)),
                '', '', '', '',
              ]}
            />
            {hasPermission(PERMISSIONS.invoice.create) && (
              <Button onClick={() => navigate('/invoices/new')}>
                <Plus className="mr-1 h-4 w-4" /> New Invoice
              </Button>
            )}
          </>
        }
      />

      <ListToolbar chips={<FilterChips chips={chips} onClearAll={list.clearFilters} />}>
        <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Search invoice #, reference or customer…" />
        <FilterSelect value={status} onChange={(v) => list.setFilter('status', v)} options={toOptions(statusOptions)} allLabel="All statuses" className="w-[140px]" />
        <FilterSelect value={paymentStatus} onChange={(v) => list.setFilter('paymentStatus', v)} options={toOptions(paymentStatusOptions)} allLabel="All payments" className="w-[150px]" />
        <FilterSelect value={settlementStatus} onChange={(v) => list.setFilter('settlementStatus', v)} options={toOptions(settlementLabel)} allLabel="All settlements" />
        <DateRangeFilter from={dateFrom} to={dateTo} onChange={(f, t) => list.setFilters({ dateFrom: f, dateTo: t })} />
      </ListToolbar>

      <ListCard>
        <div className={isFetching && !isLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <DataTable
            columns={columns}
            data={rows}
            loading={isLoading}
            loadingRows={10}
            getRowId={(i) => i.id}
            onRowClick={(i) => navigate(`/invoices/${i.id}`)}
            cellClassName="py-2 px-4"
            headerRowClassName="h-10"
            emptyMessage={chips.length ? 'No invoices match these filters.' : 'No invoices yet.'}
          />
        </div>
        {meta && (
          <DataTablePagination
            page={meta.page}
            pageSize={list.pageSize}
            total={meta.total}
            totalPages={meta.totalPages}
            onPageChange={list.setPage}
            onPageSizeChange={list.setPageSize}
            noun="invoice"
          />
        )}
      </ListCard>
    </div>
  );
}
