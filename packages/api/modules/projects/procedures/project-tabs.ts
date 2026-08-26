import { ORPCError } from "@orpc/client";
import {
	db,
	getProjectAccessById,
	isProtectedProjectTab,
	normalizeProjectTabConfig,
	normalizeProjectTabPrefs,
	type ProjectTabPrefs,
	projectTabConfigSchema,
	projectTabPrefsSchema,
} from "@repo/database";
import { hasPermission } from "@repo/permissions";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import {
	Permissions,
	requirePermission,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

// The per-user tab prefs row is read/written through the same narrow delegate
// the kanban and roadmap-view procedures use, so a deploy whose Prisma client
// predates the `projectTabPrefs` column degrades to "no prefs saved" instead of
// crashing the project page.
function getProjectTabPrefsDelegate() {
	return (
		db as typeof db & {
			projectUserPreference?: {
				findUnique: (args: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
					select: { projectTabPrefs: true };
				}) => Promise<{ projectTabPrefs: unknown } | null>;
				upsert: (args: {
					where: {
						projectId_userId: { projectId: string; userId: string };
					};
					create: {
						projectId: string;
						userId: string;
						organizationId: string | null;
						projectTabPrefs?: ProjectTabPrefs;
					};
					update: {
						organizationId: string | null;
						projectTabPrefs: ProjectTabPrefs;
					};
					select: { projectTabPrefs: true };
				}) => Promise<{ projectTabPrefs: unknown }>;
			};
		}
	).projectUserPreference;
}

// Deliberately no `organizationId` input. The access lookups below derive the
// org from the PROJECT's own record (server-owned) rather than trusting a
// caller-supplied one — `buildProjectAccessWhere` hard-scopes to
// `organizationId: org || null`, so omitting the org entirely would match only
// personal projects, and taking it from input would put this file on the
// input-org-unverified ratchet's risky shape.
const projectTabsInput = z.object({
	projectId: z.string(),
});

/**
 * Project row when the caller can access it, resolved in TWO steps: load the
 * record's host org by id alone, then run the standard owner/member access
 * where scoped to THAT org. Never trusts caller input for the tenant scope.
 */
async function getAccessibleProject(
	projectId: string,
	userId: string,
): Promise<{ id: string; organizationId: string | null } | null> {
	const row = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true },
	});
	if (!row) {
		return null;
	}
	return getProjectAccessById(
		projectId,
		userId,
		row.organizationId ?? undefined,
	);
}

export const getProjectTabVisibilityProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/tab-visibility",
		tags: ["Projects"],
		summary:
			"Get the admin-configured project-tab visibility overrides for a project",
	})
	.input(projectTabsInput)
	.output(
		z.object({
			config: projectTabConfigSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await getAccessibleProject(
			input.projectId,
			context.user.id,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const row = await db.project.findUnique({
			where: { id: input.projectId },
			select: { projectTabConfig: true },
		});
		return {
			config: normalizeProjectTabConfig(row?.projectTabConfig),
		};
	});

export const setProjectTabVisibilityProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_UPDATE, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "PATCH",
		path: "/projects/:projectId/tab-visibility",
		tags: ["Projects"],
		summary: "Set the project-wide tab visibility overrides (admin only)",
	})
	.input(
		projectTabsInput.extend({
			config: projectTabConfigSchema,
		}),
	)
	.output(
		z.object({
			config: projectTabConfigSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		// Stricter than the PROJECT_UPDATE gate above: reshaping navigation for
		// every member is a settings decision, so only the PROJECT_SETTINGS_EDIT
		// grant (org/project admins and owners) may write it. Same field-level
		// check the Read-only mode toggle uses.
		const access = await resolveEffectiveProjectPermissions(
			input.projectId,
			context.user.id,
		);
		const canEdit =
			access?.source === "owner" ||
			(access != null &&
				hasPermission(
					access.permissions,
					Permissions.PROJECT_SETTINGS_EDIT,
				));
		if (!canEdit) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only project admins or owners can change which tabs are available.",
			});
		}

		// Overview and Settings are protected: overview is every project's
		// landing page and settings is where a hidden tab gets turned back on.
		for (const tabId of Object.keys(input.config.overrides ?? {})) {
			if (isProtectedProjectTab(tabId)) {
				throw new ORPCError("BAD_REQUEST", {
					message: `The "${tabId}" tab cannot be hidden.`,
				});
			}
		}

		const row = await db.project.update({
			where: { id: input.projectId },
			data: { projectTabConfig: input.config },
			select: { projectTabConfig: true },
		});
		return {
			config: normalizeProjectTabConfig(row.projectTabConfig),
		};
	});

export const getProjectTabPreferencesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/tab-preferences",
		tags: ["Projects"],
		summary:
			"Get the caller's personal project-tab preferences for a project",
	})
	.input(projectTabsInput)
	.output(
		z.object({
			prefs: projectTabPrefsSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await getAccessibleProject(
			input.projectId,
			context.user.id,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getProjectTabPrefsDelegate();
		const preference = delegate
			? await delegate.findUnique({
					where: {
						projectId_userId: {
							projectId: input.projectId,
							userId: context.user.id,
						},
					},
					select: { projectTabPrefs: true },
				})
			: null;
		return {
			prefs: normalizeProjectTabPrefs(preference?.projectTabPrefs),
		};
	});

export const setProjectTabPreferencesProcedure = tenantProtectedProcedure
	// PROJECT_READ (not UPDATE): the row written is the caller's OWN per-user
	// view of a project they can already see — same rationale as the roadmap
	// view preference update. It never changes what teammates see.
	.use(requirePermission(Permissions.PROJECT_READ))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/tab-preferences",
		tags: ["Projects"],
		summary:
			"Persist the caller's personal project-tab visibility and ordering",
	})
	.input(
		projectTabsInput.extend({
			prefs: projectTabPrefsSchema,
		}),
	)
	.output(
		z.object({
			prefs: projectTabPrefsSchema.nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		const project = await getAccessibleProject(
			input.projectId,
			context.user.id,
		);
		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}
		const delegate = getProjectTabPrefsDelegate();
		if (!delegate) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"Tab preferences are unavailable until the Prisma client is regenerated.",
			});
		}
		const preference = await delegate.upsert({
			where: {
				projectId_userId: {
					projectId: input.projectId,
					userId: context.user.id,
				},
			},
			create: {
				projectId: input.projectId,
				userId: context.user.id,
				organizationId: project.organizationId,
				projectTabPrefs: input.prefs,
			},
			update: {
				organizationId: project.organizationId,
				projectTabPrefs: input.prefs,
			},
			select: { projectTabPrefs: true },
		});
		return {
			prefs: normalizeProjectTabPrefs(preference.projectTabPrefs),
		};
	});
