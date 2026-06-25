import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@erp/shared';
import { Public } from '../decorators/public.decorator';

/**
 * Exposes the permission catalog (resource + action) for the admin UI so it
 * can render a permission matrix without bundling its own copy of the keys.
 *
 * Marked @Public so the login screen can read the catalog before the user
 * authenticates (used by sign-in page to show "you need permission X to do Y").
 * The response carries zero secrets — just static keys.
 */
@ApiTags('auth')
@Controller('auth/permissions')
export class PermissionsController {
  @Public()
  @Get()
  catalog() {
    // Flatten the nested PERMISSIONS object into the { resource, action, key }
    // shape the admin matrix expects. We group by top-level key (e.g.
    // "organization", "user", "pos") which corresponds to the sidebar nav.
    const groups: { resource: string; permissions: { action: string; key: string }[] }[] = [];
    for (const [group, value] of Object.entries(PERMISSIONS as Record<string, unknown>)) {
      const permissions: { action: string; key: string }[] = [];
      if (typeof value === 'string') {
        const [resource, action] = value.split(':');
        permissions.push({ action: action ?? value, key: value });
      } else if (value && typeof value === 'object') {
        for (const v of Object.values(value as Record<string, unknown>)) {
          if (typeof v === 'string') {
            const [resource, action] = v.split(':');
            permissions.push({ action: action ?? v, key: v });
          }
        }
      }
      if (permissions.length > 0) {
        groups.push({ resource: group, permissions });
      }
    }
    return { groups };
  }
}
