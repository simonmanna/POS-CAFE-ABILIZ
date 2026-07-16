import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCreateAccount, useUpdateAccount, type Account } from '@/features/accounting/api';

const ACCOUNT_TYPES = [
  'asset', 'liability', 'equity', 'revenue', 'expense', 'cost_of_goods_sold',
  'bank', 'cash', 'receivable', 'payable', 'tax', 'contra_asset', 'contra_liability',
  'mobile_money', 'petty_cash',
] as const;

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  asset: 'Asset', liability: 'Liability', equity: 'Equity', revenue: 'Revenue',
  expense: 'Expense', cost_of_goods_sold: 'COGS', bank: 'Bank', cash: 'Cash',
  receivable: 'Receivable', payable: 'Payable', tax: 'Tax',
  contra_asset: 'Contra Asset', contra_liability: 'Contra Liability',
  mobile_money: 'Mobile Money', petty_cash: 'Petty Cash',
};

const createSchema = z.object({
  code: z.string().min(1, 'Required'),
  name: z.string().min(1, 'Required'),
  accountType: z.string().min(1, 'Required'),
  isGroup: z.boolean(),
  parentAccountId: z.string().optional(),
  description: z.string().optional(),
});

const updateSchema = z.object({
  code: z.string().optional(),
  name: z.string().min(1, 'Required'),
  accountType: z.string().min(1, 'Required'),
  isGroup: z.boolean(),
  parentAccountId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
});

type CreateValues = z.infer<typeof createSchema>;
type UpdateValues = z.infer<typeof updateSchema>;

interface AccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account?: Account | null;
  parentOptions: Account[];
}

export function AccountDialog({ open, onOpenChange, account, parentOptions }: AccountDialogProps) {
  const isEdit = !!account;
  const createAccount = useCreateAccount();
  const updateAccount = useUpdateAccount();

  const form = useForm<CreateValues | UpdateValues>({
    resolver: zodResolver(isEdit ? updateSchema : createSchema) as any,
    defaultValues: defaultValuesFor(isEdit, account),
  });

  useEffect(() => {
    if (!open) return;
    form.reset(defaultValuesFor(isEdit, account));
  }, [open, isEdit, account, form]);

  const watchAccountType = form.watch('accountType') || '';

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (isEdit && account) {
        const { code: _code, ...rest } = values as UpdateValues;
        await updateAccount.mutateAsync({
          id: account.id,
          ...rest,
          parentAccountId: rest.parentAccountId || null,
          description: rest.description || null,
        });
      } else {
        const v = values as CreateValues;
        await createAccount.mutateAsync(v);
      }
      onOpenChange(false);
    } catch {
      /* toast handled in mutation */
    }
  });

  const isPending = createAccount.isPending || updateAccount.isPending;

  const eligibleParents = parentOptions.filter(
    (p) => p.id !== account?.id && (p.isGroup || p.accountType === watchAccountType)
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Account' : 'New Account'}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? 'Update the account code, name, type, or description.'
              : 'Add a new account to the chart of accounts.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="code">Code</Label>
              <Input id="code" placeholder="e.g. 1100" disabled={isEdit} {...form.register('code')} />
              {form.formState.errors.code && (
                <p className="text-sm text-destructive">{form.formState.errors.code.message as string}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="accountType">Type</Label>
              <Select
                value={watchAccountType}
                onValueChange={(v) => form.setValue('accountType', v, { shouldValidate: true })}
                disabled={isEdit}
              >
                <SelectTrigger id="accountType"><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.formState.errors.accountType && (
                <p className="text-sm text-destructive">{form.formState.errors.accountType.message as string}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="e.g. Cash on Hand" {...form.register('name')} />
            {form.formState.errors.name && (
              <p className="text-sm text-destructive">{form.formState.errors.name.message as string}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="parentAccountId">Parent Account (optional)</Label>
            <Select
              value={form.watch('parentAccountId') ?? ''}
              onValueChange={(v) => form.setValue('parentAccountId', v || undefined)}
            >
              <SelectTrigger id="parentAccountId"><SelectValue placeholder="None (top-level)" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">None (top-level)</SelectItem>
                {eligibleParents.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.code} — {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              placeholder="What this account is used for…"
              {...form.register('description')}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-input"
              {...form.register('isGroup')}
            />
            <span>Group account (cannot post journal lines directly)</span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? 'Saving…' : isEdit ? 'Save changes' : 'Create account'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function defaultValuesFor(isEdit: boolean, account?: Account | null) {
  if (isEdit && account) {
    return {
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      isGroup: account.isGroup,
      parentAccountId: account.parentAccountId ?? '',
      description: account.description ?? '',
    } as UpdateValues;
  }
  return {
    code: '',
    name: '',
    accountType: '',
    isGroup: false,
    parentAccountId: '',
    description: '',
  } as CreateValues;
}
