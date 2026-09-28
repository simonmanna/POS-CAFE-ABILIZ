import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Loader2, SlidersHorizontal, Landmark, Network } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { usePosSettings, useUpdatePosSettings } from '@/features/pos/api';
import { notify } from '@/lib/notify';

/**
 * Registry-driven configuration, rendered from GET /settings/effective. Each row
 * shows the effective org-level value and the level it resolved from; editing
 * writes the org-level override via PUT /settings/:key. Warehouse/category/product
 * overrides use the same endpoint with a scopeType/scopeId (added in later UI work).
 */

type SettingType = 'bool' | 'enum' | 'string' | 'number' | 'json';

interface EffectiveSetting {
  key: string;
  label: string;
  description: string | null;
  type: SettingType;
  enumValues: string[] | null;
  cascades: boolean;
  scopeLevels: string[];
  value: unknown;
  source: string;
  scopeId: string | null;
}

function SettingRow({
  s,
  value,
  onChange,
}: {
  s: EffectiveSetting;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{s.label}</span>
          {s.source === 'default' && (
            <Badge variant="outline" className="text-[10px]">default</Badge>
          )}
          {s.cascades && (
            <Badge variant="secondary" className="text-[10px]">cascades</Badge>
          )}
        </div>
        {s.description && <p className="text-xs text-muted-foreground">{s.description}</p>}
      </div>
      <div className="w-full shrink-0 sm:w-64">
        {s.type === 'bool' ? (
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="rounded"
              checked={!!value}
              onChange={(e) => onChange(e.target.checked)}
            />
            {value ? 'Enabled' : 'Disabled'}
          </label>
        ) : s.type === 'enum' ? (
          <Select value={value == null ? '' : String(value)} onValueChange={onChange}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {s.enumValues?.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            type={s.type === 'number' ? 'number' : 'text'}
            value={value == null ? '' : String(value)}
            onChange={(e) =>
              onChange(s.type === 'number' ? Number(e.target.value) : e.target.value)
            }
          />
        )}
      </div>
    </div>
  );
}

export function GroupCard({
  group,
  title,
  description,
  icon,
}: {
  group: 'inventory' | 'accounting' | 'purchasing';
  title: string;
  description: string;
  icon: ReactNode;
}) {
  const qc = useQueryClient();
  const q = useQuery<EffectiveSetting[]>({
    queryKey: ['settings-effective', group],
    queryFn: async () =>
      (await api.get<EffectiveSetting[]>(`/settings/effective?group=${group}`)).data,
  });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (q.data) {
      setValues(Object.fromEntries(q.data.map((s) => [s.key, s.value])));
      setDirty(new Set());
    }
  }, [q.data]);

  const save = useMutation({
    mutationFn: async () => {
      for (const key of dirty) {
        await api.put(`/settings/${key}`, { value: values[key] });
      }
    },
    onSuccess: () => {
      notify.success(`${title} saved`);
      qc.invalidateQueries({ queryKey: ['settings-effective', group] });
    },
    onError: (e: any) => notify.error(e?.response?.data?.message ?? 'Failed'),
  });

  const setVal = (key: string, v: unknown) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setDirty((prev) => new Set(prev).add(key));
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (q.data?.length ?? 0) === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No configurable settings here yet.</p>
        ) : (
          <div className="divide-y">
            {q.data?.map((s) => (
              <SettingRow key={s.key} s={s} value={values[s.key]} onChange={(v) => setVal(s.key, v)} />
            ))}
            <div className="pt-3">
              <Button onClick={() => save.mutate()} disabled={dirty.size === 0 || save.isPending}>
                {save.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                Save{dirty.size > 0 ? ` (${dirty.size})` : ''}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const CONNECTION_MODES = {
  offline: 'Everything (database, services, POS) runs on this PC. The POS never checks for a network or internet connection and shows no online icon.',
  online: 'The POS monitors its connection to the server, shows an online/offline icon on the selling terminal, and syncs queued sales when the connection returns.',
} as const;

type ConnectionMode = keyof typeof CONNECTION_MODES;

/** Online/offline system mode. Stored in the POS module config, served to the
 *  terminal by GET /pos/settings (cashiers can read it; setting:read not needed). */
function ConnectionModeCard() {
  const { data, isLoading } = usePosSettings();
  const update = useUpdatePosSettings();
  const [mode, setMode] = useState<ConnectionMode>('offline');

  useEffect(() => {
    if (data) setMode(data.connectionMode === 'online' ? 'online' : 'offline');
  }, [data]);

  const saved: ConnectionMode = data?.connectionMode === 'online' ? 'online' : 'offline';

  const save = async () => {
    try {
      await update.mutateAsync({ connectionMode: mode });
      notify.success(`System set to ${mode}`);
    } catch (e: any) {
      notify.error(e?.response?.data?.message ?? 'Failed to save connection mode');
    }
  };

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <div>
            <CardTitle>System Connection Mode</CardTitle>
            <CardDescription>Is this system online (networked) or offline (runs only on this PC)?</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-muted-foreground sm:max-w-md">{CONNECTION_MODES[mode]}</p>
              <div className="w-full shrink-0 sm:w-64">
                <Select value={mode} onValueChange={(v) => setMode(v as ConnectionMode)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="offline">Offline (this PC only)</SelectItem>
                    <SelectItem value="online">Online (check connection)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button onClick={save} disabled={mode === saved || update.isPending}>
              {update.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function SystemConfigSection() {
  return (
    <>
      <ConnectionModeCard />
      <GroupCard
        group="inventory"
        title="Inventory Configuration"
        description="Org-level defaults. Cascading settings can also be overridden per warehouse, category, or product."
        icon={<SlidersHorizontal className="h-4 w-4 text-muted-foreground" />}
      />
      <GroupCard
        group="accounting"
        title="Accounting Configuration"
        description="Organization-wide accounting behaviour."
        icon={<Landmark className="h-4 w-4 text-muted-foreground" />}
      />
    </>
  );
}
