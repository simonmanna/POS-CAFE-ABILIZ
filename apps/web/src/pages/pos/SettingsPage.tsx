import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { usePosSettings, useUpdatePosSettings } from '@/features/pos/api';
import { notify } from '@/lib/notify';

const POS_MODES = [
  { value: 'cafe', label: 'Cafe / Restaurant', desc: 'Menu items with variants, accompaniments, modifiers, tables, KDS, and KOT printing.' },
  { value: 'retail', label: 'Retail', desc: 'Direct product selling with barcode scanning, no tables, no kitchen.' },
  { value: 'rental', label: 'Rental', desc: 'Hire-out of serialized assets: agreements, deposits, returns, inspection and settlement.' },
];

export function PosSettingsPage() {
  const { data: settings, isLoading } = usePosSettings();
  const update = useUpdatePosSettings();
  const [posMode, setPosMode] = useState('cafe');
  const [sharedDrawer, setSharedDrawer] = useState(false);

  useEffect(() => {
    if (settings?.posMode) setPosMode(settings.posMode);
    setSharedDrawer(settings?.sharedDrawer === true);
  }, [settings]);

  const handleSave = async () => {
    try {
      await update.mutateAsync({ posMode, sharedDrawer });
      notify.success('POS settings saved');
    } catch {
      notify.error('Failed to save POS settings');
    }
  };

  const current = POS_MODES.find((m) => m.value === posMode);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">POS Settings</h1>
        <p className="text-sm text-muted-foreground">Configure how your POS terminal behaves.</p>
      </div>

      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">POS Mode</CardTitle>
            <CardDescription>
              Choose between Cafe/Restaurant mode (menu items, tables, kitchen) or Retail mode (direct product selling, no tables).
              This affects the POS terminal layout and available features.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Select value={posMode} onValueChange={setPosMode}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {POS_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {current && (
              <p className="text-sm text-muted-foreground">{current.desc}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Register &amp; drawer</CardTitle>
            <CardDescription>
              One till shared by several cashiers. When off, a collection can only
              land in the drawer of the cashier who opened it — complete a shift
              handover before another cashier sells on it. When on, any cashier may
              settle into the open drawer; every sale still records who settled it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="rounded"
                checked={sharedDrawer}
                onChange={(e) => setSharedDrawer(e.target.checked)}
              />
              Allow other cashiers on this register (shared drawer)
            </label>
          </CardContent>
        </Card>
        <Button onClick={handleSave} disabled={update.isPending}>
          {update.isPending ? 'Saving...' : 'Save'}
        </Button>
        </>
      )}
    </div>
  );
}
