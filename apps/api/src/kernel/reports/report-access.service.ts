import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  REPORT_CATALOG,
  REPORT_VISIBILITY_SETTING_KEY,
  defaultReportsForPermissions,
  isReportId,
  type ReportVisibilityConfig,
} from '@erp/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

/**
 * Per-role report visibility.
 *
 * The config is one org-level Setting row (`reports.visibility`) holding
 * `{ roles: { [roleId]: string[] } }`. A role absent from the map falls back to
 * "every report its permissions allow", so the feature is inert until an admin
 * configures something.
 *
 * The allow-list is intersected with the role's permissions on read: this is a
 * visibility layer on top of RBAC, never a way around it. The data endpoints
 * keep their own @RequirePermissions guards.
 */
@Injectable()
export class ReportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** The whole catalog, for the admin matrix. */
  catalog() {
    return { reports: REPORT_CATALOG };
  }

  private async readConfig(): Promise<ReportVisibilityConfig> {
    const row = await this.settings.get(REPORT_VISIBILITY_SETTING_KEY);
    const value = row?.value as Partial<ReportVisibilityConfig> | undefined;
    const roles = value && typeof value === 'object' ? (value.roles ?? {}) : {};
    return { version: 1, roles: roles as Record<string, string[]> };
  }

  /**
   * Reports a role effectively sees, plus whether the answer came from an
   * explicit configuration or the permission default.
   */
  private resolve(
    role: { permissions: string[] },
    configured: string[] | undefined,
  ): { reports: string[]; configured: boolean } {
    const allowedByPermission = new Set(defaultReportsForPermissions(role.permissions ?? []));
    if (!configured) return { reports: [...allowedByPermission], configured: false };
    return { reports: configured.filter((id) => allowedByPermission.has(id)), configured: true };
  }

  /** The admin matrix: every role with its effective + configured report ids. */
  async listRoleVisibility() {
    const [config, roles] = await Promise.all([
      this.readConfig(),
      this.prisma.client.role.findMany({ orderBy: [{ isSystem: 'desc' }, { name: 'asc' }] }),
    ]);
    return {
      roles: roles.map((role) => {
        const configured = config.roles[role.id];
        const resolved = this.resolve(role as any, configured);
        return {
          id: role.id,
          name: role.name,
          isSystem: role.isSystem,
          /** Reports the role can see today. */
          reports: resolved.reports,
          /** false = inheriting the permission default. */
          configured: resolved.configured,
          /** Reports the role's permissions allow at all — the rest stay off. */
          available: defaultReportsForPermissions((role as any).permissions ?? []),
        };
      }),
    };
  }

  /**
   * Replace a role's allow-list. `null` clears the override so the role goes
   * back to the permission default.
   */
  async setRoleVisibility(roleId: string, reports: string[] | null) {
    const role = await this.prisma.client.role.findFirst({ where: { id: roleId } });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);

    const config = await this.readConfig();
    if (reports === null) {
      delete config.roles[roleId];
    } else {
      const unknown = reports.filter((id) => !isReportId(id));
      if (unknown.length > 0) {
        throw new BadRequestException(`Unknown report id(s): ${unknown.join(', ')}`);
      }
      config.roles[roleId] = [...new Set(reports)];
    }
    await this.settings.set(REPORT_VISIBILITY_SETTING_KEY, config);

    const resolved = this.resolve(role as any, config.roles[roleId]);
    return {
      id: role.id,
      name: role.name,
      reports: resolved.reports,
      configured: resolved.configured,
      available: defaultReportsForPermissions((role as any).permissions ?? []),
    };
  }

  /**
   * Report ids visible to one user: the union over their roles. Additive, like
   * permissions themselves — a second role widens access, it never narrows it.
   */
  async reportsForUser(userId: string | undefined): Promise<string[]> {
    if (!userId) return [];
    const user = await this.prisma.client.user.findFirst({
      where: { id: userId, isActive: true },
      include: { roles: true },
    });
    if (!user) return [];

    const config = await this.readConfig();
    const visible = new Set<string>();
    for (const role of user.roles as any[]) {
      for (const id of this.resolve(role, config.roles[role.id]).reports) visible.add(id);
    }
    return [...visible];
  }
}
