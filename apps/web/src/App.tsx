import { Navigate, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/protected-route';
import { AppShell } from '@/components/layout/app-shell';
import { LoginPage } from '@/pages/login';
import { DashboardPage } from '@/pages/dashboard';
import { PartnersPage } from '@/pages/partners';
import { CustomersPage, CustomerDetailPage } from '@/pages/customers';
import { SuppliersPage, SupplierDetailPage } from '@/pages/suppliers';
import { SupplierLedgerPage } from '@/pages/purchasing/supplier-ledger';
import { ProductsPage } from '@/pages/products';
import { UomPage } from '@/pages/uom';
import { MenuPage } from '@/pages/menu';
import MenuDetailPage from '@/pages/menu/MenuDetailPage';
import ModifiersPage from '@/pages/menu/ModifiersPage';
import ComboListPage from '@/pages/pos/ComboListPage';
import AccompanimentGroupsPage from '@/pages/menu/AccompanimentGroupsPage';
import { SettingsPage } from '@/pages/settings';
import { ReceiptSettingsPage } from '@/pages/pos/ReceiptSettingsPage';
import { PosSettingsPage } from '@/pages/pos/SettingsPage';
import { DevicesPage } from '@/pages/pos/DevicesPage';
import { DeadLettersPage } from '@/pages/pos/DeadLettersPage';
import { PostingMonitorPage } from '@/pages/pos/PostingMonitorPage';
import { ApprovalsPage } from '@/pages/approvals';
import { ApprovalPoliciesPage } from '@/pages/approval-policies';
import { RecurringPage } from '@/pages/recurring';
import { WebhooksPage } from '@/pages/webhooks';
import { FilesPage } from '@/pages/files';
import { ModulesPage } from '@/pages/modules';
import { BackupPage } from '@/pages/settings/BackupPage';
import { AssetDashboardPage } from '@/pages/fixed-asset/AssetDashboardPage';
import { AssetCategoriesPage } from '@/pages/fixed-asset/AssetCategoriesPage';
import { AssetsPage } from '@/pages/fixed-asset/AssetsPage';
import { AssetDetailPage } from '@/pages/fixed-asset/AssetDetailPage';
import { ChartOfAccountsPage } from '@/pages/accounting/chart-of-accounts';
import { CashAccountsPage } from '@/pages/accounting/cash-accounts';
import { CashAccountDetailPage } from '@/pages/accounting/cash-account-detail';
import { CashRegistersCrudPage } from '@/pages/accounting/cash-registers';
import { AccountMappingsPage } from '@/pages/accounting/account-mappings';
import { JournalEntriesPage } from '@/pages/accounting/journal-entries';
import { TrialBalancePage } from '@/pages/accounting/trial-balance';
import { BalanceSheetPage } from '@/pages/accounting/balance-sheet';
import { InvoicesPage } from '@/pages/invoicing/invoices';
import { InvoiceCreatePage } from '@/pages/invoicing/invoice-create';
import { InvoiceDetailPage } from '@/pages/invoicing/invoice-detail';
import { ArAgingPage } from '@/pages/invoicing/ar-aging';
import { CreditNotesPage } from '@/pages/invoicing/credit-notes';
import { CreditNoteCreatePage } from '@/pages/invoicing/credit-note-create';
import { CreditNoteDetailPage } from '@/pages/invoicing/credit-note-detail';
import { PaymentsPage } from '@/pages/invoicing/payments';
import { PaymentDetailPage } from '@/pages/invoicing/payment-detail';
import { ReceiptsPage } from '@/pages/pos/ReceiptsPage';
import { ReceiptDetailPage } from '@/pages/pos/ReceiptDetailPage';
import { ExpensesPage } from '@/pages/expenses/ExpensesPage';
import ExpensesReportPage from '@/pages/expenses/ExpensesReportPage';
import ExpenseCategoriesPage from '@/pages/expenses/ExpenseCategoriesPage';
import { SupplierPaymentsPage } from '@/pages/purchasing/supplier-payments';
import { JournalsPage } from '@/pages/accounting/journals';
import { JournalEntryCreatePage } from '@/pages/accounting/journal-entry-create';
import { JournalEntryDetailPage } from '@/pages/accounting/journal-entry-detail';
import { PurchaseRequestsPage } from '@/pages/procurement/purchase-requests';
import { PurchaseOrdersPage } from '@/pages/procurement/purchase-orders';
import { PurchaseOrderCreatePage } from '@/pages/procurement/purchase-order-create';
import { PurchaseOrderDetailPage } from '@/pages/procurement/PurchaseOrderDetailPage';
import { PurchaseOrderReceivePage } from '@/pages/procurement/PurchaseOrderReceivePage';
import { PurchaseOrderPayPage } from '@/pages/procurement/PurchaseOrderPayPage';
import { GoodsReceiptsPage } from '@/pages/procurement/goods-receipts';
import { GoodsReceiptCreatePage } from '@/pages/procurement/goods-receipt-create';
import GoodsReceiptDetailPage from '@/pages/procurement/goods-receipt-detail';
import { ThreeWayMatchPage } from '@/pages/procurement/three-way-match';
import { DebitNotesPage } from '@/pages/procurement/debit-notes';
import { DebitNoteCreatePage } from '@/pages/procurement/debit-note-create';
import { InventoryItemsPage } from '@/pages/inventory/InventoryItemsPage';
import InventoryDetailPage from '@/pages/inventory/InventoryDetailPage';
import { StockAdjustmentsPage } from '@/pages/inventory/StockAdjustmentsPage';
import { StockTransfersPage } from '@/pages/inventory/StockTransfersPage';
import { InventoryCountPage } from '@/pages/inventory/InventoryCountPage';
import { BottleCountPage } from '@/pages/beverage/BottleCountPage';
import { BeverageDashboardPage } from '@/pages/beverage/BeverageDashboardPage';
import { StockLedgerPage } from '@/pages/inventory/StockLedgerPage';
import LocationsPage from '@/pages/inventory/LocationsPage';
import TerminalPage from '@/pages/pos/Terminal';
import ReportsPage from '@/pages/pos/ReportsPage';
import DisplayPage from '@/pages/pos/DisplayPage';
import KdsPage from '@/pages/pos/KdsPage';
import CashRegistersPage from '@/pages/pos/cash/CashRegistersPage';
import DigitalMenuPage from '@/pages/pos/DigitalMenuPage';
import TablesPage from '@/pages/tables/TablesPage';
import ReservationsPage from '@/pages/tables/ReservationsPage';
import TableReportsPage from '@/pages/tables/TableReportsPage';
import ReportCenterPage from '@/pages/reports/ReportCenterPage';
import { StaffPage } from '@/pages/staff/StaffPage';
import { RolesPage } from '@/pages/staff/RolesPage';
import { TasksPage } from '@/pages/tasks/TasksPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Digital Menu — customer-facing public route (no auth, no shell). */}
      <Route path="/menu/:branchId/:tableId" element={<DigitalMenuPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          {/* POS terminal — full-screen cashier UI. Renders outside the app shell. */}
          <Route path="/pos/terminal" element={<TerminalPage />} />
          <Route path="/pos/reports" element={<ReportsPage />} />
          {/* POS customer display — second monitor / pole display, no shell. */}
          <Route path="/pos/display" element={<DisplayPage />} />
          {/* POS KDS — kitchen display for bar / kitchen / cafe monitors. */}
          <Route path="/pos/kds" element={<KdsPage />} />
          {/* POS Cash Register Management */}
          <Route path="/pos/cash-registers" element={<CashRegistersPage />} />
          <Route path="/pos/settings" element={<PosSettingsPage />} />
          <Route path="/tables" element={<TablesPage />} />
          <Route path="/tables/reservations" element={<ReservationsPage />} />
          <Route path="/tables/reports" element={<TableReportsPage />} />
          <Route path="/staff" element={<StaffPage />} />
          <Route path="/staff/roles" element={<RolesPage />} />
          <Route path="/partners" element={<PartnersPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/customers/:partnerId" element={<CustomerDetailPage />} />
          <Route path="/suppliers" element={<SuppliersPage />} />
          <Route path="/suppliers/:partnerId" element={<SupplierDetailPage />} />
          <Route path="/suppliers/:partnerId/ledger" element={<SupplierLedgerPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/uom" element={<UomPage />} />
          <Route path="/menu" element={<MenuPage />} />
          <Route path="/menu/:menuItemId" element={<MenuDetailPage />} />
          <Route path="/menu/modifiers" element={<ModifiersPage />} />
          <Route path="/menu/combos" element={<ComboListPage />} />
          <Route path="/menu/accompaniments" element={<AccompanimentGroupsPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/new" element={<InvoiceCreatePage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/credit-notes" element={<CreditNotesPage />} />
          <Route path="/credit-notes/new" element={<CreditNoteCreatePage />} />
          <Route path="/credit-notes/:id" element={<CreditNoteDetailPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/payments/:id" element={<PaymentDetailPage />} />
          <Route path="/pos/receipts" element={<ReceiptsPage />} />
          <Route path="/pos/receipts/:invoiceId" element={<ReceiptDetailPage />} />
          <Route path="/expenses" element={<ExpensesPage />} />
          <Route path="/expenses/categories" element={<ExpenseCategoriesPage />} />
          <Route path="/expenses/reports" element={<ExpensesReportPage />} />
          <Route path="/supplier-payments" element={<SupplierPaymentsPage />} />
          <Route path="/ar-aging" element={<ArAgingPage />} />
          <Route path="/accounts" element={<ChartOfAccountsPage />} />
          <Route path="/accounts/cash-accounts" element={<CashAccountsPage />} />
          <Route path="/accounts/cash-accounts/:id" element={<CashAccountDetailPage />} />
          <Route path="/accounts/cash-registers" element={<CashRegistersCrudPage />} />
          <Route path="/accounts/mappings" element={<AccountMappingsPage />} />
          <Route path="/journals" element={<JournalsPage />} />
          <Route path="/journal-entries" element={<JournalEntriesPage />} />
          <Route path="/journal-entries/new" element={<JournalEntryCreatePage />} />
          <Route path="/journal-entries/:id" element={<JournalEntryDetailPage />} />
          <Route path="/trial-balance" element={<TrialBalancePage />} />
          <Route path="/balance-sheet" element={<BalanceSheetPage />} />
          <Route path="/reports" element={<ReportCenterPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/approval-policies" element={<ApprovalPoliciesPage />} />
          <Route path="/recurring" element={<RecurringPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/modules" element={<ModulesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/receipt" element={<ReceiptSettingsPage />} />
          <Route path="/settings/backup" element={<BackupPage />} />
          <Route path="/settings/devices" element={<DevicesPage />} />
          <Route path="/settings/devices/rejected" element={<DeadLettersPage />} />
          <Route path="/inventory/posting-monitor" element={<PostingMonitorPage />} />
          <Route path="/fixed-assets" element={<AssetDashboardPage />} />
          <Route path="/fixed-assets/categories" element={<AssetCategoriesPage />} />
          <Route path="/fixed-assets/register" element={<AssetsPage />} />
          <Route path="/fixed-assets/:id" element={<AssetDetailPage />} />
          <Route path="/inventory" element={<InventoryItemsPage />} />
          <Route path="/inventory/items" element={<InventoryItemsPage />} />
          <Route path="/inventory/items/:productId" element={<InventoryDetailPage />} />
          <Route path="/inventory/adjustments" element={<StockAdjustmentsPage />} />
          <Route path="/inventory/transfers" element={<StockTransfersPage />} />
          <Route path="/inventory/count" element={<InventoryCountPage />} />
          <Route path="/beverage" element={<BeverageDashboardPage />} />
          <Route path="/beverage/count" element={<BottleCountPage />} />
          <Route path="/inventory/ledger" element={<StockLedgerPage />} />
          <Route path="/inventory/locations" element={<LocationsPage />} />
          <Route path="/procurement/purchase-requests" element={<PurchaseRequestsPage />} />
          <Route path="/procurement/purchase-orders" element={<PurchaseOrdersPage />} />
          <Route path="/procurement/purchase-orders/new" element={<PurchaseOrderCreatePage />} />
          <Route path="/procurement/purchase-orders/:id/receive" element={<PurchaseOrderReceivePage />} />
          <Route path="/procurement/purchase-orders/:id/pay" element={<PurchaseOrderPayPage />} />
          <Route path="/procurement/purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
          <Route path="/procurement/goods-receipts" element={<GoodsReceiptsPage />} />
          <Route path="/procurement/goods-receipts/new" element={<GoodsReceiptCreatePage />} />
          <Route path="/procurement/goods-receipts/:id" element={<GoodsReceiptDetailPage />} />
          <Route path="/procurement/three-way-match" element={<ThreeWayMatchPage />} />
          <Route path="/procurement/debit-notes" element={<DebitNotesPage />} />
          <Route path="/procurement/debit-notes/new" element={<DebitNoteCreatePage />} />
          <Route path="/tasks" element={<TasksPage />} />
          
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
