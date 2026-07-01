import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../kernel/tenancy/tenant-context.service';
import { OneTimeTokenService } from '../../kernel/auth/one-time-token.service';
import { EventBus } from '../../kernel/events/event-bus';
import { AuditService } from '../../kernel/audit/audit.service';
import { NotificationsService } from '../../kernel/notifications/notifications.service';
import { FeatureFlagsService } from '../../kernel/feature-flags/feature-flags.service';

/**
 * F.5 — Tenant self-service.
 *
 * A super-admin (no tenant context) can create a new Organization and a
 * bootstrap admin user via `bootstrap()`. The new admin receives an invite
 * token they redeem at `/auth/accept-invite`. Subsequent tenant-internal
 * operations stay inside the new tenant context.
 *
 * This unblocks paying customers who today cannot create an org without
 * running `prisma db seed`.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly tokens: OneTimeTokenService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly flags: FeatureFlagsService,
  ) {}

  /**
   * Public bootstrap: create a new tenant + bootstrap admin user. In a true
   * multi-tenant SaaS this is gated behind billing. For now, it is the
   * documented entry point for the demo.
   */
  async bootstrap(params: {
    organizationCode: string;
    organizationName: string;
    timezone?: string;
    currencyCode?: string;
    adminEmail: string;
    adminFirstName: string;
    adminLastName?: string;
    adminPassword?: string; // optional; if absent, an invite token is emailed
  }) {
    if (!/^[a-z0-9-]{2,32}$/i.test(params.organizationCode)) {
      throw new BadRequestException('organizationCode must be 2-32 chars, letters/digits/hyphens');
    }
    const existing = await this.prisma.raw.organization.findUnique({ where: { code: params.organizationCode } });
    if (existing) throw new ConflictException(`Organization '${params.organizationCode}' already exists`);

    const passwordHash = params.adminPassword
      ? await bcrypt.hash(params.adminPassword, 10)
      : await bcrypt.hash(randomPassword(), 10);

    const org = await this.prisma.raw.organization.create({
      data: {
        code: params.organizationCode,
        name: params.organizationName,
        currencyCode: params.currencyCode ?? 'USD',
        timezone: params.timezone ?? 'UTC',
      },
    });

    // Seed the standard chart of accounts and journals for this org.
    await this.seedChartOfAccounts(org.id);
    await this.seedJournals(org.id);
    await this.seedAdminRoleAndMappings(org.id);

    // Create the admin user (no tenant context yet).
    const user = await this.prisma.raw.user.create({
      data: {
        organizationId: org.id,
        email: params.adminEmail.toLowerCase(),
        passwordHash,
        firstName: params.adminFirstName,
        lastName: params.adminLastName ?? null,
      },
    });
    const adminRole = await this.prisma.raw.role.findUnique({
      where: { organizationId_name: { organizationId: org.id, name: 'Administrator' } },
    });
    if (adminRole) {
      await this.prisma.raw.user.update({
        where: { id: user.id },
        data: { roles: { connect: [{ id: adminRole.id }] } },
      });
    }
    // Open the current fiscal period.
    const year = new Date().getUTCFullYear();
    await this.prisma.raw.fiscalPeriod.create({
      data: {
        organizationId: org.id,
        name: `FY${year}`,
        startDate: new Date(Date.UTC(year, 0, 1)),
        endDate: new Date(Date.UTC(year, 11, 31)),
        status: 'open',
      },
    });

    let inviteToken: string | undefined;
    if (!params.adminPassword) {
      inviteToken = await this.tokens.issue({
        purpose: 'invite',
        userId: user.id,
        organizationId: org.id,
      });
      await this.notifications.send({
        organizationId: org.id,
        userId: user.id,
        channel: 'email',
        category: 'auth',
        title: 'You have been invited to ' + params.organizationName,
        body: 'Use the link in this email to set your password and sign in.',
        payload: { token: inviteToken, kind: 'invite' },
      });
    }

    return {
      organization: { id: org.id, code: org.code, name: org.name },
      adminUser: { id: user.id, email: user.email },
      inviteToken,
    };
  }

  /** Accept an invite token + set password. */
  async acceptInvite(token: string, newPassword: string) {
    const consumed = await this.tokens.consume(token, 'invite');
    if (!consumed) throw new BadRequestException('Invalid or expired invite token');
    const hash = await bcrypt.hash(newPassword, 10);
    await this.prisma.raw.user.update({
      where: { id: consumed.userId },
      data: { passwordHash: hash, isActive: true, failedLoginCount: 0, lockedUntil: null },
    });
    return { ok: true };
  }

  /** Update organization-level settings (current user must be admin). */
  async updateSettings(patch: { name?: string; timezone?: string; currencyCode?: string; settings?: Record<string, unknown> }) {
    const orgId = this.tenant.organizationId;
    return this.prisma.client.organization.update({
      where: { id: orgId },
      data: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.currencyCode !== undefined ? { currencyCode: patch.currencyCode } : {}),
        ...(patch.settings !== undefined ? { settings: patch.settings as any } : {}),
      },
    });
  }

  /** Invite a new user to the current organization. */
  async inviteUser(params: { email: string; firstName: string; lastName?: string; roleId?: string }) {
    const orgId = this.tenant.organizationId;
    const existing = await this.prisma.raw.user.findUnique({
      where: { organizationId_email: { organizationId: orgId, email: params.email.toLowerCase() } },
    });
    if (existing) throw new ConflictException('A user with this email already exists in your organization');
    const passwordHash = await bcrypt.hash(randomPassword(), 10);
    const user = await this.prisma.raw.user.create({
      data: {
        organizationId: orgId,
        email: params.email.toLowerCase(),
        passwordHash,
        firstName: params.firstName,
        lastName: params.lastName ?? null,
        ...(params.roleId ? { roles: { connect: [{ id: params.roleId }] } } : {}),
      },
    });
    const token = await this.tokens.issue({ purpose: 'invite', userId: user.id, organizationId: orgId });
    await this.notifications.send({
      organizationId: orgId,
      userId: user.id,
      channel: 'email',
      category: 'auth',
      title: 'You have been invited',
      body: 'Click the link to set your password.',
      payload: { token, kind: 'invite' },
    });
    return { id: user.id, email: user.email, inviteToken: token };
  }

  private async seedChartOfAccounts(orgId: string) {
    const defs = [
      { code: '1000', name: 'Assets', accountType: 'asset', isGroup: true },
      { code: '1100', name: 'Cash', accountType: 'cash' },
      { code: '1200', name: 'Bank', accountType: 'bank' },
      { code: '1300', name: 'Accounts Receivable', accountType: 'receivable' },
      { code: '1400', name: 'Inventory / Stock Valuation', accountType: 'asset' },
      { code: '1450', name: 'Input VAT Receivable', accountType: 'asset' },
      { code: '2000', name: 'Liabilities', accountType: 'liability', isGroup: true },
      { code: '2100', name: 'Accounts Payable', accountType: 'payable' },
      { code: '2150', name: 'Goods Received Not Invoiced (GRNI)', accountType: 'liability' },
      { code: '2200', name: 'Tax Payable', accountType: 'tax' },
      { code: '3000', name: 'Equity', accountType: 'equity', isGroup: true },
      { code: '3100', name: 'Retained Earnings', accountType: 'equity' },
      { code: '4000', name: 'Revenue', accountType: 'revenue', isGroup: true },
      { code: '4100', name: 'Sales Revenue', accountType: 'revenue' },
      { code: '4200', name: 'Stock Adjustment Income', accountType: 'revenue' },
      { code: '5000', name: 'Expenses', accountType: 'expense', isGroup: true },
      { code: '5100', name: 'Cost of Goods Sold', accountType: 'cost_of_goods_sold' },
      { code: '5200', name: 'Operating Expenses', accountType: 'expense' },
      { code: '5300', name: 'Stock Adjustment Expense', accountType: 'expense' },
    ] as const;
    const ids: Record<string, string> = {};
    for (const a of defs) {
      const row = await this.prisma.raw.account.create({
        data: {
          organizationId: orgId,
          code: a.code,
          name: a.name,
          accountType: a.accountType as any,
          isGroup: 'isGroup' in a ? a.isGroup : false,
        },
      });
      ids[a.code] = row.id;
    }
    return ids;
  }

  private async seedJournals(orgId: string) {
    const journals = [
      { code: 'GEN', name: 'General Journal', journalType: 'general' },
      { code: 'SALES', name: 'Sales Journal', journalType: 'sales' },
      { code: 'PURCH', name: 'Purchase Journal', journalType: 'purchase' },
      { code: 'CASH', name: 'Cash Journal', journalType: 'cash' },
      { code: 'BANK', name: 'Bank Journal', journalType: 'bank' },
      { code: 'INV', name: 'Inventory Journal', journalType: 'general' },
      { code: 'ADJ', name: 'Adjustment Journal', journalType: 'adjustment' },
    ] as const;
    for (const j of journals) {
      await this.prisma.raw.journal.create({
        data: { organizationId: orgId, code: j.code, name: j.name, journalType: j.journalType as any },
      });
    }
  }

  private async seedAdminRoleAndMappings(orgId: string) {
    const accountMap: Record<string, string> = {};
    const accounts = await this.prisma.raw.account.findMany({ where: { organizationId: orgId } });
    for (const a of accounts) accountMap[a.code] = a.id;
    const mappingKeys: Array<[string, string | undefined]> = [
      ['accounts_receivable', accountMap['1300']],
      ['accounts_payable', accountMap['2100']],
      ['sales_revenue', accountMap['4100']],
      ['tax_payable', accountMap['2200']],
      ['tax_receivable', accountMap['1450']],
      ['default_cash', accountMap['1100']],
      ['default_bank', accountMap['1200']],
      ['default_expense', accountMap['5200']],
      ['retained_earnings', accountMap['3100']],
      ['stock_valuation', accountMap['1400']],
      ['cogs', accountMap['5100']],
      ['grni_accrued', accountMap['2150']],
      ['stock_adjustment_income', accountMap['4200']],
      ['stock_adjustment_expense', accountMap['5300']],
    ];
    for (const [key, accountId] of mappingKeys) {
      if (!accountId) continue;
      await this.prisma.raw.accountMapping.create({
        data: { organizationId: orgId, key, accountId },
      });
    }
    // Seed permissions catalog (global).
    const { ALL_PERMISSIONS } = await import('@erp/shared');
    for (const k of ALL_PERMISSIONS) {
      const [resource, action] = k.split(':');
      await this.prisma.raw.permission.upsert({
        where: { key: k },
        update: { resource, action },
        create: { key: k, resource, action },
      });
    }
    // Seed currencies (global).
    const currencies = [
      { code: 'USD', symbol: '$', name: 'US Dollar', decimalPlaces: 2 },
      { code: 'EUR', symbol: '€', name: 'Euro', decimalPlaces: 2 },
      { code: 'GBP', symbol: '£', name: 'British Pound', decimalPlaces: 2 },
      { code: 'UGX', symbol: 'USh', name: 'Ugandan Shilling', decimalPlaces: 0 },
      { code: 'KES', symbol: 'KSh', name: 'Kenyan Shilling', decimalPlaces: 2 },
      { code: 'INR', symbol: '₹', name: 'Indian Rupee', decimalPlaces: 2 },
    ];
    for (const c of currencies) {
      await this.prisma.raw.currency.upsert({ where: { code: c.code }, update: c, create: c });
    }
    // Create the admin role with all permissions.
    await this.prisma.raw.role.create({
      data: {
        organizationId: orgId,
        name: 'Administrator',
        description: 'Full platform access',
        isSystem: true,
        permissions: ALL_PERMISSIONS as unknown as string[],
      },
    });
    // Seed units of measure and tax defaults.
    const uoms = [
      { code: 'UNIT', name: 'Piece', category: 'unit', ratio: 1, isBase: true },
      { code: 'KG', name: 'Kilogram', category: 'weight', ratio: 1, isBase: true },
      { code: 'L', name: 'Liter', category: 'volume', ratio: 1, isBase: true },
      { code: 'HR', name: 'Hour', category: 'time', ratio: 1, isBase: true },
    ];
    for (const u of uoms) {
      await this.prisma.raw.unitOfMeasure.create({
        data: { organizationId: orgId, ...u } as any,
      });
    }
    await this.prisma.raw.tax.create({
      data: { organizationId: orgId, name: 'No Tax', code: 'NONE', type: 'vat', rate: 0 },
    });
    // Seed branch.
    await this.prisma.raw.branch.create({
      data: { organizationId: orgId, code: 'MAIN', name: 'Head Office' },
    });
  }
}

function randomPassword(): string {
  // 24 chars base64url — meets the password policy by accident (length > 8,
  // includes letters/digits/symbols when used as a one-time secret).
  return require('crypto').randomBytes(18).toString('base64url');
}
