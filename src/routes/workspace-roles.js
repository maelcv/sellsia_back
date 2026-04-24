import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import {
  requireAuth,
  isPlatformAdminRole,
  isWorkspaceManagerRole,
} from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";

const router = Router();

const RESERVED_ROLE_NAMES = new Set([
  "admin",
  "client",
  "sub_client",
  "admin_platform",
  "workspace_manager",
  "workspace_user",
]);

const permissionDescriptorSchema = z.object({
  resource: z.string().min(1).max(100),
  action: z.string().min(1).max(100),
  label: z.string().min(1).max(120).optional(),
});

const createRoleSchema = z.object({
  name: z.string().min(2).max(64),
  label: z.string().min(2).max(120),
  permissionIds: z.array(z.string()).default([]),
  permissions: z.array(permissionDescriptorSchema).default([]),
});

const updateRoleSchema = z.object({
  name: z.string().min(2).max(64).optional(),
  label: z.string().min(2).max(120).optional(),
  permissionIds: z.array(z.string()).optional(),
  permissions: z.array(permissionDescriptorSchema).optional(),
});

const assignRoleSchema = z.object({
  roleIds: z.array(z.string()).min(0),
});

const assignUsersSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1),
});

const createPermissionSchema = z.object({
  resource: z.string().min(1).max(100),
  action: z.string().min(1).max(100),
  label: z.string().min(1).max(120),
});

function normalizeRoleName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\- ]/g, "")
    .replace(/\s+/g, "_");
}

function normalizePermissionField(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-:.]/g, "_");
}

function resolveWorkspaceId(req) {
  if (req.workspaceId) return req.workspaceId;

  const queryWorkspaceId = String(req.query.workspaceId || "").trim();
  if (queryWorkspaceId) return queryWorkspaceId;

  return null;
}

function ensureWorkspaceManagerOrAdmin(req, res, next) {
  const role = req.user?.roleCanonical || req.user?.role;
  const canManage = isPlatformAdminRole(role) || isWorkspaceManagerRole(role);
  if (!canManage) {
    return res.status(403).json({ error: "Forbidden" });
  }
  return next();
}

async function ensureWorkspaceExists(workspaceId) {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true },
  });
  return Boolean(workspace);
}

async function resolvePermissionIds(payload) {
  const directIds = payload.permissionIds || [];
  const descriptors = payload.permissions || [];

  const createdOrFoundIds = [];
  for (const descriptor of descriptors) {
    const resource = normalizePermissionField(descriptor.resource);
    const action = normalizePermissionField(descriptor.action);
    const label = descriptor.label || `${resource}:${action}`;

    const permission = await prisma.permission.upsert({
      where: {
        resource_action: {
          resource,
          action,
        },
      },
      update: {
        label,
      },
      create: {
        resource,
        action,
        label,
      },
      select: { id: true },
    });

    createdOrFoundIds.push(permission.id);
  }

  return [...new Set([...directIds, ...createdOrFoundIds])];
}

router.use(requireAuth, requireWorkspaceContext, ensureWorkspaceManagerOrAdmin);

router.get("/permissions", async (_req, res) => {
  try {
    const permissions = await prisma.permission.findMany({
      orderBy: [{ resource: "asc" }, { action: "asc" }],
    });
    return res.json({ permissions });
  } catch (err) {
    console.error("[workspace-roles] list permissions error:", err);
    return res.status(500).json({ error: "Failed to list permissions" });
  }
});

router.post("/permissions", async (req, res) => {
  try {
    const data = createPermissionSchema.parse(req.body || {});
    const resource = normalizePermissionField(data.resource);
    const action = normalizePermissionField(data.action);

    const permission = await prisma.permission.upsert({
      where: {
        resource_action: {
          resource,
          action,
        },
      },
      update: {
        label: data.label,
      },
      create: {
        resource,
        action,
        label: data.label,
      },
    });

    return res.status(201).json({ permission });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    console.error("[workspace-roles] upsert permission error:", err);
    return res.status(500).json({ error: "Failed to save permission" });
  }
});

