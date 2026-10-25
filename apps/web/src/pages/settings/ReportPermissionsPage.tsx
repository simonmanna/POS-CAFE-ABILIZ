/**
 * Report Permissions — per-role visibility for every report in the catalog.
 *
 * A role starts out "inheriting": it sees every report its permissions already
 * allow. Switching a role to a custom list stores an explicit allow-list; the
 * API still intersects it with the role's permissions, so this page can only
 * take reports away, never grant data the role has no permission for.
 */
import { useMemo, useState } from 'react';
import { BarChart3, Check, RotateCcw, Search, Shield } from 'lucide-react';
import type { ReportDescriptor } from '@erp/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  useReportCatalog,
  useRoleReportVisibility,
  useSetRoleReportVisibility,
  type RoleReportVisibility,
} from '@/features/reports/access-api';
import { tx } from '@/lib/i18n/tx';

type Draft = { reports: Set<string>; configured: boolean };

const groupReports = (reports: ReportDescriptor[]) => {
  const groups: { group: string; reports: ReportDescriptor[] }[] = [];
  for (const report of reports) {
    const bucket = groups.find((g) => g.group === report.group);
    if (bucket) bucket.reports.push(report);
    else groups.push({ group: report.group, reports: [report] });
  }
  return groups;
};

export function ReportPermissionsPage() {
  const { data: catalog = [] } = useReportCatalog();
  const { data: roles = [], isLoading } = useRoleReportVisibility();
  const save = useSetRoleReportVisibility();

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);

  const role: RoleReportVisibility | undefined = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? roles[0],
    [roles, selectedRoleId],
  );

  // The draft tracks edits for the selected role only; switching roles drops it.
  const current: Draft = draft ?? {
    reports: new Set(role?.reports ?? []),
    configured: role?.configured ?? false,
  };
  const available = useMemo(() => new Set(role?.available ?? []), [role]);

  const visibleGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? catalog.filter(
          (r) =>
            r.label.toLowerCase().includes(q) ||
            r.group.toLowerCase().includes(q) ||
            r.id.toLowerCase().includes(q),
        )
      : catalog;
    return groupReports(filtered);
  }, [catalog, search]);

  const selectRole = (id: string) => {
    setSelectedRoleId(id);
    setDraft(null);
  };

  const toggle = (reportId: string) => {
    const next = new Set(current.reports);
    if (next.has(reportId)) next.delete(reportId);
    else next.add(reportId);
    setDraft({ reports: next, configured: true });
  };

  const setGroup = (reports: ReportDescriptor[], on: boolean) => {
    const next = new Set(current.reports);
    for (const r of reports) {
      if (!available.has(r.id)) continue;
      if (on) next.add(r.id);
      else next.delete(r.id);
    }
    setDraft({ reports: next, configured: true });
  };

  const dirty = draft !== null;

  const onSave = () => {
    if (!role || !draft) return;
    save.mutate({ roleId: role.id, reports: [...draft.reports] }, { onSuccess: () => setDraft(null) });
  };

  const onReset = () => {
    if (!role) return;
    save.mutate({ roleId: role.id, reports: null }, { onSuccess: () => setDraft(null) });
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-muted-foreground" aria-hidden />
        <div>
          <h1 className="text-lg font-semibold">{tx('Report Permissions')}</h1>
          <p className="text-sm text-muted-foreground">
            {tx('Choose which reports each role can open. Reports a role has no permission for stay unavailable regardless of what is ticked here.')}
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="p-2">
          <div className="px-2 py-1 text-xs font-medium uppercase text-muted-foreground">{tx('Roles')}</div>
          {isLoading && <div className="p-3 text-sm text-muted-foreground">{tx('Loading…')}</div>}
          <ul className="space-y-1">
            {roles.map((r) => (
              <li key={r.id}>
                <button
                  className={
                    'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted ' +
                    (role?.id === r.id ? 'bg-muted font-medium' : '')
                  }
                  onClick={() => selectRole(r.id)}
                >
                  <span className="flex items-center gap-2">
                    <Shield className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                    {r.name}
                  </span>
                  <Badge variant={r.configured ? 'default' : 'secondary'}>
                    {r.configured ? String(r.reports.length) : 'default'}
                  </Badge>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground"
                aria-hidden
              />
              <Input
                className="w-64 pl-8"
                placeholder={tx('Search reports')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              {role && !role.configured && !dirty && (
                <span className="text-xs text-muted-foreground">
                  {tx('Inheriting from permissions — tick a box to customise.')}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!role || save.isPending || (!role.configured && !dirty)}
                onClick={onReset}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {tx('Reset to default')}
              </Button>
              <Button size="sm" disabled={!dirty || save.isPending} onClick={onSave}>
                <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                {tx('Save')}
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            {visibleGroups.map(({ group, reports }) => {
              const selectable = reports.filter((r) => available.has(r.id));
              const allOn = selectable.length > 0 && selectable.every((r) => current.reports.has(r.id));
              return (
                <div key={group}>
                  <div className="flex items-center justify-between border-b pb-1">
                    <h2 className="text-sm font-semibold">{group}</h2>
                    <button
                      className="text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                      disabled={selectable.length === 0}
                      onClick={() => setGroup(reports, !allOn)}
                    >
                      {allOn ? 'Clear all' : 'Select all'}
                    </button>
                  </div>
                  <div className="grid gap-x-6 gap-y-1 py-2 sm:grid-cols-2 xl:grid-cols-3">
                    {reports.map((report) => {
                      const permitted = available.has(report.id);
                      return (
                        <label
                          key={report.id}
                          className={
                            'flex items-start gap-2 rounded px-1 py-1 text-sm ' +
                            (permitted ? 'cursor-pointer hover:bg-muted' : 'opacity-50')
                          }
                          title={permitted ? report.description ?? report.route : `Role lacks ${report.permission}`}
                        >
                          <input
                            type="checkbox"
                            className="mt-1"
                            disabled={!permitted}
                            checked={permitted && current.reports.has(report.id)}
                            onChange={() => toggle(report.id)}
                          />
                          <span>
                            <span className="block">{report.label}</span>
                            <span className="block text-xs text-muted-foreground">{report.permission}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default ReportPermissionsPage;
