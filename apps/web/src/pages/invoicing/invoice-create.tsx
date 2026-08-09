import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { Plus, Section, StickyNote, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { money } from '@/lib/format';
import { usePartners } from '@/features/partners/api';
import { useProducts } from '@/features/products/api';
import {
  useCreateInvoice,
  usePostInvoice,
  type CreateInvoiceInput,
} from '@/features/invoicing/api';
import {
  usePaymentTerms,
  useFiscalPositions,
  useJournals,
  type PaymentTerm,
  type Journal,
} from '@/features/accounting/api';
import { useHrEmployees, type HrEmployee } from '@/features/hr/api';

const selectClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Local date → yyyy-mm-dd without timezone shifting. */
function fmtLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Client-side mirror of the backend's due-date computation (PaymentTermService). */
export function dueDateForTerm(term: PaymentTerm | undefined, issueDate: string): string {
  if (!term || term.method === 'immediate') return issueDate;
  const base = new Date(`${issueDate}T00:00:00`);
  if (term.method === 'end_of_following_month') {
    const eom = new Date(base.getFullYear(), base.getMonth() + 2, 0);
    eom.setDate(eom.getDate() + term.netDays);
    return fmtLocal(eom);
  }
  base.setDate(base.getDate() + term.netDays);
  return fmtLocal(base);
}

/** Display labels for the back-office invoice payment method (InvoicePaymentMode). */
const PAYMENT_MODE_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  mobile_money: 'Mobile Money',
  mixed: 'Mixed',
  credit: 'Credit (house account)',
};

const INCOTERM_OPTIONS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];

