import { Link, useNavigate } from 'react-router-dom';
import { ClipboardList, Eye, FileText, MoreHorizontal, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/data-table';
import {
  DataTablePagination, DateRangeFilter, ExportMenu, FilterChips, FilterSelect, ListCard,
  ListPageHeader, ListToolbar, SearchInput, StatusPill, dateRangeLabel, describeFilters,
  useListState, type ActiveChip, type Tone,
} from '@/components/list';
import { api } from '@/lib/api';
import { fetchAllPages, type ExportColumn } from '@/lib/export-list';
import { money, dateTime, useOrgCurrency, statusLabel } from '@/lib/format';
import { useOrders } from '@/features/orders/api';
import type { ListResponse, Order } from '@/features/orders/types';
import { ORDER_TYPE_LABELS } from './line-source';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const statusTone: Record<string, Tone> = {
  confirmed: 'info',
  in_progress: 'warning',
  ready: 'accent',
  completed: 'success',
  cancelled: 'danger',
  closed: 'neutral',
};

const STATUS_OPTIONS = ['confirmed', 'in_progress', 'ready', 'completed', 'cancelled', 'closed']
  .map((value) => ({ value, label: statusLabel(value) }));
const TYPE_OPTIONS = Object.entries(ORDER_TYPE_LABELS).map(([value, label]) => ({ value, label }));

const FILTERS = { status: '', orderType: '', dateFrom: '', dateTo: '' };

export function OrdersPage() {
  const navigate = useNavigate();
  const currency = useOrgCurrency();
  const list = useListState(FILTERS);
  const { status, orderType, dateFrom, dateTo } = list.filters;

  const query = {
    search: list.search || undefined,
    status: status || undefined,
    orderType: orderType || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading, isFetching } = useOrders({ page: list.page, pageSize: list.pageSize, ...query });
  const rows = data?.rows ?? [];
  const meta = data?.meta;

  const chips: ActiveChip[] = [
    ...(list.search ? [{ key: 'q', label: `“${list.search}”`, onRemove: () => list.setSearchInput('') }] : []),
    ...(status ? [{ key: 'status', label: statusLabel(status), onRemove: () => list.setFilter('status', '') }] : []),
    ...(orderType ? [{ key: 'type', label: ORDER_TYPE_LABELS[orderType as keyof typeof ORDER_TYPE_LABELS] ?? orderType, onRemove: () => list.setFilter('orderType', '') }] : []),
    ...(dateFrom || dateTo ? [{ key: 'date', label: dateRangeLabel(dateFrom, dateTo), onRemove: () => list.setFilters({ dateFrom: '', dateTo: '' }) }] : []),
  ];

  const typeLabel = (o: Order) => ORDER_TYPE_LABELS[o.orderType] ?? o.orderType;

  const columns: Column<Order>[] = [
    {
      key: 'orderNumber',
      header: 'Order #',
      render: (o) => (
        <Link to={`/orders/${o.id}`} className="font-medium text-primary hover:underline">
          {o.orderNumber}
        </Link>
      ),
    },
    {
      key: 'partnerName',
      header: 'Customer',
      render: (o) => o.partnerName ?? <span className="text-muted-foreground">Walk-in</span>,
    },
    {
      key: 'orderType',
      header: 'Type',
      render: (o) => <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium">{typeLabel(o)}</span>,
    },
    { key: 'openedAt', header: 'Date', render: (o) => <span className="whitespace-nowrap text-muted-foreground">{dateTime(o.openedAt)}</span> },
    { key: 'totalAmount', header: 'Total', className: 'text-right', render: (o) => <span className="font-semibold tabular-nums">{money(o.totalAmount, currency)}</span> },
    {
      key: 'status',
      header: 'Status',
      render: (o) => <StatusPill tone={statusTone[o.status] ?? 'neutral'}>{statusLabel(o.status)}</StatusPill>,
    },
    {
      key: 'invoiceId',
      header: 'Billed',
      render: (o) =>
        o.invoiceId ? <StatusPill tone="success" dot={false}>Invoiced</StatusPill> : <span className="text-sm text-muted-foreground">—</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'w-12 text-right',
      render: (o) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => navigate(`/orders/${o.id}`)}>
              <Eye className="mr-2 h-3.5 w-3.5" /> View details
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate(`/invoices/${o.invoiceId}`)} disabled={!o.invoiceId}>
              <FileText className="mr-2 h-3.5 w-3.5" /> View invoice
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  const exportColumns: ExportColumn<Order>[] = [
    { header: 'Order #', value: (o) => o.orderNumber },
    { header: 'Customer', value: (o) => o.partnerName ?? '' },
    { header: 'Type', value: typeLabel },
    { header: 'Date', value: (o) => dateTime(o.openedAt) },
    { header: 'Total', value: (o) => money(o.totalAmount, currency), align: 'right' },
    { header: 'Status', value: (o) => statusLabel(o.status) },
    { header: 'Billed', value: (o) => (o.invoiceId ? 'Invoiced' : '') },
  ];

  const fetchAll = () =>
    fetchAllPages<Order>(async (page, pageSize) => {
      const res = (await api.get<ListResponse<Order>>('/orders', { params: { ...query, page, pageSize } })).data;
      return { rows: res.rows, totalPages: res.meta.totalPages };
    }, { pageSize: 200 });

  return (
    <div className="space-y-4">
      <ListPageHeader
        icon={ClipboardList}
        title="Orders"
        description="Operational orders — café, retail, rental and repair share one document."
        actions={
          <>
            <ExportMenu
              basename="orders"
              title="Orders"
              subtitle={describeFilters(chips)}
              columns={exportColumns}
              pageRows={rows}
              total={meta?.total}
              fetchAll={fetchAll}
              totals={(r) => ['Total', '', '', '', money(r.reduce((s, o) => s + Number(o.totalAmount || 0), 0), currency), '', '']}
            />
            <Button onClick={() => navigate('/orders/new')}>
              <Plus className="mr-1 h-4 w-4" /> New Order
            </Button>
          </>
        }
      />

      <ListToolbar chips={<FilterChips chips={chips} onClearAll={list.clearFilters} />}>
        <SearchInput value={list.searchInput} onChange={list.setSearchInput} placeholder="Search order # or customer…" />
        <FilterSelect value={status} onChange={(v) => list.setFilter('status', v)} options={STATUS_OPTIONS} allLabel="All statuses" />
        <FilterSelect value={orderType} onChange={(v) => list.setFilter('orderType', v)} options={TYPE_OPTIONS} allLabel="All types" />
        <DateRangeFilter from={dateFrom} to={dateTo} onChange={(f, t) => list.setFilters({ dateFrom: f, dateTo: t })} />
      </ListToolbar>

      <ListCard>
        <div className={isFetching && !isLoading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          <DataTable
            columns={columns}
            data={rows}
            loading={isLoading}
            loadingRows={list.pageSize > 10 ? 10 : list.pageSize}
            getRowId={(o) => o.id}
            onRowClick={(o) => navigate(`/orders/${o.id}`)}
            cellClassName="py-2.5 px-4"
            headerRowClassName="h-10"
            emptyMessage={chips.length ? 'No orders match these filters.' : 'No orders yet. Create one with “New Order”.'}
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
            noun="order"
          />
        )}
      </ListCard>
    </div>
  );
}
