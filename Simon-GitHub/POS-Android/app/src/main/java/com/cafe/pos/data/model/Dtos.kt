package com.cafe.pos.data.model

import com.squareup.moshi.Json
import com.squareup.moshi.JsonClass

/* ===== Auth ===== */

@JsonClass(generateAdapter = true)
data class LoginRequest(
    @Json(name = "organizationCode") val organizationCode: String,
    @Json(name = "email") val email: String,
    @Json(name = "password") val password: String,
)

@JsonClass(generateAdapter = true)
data class LoginResponse(
    @Json(name = "accessToken") val accessToken: String? = null,
    @Json(name = "refreshToken") val refreshToken: String? = null,
    @Json(name = "mfaToken") val mfaToken: String? = null,
    @Json(name = "requiresMfa") val requiresMfa: Boolean = false,
    @Json(name = "user") val user: AuthUser? = null,
    @Json(name = "permissions") val permissions: List<String>? = null,
)

@JsonClass(generateAdapter = true)
data class AuthUser(
    @Json(name = "id") val id: String,
    @Json(name = "email") val email: String,
    @Json(name = "firstName") val firstName: String,
    @Json(name = "lastName") val lastName: String? = null,
    @Json(name = "roles") val roles: List<String> = emptyList(),
    @Json(name = "mfaEnrolled") val mfaEnrolled: Boolean = false,
)

@JsonClass(generateAdapter = true)
data class MfaLoginRequest(
    @Json(name = "mfaToken") val mfaToken: String,
    @Json(name = "code") val code: String,
)

@JsonClass(generateAdapter = true)
data class RefreshRequest(
    @Json(name = "refreshToken") val refreshToken: String,
)

/* ===== Catalog ===== */

@JsonClass(generateAdapter = true)
data class ProductDto(
    @Json(name = "id") val id: String,
    @Json(name = "code") val code: String,
    @Json(name = "sku") val sku: String? = null,
    @Json(name = "name") val name: String,
    @Json(name = "productType") val productType: String = "stockable",
    @Json(name = "salesPrice") val salesPrice: String? = null,
    @Json(name = "categoryId") val categoryId: String? = null,
    @Json(name = "category") val category: CategoryDto? = null,
    @Json(name = "isActive") val isActive: Boolean = true,
)

@JsonClass(generateAdapter = true)
data class CategoryDto(
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,
)

@JsonClass(generateAdapter = true)
data class PaginatedProducts(
    @Json(name = "data") val data: List<ProductDto> = emptyList(),
    @Json(name = "total") val total: Int = 0,
    @Json(name = "page") val page: Int = 1,
    @Json(name = "pageSize") val pageSize: Int = 0,
)

/* ===== Cart / Checkout ===== */

@JsonClass(generateAdapter = true)
data class CheckoutLineDto(
    @Json(name = "productId") val productId: String? = null,
    @Json(name = "sku") val sku: String? = null,
    @Json(name = "description") val description: String,
    @Json(name = "quantity") val quantity: Double,
    @Json(name = "unitPrice") val unitPrice: Double,
    @Json(name = "taxId") val taxId: String? = null,
    @Json(name = "discountPercent") val discountPercent: Double = 0.0,
    @Json(name = "note") val note: String? = null,
    @Json(name = "comboId") val comboId: String? = null,
)

@JsonClass(generateAdapter = true)
data class PaymentTenderDto(
    @Json(name = "method") val method: String,  // cash | bank | card | mobile_money | store_credit
    @Json(name = "amount") val amount: Double,
    @Json(name = "reference") val reference: String? = null,
)

@JsonClass(generateAdapter = true)
data class CheckoutRequest(
    @Json(name = "partnerId") val partnerId: String? = null,
    @Json(name = "lines") val lines: List<CheckoutLineDto>,
    @Json(name = "transactionDiscountPercent") val transactionDiscountPercent: Double = 0.0,
    @Json(name = "overrideById") val overrideById: String? = null,
    @Json(name = "tenders") val tenders: List<PaymentTenderDto>? = null,
    @Json(name = "paymentMethod") val paymentMethod: String? = null,
    @Json(name = "amountTendered") val amountTendered: Double? = null,
    @Json(name = "cashSessionId") val cashSessionId: String? = null,
    @Json(name = "branchId") val branchId: String? = null,
    @Json(name = "reference") val reference: String? = null,
    @Json(name = "notes") val notes: String? = null,
)

