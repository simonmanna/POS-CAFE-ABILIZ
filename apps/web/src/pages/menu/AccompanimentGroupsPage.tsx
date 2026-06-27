// Menu — Accompaniment groups admin. Standalone groups (like ModifierGroup) that
// can be assigned to MenuItems. Each group has options with optional price impacts.
import { useState } from 'react';
import { Plus, Star, Check, Trash2, Pencil, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  useAllAccompanimentGroups,
  useCreateAccompanimentGroup,
  useUpdateAccompanimentGroup,
  useDeleteAccompanimentGroup,
  useCreateAccompanimentOption,
  useUpdateAccompanimentOption,
  useDeleteAccompanimentOption,
} from '@/pages/pos/pos-features-api';

const fmt = (n: number | string) => `UGX ${Number(n || 0).toLocaleString()}`;

export default function AccompanimentGroupsPage() {
  const { data: groups = [], isLoading } = useAllAccompanimentGroups();
  const createGroup = useCreateAccompanimentGroup();
  const updateGroup = useUpdateAccompanimentGroup();
  const deleteGroup = useDeleteAccompanimentGroup();
  const createOption = useCreateAccompanimentOption();
  const updateOption = useUpdateAccompanimentOption();
  const deleteOption = useDeleteAccompanimentOption();

  /* Create group dialog */
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newRequired, setNewRequired] = useState(false);
  const [newMax, setNewMax] = useState(1);

  /* Per-group inline state for adding options */
  const [addingOptFor, setAddingOptFor] = useState<string | null>(null);
  const [optName, setOptName] = useState('');
  const [optPrice, setOptPrice] = useState('');
  const [optDefault, setOptDefault] = useState(false);

  const removeGroup = async (id: string, name: string) => {
    if (!window.confirm(`Delete group "${name}" and all options?`)) return;
    try { await deleteGroup.mutateAsync(id); toast.success('Group deleted'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to delete'); }
  };
  const removeOption = async (id: string) => {
    try { await deleteOption.mutateAsync(id); toast.success('Option removed'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed to remove'); }
  };
  const renameGroup = async (id: string, current: string) => {
    const name = window.prompt('Rename group', current);
    if (!name?.trim()) return;
    try { await updateGroup.mutateAsync({ groupId: id, name: name.trim() }); toast.success('Renamed'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed'); }
  };
  const renameOption = async (id: string, current: string) => {
    const name = window.prompt('Option name', current);
    if (!name?.trim()) return;
    try { await updateOption.mutateAsync({ optionId: id, name: name.trim() }); toast.success('Updated'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed'); }
  };
  const toggleActive = async (id: string, current: boolean) => {
    try { await updateGroup.mutateAsync({ groupId: id, isActive: !current }); toast.success(current ? 'Disabled' : 'Enabled'); }
    catch (e: any) { toast.error(e?.response?.data?.message || 'Failed'); }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    try {
      await createGroup.mutateAsync({ name: newName.trim(), isRequired: newRequired, minSelect: newRequired ? 1 : 0, maxSelect: newMax });
      toast.success('Group created');
      setShowCreate(false);
      setNewName('');
      setNewRequired(false);
      setNewMax(1);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed'); }
  };

  const handleAddOption = async (groupId: string) => {
    if (!optName.trim()) return;
    try {
      await createOption.mutateAsync({ groupId, name: optName.trim(), priceImpact: Number(optPrice) || 0, isDefault: optDefault });
      toast.success('Option added');
      setAddingOptFor(null);
      setOptName('');
      setOptPrice('');
      setOptDefault(false);
    } catch (e: any) { toast.error(e?.response?.data?.message || 'Failed'); }
  };

  if (isLoading) return <div className="p-6 text-sm text-slate-500">Loading…</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Accompaniment Groups</h1>
          <p className="text-sm text-slate-500 mt-0.5">Side-dish groups that can be assigned to menu items</p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white">
          <Plus className="h-4 w-4 mr-1" /> New group
        </Button>
      </div>

      {groups.length === 0 ? (
        <div className="text-center py-12 text-slate-400">
          <p className="text-lg font-semibold">No accompaniment groups yet</p>
          <p className="text-sm mt-1">Create one to get started.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {groups.map((g) => (
            <div key={g.id} className={'rounded-xl border bg-white p-4 shadow-sm ' + (!g.isActive ? 'opacity-50' : '')}>
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-800">{g.name}</span>
                  <span className={'px-2 py-0.5 rounded-full text-[11px] font-semibold ' + (g.isRequired ? 'bg-rose-100 text-rose-700' : 'bg-slate-100 text-slate-600')}>
                    {g.isRequired ? 'Required' : 'Optional'}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 text-[11px] font-semibold">
                    {g.maxSelect === 1 ? 'Pick one' : `Up to ${g.maxSelect}`}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => renameGroup(g.id, g.name)} className="p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg hover:bg-slate-100" title="Rename"><Pencil className="h-4 w-4" /></button>
                  <button onClick={() => toggleActive(g.id, g.isActive)} className="p-1.5 text-slate-400 hover:text-amber-600 rounded-lg hover:bg-slate-100" title={g.isActive ? 'Disable' : 'Enable'}><X className="h-4 w-4" /></button>
                  <button onClick={() => removeGroup(g.id, g.name)} className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100" title="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>

              {/* Options */}
              <div className="flex flex-wrap gap-2 mb-3">
                {g.options.length === 0 && <span className="text-xs text-slate-400 italic">No options</span>}
                {g.options.map((o) => (
                  <span key={o.id} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-700">
                    {o.isDefault ? <Star className="h-3 w-3 text-amber-500" /> : null}
                    {o.name}
                    <span className="font-mono text-slate-500">{o.priceImpact === 0 ? '' : (o.priceImpact > 0 ? '+' : '') + fmt(o.priceImpact)}</span>
                    <button onClick={() => renameOption(o.id, o.name)} className="ml-0.5 text-slate-300 hover:text-indigo-600 font-bold leading-none" title="Rename">✎</button>
                    <button onClick={() => removeOption(o.id)} className="ml-0.5 text-slate-300 hover:text-rose-600 font-bold leading-none" title="Remove">×</button>
                  </span>
                ))}
              </div>

              {/* Add option inline */}
              {addingOptFor === g.id ? (
                <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-2">
                  <div className="flex-1 min-w-[120px]">
                    <Label className="text-[11px]">Option name</Label>
                    <Input value={optName} onChange={(e) => setOptName(e.target.value)} placeholder="e.g. Rice" autoFocus />
                  </div>
                  <div className="w-28">
                    <Label className="text-[11px]">+ Price</Label>
                    <Input type="number" value={optPrice} onChange={(e) => setOptPrice(e.target.value)} placeholder="0" />
                  </div>
                  <label className="flex items-center gap-1 text-xs font-semibold text-slate-600 h-10">
                    <input type="checkbox" checked={optDefault} onChange={(e) => setOptDefault(e.target.checked)} /> Default
                  </label>
                  <Button size="sm" style={{ background: '#16a34a' }}
                    onClick={() => handleAddOption(g.id)}
                    disabled={createOption.isPending}>
                    <Check className="h-4 w-4 mr-1" /> Add
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddingOptFor(null)}><X className="h-4 w-4" /></Button>
                </div>
              ) : (
                <button type="button" onClick={() => { setAddingOptFor(g.id); setOptName(''); setOptPrice(''); setOptDefault(false); }}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 inline-flex items-center gap-1">
                  <Plus className="h-3.5 w-3.5" /> Add option
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New Accompaniment Group</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Group name</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Side dish" autoFocus />
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm font-medium text-slate-700">
                <input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} /> Required
              </label>
              <div className="flex items-center gap-1.5">
                <Label className="text-sm whitespace-nowrap">Max select</Label>
                <Input type="number" min={1} className="w-20 h-9" value={newMax} onChange={(e) => setNewMax(Number(e.target.value))} />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || createGroup.isPending} className="bg-indigo-600 hover:bg-indigo-700 text-white">
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
