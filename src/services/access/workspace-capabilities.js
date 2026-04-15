/**
 * Unified workspace capability checks for human routes and AI tools.
 *
 * Permissions rely on req.workspacePlan.permissions (for HTTP) or context.features (for tools).
 * The checks are fail-closed for non-admin users.
 */

function getPermissions(source) {
  if (!source || typeof source !== "object") return {};
  return source;
}

export function resolveWorkspaceIdFromRequest(req) {
  if (req?.user?.role === "admin" && req?.query?.workspaceId) {
    return req.query.workspaceId;
  }
  return req?.workspaceId || null;
}

export function canReadVaultRequest(req) {
  if (req?.user?.role === "admin") return true;
  const perms = getPermissions(req?.workspacePlan?.permissions);
  // Backward compatible: if knowledge_vault is undefined, vault is enabled by default.
  return perms.knowledge_vault !== false;
}

export function canWriteVaultRequest(req) {
  if (req?.user?.role === "admin") return true;
  if (!canReadVaultRequest(req)) return false;

  const perms = getPermissions(req?.workspacePlan?.permissions);
  const role = req?.user?.role;

  if (role === "client") {
    // Backward compatible: if vault_write is undefined, keep client write enabled.
    return perms.vault_write !== false;
  }

  if (role === "sub_client") {
    // Sub-clients require explicit write permission.
    return Boolean(perms.vault_write);
  }

  return false;
}

export function canReadAutomationsRequest(req) {
  if (req?.user?.role === "admin") return true;
  const perms = getPermissions(req?.workspacePlan?.permissions);
  return Boolean(perms.automations);
}

export function canWriteAutomationsRequest(req) {
  if (req?.user?.role === "admin") return true;
  if (!canReadAutomationsRequest(req)) return false;

  const perms = getPermissions(req?.workspacePlan?.permissions);
  const role = req?.user?.role;

  if (role === "client") {
    // Backward compatible: if automations_write is undefined, client can still write.
    return perms.automations_write !== false;
  }

  if (role === "sub_client") {
    // If the new key is missing, fallback to automations for compatibility.
    return Boolean(perms.automations_write ?? perms.automations);
  }

  return false;
}

export function canReadVaultToolContext(context = {}) {
  if (context.isAdmin) return true;
  if (!context.tenantId) return false;
  const perms = getPermissions(context.features);
  // Backward compatible: if knowledge_vault is undefined, vault is enabled by default.
  return perms.knowledge_vault !== false;
}

export function canWriteVaultToolContext(context = {}) {
  if (context.isAdmin) return true;
  if (!context.tenantId) return false;
  if (!canReadVaultToolContext(context)) return false;

  const perms = getPermissions(context.features);
  const role = context.userRole;

  if (role === "client") {
    return perms.vault_write !== false;
  }

  if (role === "sub_client") {
    return Boolean(perms.vault_write);
  }

  return false;
}