@JsonClass(generateAdapter = true)
data class CheckoutResult(
    @Json(name = "invoiceId") val invoiceId: String,
    @Json(name = "invoiceNumber") val invoiceNumber: String,
    @Json(name = "paymentIds") val paymentIds: List<String> = emptyList(),
    @Json(name = "total") val total: Double,
    @Json(name = "change") val change: Double = 0.0,
    @Json(name = "lowStock") val lowStock: List<LowStockWarning>? = null,
)

@JsonClass(generateAdapter = true)
data class LowStockWarning(
    @Json(name = "productId") val productId: String,
    @Json(name = "productName") val productName: String,
    @Json(name = "onHand") val onHand: Double,
    @Json(name = "requested") val requested: Double,
)

@JsonClass(generateAdapter = true)
data class RefundRequest(
    @Json(name = "invoiceId") val invoiceId: String,
    @Json(name = "reason") val reason: String? = null,
    @Json(name = "cashSessionId") val cashSessionId: String? = null,
    @Json(name = "overrideById") val overrideById: String? = null,
)

/* ===== Holds ===== */

@JsonClass(generateAdapter = true)
data class PosHoldDto(
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,
    @Json(name = "status") val status: String,  // open | recalled | cancelled
    @Json(name = "totalAmount") val totalAmount: String,
    @Json(name = "partnerId") val partnerId: String? = null,
    @Json(name = "branchId") val branchId: String? = null,
    @Json(name = "cashSessionId") val cashSessionId: String? = null,
    @Json(name = "notes") val notes: String? = null,
    @Json(name = "createdAt") val createdAt: String,
    @Json(name = "lines") val lines: List<PosHoldLineDto> = emptyList(),
)

@JsonClass(generateAdapter = true)
data class PosHoldLineDto(
    @Json(name = "id") val id: String,
    @Json(name = "productId") val productId: String? = null,
    @Json(name = "description") val description: String,
    @Json(name = "quantity") val quantity: String,
    @Json(name = "unitPrice") val unitPrice: String,
    @Json(name = "discountPercent") val discountPercent: String,
    @Json(name = "taxId") val taxId: String? = null,
    @Json(name = "lineNumber") val lineNumber: Int,
    @Json(name = "note") val note: String? = null,
)

@JsonClass(generateAdapter = true)
data class CreateHoldRequest(
    @Json(name = "name") val name: String,
    @Json(name = "notes") val notes: String? = null,
    @Json(name = "lines") val lines: List<CheckoutLineDto>,
    @Json(name = "partnerId") val partnerId: String? = null,
    @Json(name = "branchId") val branchId: String? = null,
    @Json(name = "cashSessionId") val cashSessionId: String? = null,
)

@JsonClass(generateAdapter = true)
data class UpdateHoldNotesRequest(
    @Json(name = "notes") val notes: String,
)

/* ===== Override (manager) ===== */

@JsonClass(generateAdapter = true)
data class OverrideVerifyRequest(
    @Json(name = "email") val email: String,
    @Json(name = "pin") val pin: String? = null,
    @Json(name = "password") val password: String? = null,
    @Json(name = "overrideKind") val overrideKind: String,  // discount | void | manual_refund
)

@JsonClass(generateAdapter = true)
data class OverrideVerifyResult(
    @Json(name = "managerId") val managerId: String,
    @Json(name = "managerName") val managerName: String,
    @Json(name = "managerEmail") val managerEmail: String,
    @Json(name = "overrideKind") val overrideKind: String,
)

/* ===== Reports ===== */

@JsonClass(generateAdapter = true)
data class XReport(
    @Json(name = "asOf") val asOf: String,
    @Json(name = "cashSession") val cashSession: CashSessionRef? = null,
    @Json(name = "totals") val totals: XTotals,
    @Json(name = "byMethod") val byMethod: List<PaymentMethodTotal> = emptyList(),
    @Json(name = "byCategory") val byCategory: List<CategoryTotal> = emptyList(),
)

