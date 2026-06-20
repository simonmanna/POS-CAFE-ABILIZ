import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/protected-route';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/pages/login';
import { DashboardPage } from '@/pages/dashboard';
import { PartnersPage } from '@/pages/partners';
import { ProductsPage } from '@/pages/products';
import { SettingsPage } from '@/pages/settings';
import { ChartOfAccountsPage } from '@/pages/accounting/chart-of-accounts';
import { JournalEntriesPage } from '@/pages/accounting/journal-entries';
import { TrialBalancePage } from '@/pages/accounting/trial-balance';
import { InvoicesPage } from '@/pages/invoicing/invoices';
import { InvoiceCreatePage } from '@/pages/invoicing/invoice-create';
import { InvoiceDetailPage } from '@/pages/invoicing/invoice-detail';
import { ArAgingPage } from '@/pages/invoicing/ar-aging';
import { CreditNotesPage } from '@/pages/invoicing/credit-notes';
import { CreditNoteCreatePage } from '@/pages/invoicing/credit-note-create';
import { CreditNoteDetailPage } from '@/pages/invoicing/credit-note-detail';
import { PaymentsPage } from '@/pages/invoicing/payments';
import { PaymentDetailPage } from '@/pages/invoicing/payment-detail';
import { ExpensesPage } from '@/pages/purchasing/expenses';
import { ExpenseCreatePage } from '@/pages/purchasing/expense-create';
import { ExpenseDetailPage } from '@/pages/purchasing/expense-detail';
import { SupplierPaymentsPage } from '@/pages/purchasing/supplier-payments';
import { JournalsPage } from '@/pages/accounting/journals';
import { JournalEntryCreatePage } from '@/pages/accounting/journal-entry-create';
import { JournalEntryDetailPage } from '@/pages/accounting/journal-entry-detail';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/partners" element={<PartnersPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/new" element={<InvoiceCreatePage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/credit-notes" element={<CreditNotesPage />} />
          <Route path="/credit-notes/new" element={<CreditNoteCreatePage />} />
          <Route path="/credit-notes/:id" element={<CreditNoteDetailPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/payments/:id" element={<PaymentDetailPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/expenses/new" element={<ExpenseCreatePage />} />
          <Route path="/expenses/:id" element={<ExpenseDetailPage />} />
          <Route path="/supplier-payments" element={<SupplierPaymentsPage />} />
          <Route path="/ar-aging" element={<ArAgingPage />} />
          <Route path="/accounts" element={<ChartOfAccountsPage />} />
          <Route path="/journals" element={<JournalsPage />} />
          <Route path="/journal-entries" element={<JournalEntriesPage />} />
          <Route path="/journal-entries/new" element={<JournalEntryCreatePage />} />
          <Route path="/journal-entries/:id" element={<JournalEntryDetailPage />} />
          <Route path="/trial-balance" element={<TrialBalancePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
