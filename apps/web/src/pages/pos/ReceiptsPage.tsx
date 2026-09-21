import { useNavigate } from 'react-router-dom';
import { Eye, ReceiptText } from 'lucide-react';
import type { PaginatedResult } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/data-table';
import {
  DataTablePagination, DateRangeFilter, ExportMenu, FilterChips, FilterSelect, ListCard,
  ListPageHeader, ListToolbar, SearchInput, StatusPill, dateRangeLabel, describeFilters,
  useListState, type ActiveChip, type Tone,
} from '@/components/list';
import { api } from '@/lib/api';
import { fetchAllPages, type ExportColumn } from '@/lib/export-list';
import { money, date, useOrgCurrency } from '@/lib/format';
import { useReceipts } from '@/pages/pos/api';
import type { Receipt } from '@/pages/pos/types';

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

const settlementTone: Record<string, Tone> = {
  unsettled: 'neutral',
  partially_settled: 'warning',
  settled: 'success',
  written_off: 'danger',
};

const toOptions = (m: Record<string, string>) => Object.entries(m).map(([value, label]) => ({ value, label }));

const FILTERS = { paymentMode: '', settlementStatus: '', dateFrom: '', dateTo: '' };

export function ReceiptsPage() {
  const navigate = useNavigate();
  const currency = useOrgCurrency();
  const list = useListState(FILTERS);
  const { paymentMode, settlementStatus, dateFrom, dateTo } = list.filters;

  const query = {
    search: list.search || undefined,
    paymentMode: paymentMode || undefined,
    settlementStatus: settlementStatus || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading, isFetching } = useReceipts({ page: list.page, pageSize: list.pageSize, ...query });
  const rows = data?.data ?? [];
  const meta = data?.meta;

  const chips: ActiveChip[] = [
    ...(list.search ? [{ key: 'q', label: `“${list.search}”`, onRemove: () => list.setSearchInput('') }] : []),
    ...(paymentMode ? [{ key: 'method', label: methodLabel[paymentMode] ?? paymentMode, onRemove: () => list.setFilter('paymentMode', '') }] : []),
    ...(settlementStatus ? [{ key: 'settlement', label: settlementLabel[settlementStatus] ?? settlementStatus, onRemove: () => list.setFilter('settlementStatus', '') }] : []),
    ...(dateFrom || dateTo ? [{ key: 'date', label: dateRangeLabel(dateFrom, dateTo), onRemove: () => list.setFilters({ dateFrom: '', dateTo: '' }) }] : []),
  ];

  const method = (r: Receipt) => (r.paymentMode ? methodLabel[r.paymentMode] ?? r.paymentMode : '—');

  const columns: Column<Receipt>[] = [
    {
      key: 'invoiceNumber',
      header: 'Receipt #',
      render: (r) => <span className="font-medium text-primary">{r.documentNumber}</span>,
    },
    { key: 'partner', header: 'Customer', render: (r) => r.partner?.name ?? <span className="text-muted-foreground">Walk-in</span> },
    { key: 'issueDate', header: 'Date', render: (r) => <span className="whitespace-nowrap text-muted-foreground">{date(r.issueDate)}</span> },
    { key: 'itemCount', header: 'Items', className: 'text-right', render: (r) => <span className="tabular-nums text-muted-foreground">{r.itemCount}</span> },
    {
      key: 'paymentMode',
      header: 'Method',
      render: (r) => <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">{method(r)}</span>,
    },
    { key: 'totalAmount', header: 'Total', className: 'text-right', render: (r) => <span className="font-semibold tabular-nums">{money(r.totalAmount, currency)}</span> },
    {
      key: 'settlementStatus',
      header: 'Settlement',
      render: (r) => (
        <StatusPill tone={settlementTone[r.settlementStatus] ?? 'neutral'}>
          {settlementLabel[r.settlementStatus] ?? r.settlementStatus}
        </StatusPill>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      render: (r) => (
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(`/pos/receipts/${r.id}`)} aria-label="View receipt">
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  const exportColumns: ExportColumn<Receipt>[] = [
    { header: 'Receipt #', value: (r) => r.documentNumber },
    { header: 'Customer', value: (r) => r.partner?.name ?? '' },
    { header: 'Date', value: (r) => date(r.issueDate) },
    { header: 'Items', value: (r) => r.itemCount, align: 'right' },
    { header: 'Method', value: method },
    { header: 'Total', value: (r) => money(r.totalAmount, currency), align: 'right' },
    { header: 'Settlement', value: (r) => settlementLabel[r.settlementStatus] ?? r.settlementStatus },
  ];

  const fetchAll = () =>
    fetchAllPages<Receipt>(async (page, pageSize) => {
      const res = (await api.get<PaginatedResult<Receipt>>('/pos/receipts', { params: { ...query, page, pageSize } })).data;
      return { rows: res.data, totalPages: res.meta.totalPages };
    }, { pageSize: 100 });

  return (
    <div className="space-y-4">
      <ListPageHeader
        icon={ReceiptText}
        title="Receipts"
        description="POS transaction receipts. Click a row to view its full detail."
        actions={
          <ExportMenu
            basename="receipts"
            title="Receipts"
            subtitle={describeFilters(chips)}
            columns={exportColumns}
            pageRows={rows}
            total={meta?.total}
            fetchAll={fetchAll}
            totals={(r) => ['Total', '', '', '', '', money(r.reduce((s, x) => s + Number(x.totalAmount || 0), 0), currency), '']}
          />
        }
      />

      <ListToolbar chips={<FilterChips chips={chips} onClearAll={list.clearFilters} />}>
        <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Search receipt # or customer…" />
        <FilterSelect value={paymentMode} onChange={(v) => list.setFilter('paymentMode', v)} options={toOptions(methodLabel)} allLabel="All methods" />
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
            getRowId={(r) => r.id}
            onRowClick={(r) => navigate(`/pos/receipts/${r.id}`)}
            cellClassName="py-2.5 px-4"
            headerRowClassName="h-10"
            emptyMessage={chips.length ? 'No receipts match these filters.' : 'No receipts yet.'}
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
            noun="receipt"
          />
        )}
      </ListCard>
    </div>
  );
}