@JsonClass(generateAdapter = true)
data class CashSessionRef(
    @Json(name = "id") val id: String,
    @Json(name = "cashRegisterId") val cashRegisterId: String,
    @Json(name = "userId") val userId: String? = null,
    @Json(name = "openedAt") val openedAt: String? = null,
    @Json(name = "openingFloat") val openingFloat: String,
)

@JsonClass(generateAdapter = true)
data class XTotals(
    @Json(name = "saleCount") val saleCount: Int,
    @Json(name = "salesTotal") val salesTotal: String,
    @Json(name = "refundsTotal") val refundsTotal: String,
    @Json(name = "netSales") val netSales: String,
    @Json(name = "overridesTotal") val overridesTotal: String,
    @Json(name = "payInsTotal") val payInsTotal: String,
    @Json(name = "payOutsTotal") val payOutsTotal: String,
    @Json(name = "expectedCash") val expectedCash: String,
)

@JsonClass(generateAdapter = true)
data class PaymentMethodTotal(
    @Json(name = "method") val method: String,
    @Json(name = "count") val count: Int,
    @Json(name = "total") val total: String,
)

@JsonClass(generateAdapter = true)
data class CategoryTotal(
    @Json(name = "categoryId") val categoryId: String? = null,
    @Json(name = "categoryName") val categoryName: String,
    @Json(name = "count") val count: Int,
    @Json(name = "total") val total: String,
)

@JsonClass(generateAdapter = true)
data class HourlyReport(
    @Json(name = "date") val date: String,
    @Json(name = "buckets") val buckets: List<HourlyBucket>,
)

@JsonClass(generateAdapter = true)
data class HourlyBucket(
    @Json(name = "hour") val hour: Int,
    @Json(name = "count") val count: Int,
    @Json(name = "total") val total: String,
)

@JsonClass(generateAdapter = true)
data class TopItemRow(
    @Json(name = "productId") val productId: String,
    @Json(name = "name") val name: String,
    @Json(name = "sku") val sku: String? = null,
    @Json(name = "quantity") val quantity: Double,
    @Json(name = "total") val total: String,
)

/* ===== KDS ===== */

@JsonClass(generateAdapter = true)
data class KdsTicketDto(
    @Json(name = "id") val id: String,
    @Json(name = "orderId") val orderId: String,
    @Json(name = "status") val status: String,  // queued | in_progress | ready | done
    @Json(name = "channel") val channel: String? = null,
    @Json(name = "tableNumber") val tableNumber: String? = null,
    @Json(name = "notes") val notes: String? = null,
    @Json(name = "createdAt") val createdAt: String,
    @Json(name = "lines") val lines: List<KdsTicketLineDto> = emptyList(),
)

@JsonClass(generateAdapter = true)
data class KdsTicketLineDto(
    @Json(name = "id") val id: String,
    @Json(name = "description") val description: String,
    @Json(name = "quantity") val quantity: Double,
    @Json(name = "note") val note: String? = null,
    @Json(name = "modifiers") val modifiers: List<String> = emptyList(),
)

@JsonClass(generateAdapter = true)
data class KdsTransitionRequest(
    @Json(name = "status") val status: String,
)

/* ===== Modifiers / Combos ===== */

@JsonClass(generateAdapter = true)
data class ModifierGroupDto(
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,
    @Json(name = "required") val required: Boolean = false,
    @Json(name = "multiSelect") val multiSelect: Boolean = false,
    @Json(name = "minSelect") val minSelect: Int = 0,
    @Json(name = "maxSelect") val maxSelect: Int = 1,
    @Json(name = "modifiers") val modifiers: List<ModifierDto> = emptyList(),
)

@JsonClass(generateAdapter = true)
data class ModifierDto(
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,
    @Json(name = "priceDelta") val priceDelta: Double = 0.0,
    @Json(name = "isDefault") val isDefault: Boolean = false,
)

@JsonClass(generateAdapter = true)
data class ComboDto(
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,
    @Json(name = "price") val price: Double,
    @Json(name = "items") val items: List<ComboItemDto> = emptyList(),
)

