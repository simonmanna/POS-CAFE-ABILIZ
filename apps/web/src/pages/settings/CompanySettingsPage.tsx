import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Loader2, Landmark, BookOpen, ArrowLeftRight, Coins, Boxes, UserPlus, KeyRound, Mail, Check, Building2, Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';
import { useAuthStore } from '@/stores/auth.store';
import { SystemConfigSection } from './system-config';

// ── Types ────────────────────────────────────────────────────────────────────

interface ReferenceItem {
  id: string;
  code: string;
  name: string;
  accountType?: string;
}

interface TaxItem {
  id: string;
  name: string;
  code: string;
  rate: number;
}

interface CurrencyItem {
  code: string;
  name: string;
  symbol: string;
}

interface CompanySettingsData {
  incomeAccountId: string | null;
  expenseAccountId: string | null;
  defaultSalesTaxId: string | null;
  exchangeDifferenceJournalId: string | null;
  exchangeGainAccountId: string | null;
  exchangeLossAccountId: string | null;
  productIncomeAccountId: string | null;
  productExpenseAccountId: string | null;
  allCurrencyCodes: string[];
  costingMethod: string | null;
  baseCurrencyCode: string | null;
  fiscalYearStartMonth: number | null;
  _references: {
    accounts: ReferenceItem[];
    journals: ReferenceItem[];
    taxes: TaxItem[];
    currencies: CurrencyItem[];
  };
}

interface OrgDetails {
  id: string;
  code: string;
  name: string;
  timezone: string;
  currencyCode: string;
}

interface OrgUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  isActive: boolean;
  roles: { id: string; name: string }[];
}

interface InventoryDefaults {
  costingMethod: string | null;
  pickingStrategy: string | null;
  batchTracking: boolean;
  expiryTracking: boolean;
  serialTracking: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COSTING_METHODS = [
  { value: 'AVCO', label: 'Average Cost (AVCO)' },
  { value: 'FIFO', label: 'First-In, First-Out (FIFO)' },
  { value: 'STANDARD', label: 'Standard Cost' },
  { value: 'SPECIFIC', label: 'Specific Identification' },
] as const;

const PICKING_STRATEGIES = [
  { value: 'FEFO', label: 'FEFO — nearest expiry first' },
  { value: 'FIFO', label: 'FIFO — oldest receipt first' },
  { value: 'MANUAL', label: 'Manual batch selection' },
  { value: 'SERIAL', label: 'Serial selection' },
] as const;

const FISCAL_MONTHS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
] as const;

// ── Reusable field wrappers ──────────────────────────────────────────────────

