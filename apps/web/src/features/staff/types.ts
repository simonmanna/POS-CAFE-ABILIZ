/** Shared types for the Staff / RBAC admin UI. */

export interface Role {
  id: string;
  organizationId: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
  /** Only present on GET /roles/:id (includes _count.users from the API). */
  _count?: { users: number };
}

export interface UserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  isActive: boolean;
  lastLoginAt: string | null;
  failedLoginCount: number;
  lockedUntil: string | null;
  mfaEnrolled: boolean;
  /** Whether a POS PIN is set. The PIN itself never leaves the server. */
  hasPin: boolean;
  defaultBranchId: string | null;
  createdAt: string;
  updatedAt: string;
  roles: { id: string; name: string }[];
  /** Workforce record this login belongs to. `null` = not linked to HR yet. */
  employee: {
    id: string;
    employeeCode: string;
    firstName: string;
    lastName: string | null;
    employmentStatus: string;
  } | null;
}

export interface UserList {
  data: UserSummary[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface PermissionGroup {
  resource: string;
  permissions: { action: string; key: string }[];
}

export interface PermissionCatalog {
  groups: PermissionGroup[];
}

/** Payload shapes sent to the API. */
export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: string[];
  isSystem?: boolean;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string;
  permissions?: string[];
}

export interface CreateUserInput {
  email: string;
  password: string;
  firstName: string;
  lastName?: string;
  isActive?: boolean;
  roleIds: string[];
}

export interface UpdateUserInput {
  email?: string;
  firstName?: string;
  lastName?: string;
  isActive?: boolean;
  roleIds?: string[];
}

export interface ResetPasswordInput {
  newPassword: string;
}
