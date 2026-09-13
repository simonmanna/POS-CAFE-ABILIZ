import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowDownToLine, ArrowUpFromLine, Building2, Banknote, Smartphone, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  useCashAccountTransactions,
  useCashFlowDeposit,
  useCashFlowOperationTypes,
  useCashFlowWithdraw,
  type TreasuryOperationType,
} from '@/features/accounting/api';
import { apiErrorMessage } from '@/lib/api-error';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

const TYPE_CONFIG: Record<string, { icon: typeof Banknote; label: string; color: string; bg: string }> = {
  cash: { icon: Banknote, label: 'Cash', color: 'text-emerald-600', bg: 'bg-emerald-500' },
  bank: { icon: Building2, label: 'Bank', color: 'text-blue-600', bg: 'bg-blue-500' },
  mobile_money: { icon: Smartphone, label: 'Mobile Money', color: 'text-orange-600', bg: 'bg-orange-500' },
  petty_cash: { icon: Banknote, label: 'Petty Cash', color: 'text-purple-600', bg: 'bg-purple-500' },
};

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2 });

type Direction = 'deposit' | 'withdrawal';

export function CashAccountDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const { data, isLoading } = useCashAccountTransactions(id, { page, pageSize });
  const { data: operationTypes } = useCashFlowOperationTypes();
  const deposit = useCashFlowDeposit();
  const withdraw = useCashFlowWithdraw();

  const [dialog, setDialog] = useState<Direction | null>(null);
  const [formAmount, setFormAmount] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [counterpartAccountId, setCounterpartAccountId] = useState('');
  const [operationType, setOperationType] = useState('');

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const acct = data.account as typeof data.account & { cashRegister?: unknown };
  const cfg = TYPE_CONFIG[acct.accountType] ?? { icon: Banknote, label: acct.accountType, color: '', bg: 'bg-slate-500' };
  const currentBalance = Number(acct.currentBalance);
  const types: TreasuryOperationType[] = dialog === 'deposit' ? operationTypes?.deposit ?? [] : operationTypes?.withdrawal ?? [];
  const counterparts = types.find((t) => t.key === operationType)?.accounts ?? [];
  const pending = deposit.isPending || withdraw.isPending;

  const open = (direction: Direction) => {
    setFormAmount('');
    setFormDesc('');
    setCounterpartAccountId('');
    setOperationType('');
    setDialog(direction);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dialog) return;
    const amount = Number(formAmount);
    if (!(amount > 0) || !counterpartAccountId || !operationType || !formDesc.trim()) {
      toast.error('Enter the amount, type, counterpart account and a description');
      return;
    }
    if (dialog === 'withdrawal' && amount > currentBalance) {
      toast.error(`Insufficient funds: available ${money(currentBalance)}`);
      return;
    }
    const input = { accountId: id!, counterpartAccountId, operationType, amount, description: formDesc.trim() };
    try {
      if (dialog === 'deposit') await deposit.mutateAsync(input);
      else await withdraw.mutateAsync(input);
      toast.success(dialog === 'deposit' ? 'Deposit recorded' : 'Withdrawal recorded');
      setDialog(null);
    } catch (err) {
      toast.error(apiErrorMessage(err, dialog === 'deposit' ? 'Deposit failed' : 'Withdrawal failed'));
    }
  };

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate('/accounts/cash-accounts')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className={cn('p-2 rounded-lg text-white shadow-inner text-lg', cfg.bg)}>
          {acct.accountType === 'mobile_money' ? '📱' : acct.accountType === 'petty_cash' ? '🪙' : acct.accountType === 'bank' ? '🏦' : '💵'}
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">{acct.name}</h1>
          <p className="text-sm text-muted-foreground">
            {acct.code} &middot; {cfg.label}
            {acct.accountType === 'bank' || acct.accountType === 'mobile_money' ? ` · ${acct.accountNumber || ''}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-sm text-muted-foreground">Current Balance</p>
          <p className={`text-2xl font-bold ${currentBalance < 0 ? 'text-red-600' : currentBalance > 0 ? 'text-green-600' : ''}`}>
            {currentBalance < 0 ? '-' : ''}{money(Math.abs(currentBalance))}
          </p>
        </div>
        {acct.cashRegister ? (
          <p className="max-w-[240px] text-xs text-muted-foreground">
            Register drawer account: cash moves only through its shift (sales, pay-ins, pay-outs, banking).
          </p>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => open('deposit')}>
              <ArrowDownToLine className="h-4 w-4 mr-2" /> Deposit
            </Button>
            <Button variant="outline" onClick={() => open('withdrawal')}>
              <ArrowUpFromLine className="h-4 w-4 mr-2" /> Withdraw
            </Button>
          </div>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transaction History</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">In (Dr)</TableHead>
                <TableHead className="text-right">Out (Cr)</TableHead>
                <TableHead className="text-right">Running Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No transactions yet
                  </TableCell>
                </TableRow>
              ) : (
                data.data.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(t.postingDate).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{t.entryNumber}</TableCell>
                    <TableCell className="max-w-[250px] truncate">{t.description}</TableCell>
                    <TableCell className="text-right font-mono">
                      {Number(t.baseDebit) > 0 ? money(Number(t.baseDebit)) : ''}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {Number(t.baseCredit) > 0 ? money(Number(t.baseCredit)) : ''}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      <span className={Number(t.runningBalance) < 0 ? 'text-red-600' : Number(t.runningBalance) > 0 ? 'text-green-600' : ''}>
                        {money(Number(t.runningBalance))}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {data.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Page {data.page} of {data.totalPages} ({data.total} transactions)
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(o) => { if (!o && !pending) setDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {dialog === 'deposit'
                ? <><ArrowDownToLine className="h-5 w-5" /> Deposit to {acct.name}</>
                : <><ArrowUpFromLine className="h-5 w-5" /> Withdraw from {acct.name}</>}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input type="number" step="0.01" min="0.01" placeholder="0.00" value={formAmount} onChange={(e) => setFormAmount(e.target.value)} required />
              {dialog === 'withdrawal' && (
                <p className="text-xs text-muted-foreground">Available: {money(currentBalance)}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{dialog === 'deposit' ? 'Deposit type' : 'Withdrawal type'}</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={operationType}
                onChange={(e) => { setOperationType(e.target.value); setCounterpartAccountId(''); }}
                required
              >
                <option value="">{dialog === 'deposit' ? 'Where does this money come from?' : 'What is this money for?'}</option>
                {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">
                Moving money between your own cash, bank and wallet accounts is a transfer, not a {dialog === 'deposit' ? 'deposit' : 'withdrawal'}.
              </p>
            </div>
            <div className="space-y-2">
              <Label>Counterpart account</Label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={counterpartAccountId}
                onChange={(e) => setCounterpartAccountId(e.target.value)}
                required
                disabled={!operationType}
              >
                <option value="">{operationType ? (counterparts.length ? 'Choose the account' : 'No eligible account — add one to the chart of accounts') : 'Choose a type first'}</option>
                {counterparts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Input
                placeholder={dialog === 'deposit' ? 'e.g. Capital injection from owner' : 'e.g. Monthly bank charges'}
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {dialog === 'deposit' ? 'Record Deposit' : 'Record Withdrawal'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
