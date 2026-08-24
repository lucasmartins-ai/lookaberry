/**
 * S15: Security & Governance — barrel export
 *
 * NOTE: apiKeys.ts and rbac.ts both export canAccessCampaign.
 * We re-export all from rbac for the unified RBAC version.
 */

export * from './apiKeys.js';
export { canPerform, canAccessLead, hasPermissionLevel, visibleCampaignIds, contextFromApiKey, PERMISSION_LABELS_PT_BR, type PermissionContext, type Resource, type Action } from './rbac.js';
export * from './auditTrail.js';
export * from './suppression.js';
export * from './retention.js';
export * from './secretsMasking.js';
export * from './totp.js';