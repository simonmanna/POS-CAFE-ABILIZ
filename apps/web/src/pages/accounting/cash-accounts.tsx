import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Banknote, Building2, Smartphone, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, Loader2 } from 'lucide-react';
import { useCashAccounts, useCashFlowDeposit, useCashFlowWithdraw, useTreasuryTransfer } from '@/features/accounting/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

const TYPE_CONFIG: Record<string, { icon: typeof Banknote; label: string; color: string }> = {
  cash: { icon: Banknote, label: 'Cash', color: 'text-green-600' },
  bank: { icon: Building2, label: 'Bank', color: 'text-blue-600' },
  mobile_money: { icon: Smartphone, label: 'Mobile Money', color: 'text-yellow-600' },
};

function CurrencyDisplay({ value }: { value: string }) {
  const num = Number(value);
  const abs = Math.abs(num);
  return (
    <span className={num < 0 ? 'text-red-600' : num > 0 ? 'text-green-600' : ''}>
      {num < 0 ? '-' : ''}{abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

export function CashAccountsPage() {
  const { data: accounts, isLoading } = useCashAccounts();
  const deposit = useCashFlowDeposit();
  const withdraw = useCashFlowWithdraw();
  const transfer = useTreasuryTransfer();
  const navigate = useNavigate();

  const [modal, setModal] = useState<'deposit' | 'withdraw' | 'transfer' | null>(null);

  const [formAccountId, setFormAccountId] = useState('');
  const [formToAccountId, setFormToAccountId] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formLoading, setFormLoading] = useState(false);

  const allCashAccounts = (accounts ?? []) as { id: string; code: string; name: string; accountType: string; balance: string }[];

  const resetForm = () => {
    setFormAccountId('');
    setFormToAccountId('');
    setFormAmount('');
    setFormDesc('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(formAmount);
    if (!amount || amount <= 0) return;
    setFormLoading(true);
    try {
      if (modal === 'deposit') {
        await deposit.mutateAsync({ accountId: formAccountId, amount, description: formDesc });
        toast.success('Deposit recorded');
      } else if (modal === 'withdraw') {
        await withdraw.mutateAsync({ accountId: formAccountId, amount, description: formDesc });
        toast.success('Withdrawal recorded');
      } else if (modal === 'transfer') {
        await transfer.mutateAsync({
          fromAccountId: formAccountId,
          toAccountId: formToAccountId,
          amount,
          date: new Date().toISOString().split('T')[0],
          reference: formDesc || undefined,
        });
        toast.success('Transfer completed');
      }
      resetForm();
      setModal(null);
    } catch {
        toast.error('Transaction failed');
    } finally {
      setFormLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash Accounts</h1>
          <p className="text-sm text-muted-foreground">
            Manage cash drawers, bank accounts, and mobile money wallets
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => { resetForm(); setModal('deposit'); }}>
            <ArrowDownToLine className="h-4 w-4 mr-2" /> Deposit
          </Button>
          <Button variant="outline" onClick={() => { resetForm(); setModal('withdraw'); }}>
            <ArrowUpFromLine className="h-4 w-4 mr-2" /> Withdraw
          </Button>
          <Button onClick={() => { resetForm(); setModal('transfer'); }}>
            <ArrowRightLeft className="h-4 w-4 mr-2" /> Transfer
          </Button>
        </div>
      </div>

      {allCashAccounts.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Banknote className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium">No cash accounts found</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create accounts with type Cash, Bank, or Mobile Money in the Chart of Accounts first.
            </p>
            <Button className="mt-4" variant="outline" onClick={() => navigate('/accounts')}>
              Go to Chart of Accounts
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {allCashAccounts.map((account) => {
            const cfg = TYPE_CONFIG[account.accountType] ?? { icon: Banknote, label: account.accountType, color: '' };
            const Icon = cfg.icon;
            return (
              <Card
                key={account.id}
                className="cursor-pointer hover:shadow-md transition-shadow"
                onClick={() => navigate(`/accounts/cash-accounts/${account.id}`)}
              >
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Icon className={`h-5 w-5 ${cfg.color}`} />
                    {account.name}
                  </CardTitle>
                  <span className="text-xs bg-muted px-2 py-0.5 rounded-full">{cfg.label}</span>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    <CurrencyDisplay value={account.balance} />
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{account.code}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!modal} onOpenChange={(v) => { if (!v) setModal(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {modal === 'deposit' && <><ArrowDownToLine className="h-5 w-5" /> Cash Deposit</>}
              {modal === 'withdraw' && <><ArrowUpFromLine className="h-5 w-5" /> Cash Withdrawal</>}
              {modal === 'transfer' && <><ArrowRightLeft className="h-5 w-5" /> Transfer Between Accounts</>}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label>{modal === 'transfer' ? 'From Account' : 'Account'}</Label>
              <Select value={formAccountId} onValueChange={setFormAccountId} required>
                <SelectTrigger>
                  <SelectValue placeholder="Select account" />
                </SelectTrigger>
                <SelectContent>
                  {allCashAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} ({a.accountType}) — Bal: {Number(a.balance).toLocaleString()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {modal === 'transfer' && (
              <div className="space-y-2">
                <Label>To Account</Label>
                <Select value={formToAccountId} onValueChange={setFormToAccountId} required>
                  <SelectTrigger>
                    <SelectValue placeholder="Select destination account" />
                  </SelectTrigger>
                  <SelectContent>
                    {allCashAccounts.filter((a) => a.id !== formAccountId).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} ({a.accountType}) — Bal: {Number(a.balance).toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                placeholder="0.00"
                value={formAmount}
                onChange={(e) => setFormAmount(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input
                placeholder="Reason for transaction"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
              />
            </div>
            <Button type="submit" className="w-full" disabled={formLoading}>
              {formLoading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {modal === 'deposit' ? 'Record Deposit' : modal === 'withdraw' ? 'Record Withdrawal' : 'Transfer'}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
