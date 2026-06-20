import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AuditService } from '../audit/audit.service';
import { EventBus } from '../events/event-bus';
import { JwtTokenService, type AuthUser } from './jwt-token.service';
import { PasswordService } from './password.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';

interface UserWithRoles {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  passwordHash: string;
  roles: { name: string; permissions: string[] }[];
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantContextService,
    private readonly jwt: JwtTokenService,
    private readonly password: PasswordService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async login(dto: LoginDto) {
    // Organization is a global table → resolvable without a tenant context.
    const org = await this.prisma.client.organization.findUnique({
      where: { code: dto.organizationCode },
    });
    if (!org || org.status !== 'active') {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.tenant.run({ organizationId: org.id }, async () => {
      const user = (await this.prisma.client.user.findFirst({
        where: { email: dto.email, isActive: true },
        include: { roles: true },
      })) as UserWithRoles | null;

      if (!user || !(await this.password.compare(dto.password, user.passwordHash))) {
        throw new UnauthorizedException('Invalid credentials');
      }

      await this.prisma.client.user.updateMany({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
      await this.audit.record({ entity: 'User', entityId: user.id, action: 'login' });

      return this.issueTokens(user, org.id);
    });
  }

  async refresh(dto: RefreshDto) {
    const payload = this.jwt.verifyRefresh(dto.refreshToken);
    return this.tenant.run({ organizationId: payload.organizationId }, async () => {
      const user = (await this.prisma.client.user.findFirst({
        where: { id: payload.sub, isActive: true },
        include: { roles: true },
      })) as UserWithRoles | null;
      if (!user) throw new UnauthorizedException('User no longer active');
      return this.issueTokens(user, payload.organizationId);
    });
  }

  async me(auth: AuthUser) {
    const user = (await this.prisma.client.user.findFirst({
      where: { id: auth.sub },
      include: { roles: true },
    })) as UserWithRoles | null;
    if (!user) throw new UnauthorizedException();
    return { ...this.sanitize(user), permissions: this.aggregatePermissions(user.roles) };
  }

  private issueTokens(user: UserWithRoles, organizationId: string) {
    const permissions = this.aggregatePermissions(user.roles);
    const accessToken = this.jwt.signAccess({
      sub: user.id,
      organizationId,
      email: user.email,
      permissions,
    });
    const refreshToken = this.jwt.signRefresh({ sub: user.id, organizationId });
    this.events.publish('user.logged_in', {
      userId: user.id,
      organizationId,
      at: new Date().toISOString(),
    });
    return { accessToken, refreshToken, user: this.sanitize(user), permissions };
  }

  private aggregatePermissions(roles: { permissions: string[] }[]): string[] {
    return [...new Set(roles.flatMap((r) => r.permissions))];
  }

  private sanitize(user: UserWithRoles) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: user.roles.map((r) => r.name),
    };
  }
}
