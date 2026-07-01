import { useQuery } from '@tanstack/react-query';
import {
  ArrowUpRight, ArrowDownRight, Receipt, AlertCircle, Wallet, TrendingUp,
  Users, Package, Plus, FileText, HandCoins, ShoppingCart,
  Coffee, Sparkles, ArrowRight, Activity as ActivityIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { usePartnerStats } from '@/features/partners/api';
import { useProducts } from '@/features/products/api';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';

interface KPIData {
  openInvoices: number;
  overdueInvoices: number;
  cashPosition: number;
  revenueMonth: number;
  netIncomeMonth: number;
  arAging: { current: number; b30: number; b60: number; b90: number; over90: number };
}

interface ActivityItem {
  id: string;
  type: string;
  description: string;
  amount?: number;
  at: string;
  href: string;
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const org = useAuthStore((s) => s.organization);

  const partners = usePartnerStats();
  const products = useProducts({ page: 1, pageSize: 1 });
  const kpi = useQuery<KPIData>({
    queryKey: ['dashboard-kpi'],
    queryFn: async () => (await api.get<KPIData>('/reports/dashboard-kpi')).data,
    refetchInterval: 60_000,
  });
  const activity = useQuery<ActivityItem[]>({
    queryKey: ['dashboard-activity'],
    queryFn: async () => (await api.get<{ data: ActivityItem[] }>('/reports/dashboard-activity?limit=10')).data.data,
    refetchInterval: 30_000,
  });

  const cards = [
    {
      title: 'Open Invoices',
      value: kpi.data?.openInvoices,
      icon: Receipt,
      tone: 'from-blue-500 to-indigo-500',
      href: '/invoices',
    },
    {
      title: 'Overdue',
      value: kpi.data?.overdueInvoices,
      icon: AlertCircle,
      tone: 'from-rose-500 to-red-500',
      href: '/ar-aging',
    },
    {
      title: 'Cash Position',
      value: kpi.data?.cashPosition != null ? formatMoney(kpi.data.cashPosition, org?.currencyCode) : undefined,
      icon: Wallet,
      tone: 'from-emerald-500 to-teal-500',
      href: '/trial-balance',
    },
    {
      title: 'Revenue (Month)',
      value: kpi.data?.revenueMonth != null ? formatMoney(kpi.data.revenueMonth, org?.currencyCode) : undefined,
      icon: TrendingUp,
      tone: 'from-sky-500 to-blue-500',
      href: '/trial-balance',
    },
    {
      title: 'Net Income (Month)',
      value: kpi.data?.netIncomeMonth != null ? formatMoney(kpi.data.netIncomeMonth, org?.currencyCode) : undefined,
      icon: kpi.data && kpi.data.netIncomeMonth >= 0 ? ArrowUpRight : ArrowDownRight,
      tone: kpi.data && kpi.data.netIncomeMonth >= 0
        ? 'from-emerald-500 to-green-500'
        : 'from-orange-500 to-rose-500',
      href: '/trial-balance',
    },
  ];

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  return (
    <div className="page-wrap space-y-4">
      {/* ── Hero ── */}
      <div className="page-hero hero-strip">
        <div className="page-hero-inner">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md border border-white/30 text-2xl">
              ☕
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-white/70">
                {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
              </div>
              <div className="text-2xl md:text-3xl font-extrabold tracking-tight">
                {greeting}, {user?.firstName}
              </div>
              <div className="text-sm text-white/80 mt-0.5">{org?.name}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild className="bg-white text-blue-700 hover:bg-white/90 btn-shine shadow-lg">
              <Link to="/pos/terminal">
                <Coffee className="mr-2 h-4 w-4" /> Open Terminal
              </Link>
            </Button>
            <Button asChild variant="outline" className="border-white/30 bg-white/10 text-white hover:bg-white/20">
              <Link to="/tables">
                <Sparkles className="mr-2 h-4 w-4" /> Tables
              </Link>
            </Button>
          </div>
        </div>
      </div>

      {/* ── KPI grid ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {cards.map((card) => (
          <Link key={card.title} to={card.href} className="group">
            <div className="kpi-tile h-full">
              <div className="flex items-start justify-between mb-3">
                <div className="section-title">{card.title}</div>
                <div className={`flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br ${card.tone} text-white shadow-md`}>
                  <card.icon className="h-4 w-4" />
                </div>
              </div>
              {kpi.isLoading ? (
                <Skeleton className="h-8 w-24 shimmer" />
              ) : (
                <div className="text-2xl font-extrabold tracking-tight text-foreground">
                  {card.value ?? '—'}
                </div>
              )}
              <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                View details <ArrowRight className="h-3 w-3" />
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* ── Quick actions + Activity + Aging ── */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="lift-on-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Quick Actions
            </CardTitle>
            <CardDescription>Common tasks</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2">
            <Button asChild variant="outline" className="justify-start h-11 lift-on-hover">
              <Link to="/invoices/new"><Plus className="mr-2 h-4 w-4 text-primary" />New Invoice</Link>
            </Button>
            <Button asChild variant="outline" className="justify-start h-11 lift-on-hover">
              <Link to="/payments"><HandCoins className="mr-2 h-4 w-4 text-emerald-600" />Record Payment</Link>
            </Button>
            <Button asChild variant="outline" className="justify-start h-11 lift-on-hover">
              <Link to="/products"><Package className="mr-2 h-4 w-4 text-orange-600" />Add Product</Link>
            </Button>
            <Button asChild variant="outline" className="justify-start h-11 lift-on-hover">
              <Link to="/partners"><Users className="mr-2 h-4 w-4 text-blue-600" />Add Partner</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="lift-on-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-orange-600" /> AR Aging Snapshot
            </CardTitle>
            <CardDescription>Open receivables by age</CardDescription>
          </CardHeader>
          <CardContent>
            {kpi.data ? (
              <div className="space-y-2 text-sm">
                {[
                  ['Current', kpi.data.arAging.current, 'bg-emerald-500'],
                  ['1–30',    kpi.data.arAging.b30,     'bg-yellow-500'],
                  ['31–60',   kpi.data.arAging.b60,     'bg-orange-500'],
                  ['61–90',   kpi.data.arAging.b90,     'bg-red-500'],
                  ['90+',     kpi.data.arAging.over90,  'bg-red-700'],
                ].map(([label, value, color]) => (
                  <AgingBar key={label as string} label={label as string} value={value as number} color={color as string} currency={org?.currencyCode} />
                ))}
              </div>
            ) : (
              <Skeleton className="h-24 w-full shimmer" />
            )}
          </CardContent>
        </Card>

        <Card className="lift-on-hover">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ActivityIcon className="h-4 w-4 text-blue-600" /> Recent Activity
            </CardTitle>
            <CardDescription>Latest events in your org</CardDescription>
          </CardHeader>
          <CardContent>
            {activity.isLoading && <Skeleton className="h-32 w-full shimmer" />}
            {activity.data && activity.data.length === 0 && (
              <div className="empty-state">
                <ActivityIcon className="h-8 w-8 opacity-40" />
                <p className="text-sm">No activity yet.</p>
              </div>
            )}
            {activity.data && activity.data.length > 0 && (
              <ul className="space-y-2 text-sm scroll-thin max-h-72 overflow-y-auto pr-1">
                {activity.data.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 rounded-lg p-2 -mx-2 hover:bg-muted/60 transition-colors">
                    <div className="mt-0.5 h-7 w-7 rounded-md bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                      <FileText className="h-3.5 w-3.5" />
                    </div>
                    <Link to={a.href} className="flex-1 truncate hover:underline">
                      {a.description}
                    </Link>
                    {a.amount != null && (
                      <span className="shrink-0 text-xs tabular-nums font-bold text-foreground">
                        {formatMoney(a.amount, org?.currencyCode)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Master data counts ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SmallStat label="Partners"    value={partners.data?.total}      href="/partners" icon={Users} />
        <SmallStat label="Products"    value={products.data?.meta.total} href="/products" icon={Package} />
        <SmallStat label="Branches"    value={undefined}                 href="/settings" icon={ShoppingCart} />
        <SmallStat label="Active Users" value={undefined}                href="/settings" icon={Users} />
      </div>
    </div>
  );
}

function AgingBar({ label, value, color, currency }: { label: string; value: number; color: string; currency?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-xs text-muted-foreground font-semibold">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full ${color} transition-all duration-500`}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right text-xs tabular-nums font-semibold">{formatMoney(value, currency)}</span>
    </div>
  );
}

function SmallStat({ label, value, href, icon: Icon }: { label: string; value?: number; href: string; icon: typeof Users }) {
  return (
    <Link to={href} className="group">
      <Card className="lift-on-hover h-full">
        <CardContent className="flex items-center gap-3 p-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-500 text-white shadow-md group-hover:scale-105 transition-transform">
            <Icon className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <div className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">{label}</div>
            <div className="text-xl font-extrabold">{value ?? '—'}</div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        </CardContent>
      </Card>
    </Link>
  );
}