/** Odoo file-tab: bold uppercase micro-label row (matches invoice-detail). */
function TabBtn({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors ${
        active ? 'border-sky-600 text-sky-700' : 'border-transparent text-muted-foreground hover:text-sky-700'
      }`}
    >
      {children}
    </button>
  );
}

interface LineForm {
  /** 'product' (default) | 'section' | 'note' (Odoo-style display rows). */
  lineType?: string;
  productId?: string;
  description?: string;
  quantity: number;
  unitPrice?: number;
  discountPercent?: number;
}
interface FormValues {
  partnerId: string;
  issueDate: string;
  dueDate?: string;
  paymentTermId?: string;
  /* Other Info (Odoo-style sale attributes) */
  paymentMode?: string;
  fiscalPositionId?: string;
  invoicingJournalId?: string;
  salespersonId?: string;
  sourceDocument?: string;
  /* Delivery */
  deliveryDate?: string;
  deliveryAddress?: string;
  incoterm?: string;
  incotermLocation?: string;
  reference?: string;
  lines: LineForm[];
}

export function InvoiceCreatePage() {
  const navigate = useNavigate();
  const partners = usePartners({ page: 1, pageSize: 200 });
  const products = useProducts({ page: 1, pageSize: 200 });
  const { data: paymentTerms } = usePaymentTerms();
  const { data: fiscalPositions } = useFiscalPositions();
  const { data: journalsData } = useJournals();
  const { data: employeesData } = useHrEmployees({ pageSize: 200 });
  const createInvoice = useCreateInvoice();
  const postInvoice = usePostInvoice();

  const today = new Date().toISOString().slice(0, 10);
  const { register, control, handleSubmit, watch, setValue } = useForm<FormValues>({
    defaultValues: {
      partnerId: '',
      issueDate: today,
      dueDate: '',
      paymentTermId: '',
      paymentMode: '',
      fiscalPositionId: '',
      invoicingJournalId: '',
      salespersonId: '',
      sourceDocument: '',
      deliveryDate: '',
      deliveryAddress: '',
      incoterm: '',
      incotermLocation: '',
      reference: '',
      lines: [{ quantity: 1 }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'lines' });
  const lines = watch('lines');
  const productList = products.data?.data ?? [];
  const terms = paymentTerms?.filter((t) => t.isActive) ?? [];
  const fiscalPositionList = (fiscalPositions ?? []).filter((f) => f.isActive);
  const journalList = (journalsData?.data ?? []).filter(
    (j: Journal) => j.isActive && j.journalType === 'sales',
  );
  const salespersonList = (employeesData?.data ?? []) as HrEmployee[];

  /* When a payment term is chosen, auto-fill the due date from its method. */
  const selectedTermId = watch('paymentTermId');
  const issueDate = watch('issueDate');
  const selectedTerm = terms.find((t) => t.id === selectedTermId);
  useEffect(() => {
    if (selectedTermId && issueDate) {
      setValue('dueDate', dueDateForTerm(selectedTerm, issueDate));
    }
  }, [selectedTermId, issueDate, selectedTerm, setValue]);

  const lineTotal = (l?: LineForm): number => {
    if (!l) return 0;
    const product = productList.find((p) => p.id === l.productId);
    const price = Number.isFinite(l.unitPrice)
      ? Number(l.unitPrice)
      : product?.salesPrice != null
        ? Number(product.salesPrice)
        : 0;
    const qty = Number.isFinite(l.quantity) ? Number(l.quantity) : 0;
    const disc = Number.isFinite(l.discountPercent) ? Number(l.discountPercent) : 0;
    return qty * price * (1 - disc / 100);
  };
  const subtotal = (lines ?? []).reduce((s, l) => s + lineTotal(l), 0);

  const onProductChange = (index: number, productId: string) => {
    setValue(`lines.${index}.productId`, productId);
    const p = productList.find((x) => x.id === productId);
    if (p) {
      setValue(`lines.${index}.description`, p.name);
      if (p.salesPrice != null) setValue(`lines.${index}.unitPrice`, Number(p.salesPrice));
    }
  };

  const onSubmit = handleSubmit(async (values, event) => {
    const submitter = (event?.nativeEvent as SubmitEvent | undefined)?.submitter as
      | HTMLButtonElement
      | undefined;
    const action = submitter?.value ?? 'save';

    const payload: CreateInvoiceInput = {
      partnerId: values.partnerId,
      issueDate: values.issueDate,
      dueDate: values.dueDate || undefined,
      paymentTermId: values.paymentTermId || undefined,
      paymentMode: values.paymentMode || undefined,
      fiscalPositionId: values.fiscalPositionId || undefined,
      invoicingJournalId: values.invoicingJournalId || undefined,
      salespersonId: values.salespersonId || undefined,
      deliveryDate: values.deliveryDate || undefined,
      deliveryAddress: values.deliveryAddress || undefined,
      incoterm: values.incoterm || undefined,
      incotermLocation: values.incotermLocation || undefined,
      sourceDocument: values.sourceDocument || undefined,
      reference: values.reference || undefined,
      lines: values.lines.map((l) => ({
        lineType: l.lineType ?? 'product',
        productId: l.productId || undefined,
        description: l.description || undefined,
        quantity: Number.isFinite(l.quantity) ? Number(l.quantity) : 1,
        unitPrice: Number.isFinite(l.unitPrice) ? Number(l.unitPrice) : undefined,
        discountPercent: Number.isFinite(l.discountPercent) ? Number(l.discountPercent) : undefined,
      })),
    };

    const invoice = await createInvoice.mutateAsync(payload);
    if (action === 'post') await postInvoice.mutateAsync(invoice.id);
    navigate(`/invoices/${invoice.id}`);
  });

  const busy = createInvoice.isPending || postInvoice.isPending;
  const [activeTab, setActiveTab] = useState<'lines' | 'info' | 'delivery'>('lines');

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">New Invoice</h1>
        <div className="flex gap-2">
          <Button type="submit" name="action" value="save" variant="outline" disabled={busy}>
            Save draft
          </Button>
          <Button type="submit" name="action" value="post" disabled={busy}>
            Save &amp; Post
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Customer</Label>
            <select className={selectClass} {...register('partnerId', { required: true })}>
              <option value="">Select customer</option>
              {(partners.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reference">Reference</Label>
            <Input id="reference" {...register('reference')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="issueDate">Issue date</Label>
            <Input id="issueDate" type="date" {...register('issueDate', { required: true })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="paymentTermId">Payment terms</Label>
            <select id="paymentTermId" className={selectClass} {...register('paymentTermId')}>
              <option value="">No payment terms</option>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="dueDate">Due date</Label>
            <Input id="dueDate" type="date" {...register('dueDate')} />
          </div>
        </CardContent>
      </Card>

      {selectedTerm && (
        <Card className="border-l-4 border-l-indigo-500 bg-muted/30">
          <CardContent className="flex items-center justify-between py-3 text-sm">
            <span className="text-muted-foreground">
              Due date derived from <strong className="text-foreground">{selectedTerm.name}</strong>
            </span>
            <span className="font-mono">{dueDateForTerm(selectedTerm, issueDate)}</span>
          </CardContent>
        </Card>
      )}

      {/* Odoo-style tab bar — panels live in Invoice Lines / Other Info / Delivery */}
      <div className="-mb-4 flex border-b border-border">
        <TabBtn active={activeTab === 'lines'} onClick={() => setActiveTab('lines')}>
          Invoice Lines
        </TabBtn>
        <TabBtn active={activeTab === 'info'} onClick={() => setActiveTab('info')}>
          Other Info
        </TabBtn>
        <TabBtn active={activeTab === 'delivery'} onClick={() => setActiveTab('delivery')}>
          Delivery
        </TabBtn>
      </div>

      {activeTab === 'info' && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Other Info</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="fiscalPositionId">Fiscal position</Label>
            <select id="fiscalPositionId" className={selectClass} {...register('fiscalPositionId')}>
              <option value="">— No fiscal position —</option>
              {fiscalPositionList.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="invoicingJournalId">Invoicing journal</Label>
            <select id="invoicingJournalId" className={selectClass} {...register('invoicingJournalId')}>
              <option value="">— Default sales journal —</option>
              {journalList.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="salespersonId">Salesperson</Label>
            <select id="salespersonId" className={selectClass} {...register('salespersonId')}>
              <option value="">— Not assigned —</option>
              {salespersonList.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName ?? ''}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="paymentMode">Payment method</Label>
            <select id="paymentMode" className={selectClass} {...register('paymentMode')}>
              <option value="">— Not set —</option>
              {Object.entries(PAYMENT_MODE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sourceDocument">Source document</Label>
            <Input id="sourceDocument" placeholder="SO/PO/reference of the originating doc" {...register('sourceDocument')} />
          </div>
        </CardContent>
      </Card>
      )}

      {activeTab === 'delivery' && (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="deliveryDate">Delivery date</Label>
            <Input id="deliveryDate" type="date" {...register('deliveryDate')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="deliveryAddress">Delivery address</Label>
            <Input id="deliveryAddress" placeholder="Street, city, region" {...register('deliveryAddress')} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="incoterm">Incoterm</Label>
            <select id="incoterm" className={selectClass} {...register('incoterm')}>
              <option value="">— None —</option>
              {INCOTERM_OPTIONS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="incotermLocation">Incoterm location</Label>
            <Input id="incotermLocation" placeholder="e.g. Jakarta (ID)" {...register('incotermLocation')} />
          </div>
        </CardContent>
      </Card>
      )}

      {activeTab === 'lines' && (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Invoice Lines</CardTitle>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => append({ quantity: 1 })}>
              <Plus className="h-4 w-4" /> Add a line
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => append({ lineType: 'section', description: '', quantity: 0 })}>
              <Section className="h-4 w-4" /> Add a section
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => append({ lineType: 'note', description: '', quantity: 0 })}>
              <StickyNote className="h-4 w-4" /> Add a note
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {fields.map((field, index) => {
            const rowType = watch(`lines.${index}.lineType`) ?? 'product';
            const isMeta = rowType === 'section' || rowType === 'note';
            if (isMeta) {
              return (
                <div key={field.id} className="grid grid-cols-12 items-center gap-2">
                  <div className="col-span-11">
                    <Label className="text-xs">{rowType === 'section' ? 'Section title' : 'Note'}</Label>
                    <Input
                      className={rowType === 'section' ? 'font-bold uppercase tracking-wide' : 'italic text-slate-600'}
                      placeholder={rowType === 'section' ? 'e.g. Services' : 'e.g. Courtesy discount approved by manager'}
                      {...register(`lines.${index}.description`)}
                    />
                  </div>
                  <div className="col-span-1">
                    <Button type="button" variant="ghost" size="icon" onClick={() => remove(index)} disabled={fields.length <= 1}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            }
            return (
            <div key={field.id} className="grid grid-cols-12 items-end gap-2">
              <div className="col-span-3">
                <Label className="text-xs">Product</Label>
                <select
                  className={selectClass}
                  value={watch(`lines.${index}.productId`) ?? ''}
                  onChange={(e) => onProductChange(index, e.target.value)}
                >
                  <option value="">— none —</option>
                  {productList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-3">
                <Label className="text-xs">Description</Label>
                <Input {...register(`lines.${index}.description`)} />
              </div>
              <div className="col-span-1">
                <Label className="text-xs">Qty</Label>
                <Input type="number" step="any" {...register(`lines.${index}.quantity`, { valueAsNumber: true })} />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Unit price</Label>
                <Input type="number" step="any" {...register(`lines.${index}.unitPrice`, { valueAsNumber: true })} />
              </div>
              <div className="col-span-1">
                <Label className="text-xs">Disc %</Label>
                <Input
                  type="number"
                  step="any"
                  {...register(`lines.${index}.discountPercent`, { valueAsNumber: true })}
                />
              </div>
              <div className="col-span-1 pb-2 text-right text-sm">{money(lineTotal(lines?.[index]))}</div>
              <div className="col-span-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(index)}
                  disabled={fields.length <= 1}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            );
          })}

          <div className="flex justify-end border-t pt-3">
            <div className="w-64 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal (net of discount)</span>
                <span>{money(subtotal)}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Tax is applied from each product when the invoice is posted.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      )}
    </form>
  );
}