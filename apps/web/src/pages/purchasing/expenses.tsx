import { useEffect, useState, useCallback, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { Loader2, Plus, Search, X, ChevronLeft, ChevronRight, Building2, Receipt, TrendingUp, Clock } from 'lucide-react';
import { expensesApi, accountsApi } from '@/lib/api/expenses';
import { expenseCategoriesApi } from '@/lib/api/expenseCategories';
import type { Expense, ExpenseStats, AuditLogRow, Account } from '@/types/expenses';
import { formatCurrency, cn } from '@/lib/utils';
import { date, dateTime } from '@/lib/format';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuthStore } from '@/stores/auth.store';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

// ── Status Badge ────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
    draft: { label: 'Draft', variant: 'secondary' },
    pending: { label: 'Pending', variant: 'outline' },
    approved: { label: 'Approved', variant: 'default' },
    rejected: { label: 'Rejected', variant: 'destructive' },
    paid: { label: 'Paid', variant: 'default' },
    partial: { label: 'Partial', variant: 'secondary' },
    void: { label: 'Void', variant: 'destructive' },
    overpaid: { label: 'Overpaid', variant: 'secondary' },
  };
  const s = map[status] ?? { label: status, variant: 'secondary' as const };
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

// ── Stat Card ────────────────────────────────────────────────
function StatCard({
  icon: Icon,
  title,
  value,
  subtitle,
  className,
}: {
  icon: React.ElementType;
  title: string;
  value: string;
  subtitle?: string;
  className?: string;
}) {
  return (
    <Card className={cn('transition-shadow hover:shadow-md', className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <Icon className="h-5 w-5 text-muted-foreground/70" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}

// ── Breakdown Card (by category) ────────────────────────────
function BreakdownCard({
  data,
  title,
}: {
  data: Array<{ category?: string; _sum: { amount?: number }; _count: { id: number } }>;
  title: string;
}) {
  const total = data.reduce((acc, d) => acc + (d._sum.amount ?? 0), 0) || 1;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data.map((d, i) => {
          const pct = ((d._sum.amount ?? 0) / total) * 100;
          return (
            <div key={i}>
              <div className="flex items-center justify-between text-sm">
                <span className="truncate">{d.category || 'Uncategorized'}</span>
                <span className="font-medium">{pct.toFixed(1)}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

// ── Expense Form Dialog ──────────────────────────────────────
function ExpenseFormDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const user = useAuthStore((s) => s.user);
  const organizationId = useAuthStore((s) => s.organization?.id);

  const form = useForm({
    defaultValues: {
      title: '',
      description: '',
      amount: '' as string | number,
      categoryId: '',
      expenseDate: new Date().toISOString().slice(0, 10),
    },
  });

  useEffect(() => {
    if (open) {
      expenseCategoriesApi.list().then(setCategories).catch(() => {});
      form.reset({
        title: '',
        description: '',
        amount: '',
        categoryId: '',
        expenseDate: new Date().toISOString().slice(0, 10),
      });
    }
  }, [open, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await expensesApi.create({
        ...values,
        amount: Number(values.amount),
        createdBy: user?.id,
        organizationId,
      });
      onSuccess();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>New Expense</DialogTitle>
          <DialogDescription>Record a new business expense.</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              rules={{ required: 'Title is required' }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Office supplies" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="amount"
                rules={{ required: 'Amount is required' }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Amount (UGX)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" placeholder="0" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expenseDate"
                rules={{ required: 'Date is required' }}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="categoryId"
              rules={{ required: 'Category is required' }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Category</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {categories.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Additional notes..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Expense
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ── Pay Dialog ───────────────────────────────────────────────
function PayExpenseDialog({
  expense,
  open,
  onOpenChange,
  onSuccess,
}: {
  expense: Expense | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [method, setMethod] = useState('cash');
  const [accountId, setAccountId] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    if (open) accountsApi.getAll().then(setAccounts).catch(() => {});
  }, [open]);

  const handlePay = async () => {
    if (!expense || !user?.id) return;
    setSubmitting(true);
    try {
      await expensesApi.pay(expense.id, {
        paidBy: user.id,
        paymentMethod: method,
        reference,
        paymentNotes: notes,
        accountId,
      });
      onSuccess();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>Pay Expense</DialogTitle>
          <DialogDescription>
            Record payment for <strong>{expense?.title}</strong> — UGX{' '}
            {expense?.amount?.toLocaleString()}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Payment Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                <SelectItem value="cheque">Cheque</SelectItem>
                <SelectItem value="mobile_money">Mobile Money</SelectItem>
                <SelectItem value="credit_card">Credit Card</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Select account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name} ({a.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Reference (optional)</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Cheque no. / TXN ID" />
          </div>
          <div className="space-y-1">
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handlePay} disabled={submitting || !accountId}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Record Payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Approve Dialog ───────────────────────────────────────────
function ApproveDialog({
  expense,
  open,
  onOpenChange,
  onSuccess,
}: {
  expense: Expense | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const user = useAuthStore((s) => s.user);

  const handleApprove = async () => {
    if (!expense || !user?.id) return;
    setSubmitting(true);
    try {
      await expensesApi.approve(expense.id, { approvedBy: user.id, approvalNotes: notes });
      onSuccess();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve Expense</DialogTitle>
          <DialogDescription>
            Approve <strong>{expense?.title}</strong> — UGX {expense?.amount?.toLocaleString()}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Approval Notes (optional)</Label>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any remarks..." />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleApprove} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Reject Dialog ────────────────────────────────────────────
function RejectDialog({
  expense,
  open,
  onOpenChange,
  onSuccess,
}: {
  expense: Expense | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleReject = async () => {
    if (!expense) return;
    setSubmitting(true);
    try {
      await expensesApi.reject(expense.id, reason);
      onSuccess();
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject Expense</DialogTitle>
          <DialogDescription>
            Reject <strong>{expense?.title}</strong>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Reason for rejection</Label>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why this expense is being rejected..."
            className="min-h-[100px]"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleReject} disabled={submitting || !reason.trim()}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Detail Dialog (with audit trail) ─────────────────────────
function ExpenseDetailDialog({
  expense,
  open,
  onOpenChange,
}: {
  expense: Expense | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [audit, setAudit] = useState<AuditLogRow[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);

  useEffect(() => {
    if (open && expense) {
      setLoadingAudit(true);
      expensesApi
        .getAudit(expense.id)
        .then(setAudit)
        .catch(() => setAudit([]))
        .finally(() => setLoadingAudit(false));
    }
  }, [open, expense]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{expense?.title}</DialogTitle>
          <DialogDescription>
            Code: {expense?.expenseCode} &middot; {expense?.categoryName}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Amount</span>
              <p className="font-semibold">{formatCurrency(expense?.amount)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Status</span>
              <p>{expense && <StatusBadge status={expense.status} />}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Date</span>
              <p>{date(expense?.expenseDate)}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Created By</span>
              <p>
                {expense?.createdBy?.staff
                  ? `${expense.createdBy.staff.firstName} ${expense.createdBy.staff.lastName}`
                  : '-'}
              </p>
            </div>
            {expense?.description && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Description</span>
                <p>{expense.description}</p>
              </div>
            )}
          </div>

          <div>
            <h4 className="mb-2 text-sm font-medium">Audit Trail</h4>
            {loadingAudit ? (
              <div className="space-y-2">
                <Skeleton className="h-6 w-full" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : audit.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit records found.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {audit.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 rounded-md border p-2">
                    <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="font-medium capitalize">{a.action.replace(/_/g, ' ')}</p>
                      <p className="text-xs text-muted-foreground">
                        {a.userName ?? 'System'} &middot; {dateTime(a.createdAt)}
                      </p>
                      {a.reason && <p className="text-xs italic">{a.reason}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Expenses Page ───────────────────────────────────────
export function ExpensesPage() {

  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [stats, setStats] = useState<ExpenseStats | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [categories, setCategories] = useState<Array<{ id: string; name: string }>>([]);

  // Dialog state
  const [showForm, setShowForm] = useState(false);
  const [selectedExpense, setSelectedExpense] = useState<Expense | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [showPay, setShowPay] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [showReject, setShowReject] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params: any = { page, limit };
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;
      if (categoryFilter) params.categoryId = categoryFilter;
      const res = await expensesApi.getAll(params);
      setExpenses(res.data);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  }, [page, limit, search, statusFilter, categoryFilter]);

  const fetchStats = useCallback(async () => {
    try {
      const s = await expensesApi.getStats();
      setStats(s);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    expenseCategoriesApi.list().then(setCategories).catch(() => {});
  }, []);

  // Debounced search
  const handleSearch = (val: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearch(val);
      setPage(1);
    }, 400);
  };

  const totalPages = Math.ceil(total / limit);

  const actions = (exp: Expense) => (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setSelectedExpense(exp);
          setShowDetail(true);
        }}
      >
        View
      </Button>
      {exp.status === 'pending' && (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="text-green-600"
            onClick={() => {
              setSelectedExpense(exp);
              setShowApprove(true);
            }}
          >
            Approve
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600"
            onClick={() => {
              setSelectedExpense(exp);
              setShowReject(true);
            }}
          >
            Reject
          </Button>
        </>
      )}
      {(exp.status === 'approved' || exp.status === 'partial') && (
        <Button
          variant="ghost"
          size="sm"
          className="text-blue-600"
          onClick={() => {
            setSelectedExpense(exp);
            setShowPay(true);
          }}
        >
          Pay
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* ── Stats cards ── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Receipt}
          title="Total Expenses"
          value={stats ? formatCurrency(stats.grandTotal) : '—'}
          subtitle={`${stats?.count ?? 0} records`}
        />
        <StatCard
          icon={TrendingUp}
          title="Paid"
          value={stats ? formatCurrency(stats.totalPaid) : '—'}
          subtitle={`${stats?.totalPaidCount ?? 0} paid`}
          className="border-l-4 border-l-green-500"
        />
        <StatCard
          icon={Building2}
          title="Unpaid"
          value={stats ? formatCurrency(stats.totalUnpaid) : '—'}
          subtitle={`${stats?.totalUnpaidCount ?? 0} unpaid`}
          className="border-l-4 border-l-amber-500"
        />
        <StatCard
          icon={Clock}
          title="Outstanding Payables"
          value={stats?.outstandingPayables ? formatCurrency(stats.outstandingPayables.amount) : '—'}
          subtitle={`${stats?.outstandingPayables?.count ?? 0} items`}
          className="border-l-4 border-l-red-500"
        />
      </div>

      {/* ── Breakdowns ── */}
      {stats?.byCategory && stats.byCategory.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          <BreakdownCard data={stats.byCategory} title="Expense by Category" />
          {stats.bySupplier && stats.bySupplier.length > 0 && (
            <BreakdownCard data={stats.bySupplier} title="Expense by Supplier" />
          )}
        </div>
      )}

      {/* ── Filters & Actions ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search expenses..."
              className="pl-8"
              onChange={(e) => handleSearch(e.target.value)}
            />
            {search && (
              <button
                className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setSearch('');
                  setPage(1);
                }}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="void">Void</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v); setPage(1); }}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowForm(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Expense
        </Button>
      </div>

      {/* ── Table ── */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created By</TableHead>
                <TableHead className="w-[180px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : expenses.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    No expenses found.
                  </TableCell>
                </TableRow>
              ) : (
                expenses.map((exp) => (
                  <TableRow key={exp.id}>
                    <TableCell className="font-mono text-xs">{exp.expenseCode}</TableCell>
                    <TableCell className="font-medium">{exp.title}</TableCell>
                    <TableCell>{exp.categoryName || '-'}</TableCell>
                    <TableCell className="text-right font-medium">{formatCurrency(exp.amount)}</TableCell>
                    <TableCell>{date(exp.expenseDate)}</TableCell>
                    <TableCell><StatusBadge status={exp.status} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {exp.createdBy?.staff
                        ? `${exp.createdBy.staff.firstName} ${exp.createdBy.staff.lastName}`
                        : '-'}
                    </TableCell>
                    <TableCell>{actions(exp)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Pagination ── */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {total === 0 ? 0 : (page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
            .map((p, idx, arr) => (
              <span key={p} className="flex items-center">
                {idx > 0 && arr[idx - 1] !== p - 1 && <span className="px-1">...</span>}
                <Button
                  variant={page === p ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 w-8 p-0"
                  onClick={() => setPage(p)}
                >
                  {p}
                </Button>
              </span>
            ))}
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── Dialogs ── */}
      <ExpenseFormDialog
        open={showForm}
        onOpenChange={setShowForm}
        onSuccess={() => { fetchData(); fetchStats(); }}
      />
      <ExpenseDetailDialog
        expense={selectedExpense}
        open={showDetail}
        onOpenChange={setShowDetail}
      />
      <PayExpenseDialog
        expense={selectedExpense}
        open={showPay}
        onOpenChange={setShowPay}
        onSuccess={() => { fetchData(); fetchStats(); }}
      />
      <ApproveDialog
        expense={selectedExpense}
        open={showApprove}
        onOpenChange={setShowApprove}
        onSuccess={() => { fetchData(); fetchStats(); }}
      />
      <RejectDialog
        expense={selectedExpense}
        open={showReject}
        onOpenChange={setShowReject}
        onSuccess={() => { fetchData(); fetchStats(); }}
      />
    </div>
  );
}
