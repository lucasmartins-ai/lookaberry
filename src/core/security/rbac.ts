/**
 * S15: Role-Based Access Control (RBAC) — User / Team / Campaign Permissions
 *
 * Permission hierarchy (higher includes lower):
 *   ADMIN (4) > OPERATOR (3) > CAMPAIGN_MANAGER (2) > VIEWER (1)
 *
 * Isolation model:
 *   - ADMIN: full access to everything (no scope restriction)
 *   - OPERATOR: full operational access within their team scope
 *   - CAMPAIGN_MANAGER: can manage campaigns explicitly assigned to them
 *   - VIEWER: read-only access to assigned campaigns
 */

import type { ApiKeyPermission } from './apiKeys.js';

// ──────────────────────────────── Types ────────────────────────────────

export interface PermissionContext {
  permission: ApiKeyPermission;
  userId?: string | null;
  teamId?: string | null;
  campaignIds?: string[];
}

export type Resource = 'api_key' | 'campaign' | 'lead' | 'sequence' | 'audit_log' | 'suppression' | 'retention';
export type Action = 'read' | 'create' | 'update' | 'delete' | 'admin';

// ──────────────────────────────── Permission levels ────────────────────────────────

const PERMISSION_RANK: Record<ApiKeyPermission, number> = {
  ADMIN: 4,
  OPERATOR: 3,
  CAMPAIGN_MANAGER: 2,
  VIEWER: 1,
};

// Which actions each permission can perform per resource
const ACTION_MATRIX: Record<ApiKeyPermission, Partial<Record<Action, Resource[]>>> = {
  ADMIN: {
    read: ['api_key', 'campaign', 'lead', 'sequence', 'audit_log', 'suppression', 'retention'],
    create: ['api_key', 'campaign', 'lead', 'sequence', 'suppression', 'retention'],
    update: ['api_key', 'campaign', 'lead', 'sequence', 'suppression', 'retention'],
    delete: ['api_key', 'campaign', 'lead', 'sequence', 'suppression', 'retention'],
    admin: ['api_key', 'campaign', 'lead', 'sequence', 'audit_log', 'suppression', 'retention'],
  },
  OPERATOR: {
    read: ['campaign', 'lead', 'sequence', 'audit_log', 'suppression'],
    create: ['campaign', 'lead', 'sequence', 'suppression'],
    update: ['campaign', 'lead', 'sequence', 'suppression'],
    delete: ['campaign', 'lead', 'sequence'],
    admin: [],
  },
  CAMPAIGN_MANAGER: {
    read: ['campaign', 'lead', 'sequence'],
    create: ['campaign', 'lead', 'sequence'],
    update: ['campaign', 'lead', 'sequence'],
    delete: [],
    admin: [],
  },
  VIEWER: {
    read: ['campaign', 'lead', 'sequence'],
    create: [],
    update: [],
    delete: [],
    admin: [],
  },
};

// ──────────────────────────────── Helpers ────────────────────────────────

/**
 * Check if a permission context can perform an action on a resource.
 */
export function canPerform(
  ctx: PermissionContext,
  resource: Resource,
  action: Action,
): boolean {
  const allowed = ACTION_MATRIX[ctx.permission]?.[action] ?? [];
  return allowed.includes(resource);
}

/**
 * Check campaign-level isolation.
 * - ADMIN: always allowed
 * - OPERATOR: allowed for any campaign within their team (campaignIds empty = all team campaigns)
 * - CAMPAIGN_MANAGER / VIEWER: allowed only for explicitly assigned campaignIds
 */
export function canAccessCampaign(ctx: PermissionContext, campaignId: string): boolean {
  if (ctx.permission === 'ADMIN') return true;
  if (ctx.permission === 'OPERATOR' && (!ctx.campaignIds || ctx.campaignIds.length === 0)) {
    // Operator without explicit campaign restriction has team-wide access
    return true;
  }
  return ctx.campaignIds?.includes(campaignId) ?? false;
}

/**
 * Enforce that a user can read a lead, given the lead's campaign id.
 */
export function canAccessLead(ctx: PermissionContext, leadCampaignId: string): boolean {
  return canAccessCampaign(ctx, leadCampaignId);
}

/**
 * Check whether a permission is at least as privileged as the target.
 */
export function hasPermissionLevel(
  ctx: PermissionContext,
  required: ApiKeyPermission,
): boolean {
  return (PERMISSION_RANK[ctx.permission] ?? 0) >= (PERMISSION_RANK[required] ?? 0);
}

/**
 * Return a filtered list of campaign IDs visible to this context.
 * Returns `null` for ADMIN/OPERATOR-without-restriction (all campaigns).
 */
export function visibleCampaignIds(ctx: PermissionContext): string[] | null {
  if (ctx.permission === 'ADMIN') return null;
  if (ctx.permission === 'OPERATOR' && (!ctx.campaignIds || ctx.campaignIds.length === 0)) {
    return null;
  }
  return ctx.campaignIds ?? [];
}

/**
 * Build a permission context from an API key record.
 */
export function contextFromApiKey(key: {
  permission: ApiKeyPermission;
  userId?: string | null;
  teamId?: string | null;
  campaignIds?: string[];
}): PermissionContext {
  return {
    permission: key.permission,
    userId: key.userId ?? null,
    teamId: key.teamId ?? null,
    campaignIds: key.campaignIds ?? [],
  };
}

/**
 * pt-BR human-readable labels for permissions (user-facing copy).
 */
export const PERMISSION_LABELS_PT_BR: Record<ApiKeyPermission, string> = {
  ADMIN: 'Administrador',
  OPERATOR: 'Operador',
  CAMPAIGN_MANAGER: 'Gestor de Campanhas',
  VIEWER: 'Somente leitura',
};