@JsonClass(generateAdapter = true)
data class ComboItemDto(
    @Json(name = "productId") val productId: String,
    @Json(name = "name") val name: String,
    @Json(name = "quantity") val quantity: Double,
)

/* ===== Loyalty ===== */

@JsonClass(generateAdapter = true)
data class LoyaltyProgramDto(
    @Json(name = "id") val id: String,
    @Json(name = "name") val name: String,
    @Json(name = "earnRate") val earnRate: Double = 1.0,
    @Json(name = "redeemRate") val redeemRate: Double = 0.01,
    @Json(name = "minRedeemPoints") val minRedeemPoints: Int = 100,
    @Json(name = "active") val active: Boolean = true,
)

@JsonClass(generateAdapter = true)
data class LoyaltyBalanceDto(
    @Json(name = "partnerId") val partnerId: String,
    @Json(name = "points") val points: Int,
    @Json(name = "lifetimeEarned") val lifetimeEarned: Int,
)

@JsonClass(generateAdapter = true)
data class LoyaltyEarnRequest(
    @Json(name = "partnerId") val partnerId: String,
    @Json(name = "saleAmount") val saleAmount: Double,
    @Json(name = "invoiceId") val invoiceId: String? = null,
)

@JsonClass(generateAdapter = true)
data class LoyaltyRedeemRequest(
    @Json(name = "partnerId") val partnerId: String,
    @Json(name = "points") val points: Int,
    @Json(name = "invoiceId") val invoiceId: String? = null,
)

/* ===== Generic ===== */

@JsonClass(generateAdapter = true)
data class ApiError(
    @Json(name = "statusCode") val statusCode: Int? = null,
    @Json(name = "message") val message: Any? = null,
    @Json(name = "error") val error: String? = null,
)

/* ===== Cash session / shift ===== */

@JsonClass(generateAdapter = true)
data class CashRegisterDto(
    @Json(name = "id") val id: String,
    @Json(name = "code") val code: String,
    @Json(name = "name") val name: String,
    @Json(name = "defaultAccountId") val defaultAccountId: String? = null,
    @Json(name = "locationId") val locationId: String? = null,
    @Json(name = "isActive") val isActive: Boolean = true,
)

@JsonClass(generateAdapter = true)
data class PaginatedCashRegisters(
    @Json(name = "data") val data: List<CashRegisterDto> = emptyList(),
    @Json(name = "total") val total: Int = 0,
)

@JsonClass(generateAdapter = true)
data class CashSessionDto(
    @Json(name = "id") val id: String,
    @Json(name = "cashRegisterId") val cashRegisterId: String,
    @Json(name = "userId") val userId: String? = null,
    @Json(name = "status") val status: String,                   // 'open' | 'closed'
    @Json(name = "openingFloat") val openingFloat: String = "0",
    @Json(name = "closingCounted") val closingCounted: String? = null,
    @Json(name = "closingExpected") val closingExpected: String? = null,
    @Json(name = "closingDifference") val closingDifference: String? = null,
    @Json(name = "openedAt") val openedAt: String? = null,
    @Json(name = "closedAt") val closedAt: String? = null,
    @Json(name = "notes") val notes: String? = null,
    @Json(name = "cashRegister") val cashRegister: CashRegisterRef? = null,
)

@JsonClass(generateAdapter = true)
data class CashRegisterRef(
    @Json(name = "id") val id: String,
    @Json(name = "code") val code: String,
    @Json(name = "name") val name: String,
)

@JsonClass(generateAdapter = true)
data class OpenSessionRequest(
    @Json(name = "cashRegisterId") val cashRegisterId: String,
    @Json(name = "openingFloat") val openingFloat: Double = 0.0,
    @Json(name = "notes") val notes: String? = null,
)

@JsonClass(generateAdapter = true)
data class CloseSessionRequest(
    @Json(name = "closingCounted") val closingCounted: Double,
    @Json(name = "notes") val notes: String? = null,
)

@JsonClass(generateAdapter = true)
data class ExpectedCashDto(
    @Json(name = "sessionId") val sessionId: String,
    @Json(name = "expectedCash") val expectedCash: String,
)