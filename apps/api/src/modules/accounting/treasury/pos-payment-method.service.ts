import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../kernel/prisma/prisma.service';
import { TenantContextService } from '../../../kernel/tenancy/tenant-context.service';
import { ALLOWED_CATEGORIES_BY_METHOD, POS_TENDER_METHODS } from './tender-account';

/** Tile order in the Charge dialog. Anything unlisted sorts last. */
const KIND_ORDER = ['cash', 'mobile_money', 'card', 'bank', 'store_credit'];

/** Default lucide icon per kind when a method does not name its own. */
const KIND_ICON: Record<string, string> = {
  cash: 'Banknote', mobile_money: 'Smartphone', card: 'CreditCard', bank: 'Building2', store_credit: 'Gift',
};

const KIND_LABEL: Record<string, string> = {
  cash: 'Cash', mobile_money: 'Mobile Money', card: 'Card', bank: 'Bank', store_credit: 'Store Credit',
};

export interface PosPaymentMethodView {
  id: string;
  code: string;
  label: string;
  kind: string;
  provider: string | null;
  accountId: string | null;
  accountName: string | null;
  accountCode: string | null;
  icon: string;
  sortOrder: number;
  requiresReference: boolean;
  trackInShift: boolean;
  isActive: boolean;
  /** True when this row is synthesized from accounts, not stored config. */
  synthetic?: boolean;
}

export interface UpsertPosPaymentMethodDto {
  code?: string;
  label?: string;
  kind?: string;
  provider?: string | null;
  accountId?: string | null;
  icon?: string | null;
  sortOrder?: number;
  isActive?: boolean;
  requiresReference?: boolean;
  trackInShift?: boolean;
}

/**
 * Configuration binding a POS payment mode to the finance account the money
 * lands in.
 *
 * The cashier picks a mode (and a provider when a mode has several); this table
 * decides the account. Every write is validated against
 * `ALLOWED_CATEGORIES_BY_METHOD` — the same map `resolveTenderAccount` enforces
 * at posting time — so a saved tile can never produce a rejected tender.
 */
