/** Canonical document lifecycle states reused by every future document (ADR-007). */
export const WORKFLOW_STATES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'posted',
  'paid',
  'cancelled',
  'closed',
  'reversed',
  'archived',
  'active',
  'inactive',
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Auditable actions (ADR-006). */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'login',
  'logout',
  'approve',
  'reject',
  'post',
  'cancel',
  'receive',
  'issue',
  'adjust',
  'transfer',
  'reprint',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface WorkflowTransition {
  from: WorkflowState;
  to: WorkflowState;
  action: string;
  /** resource:action permission required to perform this transition. */
  permission?: string;
  /** Optional sync guard — must return truthy for the transition to proceed. */
  guard?: (ctx: WorkflowContext) => boolean | Promise<boolean>;
  /**
   * Optional sync side effect to run inside the same DB transaction as the
   * status update. Use for "post" transitions (GL effects) — let the registry
   * compose them.
   */
  sideEffect?: (ctx: WorkflowContext, tx: any) => void | Promise<void>;
}

/** Runtime context passed to guards/side effects (ADR-007). */
export interface WorkflowContext {
  entityType: string;
  entityId: string;
  organizationId: string;
  userId?: string | null;
  permissions: string[];
  action: string;
  fromState: WorkflowState;
  toState: WorkflowState;
  /** Free-form payload (transition-specific args, e.g. cancellation reason). */
  payload?: Record<string, unknown>;
  /** The current entity row (the loader fills this). */
  entity?: unknown;
}

export interface WorkflowDefinition {
  /** Entity type key, e.g. "invoice", "purchase_order". */
  documentType: string;
  initial: WorkflowState;
  transitions: WorkflowTransition[];
}
