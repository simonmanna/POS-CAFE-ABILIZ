import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Power, PowerOff, Boxes } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { notify } from '@/lib/notify';

interface OrgModule {
  id: string;
  moduleName: string;
  isActive: boolean;
  config: Record<string, unknown>;
  enabledAt: string;
  disabledAt: string | null;
}

const VERTICALS: { name: string; label: string; description: string }[] = [
  { name: 'pos', label: 'Retail POS', description: 'Point-of-sale with barcode, fast checkout, EOD Z-report' },
  { name: 'restaurant', label: 'Restaurant', description: 'Tables, KDS, recipes (BOM), course timing' },
  { name: 'school', label: 'School ERP', description: 'Students, enrollment, fee schedules, term invoicing' },
  { name: 'hospital', label: 'Hospital ERP', description: 'Patients, visits, prescriptions, lab orders' },
  { name: 'hotel', label: 'Hotel Management', description: 'Rooms, reservations, folios, night audit' },
  { name: 'warehouse', label: 'Warehouse', description: 'Bin locations, pick lists, packing, receiving' },
  { name: 'manufacturing', label: 'Manufacturing', description: 'Bills of materials, work orders, MRP' },
  { name: 'church', label: 'Church / NGO', description: 'Members, donations, pledges, tithe receipts' },
  { name: 'property', label: 'Property Management', description: 'Leases, deposits, tenant ledger, maintenance' },
];

export function ModulesPage() {
  const qc = useQueryClient();
  const list = useQuery<OrgModule[]>({
    queryKey: ['org-modules'],
    queryFn: async () => (await api.get<OrgModule[]>('/feature-flags/modules')).data,
  });
  const enable = useMutation({
    mutationFn: async (name: string) => await api.post(`/feature-flags/modules/${name}/enable`, { config: {} }),
    onSuccess: () => {
      notify.success('Module enabled');
      qc.invalidateQueries({ queryKey: ['org-modules'] });
    },
  });
  const disable = useMutation({
    mutationFn: async (name: string) => await api.patch(`/feature-flags/modules/${name}/disable`),
    onSuccess: () => {
      notify.success('Module disabled');
      qc.invalidateQueries({ queryKey: ['org-modules'] });
    },
  });

  const byName = new Map((list.data ?? []).map((m) => [m.moduleName, m]));
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Modules</h1>
        <p className="text-sm text-muted-foreground">
          Enable vertical apps for your organization. Each module is a thin layer that uses the core ERP — your data stays in one place.
        </p>
      </div>
      {list.isLoading && <Skeleton className="h-32 w-full" />}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {VERTICALS.map((v) => {
          const m = byName.get(v.name);
          const active = !!m?.isActive;
          return (
            <Card key={v.name}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Boxes className="h-5 w-5 text-primary" />
                    <CardTitle className="text-base">{v.label}</CardTitle>
                  </div>
                  <Badge variant={active ? 'default' : 'outline'}>
                    {active ? 'enabled' : 'disabled'}
                  </Badge>
                </div>
                <CardDescription>{v.description}</CardDescription>
              </CardHeader>
              <CardContent>
                {active ? (
                  <Button size="sm" variant="outline" className="w-full" onClick={() => disable.mutate(v.name)}>
                    <PowerOff className="mr-2 h-3 w-3" />Disable
                  </Button>
                ) : (
                  <Button size="sm" className="w-full" onClick={() => enable.mutate(v.name)}>
                    <Power className="mr-2 h-3 w-3" />Enable
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