router.get("/users", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    if (!(await ensureWorkspaceExists(workspaceId))) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const users = await prisma.user.findMany({
      where: { workspaceId },
      select: {
        id: true,
        email: true,
        role: true,
        companyName: true,
        roleAssignments: {
          where: { role: { workspaceId } },
          select: {
            roleId: true,
            role: {
              select: { id: true, name: true, label: true },
            },
          },
        },
      },
      orderBy: { email: "asc" },
    });

    return res.json({
      users: users.map((user) => ({
        ...user,
        customRoles: user.roleAssignments.map((assignment) => assignment.role),
      })),
    });
  } catch (err) {
    console.error("[workspace-roles] list users error:", err);
    return res.status(500).json({ error: "Failed to list users" });
  }
});

router.get("/", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    if (!(await ensureWorkspaceExists(workspaceId))) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const roles = await prisma.role.findMany({
      where: { workspaceId },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
        assignments: {
          include: {
            user: {
              select: { id: true, email: true, role: true },
            },
          },
        },
      },
      orderBy: { name: "asc" },
    });

    return res.json({
      roles: roles.map((role) => ({
        id: role.id,
        workspaceId: role.workspaceId,
        name: role.name,
        label: role.label,
        permissions: role.permissions.map((entry) => entry.permission),
        users: role.assignments.map((entry) => entry.user),
        usersCount: role.assignments.length,
      })),
    });
  } catch (err) {
    console.error("[workspace-roles] list roles error:", err);
    return res.status(500).json({ error: "Failed to list roles" });
  }
});

router.post("/", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    if (!(await ensureWorkspaceExists(workspaceId))) {
      return res.status(404).json({ error: "Workspace not found" });
    }

    const parsed = createRoleSchema.parse(req.body || {});
    const normalizedName = normalizeRoleName(parsed.name);

    if (!normalizedName) {
      return res.status(400).json({ error: "Invalid role name" });
    }

    if (RESERVED_ROLE_NAMES.has(normalizedName)) {
      return res.status(400).json({ error: "Role name is reserved" });
    }

    const permissionIds = await resolvePermissionIds(parsed);

    const role = await prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          workspaceId,
          name: normalizedName,
          label: parsed.label.trim(),
        },
      });

      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId: created.id, permissionId })),
          skipDuplicates: true,
        });
      }

      return tx.role.findUnique({
        where: { id: created.id },
        include: {
          permissions: { include: { permission: true } },
        },
      });
    });

    return res.status(201).json({
      role: {
        id: role.id,
        workspaceId: role.workspaceId,
        name: role.name,
        label: role.label,
        permissions: role.permissions.map((entry) => entry.permission),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Role already exists in this workspace" });
    }
    console.error("[workspace-roles] create role error:", err);
    return res.status(500).json({ error: "Failed to create role" });
  }
});

router.patch("/:roleId", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const role = await prisma.role.findFirst({
      where: { id: req.params.roleId, workspaceId },
      select: { id: true, workspaceId: true },
    });

    if (!role) {
      return res.status(404).json({ error: "Role not found" });
    }

    const parsed = updateRoleSchema.parse(req.body || {});
    const updates = {};

    if (parsed.name !== undefined) {
      const normalizedName = normalizeRoleName(parsed.name);
      if (!normalizedName) {
        return res.status(400).json({ error: "Invalid role name" });
      }
      if (RESERVED_ROLE_NAMES.has(normalizedName)) {
        return res.status(400).json({ error: "Role name is reserved" });
      }
      updates.name = normalizedName;
    }

    if (parsed.label !== undefined) {
      updates.label = parsed.label.trim();
    }

    const roleWithPermissions = await prisma.$transaction(async (tx) => {
      if (Object.keys(updates).length > 0) {
        await tx.role.update({
          where: { id: req.params.roleId },
          data: updates,
        });
      }

      if (parsed.permissionIds !== undefined || parsed.permissions !== undefined) {
        const permissionIds = await resolvePermissionIds({
          permissionIds: parsed.permissionIds || [],
          permissions: parsed.permissions || [],
        });

        await tx.rolePermission.deleteMany({ where: { roleId: req.params.roleId } });

        if (permissionIds.length > 0) {
          await tx.rolePermission.createMany({
            data: permissionIds.map((permissionId) => ({
              roleId: req.params.roleId,
              permissionId,
            })),
            skipDuplicates: true,
          });
        }
      }

      return tx.role.findUnique({
        where: { id: req.params.roleId },
        include: {
          permissions: { include: { permission: true } },
        },
      });
    });

    return res.json({
      role: {
        id: roleWithPermissions.id,
        workspaceId: roleWithPermissions.workspaceId,
        name: roleWithPermissions.name,
        label: roleWithPermissions.label,
        permissions: roleWithPermissions.permissions.map((entry) => entry.permission),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    if (err?.code === "P2002") {
      return res.status(409).json({ error: "Role already exists in this workspace" });
    }
    console.error("[workspace-roles] update role error:", err);
    return res.status(500).json({ error: "Failed to update role" });
  }
});

router.delete("/:roleId", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const role = await prisma.role.findFirst({
      where: { id: req.params.roleId, workspaceId },
      select: { id: true },
    });

    if (!role) {
      return res.status(404).json({ error: "Role not found" });
    }

    await prisma.role.delete({ where: { id: req.params.roleId } });
    return res.json({ success: true });
  } catch (err) {
    console.error("[workspace-roles] delete role error:", err);
    return res.status(500).json({ error: "Failed to delete role" });
  }
});

