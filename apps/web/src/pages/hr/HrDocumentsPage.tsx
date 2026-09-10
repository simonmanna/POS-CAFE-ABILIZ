import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import {
  useCreateDocument,
  useDeleteDocument,
  useExpiringDocuments,
  useHrDocuments,
} from '@/features/hr/access-api';
import { useHrEmployees } from '@/features/hr/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { notify } from '@/lib/notify';
import { apiErrorMessage } from '@/lib/api-error';

const DOCUMENT_TYPES = [
  'CONTRACT',
  'OFFER_LETTER',
  'ID_DOCUMENT',
  'CERTIFICATE',
  'WORK_PERMIT',
  'TRAINING_CERTIFICATE',
  'DISCIPLINARY',
  'OTHER',
];

const date = (d: string | null) => (d ? new Date(d).toLocaleDateString('id-ID') : '—');

const daysUntil = (d: string | null) =>
  d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86400000) : null;

/**
 * Employee documents — contracts, IDs, work permits.
 *
 * Behind `hr:document` rather than `hr:read`: the staff directory and someone's
 * passport are not the same sensitivity. The expiry board is the reason this
 * screen earns its place — a lapsed work permit is a compliance problem that
 * nobody notices until it is already a problem.
 */
export function HrDocumentsPage() {
  const [open, setOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState('');
  const { data: documents } = useHrDocuments(employeeId ? { employeeId } : {});
  const { data: expiring } = useExpiringDocuments(60);
  const { data: employees } = useHrEmployees({ pageSize: 200 });
  const remove = useDeleteDocument();

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Employee documents</h1>
          <p className="text-sm text-muted-foreground">
            Contracts, identity documents, permits and certificates.
          </p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add document
        </Button>
      </div>

      {expiring?.rows?.length ? (
        <Card className="border-amber-200 bg-amber-50">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-amber-900">
              <AlertTriangle className="h-4 w-4" />
              Expiring within 60 days ({expiring.rows.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1.5 text-sm text-amber-900">
              {expiring.rows.slice(0, 8).map((d) => {
                const left = daysUntil(d.expiresAt);
                return (
                  <li key={d.id} className="flex items-center justify-between">
                    <span>
                      <Link
                        to={`/hr/employees/${d.employeeId}`}
                        className="font-medium hover:underline"
                      >
                        {d.employee?.firstName} {d.employee?.lastName ?? ''}
                      </Link>
                      <span className="text-amber-800"> — {d.title}</span>
                    </span>
                    <span>
                      {left !== null && left < 0 ? `expired ${-left}d ago` : `${left}d left`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">All documents</CardTitle>
          <select
            className="h-9 rounded-md border bg-background px-3 text-sm"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">All employees</option>
            {(employees?.rows ?? []).map((e: any) => (
              <option key={e.id} value={e.id}>
                {e.firstName} {e.lastName ?? ''} ({e.employeeCode})
              </option>
            ))}
          </select>
        </CardHeader>
        <CardContent>
          {documents?.rows?.length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2">Employee</th>
                  <th className="py-2">Title</th>
                  <th className="py-2">Type</th>
                  <th className="py-2">Number</th>
                  <th className="py-2">Issued</th>
                  <th className="py-2">Expires</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {documents.rows.map((d) => {
                  const left = daysUntil(d.expiresAt);
                  return (
                    <tr key={d.id} className="border-b last:border-0">
                      <td className="py-2">
                        <Link to={`/hr/employees/${d.employeeId}`} className="hover:underline">
                          {d.employee?.firstName} {d.employee?.lastName ?? ''}
                        </Link>
                      </td>
                      <td className="py-2">{d.title}</td>
                      <td className="py-2">
                        <Badge className="bg-muted text-muted-foreground">
                          {d.documentType.replace(/_/g, ' ')}
                        </Badge>
                      </td>
                      <td className="py-2">{d.documentNumber ?? '—'}</td>
                      <td className="py-2">{date(d.issuedAt)}</td>
                      <td
                        className={`py-2 ${
                          left !== null && left < 60 ? 'font-medium text-amber-700' : ''
                        }`}
                      >
                        {date(d.expiresAt)}
                      </td>
                      <td className="py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={remove.isPending}
                          onClick={async () => {
                            try {
                              await remove.mutateAsync(d.id);
                              notify.success('Document removed');
                            } catch (err) {
                              notify.error(apiErrorMessage(err, 'Could not remove the document'));
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">No documents recorded.</p>
          )}
        </CardContent>
      </Card>

      <AddDocumentDialog open={open} onOpenChange={setOpen} employees={employees?.rows ?? []} />
    </div>
  );
}

function AddDocumentDialog({
  open,
  onOpenChange,
  employees,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employees: any[];
}) {
  const create = useCreateDocument();
  const [form, setForm] = useState({
    employeeId: '',
    title: '',
    documentType: 'OTHER',
    documentNumber: '',
    issuedAt: '',
    expiresAt: '',
    notes: '',
  });
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a document</DialogTitle>
          <DialogDescription>
            Records the paperwork and its expiry. Upload the file itself from the employee&apos;s
            file area — this is the HR metadata.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Employee</Label>
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm"
              value={form.employeeId}
              onChange={(e) => set('employeeId', e.target.value)}
            >
              <option value="">Select…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName ?? ''} ({e.employeeCode})
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Type</Label>
              <select
                className="h-9 rounded-md border bg-background px-3 text-sm"
                value={form.documentType}
                onChange={(e) => set('documentType', e.target.value)}
              >
                {DOCUMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>Document number</Label>
              <Input
                value={form.documentNumber}
                onChange={(e) => set('documentNumber', e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Issued</Label>
              <Input
                type="date"
                value={form.issuedAt}
                onChange={(e) => set('issuedAt', e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Expires</Label>
              <Input
                type="date"
                value={form.expiresAt}
                onChange={(e) => set('expiresAt', e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={create.isPending || !form.employeeId || !form.title}
            onClick={async () => {
              try {
                await create.mutateAsync({
                  employeeId: form.employeeId,
                  title: form.title,
                  documentType: form.documentType,
                  documentNumber: form.documentNumber || undefined,
                  issuedAt: form.issuedAt || undefined,
                  expiresAt: form.expiresAt || undefined,
                  notes: form.notes || undefined,
                } as any);
                notify.success('Document added');
                onOpenChange(false);
              } catch (err) {
                notify.error(apiErrorMessage(err, 'Could not add the document'));
              }
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
