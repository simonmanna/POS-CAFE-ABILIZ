# Customer & Supplier Detail Pages

## Goal
Build detail pages for customers and suppliers with Overview/Contacts/Addresses/Invoices/Payments tabs (customer) and Overview/Contacts/Addresses/Purchase Orders/Ledger/Payments tabs (supplier).

## Backend Changes

### 1. `apps/api/src/modules/invoicing/invoice/invoice.controller.ts`
- Line 17: Change `list(@Query() query: PaginationDto)` to `list(@Query() query: PaginationDto, @Query('partnerId') partnerId?: string)`
- Line 18: Change `return this.invoices.list(query);` to `return this.invoices.list(query, partnerId);`

### 2. `apps/api/src/modules/invoicing/invoice/invoice.service.ts`
- Line 23: Change `async list(query: PaginationQuery)` to `async list(query: PaginationQuery, partnerId?: string)`
- After line 31: Add `if (partnerId) where.partnerId = partnerId;`

### 3. `apps/api/src/modules/invoicing/payment/payment.controller.ts`
- Line 18: Change `listReceipts(@Query() query: PaginationDto)` to `listReceipts(@Query() query: PaginationDto, @Query('partnerId') partnerId?: string)`
- Line 19: Change `return this.payments.list(query, 'inbound');` to `return this.payments.list(query, 'inbound', partnerId);`
- Line 45: Change `listSupplierPayments(@Query() query: PaginationDto)` to `listSupplierPayments(@Query() query: PaginationDto, @Query('partnerId') partnerId?: string)`
- Line 46: Change `return this.payments.list(query, 'outbound');` to `return this.payments.list(query, 'outbound', partnerId);`

### 4. `apps/api/src/modules/invoicing/payment/payment.service.ts`
- Line 42: Change `async list(query: PaginationQuery, direction?: PaymentDirection)` to `async list(query: PaginationQuery, direction?: PaymentDirection, partnerId?: string)`
- After line 46 or 51: Add `if (partnerId) where.partnerId = partnerId;` (before the findMany call)

## Frontend Changes

### 5. CREATE: `apps/web/src/pages/partners/PartnerDetailPage.tsx`
Full detail page (~450 lines) following InventoryDetailPage pattern:
- Import: useState, useParams, useNavigate, lucide icons, shadcn/ui components, api, format utils, Partner type
- `usePartner(partnerId)` for partner data
- Direct `api.get()` for invoices, payments, POs, ledger (since existing hooks don't support partnerId)
- Shared Overview/Contacts/Addresses tabs for both types
- Customer: add Invoices + Payments tabs
- Supplier: add Purchase Orders + Ledger + Payments tabs

#### Tab: Overview
- Two-column Card layout
  - **Card 1: Basic Info** — Code, Name, Email, Phone, Status (Active/Inactive badge), Category, Membership Level, Gender, Notes, Created/Updated timestamps
  - **Card 2: Financial Summary** — Opening Balance, Credit Limit (formatted currency)
- InfoRow component (copied from InventoryDetailPage)

#### Tab: Contacts
- Table: First Name, Last Name, Position, Email, Phone, Primary (badge)
- Empty state: "No contacts registered"

#### Tab: Addresses
- Table: Type (billing/shipping), Line 1, Line 2, City, State/Province, Postal Code, Country, Primary
- Empty state: "No addresses registered"

#### Tab: Invoices (both types)
- 5 most recent invoices
- Table: Document Number, Date, Total Amount, Status (badge)
- Link to invoice detail page

#### Tab: Payments (both types)
- 5 most recent payments
- Table: Payment Number, Date, Amount, Direction (badge), Status
- Customer = inbound, Supplier = outbound

#### Tab: Purchase Orders (supplier only)
- 5 most recent POs
- Table: PO Number, Date, Total, Status (badge)

#### Tab: Ledger (supplier only)
- Full ledger from vendor-bills endpoint
- Table: Date, Reference, Description, Debit, Credit, Residual, Status

### 6. `apps/web/src/pages/customers.tsx`
Add after existing code:
```tsx
export function CustomerDetailPage() {
  const { partnerId } = useParams<{ partnerId: string }>();
  return <PartnerDetailPage partnerId={partnerId!} partnerType="customer" />;
}
```
Add import: `import { useParams } from 'react-router-dom';`
Add import: `import { PartnerDetailPage } from '@/pages/partners/PartnerDetailPage';`

### 7. `apps/web/src/pages/suppliers.tsx`
Same pattern as customers:
```tsx
export function SupplierDetailPage() {
  const { partnerId } = useParams<{ partnerId: string }>();
  return <PartnerDetailPage partnerId={partnerId!} partnerType="supplier" />;
}
```

### 8. `apps/web/src/App.tsx`
Add imports:
```
import PartnerDetailPage from '@/pages/partners/PartnerDetailPage';
```
Wait — PartnerDetailPage exports named `PartnerDetailPage` component, not default. So:
```
import { PartnerDetailPage, CustomerDetailPage, SupplierDetailPage } from '@/pages/partners/PartnerDetailPage';
```

Actually better to export named from PartnerDetailPage.tsx and import them individually from the wrapper pages.

Better approach: Keep PartnerDetailPage.tsx as a named export. In customers.tsx and suppliers.tsx, import and wrap it. Then App.tsx imports only from customers/suppliers.

So App.tsx needs:
```tsx
import { CustomersPage, CustomerDetailPage } from '@/pages/customers';
import { SuppliersPage, SupplierDetailPage } from '@/pages/suppliers';
```

Add routes after line 92:
```tsx
<Route path="/customers/:partnerId" element={<CustomerDetailPage />} />
```
After line 93:
```tsx
<Route path="/suppliers/:partnerId" element={<SupplierDetailPage />} />
```

### 9. `apps/web/src/components/partners/PartnersPage.tsx`
- Line ~14: Add `Eye` to lucide imports: `import { ..., Eye } from 'lucide-react';`
- Line ~57: Add `import { useNavigate } from 'react-router-dom';` (after useAuthStore import)
- Add `const navigate = useNavigate();` in PartnersList component
- In actions column (line 390-417): Add View button before Edit:

```tsx
<Button
  size="sm"
  variant="ghost"
  onClick={() => navigate(p.isCustomer ? `/customers/${p.id}` : `/suppliers/${p.id}`)}
  aria-label={`View ${p.name}`}
  title="View"
  className="h-8 w-8 p-0 hover:bg-gray-50 hover:text-gray-600"
>
  <Eye className="h-4 w-4" />
</Button>
```

## Verification
```bash
pnpm --filter @erp/api lint --fix
pnpm --filter @erp/web lint --fix
cd apps/web && npx tsc --noEmit
```