router.put("/users/:userId", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const parsed = assignRoleSchema.parse(req.body || {});

    const user = await prisma.user.findFirst({
      where: { id: userId, workspaceId },
      select: { id: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found in workspace" });
    }

    if (parsed.roleIds.length > 0) {
      const existingRoles = await prisma.role.findMany({
        where: {
          id: { in: parsed.roleIds },
          workspaceId,
        },
        select: { id: true },
      });

      if (existingRoles.length !== parsed.roleIds.length) {
        return res.status(400).json({ error: "One or more roles do not belong to this workspace" });
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.userRoleAssignment.deleteMany({
        where: {
          userId,
          role: { workspaceId },
        },
      });

      if (parsed.roleIds.length > 0) {
        await tx.userRoleAssignment.createMany({
          data: parsed.roleIds.map((roleId) => ({ userId, roleId })),
          skipDuplicates: true,
        });
      }
    });

    const assignments = await prisma.userRoleAssignment.findMany({
      where: {
        userId,
        role: { workspaceId },
      },
      include: {
        role: {
          select: { id: true, name: true, label: true },
        },
      },
    });

    return res.json({ roles: assignments.map((entry) => entry.role) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    console.error("[workspace-roles] assign user roles error:", err);
    return res.status(500).json({ error: "Failed to assign roles" });
  }
});

router.post("/:roleId/users", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const parsed = assignUsersSchema.parse(req.body || {});

    const role = await prisma.role.findFirst({
      where: { id: req.params.roleId, workspaceId },
      select: { id: true },
    });

    if (!role) {
      return res.status(404).json({ error: "Role not found" });
    }

    const users = await prisma.user.findMany({
      where: {
        id: { in: parsed.userIds },
        workspaceId,
      },
      select: { id: true },
    });

    if (users.length !== parsed.userIds.length) {
      return res.status(400).json({ error: "One or more users do not belong to this workspace" });
    }

    const result = await prisma.userRoleAssignment.createMany({
      data: parsed.userIds.map((userId) => ({ userId, roleId: req.params.roleId })),
      skipDuplicates: true,
    });

    return res.status(201).json({ success: true, assignedCount: result.count });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid input", issues: err.errors });
    }
    console.error("[workspace-roles] assign users to role error:", err);
    return res.status(500).json({ error: "Failed to assign users to role" });
  }
});

router.delete("/:roleId/users/:userId", async (req, res) => {
  try {
    const workspaceId = resolveWorkspaceId(req);
    if (!workspaceId) {
      return res.status(400).json({ error: "workspaceId is required" });
    }

    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: "Invalid userId" });
    }

    const role = await prisma.role.findFirst({
      where: { id: req.params.roleId, workspaceId },
      select: { id: true },
    });

    if (!role) {
      return res.status(404).json({ error: "Role not found" });
    }

    await prisma.userRoleAssignment.deleteMany({
      where: {
        userId,
        roleId: req.params.roleId,
      },
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("[workspace-roles] remove role assignment error:", err);
    return res.status(500).json({ error: "Failed to remove role assignment" });
  }
});

export default router;
