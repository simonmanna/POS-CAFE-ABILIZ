// M-C — Menu modifier admin. Create modifier groups (size, milk, extras) with
// single/multi + required + min/max, add priced options, and assign groups to
// products. Uses the existing /pos/modifiers endpoints.
import { useState } from 'react';
import { Plus, Tag, Star, Link2, Check, Trash2, Pencil, BarChart3, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  useModifierGroups,
  useCreateModifierGroup,
  useCreateModifier,
  useAssignModifierGroupToMenuItem,
  useUnassignModifierGroupFromMenuItem,
  useMenuItemBundle,
  useUpdateModifierGroup,
  useDeleteModifierGroup,
  useDeleteModifier,
  useModifierSalesReport,
} from '@/pages/pos/pos-features-api';
import { useMenuItems } from '@/features/menu/api';

const fmt = (n: number | string) => `UGX ${Number(n || 0).toLocaleString()}`;
const selectCls = 'w-full h-10 rounded-md border border-slate-200 bg-white px-3 text-sm';

export default function ModifiersPage() {
  const { data: groups = [] } = useModifierGroups();
  const createGroup = useCreateModifierGroup();
  const createModifier = useCreateModifier();
  const updateGroup = useUpdateModifierGroup();
  const deleteGroup = useDeleteModifierGroup();
  const deleteModifier = useDeleteModifier();
  const { data: report = [] } = useModifierSalesReport();

  const removeGroup = async (id: string, name: string) => {
    if (!window.confirm(`Delete group "${name}" and all its options?`)) return;
    try { await deleteGroup.mutateAsync(id); toast.success('Group deleted'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to delete'); }
  };
  const removeOption = async (id: string) => {
    try { await deleteModifier.mutateAsync(id); toast.success('Option removed'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to remove'); }
  };
  const renameGroup = async (id: string, current: string) => {
    const name = window.prompt('Rename group', current);
    if (!name || !name.trim() || name.trim() === current) return;
    try { await updateGroup.mutateAsync({ id, name: name.trim() }); toast.success('Group renamed'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to rename'); }
  };

  const toggleGroupType = async (id: string, current: 'ADD_ON' | 'MODIFIER') => {
    const next = current === 'ADD_ON' ? 'MODIFIER' : 'ADD_ON';
    const label = next === 'ADD_ON' ? 'Add-on' : 'Modifier';
    try { await updateGroup.mutateAsync({ id, groupType: next }); toast.success(`Type changed to ${label}`); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to change type'); }
  };

  // New-group dialog
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [gName, setGName] = useState('');
  const [gType, setGType] = useState<'single' | 'multi'>('single');
  const [gRequired, setGRequired] = useState(false);
  const [gMax, setGMax] = useState(2);
  const [gGroupType, setGGroupType] = useState<'ADD_ON' | 'MODIFIER'>('ADD_ON');

  // Inline add-option (per group)
  const [optFor, setOptFor] = useState<string | null>(null);
  const [optName, setOptName] = useState('');
  const [optPrice, setOptPrice] = useState('');
  const [optDefault, setOptDefault] = useState(false);

  // Assign to menu item
  const [assignMenuItem, setAssignMenuItem] = useState('');
  const [assignMenuItemGroup, setAssignMenuItemGroup] = useState('');
  const { data: menuItemBundle } = useMenuItemBundle(assignMenuItem || null);
  const assignToMenuItem = useAssignModifierGroupToMenuItem();
  const unassignFromMenuItem = useUnassignModifierGroupFromMenuItem();
  const { data: menuItems = [] } = useMenuItems();

  const submitGroup = async () => {
    if (!gName.trim()) { toast.error('Group name is required'); return; }
    const maxSelect = gType === 'single' ? 1 : Math.max(1, Number(gMax) || 1);
    const minSelect = gRequired ? 1 : 0;
    try {
      await createGroup.mutateAsync({ name: gName.trim(), groupType: gGroupType, minSelect, maxSelect });
      toast.success(`Group "${gName.trim()}" created`);
      setShowNewGroup(false); setGName(''); setGType('single'); setGRequired(false); setGMax(2); setGGroupType('ADD_ON');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to create group'); }
  };

  const submitOption = async (groupId: string) => {
    if (!optName.trim()) { toast.error('Option name is required'); return; }
    try {
      await createModifier.mutateAsync({ groupId, name: optName.trim(), priceDelta: Number(optPrice) || 0, isDefault: optDefault });
      toast.success('Option added');
      setOptFor(null); setOptName(''); setOptPrice(''); setOptDefault(false);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to add option'); }
  };

  const submitAssignToMenuItem = async () => {
    if (!assignMenuItem || !assignMenuItemGroup) { toast.error('Pick a menu item and a group'); return; }
    try {
      await assignToMenuItem.mutateAsync({ menuItemId: assignMenuItem, modifierGroupId: assignMenuItemGroup });
      toast.success('Group assigned to menu item');
      setAssignMenuItemGroup('');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to assign'); }
  };

  const handleUnassignFromMenuItem = async (menuItemId: string, modifierGroupId: string, name: string) => {
    if (!window.confirm(`Remove "${name}" from this menu item?`)) return;
    try {
      await unassignFromMenuItem.mutateAsync({ menuItemId, modifierGroupId });
      toast.success('Group removed');
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to remove'); }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Menu Modifiers &amp; Add-ons</h1>
          <p className="text-sm text-slate-500">Configure size / milk / extras groups and assign them to menu items.</p>
        </div>
        <Button onClick={() => setShowNewGroup(true)} style={{ background: '#4f46e5' }}>
          <Plus className="h-4 w-4 mr-1" /> New Group
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Groups */}
        <div className="lg:col-span-2 space-y-3">
          {groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-slate-400">
              <Tag className="h-8 w-8 mx-auto mb-2 opacity-50" />
              No modifier groups yet. Create one (e.g. "Size", "Milk", "Extras").
            </div>
          ) : null}

          {groups.map((g) => (
            <div key={g.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="font-bold text-slate-800">{g.name}</div>
                  <span className={'text-[10px] font-bold px-1.5 py-0.5 rounded ' + (g.groupType === 'ADD_ON' ? 'bg-emerald-100 text-emerald-700' : 'bg-violet-100 text-violet-700')}>
                    {g.groupType === 'ADD_ON' ? 'Add-on' : 'Modifier'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={'px-2 py-0.5 rounded-full font-semibold ' + (g.minSelect > 0 ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600')}>
                    {g.minSelect > 0 ? 'Required' : 'Optional'}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 font-semibold">
                    {g.maxSelect === 1 ? 'Single choice' : `Up to ${g.maxSelect}`}
                  </span>
                  <button onClick={() => toggleGroupType(g.id, g.groupType)} className="p-1 text-slate-400 hover:text-amber-600" title="Toggle group type">
                    <Settings2 className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => renameGroup(g.id, g.name)} className="p-1 text-slate-400 hover:text-indigo-600" title="Rename group">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => removeGroup(g.id, g.name)} className="p-1 text-slate-400 hover:text-rose-600" title="Delete group">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 mb-2">
                {g.modifiers.length === 0 ? (
                  <span className="text-xs text-slate-400 italic">No options yet</span>
                ) : null}
                {g.modifiers.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">
                    {m.isDefault ? <Star className="h-3 w-3 text-amber-500" /> : null}
                    {m.name}
                    <span className="font-mono text-slate-500">{m.priceDelta === 0 ? '' : (m.priceDelta > 0 ? '+' : '') + fmt(m.priceDelta)}</span>
                    <button onClick={() => removeOption(m.id)} className="ml-0.5 text-slate-300 hover:text-rose-600 font-bold leading-none" title="Remove option">×</button>
                  </span>
                ))}
              </div>

              {optFor === g.id ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
                  <div className="flex-1 min-w-[120px]">
                    <Label className="text-[11px]">Option name</Label>
                    <Input value={optName} onChange={(e) => setOptName(e.target.value)} placeholder="e.g. Large" autoFocus />
                  </div>
                  <div className="w-28">
                    <Label className="text-[11px]">+ Price</Label>
                    <Input type="number" value={optPrice} onChange={(e) => setOptPrice(e.target.value)} placeholder="0" />
                  </div>
                  <label className="flex items-center gap-1 text-xs font-semibold text-slate-600 h-10">
                    <input type="checkbox" checked={optDefault} onChange={(e) => setOptDefault(e.target.checked)} /> Default
                  </label>
                  <Button onClick={() => submitOption(g.id)} disabled={createModifier.isPending} style={{ background: '#16a34a' }}>
                    <Check className="h-4 w-4 mr-1" /> Add
                  </Button>
                  <Button variant="ghost" onClick={() => { setOptFor(null); setOptName(''); setOptPrice(''); setOptDefault(false); }}>Cancel</Button>
                </div>
              ) : (
                <button type="button" onClick={() => setOptFor(g.id)} className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1">
                  <Plus className="h-3.5 w-3.5" /> Add option
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Assign modifier groups to sellable menu items */}
        <div className="space-y-3">
          {/* Assign to menu items */}
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="font-bold text-slate-800 mb-2 flex items-center gap-1.5">
              <Link2 className="h-4 w-4" /> Assign to menu item
            </div>
            <div className="space-y-2">
              <div>
                <Label className="text-[11px]">Menu item</Label>
                <select className={selectCls} value={assignMenuItem} onChange={(e) => setAssignMenuItem(e.target.value)}>
                  <option value="">Select a menu item…</option>
                  {(menuItems as any[]).filter((m: any) => m.isAvailable).map((m: any) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-[11px]">Modifier group</Label>
                <select className={selectCls} value={assignMenuItemGroup} onChange={(e) => setAssignMenuItemGroup(e.target.value)}>
                  <option value="">Select a group…</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </div>
              <Button onClick={submitAssignToMenuItem} disabled={assignToMenuItem.isPending} className="w-full" style={{ background: '#4f46e5' }}>
                <Link2 className="h-4 w-4 mr-1" /> Assign
              </Button>
            </div>

            {assignMenuItem && menuItemBundle ? (
              <div className="mt-3 border-t border-slate-100 pt-2">
                <div className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-1">Groups on this menu item</div>
                {menuItemBundle.groups.length === 0 ? (
                  <div className="text-xs text-slate-400 italic">None assigned yet</div>
                ) : (
                  <div className="space-y-1">
                    {menuItemBundle.groups.map((g) => (
                      <div key={g.id} className="text-xs text-slate-700 flex items-center justify-between">
                        <span>{g.name}</span>
                        <div className="flex items-center gap-1">
                          <span className="text-slate-400">{g.modifiers.length} option{g.modifiers.length !== 1 ? 's' : ''}</span>
                          <button onClick={() => handleUnassignFromMenuItem(assignMenuItem, g.id, g.name)} className="text-slate-300 hover:text-rose-600 font-bold leading-none" title="Remove group">×</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* M-F: modifier sales report */}
      <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
        <div className="font-bold text-slate-800 mb-3 flex items-center gap-1.5">
          <BarChart3 className="h-4 w-4" /> Modifier sales
        </div>
        {report.length === 0 ? (
          <div className="text-sm text-slate-400 italic">
            No modifier sales yet — needs the DocumentLineModifier migration applied and some sales made.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500 border-b">
                <th className="py-1">Modifier</th>
                <th className="py-1 text-right">Times sold</th>
                <th className="py-1 text-right">Add-on revenue</th>
              </tr>
            </thead>
            <tbody>
              {report.map((r) => (
                <tr key={r.name} className="border-b border-slate-100">
                  <td className="py-1.5 font-semibold text-slate-700">{r.name}</td>
                  <td className="py-1.5 text-right font-mono">{r.count}</td>
                  <td className="py-1.5 text-right font-mono">{fmt(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* New group dialog */}
      <Dialog open={showNewGroup} onOpenChange={(o) => !o && setShowNewGroup(false)}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>New modifier group</DialogTitle>
            <DialogDescription>e.g. Size, Milk type, Sugar level, Extras.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Group name</Label>
              <Input value={gName} onChange={(e) => setGName(e.target.value)} placeholder="e.g. Size" autoFocus />
            </div>
            <div>
              <Label>Group type</Label>
              <Select value={gGroupType} onValueChange={(v) => setGGroupType(v as 'ADD_ON' | 'MODIFIER')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ADD_ON">Add-on (product upsell)</SelectItem>
                  <SelectItem value="MODIFIER">Modifier (prep instruction)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Selection type</Label>
              <select className={selectCls} value={gType} onChange={(e) => setGType(e.target.value as 'single' | 'multi')}>
                <option value="single">Single choice (radio)</option>
                <option value="multi">Multiple choice (checkbox)</option>
              </select>
            </div>
            {gType === 'multi' ? (
              <div>
                <Label>Max selections</Label>
                <Input type="number" value={gMax} onChange={(e) => setGMax(Number(e.target.value))} min={1} />
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <input type="checkbox" checked={gRequired} onChange={(e) => setGRequired(e.target.checked)} />
              Required (customer must choose at least one)
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNewGroup(false)}>Cancel</Button>
            <Button onClick={submitGroup} disabled={createGroup.isPending} style={{ background: '#4f46e5' }}>Create group</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