@Injectable()
export class PosPaymentMethodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
  ) {}

  /** Config listing: every non-deleted row, active or not. */
  async list(): Promise<PosPaymentMethodView[]> {
    const rows = await this.prisma.client.posPaymentMethod.findMany({
      where: { organizationId: this.tenant.organizationId, deletedAt: null },
      include: { account: { select: { id: true, code: true, name: true } } },
    });
    return this.sort(rows.map((r: any) => this.toView(r)));
  }

  /**
   * Tiles for the terminal: active rows only.
   *
   * When an organization has configured nothing yet the list is synthesized
   * from its existing accounts and mappings, so the Charge dialog is never
   * blank on an unconfigured org — the same set `PosService.paymentAccounts()`
   * has always exposed, just already bound to a mode.
   */
  async listForTerminal(): Promise<PosPaymentMethodView[]> {
    return terminalPaymentMethods(this.prisma.client, this.tenant.organizationId);
  }

  async create(dto: UpsertPosPaymentMethodDto): Promise<PosPaymentMethodView> {
    const orgId = this.tenant.organizationId;
    const code = (dto.code ?? '').trim();
    const label = (dto.label ?? '').trim();
    const kind = (dto.kind ?? '').trim();
    if (!code || !label) throw new BadRequestException('Code and label are required');
    if (!POS_TENDER_METHODS.includes(kind as any)) {
      throw new BadRequestException(`Payment kind must be one of ${POS_TENDER_METHODS.join(', ')}`);
    }
    const existing = await this.prisma.client.posPaymentMethod.findFirst({ where: { organizationId: orgId, code } });
    if (existing) throw new BadRequestException('A payment method with this code already exists');
    const accountId = await this.validateAccount(kind, dto.accountId ?? null);
    const row = await this.prisma.client.posPaymentMethod.create({
      data: {
        organizationId: orgId,
        code, label, kind,
        provider: dto.provider?.trim() || null,
        accountId,
        icon: dto.icon?.trim() || null,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        // Default off: a reference is prompted at the till, never demanded — a
        // sale must never be blocked on a number the customer has not read out yet.
        requiresReference: dto.requiresReference ?? false,
        // Physical drawer cash is counted on its own; never as a wallet balance.
        trackInShift: kind === 'cash' ? false : dto.trackInShift ?? true,
      },
      include: { account: { select: { id: true, code: true, name: true } } },
    });
    return this.toView(row);
  }

  async update(id: string, dto: UpsertPosPaymentMethodDto): Promise<PosPaymentMethodView> {
    const orgId = this.tenant.organizationId;
    const current = await this.prisma.client.posPaymentMethod.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!current) throw new NotFoundException('Payment method not found');
    const kind = (dto.kind ?? current.kind).trim();
    if (!POS_TENDER_METHODS.includes(kind as any)) {
      throw new BadRequestException(`Payment kind must be one of ${POS_TENDER_METHODS.join(', ')}`);
    }
    const accountId = await this.validateAccount(kind, dto.accountId !== undefined ? dto.accountId : current.accountId);
    if (dto.isActive === false || (dto.kind && dto.kind !== 'cash' && current.kind === 'cash')) {
      await this.assertNotLastCashMethod(current);
    }
    if (dto.code !== undefined && dto.code.trim() !== current.code) {
      const clash = await this.prisma.client.posPaymentMethod.findFirst({
        where: { organizationId: orgId, code: dto.code.trim(), id: { not: id } },
      });
      if (clash) throw new BadRequestException('A payment method with this code already exists');
    }
    const row = await this.prisma.client.posPaymentMethod.update({
      where: { id },
      data: {
        code: dto.code?.trim(),
        label: dto.label?.trim(),
        kind,
        provider: dto.provider !== undefined ? dto.provider?.trim() || null : undefined,
        accountId,
        icon: dto.icon !== undefined ? dto.icon?.trim() || null : undefined,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
        requiresReference: dto.requiresReference,
        trackInShift: kind === 'cash' ? false : dto.trackInShift,
      },
      include: { account: { select: { id: true, code: true, name: true } } },
    });
    return this.toView(row);
  }

  /** Soft-retire. History keeps referring to the account, not to this row. */
  async remove(id: string) {
    const orgId = this.tenant.organizationId;
    const current = await this.prisma.client.posPaymentMethod.findFirst({ where: { id, organizationId: orgId, deletedAt: null } });
    if (!current) throw new NotFoundException('Payment method not found');
    await this.assertNotLastCashMethod(current);
    return this.prisma.client.posPaymentMethod.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
  }

  /**
   * The account must exist, be usable, and its category must be one the posting
   * engine accepts for this kind. Cash is the exception: the register's own
   * drawer account wins at post time, so a cash tile carries no account.
   */
  private async validateAccount(kind: string, accountId: string | null): Promise<string | null> {
    const orgId = this.tenant.organizationId;
    if (kind === 'cash') return null;
    if (!accountId) throw new BadRequestException(`A ${KIND_LABEL[kind] ?? kind} payment method needs a receiving account`);
    const account = await this.prisma.client.account.findFirst({
      where: { id: accountId, organizationId: orgId, isActive: true, deletedAt: null },
      include: { category: true },
    });
    if (!account) throw new BadRequestException('Receiving account is inactive or unavailable');
    const allowed = ALLOWED_CATEGORIES_BY_METHOD[kind] ?? [];
    const category = (account as any).category?.key;
    if (!allowed.includes(category)) {
      throw new BadRequestException(`${account.name} is not a ${KIND_LABEL[kind] ?? kind} account`);
    }
    // Mirrors resolveTenderAccount: a card tile on a plain current asset must be
    // THE configured clearing account, not any current asset that happens to exist.
    if (kind === 'card' && category === 'current_asset') {
      const clearing = await this.prisma.client.accountMapping.findFirst({ where: { organizationId: orgId, key: 'card_clearing' } });
      if (clearing?.accountId !== account.id) {
        throw new BadRequestException('Card clearing must use the account configured under the card_clearing mapping');
      }
    }
    return account.id;
  }

  /** A terminal with no cash tile cannot take money at the counter. */
  private async assertNotLastCashMethod(current: { id: string; kind: string }) {
    if (current.kind !== 'cash') return;
    const others = await this.prisma.client.posPaymentMethod.count({
      where: { organizationId: this.tenant.organizationId, deletedAt: null, isActive: true, kind: 'cash', id: { not: current.id } },
    });
    if (!others) throw new BadRequestException('The last cash payment method cannot be removed — the terminal must always be able to take cash');
  }

  private sort(rows: PosPaymentMethodView[]) {
    return sortMethods(rows);
  }

  private toView(row: any): PosPaymentMethodView {
    return toView(row);
  }
}

