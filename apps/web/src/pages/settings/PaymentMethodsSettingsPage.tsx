import { PosPaymentMethodsPanel } from '@/components/money/PosPaymentMethodsPanel';
import { MoneyPageHeader } from '@/components/money/money-ui';
import { tx } from '@/lib/i18n/tx';

export function PaymentMethodsSettingsPage() {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 md:p-6">
      <MoneyPageHeader
        title={tx('Payment methods')}
        description={tx('What the cashier can charge with, and which account each payment\'s money goes to.')}
      />
      <PosPaymentMethodsPanel />
    </div>
  );
}
