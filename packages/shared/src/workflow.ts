/** Canonical document lifecycle states reused by every future document (ADR-007). */
export const WORKFLOW_STATES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'posted',
  'cancelled',
  'closed',
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
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface WorkflowTransition {
  from: WorkflowState;
  to: WorkflowState;
  action: string;
  /** resource:action permission required to perform this transition. */
  permission?: string;
}

export interface WorkflowDefinition {
  /** Document type key, e.g. "invoice", "purchase_order". */
  documentType: string;
  initial: WorkflowState;
  transitions: WorkflowTransition[];
}
