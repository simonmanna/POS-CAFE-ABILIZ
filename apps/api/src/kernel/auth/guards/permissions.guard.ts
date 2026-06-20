import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import type { AuthUser } from '../jwt-token.service';

/** Enforces @RequirePermissions(...) using the permissions baked into the JWT. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<{ auth?: AuthUser }>();
    const granted = request.auth?.permissions ?? [];
    const ok = required.every((perm) => granted.includes(perm));
    if (!ok) {
      throw new ForbiddenException(`Missing required permission(s): ${required.join(', ')}`);
    }
    return true;
  }
}