function AccountField({ label, description, value, accounts, onChange }: {
  label: string;
  description: string;
  value: string | null;
  accounts: ReferenceItem[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <p className="text-xs text-muted-foreground">{description}</p>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Select account..." /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">— None —</SelectItem>
          {accounts.map((a) => (
            <SelectItem key={a.id} value={a.id}>{a.code} — {a.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function JournalField({ label, description, value, journals, onChange }: {
  label: string;
  description: string;
  value: string | null;
  journals: ReferenceItem[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <p className="text-xs text-muted-foreground">{description}</p>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger><SelectValue placeholder="Select journal..." /></SelectTrigger>
        <SelectContent>
          <SelectItem value="">— None —</SelectItem>
          {journals.map((j) => (
            <SelectItem key={j.id} value={j.id}>{j.code} — {j.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function CompanySettingsPage() {
  const qc = useQueryClient();
  const auth = useAuthStore();

  // -- Accounting settings state --
  const [incomeAccountId, setIncomeAccountId] = useState('');
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [costingMethod, setCostingMethod] = useState('');
  const [baseCurrencyCode, setBaseCurrencyCode] = useState('');
  const [defaultSalesTaxId, setDefaultSalesTaxId] = useState('');
  const [allCurrencyCodes, setAllCurrencyCodes] = useState<string[]>([]);
  const [exchangeDifferenceJournalId, setExchangeDifferenceJournalId] = useState('');
  const [exchangeGainAccountId, setExchangeGainAccountId] = useState('');
  const [exchangeLossAccountId, setExchangeLossAccountId] = useState('');
  const [productIncomeAccountId, setProductIncomeAccountId] = useState('');
  const [productExpenseAccountId, setProductExpenseAccountId] = useState('');
  const [fiscalYearStartMonth, setFiscalYearStartMonth] = useState<number>(1);

  // -- Org / users / inventory state --
  const [timezone, setTimezone] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirst, setInviteFirst] = useState('');
  const [inviteLast, setInviteLast] = useState('');
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');

  const [invCosting, setInvCosting] = useState('');
  const [invPicking, setInvPicking] = useState('FEFO');
  const [invBatch, setInvBatch] = useState(false);
  const [invExpiry, setInvExpiry] = useState(false);
  const [invSerial, setInvSerial] = useState(false);

  // -- Data queries --
  const companyQ = useQuery<CompanySettingsData>({
    queryKey: ['settings-company'],
    queryFn: async () => (await api.get<CompanySettingsData>('/settings/company')).data,
  });

  const org = useQuery<OrgDetails>({
    queryKey: ['organization-me'],
    queryFn: async () => (await api.get<OrgDetails>('/organizations/me')).data,
  });

  const users = useQuery<OrgUser[]>({
    queryKey: ['organization-users'],
    queryFn: async () => (await api.get<OrgUser[]>('/organizations/users')).data,
  });

  const invDefaults = useQuery<InventoryDefaults>({
    queryKey: ['inventory-defaults'],
    queryFn: async () => (await api.get<InventoryDefaults>('/settings/inventory-defaults')).data,
  });

  // -- Init form state from query data --
  useEffect(() => {
    const d = companyQ.data;
    if (d) {
      setIncomeAccountId(d.incomeAccountId ?? '');
      setExpenseAccountId(d.expenseAccountId ?? '');
      setCostingMethod(d.costingMethod ?? '');
      setBaseCurrencyCode(d.baseCurrencyCode ?? '');
      setDefaultSalesTaxId(d.defaultSalesTaxId ?? '');
      setAllCurrencyCodes(d.allCurrencyCodes ?? []);
      setExchangeDifferenceJournalId(d.exchangeDifferenceJournalId ?? '');
      setExchangeGainAccountId(d.exchangeGainAccountId ?? '');
      setExchangeLossAccountId(d.exchangeLossAccountId ?? '');
      setProductIncomeAccountId(d.productIncomeAccountId ?? '');
      setProductExpenseAccountId(d.productExpenseAccountId ?? '');
      setFiscalYearStartMonth(d.fiscalYearStartMonth ?? 1);
    }
  }, [companyQ.data]);

  useEffect(() => {
    if (org.data) setTimezone(org.data.timezone);
  }, [org.data]);

  useEffect(() => {
    const d = invDefaults.data;
    if (d) {
      setInvCosting(d.costingMethod ?? '');
      setInvPicking(d.pickingStrategy ?? 'FEFO');
      setInvBatch(!!d.batchTracking);
      setInvExpiry(!!d.expiryTracking);
      setInvSerial(!!d.serialTracking);
    }
  }, [invDefaults.data]);

  // -- Mutations --
  const saveAccounting = useMutation({
    mutationFn: async () => (await api.put('/settings/company', {
      incomeAccountId: incomeAccountId || undefined,
      expenseAccountId: expenseAccountId || undefined,
      costingMethod: costingMethod || undefined,
      baseCurrencyCode: baseCurrencyCode || undefined,
      defaultSalesTaxId: defaultSalesTaxId || undefined,
      allCurrencyCodes,
      exchangeDifferenceJournalId: exchangeDifferenceJournalId || undefined,
      exchangeGainAccountId: exchangeGainAccountId || undefined,
      exchangeLossAccountId: exchangeLossAccountId || undefined,
      productIncomeAccountId: productIncomeAccountId || undefined,
      productExpenseAccountId: productExpenseAccountId || undefined,
      fiscalYearStartMonth,
    })).data,
    onSuccess: (data: CompanySettingsData) => {
      notify.success('Accounting settings saved');
      const o = auth.organization;
      if (data.baseCurrencyCode && o) auth.setOrganization({ ...o, currencyCode: data.baseCurrencyCode });
      qc.invalidateQueries({ queryKey: ['settings-company'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  const updateOrg = useMutation({
    mutationFn: async () => (await api.patch('/organizations/me/settings', { timezone })).data,
    onSuccess: (data: OrgDetails) => {
      notify.success('Organization updated');
      const o = auth.organization;
      if (o) auth.setOrganization({ ...o, timezone: data.timezone });
      qc.invalidateQueries({ queryKey: ['organization-me'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  const saveInvDefaults = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = { batchTracking: invBatch, expiryTracking: invExpiry, serialTracking: invSerial };
      if (invCosting) payload.costingMethod = invCosting;
      if (invPicking) payload.pickingStrategy = invPicking;
      return (await api.put('/settings/inventory-defaults', payload)).data;
    },
    onSuccess: () => {
      notify.success('Inventory defaults saved');
      qc.invalidateQueries({ queryKey: ['inventory-defaults'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  const invite = useMutation({
    mutationFn: async () => (await api.post('/organizations/users/invite', {
      email: inviteEmail, firstName: inviteFirst, lastName: inviteLast || undefined,
    })).data,
    onSuccess: (data: any) => {
      notify.success('Invited', `Token: ${data.inviteToken?.slice(0, 12)}…`);
      setInviteOpen(false);
      setInviteEmail('');
      setInviteFirst('');
      setInviteLast('');
      qc.invalidateQueries({ queryKey: ['organization-users'] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  const deactivate = useMutation({
    mutationFn: async (id: string) => await api.patch(`/organizations/users/${id}/deactivate`),
    onSuccess: () => { notify.success('Deactivated'); qc.invalidateQueries({ queryKey: ['organization-users'] }); },
  });

  const changePwd = useMutation({
    mutationFn: async () => (await api.post('/auth/change-password', { currentPassword: oldPwd, newPassword: newPwd })).data,
    onSuccess: () => {
      notify.success('Password changed — please sign in again');
      setPasswordOpen(false);
      setOldPwd('');
      setNewPwd('');
      auth.clear();
      window.location.href = '/login';
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  // -- Derived --
  const accounts = companyQ.data?._references?.accounts ?? [];
  const journals = companyQ.data?._references?.journals ?? [];
  const taxes = companyQ.data?._references?.taxes ?? [];
  const currencies = companyQ.data?._references?.currencies ?? [];

  const toggleCurrency = (code: string) => {
    setAllCurrencyCodes((prev) => prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]);
  };

  const loading = companyQ.isLoading;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Company Settings</h1>
      <p className="text-sm text-muted-foreground">
        Configure financial defaults, organization-wide settings, inventory, and users.
      </p>

      {loading ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">

          {/* ── Base Configuration ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle>Base Configuration</CardTitle>
                  <CardDescription>Core financial settings that affect all transactions.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Base Currency</label>
                <p className="text-xs text-muted-foreground">The primary currency for this organization.</p>
                <Select value={baseCurrencyCode} onValueChange={setBaseCurrencyCode}>
                  <SelectTrigger><SelectValue placeholder="Select currency..." /></SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c.code} value={c.code}>{c.code} — {c.name} ({c.symbol})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Costing Method</label>
                <p className="text-xs text-muted-foreground">Default inventory costing method.</p>
                <Select value={costingMethod} onValueChange={setCostingMethod}>
                  <SelectTrigger><SelectValue placeholder="Select costing method..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— None —</SelectItem>
                    {COSTING_METHODS.map((m) => (<SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Fiscal Year Start</label>
                <p className="text-xs text-muted-foreground">First month of the fiscal year.</p>
                <Select value={String(fiscalYearStartMonth)} onValueChange={(v) => setFiscalYearStartMonth(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FISCAL_MONTHS.map((m) => (<SelectItem key={m.value} value={String(m.value)}>{m.label}</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Default Sales Tax</label>
                <p className="text-xs text-muted-foreground">Tax applied to sales transactions by default.</p>
                <Select value={defaultSalesTaxId} onValueChange={setDefaultSalesTaxId}>
                  <SelectTrigger><SelectValue placeholder="Select tax..." /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— None —</SelectItem>
                    {taxes.map((t) => (<SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%)</SelectItem>))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* ── Default Accounts ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle>Default Accounts</CardTitle>
                  <CardDescription>Primary accounts used by the posting engine.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <AccountField label="Income Account" description="Default account for income/revenue transactions." value={incomeAccountId} accounts={accounts} onChange={setIncomeAccountId} />
              <AccountField label="Expense Account" description="Default account for expense transactions." value={expenseAccountId} accounts={accounts} onChange={setExpenseAccountId} />
              <AccountField label="Product Income Account" description="Default income account for product sales." value={productIncomeAccountId} accounts={accounts} onChange={setProductIncomeAccountId} />
              <AccountField label="Product Expense Account" description="Default expense account for product cost of goods." value={productExpenseAccountId} accounts={accounts} onChange={setProductExpenseAccountId} />
            </CardContent>
          </Card>

          {/* ── Exchange Differences ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle>Exchange Differences</CardTitle>
                  <CardDescription>Journal and accounts for FX revaluation entries.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <JournalField label="Exchange Difference Journal" description="Journal used for recording exchange rate gain/loss adjustments." value={exchangeDifferenceJournalId} journals={journals} onChange={setExchangeDifferenceJournalId} />
              <AccountField label="Exchange Gain Account" description="Account credited for unrealized/realized exchange gains." value={exchangeGainAccountId} accounts={accounts} onChange={setExchangeGainAccountId} />
              <AccountField label="Exchange Loss Account" description="Account debited for unrealized/realized exchange losses." value={exchangeLossAccountId} accounts={accounts} onChange={setExchangeLossAccountId} />
            </CardContent>
          </Card>

          {/* ── Currencies ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Coins className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle>Enabled Currencies</CardTitle>
                  <CardDescription>Currencies available for transactions.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <p className="mb-3 text-xs text-muted-foreground">Base currency is always enabled.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {currencies.map((c) => {
                  const isBase = c.code === baseCurrencyCode;
                  const enabled = allCurrencyCodes.includes(c.code) || isBase;
                  return (
                    <label key={c.code} className={`flex cursor-pointer items-center gap-2 rounded-lg border p-2.5 text-sm transition-colors ${isBase ? 'border-primary/30 bg-primary/5' : enabled ? 'border-primary' : 'border-muted hover:bg-muted/50'}`}>
                      <input type="checkbox" className="rounded" checked={enabled} disabled={isBase} onChange={() => toggleCurrency(c.code)} />
                      <span className="font-medium">{c.code}</span>
                      <span className="text-xs text-muted-foreground">{c.symbol}</span>
                    </label>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ── Accounting Save ── */}
          <div className="lg:col-span-2">
            <Button onClick={() => saveAccounting.mutate()} disabled={saveAccounting.isPending || loading}>
              {saveAccounting.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Accounting Settings
            </Button>
          </div>

          {/* ── Organization ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle>Organization</CardTitle>
                  <CardDescription>Tenant-wide settings.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-xs text-muted-foreground rounded-lg bg-muted/30 p-2.5 mb-2">
                Company name, logo, and features managed in{' '}
                <a href="/settings/developer" className="underline">Developer Company Settings</a>.
              </div>
              {org.isLoading ? <Skeleton className="h-16 w-full" /> : (
                <>
                  <div>
                    <label className="text-sm font-medium">Timezone</label>
                    <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} className="mt-1" />
                  </div>
                  <Button onClick={() => updateOrg.mutate()} disabled={updateOrg.isPending}>
                    {updateOrg.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                    Save
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* ── My Account ── */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>My Account</CardTitle>
                  <CardDescription>{auth.user?.email}</CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPasswordOpen(true)}>
                  <KeyRound className="mr-2 h-3 w-3" />Change password
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Roles</span>
                <span>{auth.user?.roles?.join(', ') || '—'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Permissions</span>
                <span>{auth.permissions.length}</span>
              </div>
            </CardContent>
          </Card>

          {/* ── Inventory Defaults ── */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Boxes className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle>Inventory Defaults</CardTitle>
                  <CardDescription>Applied to new products that don't set their own tracking config.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {invDefaults.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Default costing method</label>
                    <Select value={invCosting} onValueChange={setInvCosting}>
                      <SelectTrigger><SelectValue placeholder="System default (AVCO)" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">System default (AVCO)</SelectItem>
                        {COSTING_METHODS.map((m) => (<SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium">Default picking strategy</label>
                    <Select value={invPicking} onValueChange={setInvPicking}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PICKING_STRATEGIES.map((s) => (<SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2 flex flex-wrap gap-6">
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" className="rounded" checked={invBatch} onChange={(e) => { setInvBatch(e.target.checked); if (!e.target.checked) setInvExpiry(false); }} /> Batch tracking
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" className="rounded" checked={invExpiry} onChange={(e) => { setInvExpiry(e.target.checked); if (e.target.checked) setInvBatch(true); }} /> Expiry tracking
                    </label>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" className="rounded" checked={invSerial} onChange={(e) => setInvSerial(e.target.checked)} /> Serial tracking
                    </label>
                  </div>
                  <div>
                    <Button onClick={() => saveInvDefaults.mutate()} disabled={saveInvDefaults.isPending}>
                      {saveInvDefaults.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                      Save defaults
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Registry-driven system config ── */}
          <SystemConfigSection />

          {/* ── Users ── */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <CardTitle>Users</CardTitle>
                    <CardDescription>Manage who has access to this organization</CardDescription>
                  </div>
                </div>
                <Button size="sm" onClick={() => setInviteOpen(true)}>
                  <UserPlus className="mr-2 h-3 w-3" />Invite
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {users.isLoading && <Skeleton className="h-24 w-full" />}
              {users.data?.map((u) => (
                <div key={u.id} className="flex items-center justify-between border-b py-2 last:border-b-0">
                  <div>
                    <div className="font-medium">{u.firstName}</div>
                    <div className="text-xs text-muted-foreground">{u.email} · {u.roles.map((r) => r.name).join(', ') || 'no role'}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={u.isActive ? 'default' : 'outline'}>{u.isActive ? 'active' : 'inactive'}</Badge>
                    {u.isActive && u.id !== auth.user?.id && (
                      <Button size="sm" variant="ghost" onClick={() => deactivate.mutate(u.id)}>Deactivate</Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Invite user</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Email</label>
              <Input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} className="mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-sm font-medium">First name</label>
                <Input value={inviteFirst} onChange={(e) => setInviteFirst(e.target.value)} className="mt-1" />
              </div>
              <div>
                <label className="text-sm font-medium">Last name</label>
                <Input value={inviteLast} onChange={(e) => setInviteLast(e.target.value)} className="mt-1" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button onClick={() => invite.mutate()} disabled={!inviteEmail || !inviteFirst || invite.isPending}>
              <Mail className="mr-2 h-4 w-4" />Send invite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change password dialog */}
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Change password</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Current password</label>
              <Input type="password" value={oldPwd} onChange={(e) => setOldPwd(e.target.value)} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">New password (min 8 chars)</label>
              <Input type="password" value={newPwd} onChange={(e) => setNewPwd(e.target.value)} className="mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPasswordOpen(false)}>Cancel</Button>
            <Button onClick={() => changePwd.mutate()} disabled={!oldPwd || newPwd.length < 8 || changePwd.isPending}>
              <Check className="mr-2 h-4 w-4" />Change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