/**
 * The payment methods the terminal offers: stored configuration when the org
 * has any, otherwise the legacy shape synthesized from accounts. Shift close
 * uses the same list, so the accounts a cashier is asked to count are exactly
 * the accounts the server requires.
 */
export async function terminalPaymentMethods(client: any, orgId: string): Promise<PosPaymentMethodView[]> {
  const rows = await client.posPaymentMethod.findMany({
    where: { organizationId: orgId, deletedAt: null, isActive: true },
    include: { account: { select: { id: true, code: true, name: true } } },
  });
  if (rows.length) return sortMethods(rows.map((r: any) => toView(r)));
  return synthesize(client, orgId);
}

/**
 * Legacy shape for an org that has not configured anything: one cash tile,
 * one tile per mobile-money / bank account, and the mapped card-clearing
 * account. Ids are prefixed so they cannot be mistaken for stored rows.
 */
async function synthesize(client: any, orgId: string): Promise<PosPaymentMethodView[]> {
  const accounts = await client.account.findMany({
    where: {
      organizationId: orgId, isActive: true, deletedAt: null,
      category: { key: { in: ['bank', 'mobile_money', 'current_asset'] } },
    },
    include: { category: true },
    orderBy: { code: 'asc' },
  });
  const clearing = await client.accountMapping.findFirst({ where: { organizationId: orgId, key: 'card_clearing' } });
  const out: PosPaymentMethodView[] = [{
    id: 'synthetic:cash', code: 'cash', label: 'Cash', kind: 'cash', provider: null,
    accountId: null, accountName: null, accountCode: null, icon: KIND_ICON.cash,
    sortOrder: 0, requiresReference: false, trackInShift: false, isActive: true, synthetic: true,
  }];
  for (const account of accounts as any[]) {
    const key = account.category?.key;
    // A current asset is only ever the card clearing account, never a tile of its own.
    const kind = key === 'current_asset' ? 'card' : key;
    if (key === 'current_asset' && account.id !== clearing?.accountId) continue;
    out.push({
      id: `synthetic:${account.id}`, code: `${kind}_${account.code}`,
      label: key === 'current_asset' ? 'Card' : account.name,
      kind, provider: key === 'mobile_money' || key === 'bank' ? account.name : null,
      accountId: account.id, accountName: account.name, accountCode: account.code,
      icon: KIND_ICON[kind] ?? 'Wallet', sortOrder: 0,
      requiresReference: kind === 'mobile_money' || kind === 'bank',
      trackInShift: true, isActive: true, synthetic: true,
    });
  }
  // A bank account also backs card payments when no clearing account is mapped.
  if (!clearing?.accountId) {
    const bank = (accounts as any[]).find((a) => a.category?.key === 'bank');
    if (bank) {
      out.push({
        id: `synthetic:card:${bank.id}`, code: `card_${bank.code}`, label: 'Card',
        kind: 'card', provider: null, accountId: bank.id, accountName: bank.name, accountCode: bank.code,
        icon: KIND_ICON.card, sortOrder: 0, requiresReference: false, trackInShift: true, isActive: true, synthetic: true,
      });
    }
  }
  return sortMethods(out);
}

function sortMethods(rows: PosPaymentMethodView[]) {
  const rank = (kind: string) => { const i = KIND_ORDER.indexOf(kind); return i === -1 ? KIND_ORDER.length : i; };
  return rows.sort((a, b) =>
    rank(a.kind) - rank(b.kind) || a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

function toView(row: any): PosPaymentMethodView {
  return {
    id: row.id, code: row.code, label: row.label, kind: row.kind, provider: row.provider ?? null,
    accountId: row.accountId ?? null,
    accountName: row.account?.name ?? null,
    accountCode: row.account?.code ?? null,
    icon: row.icon || KIND_ICON[row.kind] || 'Wallet',
    sortOrder: row.sortOrder ?? 0,
    requiresReference: !!row.requiresReference,
    trackInShift: !!row.trackInShift,
    isActive: !!row.isActive,
  };
}
