import { ORPCError } from "@orpc/client";
import {
	getProjectById,
	getProjectRole,
	hasProjectAccess,
	resolveAttachmentRetentionOverrides,
} from "@repo/database";
import { hasPermission, Permissions as ProjectPerms } from "@repo/permissions";
import {
	DEFAULT_ATTACHMENT_RETENTION_DAYS,
	sanitizeRetentionDays,
} from "@repo/utils/attachment";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";
import { userHasProjectPermission } from "../../../lib/project-permissions";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const getProjectProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "id",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:id",
		tags: ["Projects"],
		summary: "Get project",
		description: "Get a project by ID with user's role",
	})
	.input(
		z.object({
			id: z.string(),
			// organizationId: null = explicit personal context, undefined = use session fallback
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// Resolve organizationId from input or session's activeOrganizationId
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Get project with authorization check
		const project = await getProjectById(input.id, user.id, organizationId);

		if (!project) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or you don't have access",
			});
		}

		// Get user's role in the project for authorization checks
		const userRole = await getProjectRole(input.id, user.id);

		// Capability flags resolved via the permission matrix so the UI
		// reflects org-level permissions too (e.g. org admins without an
		// explicit ProjectMember row). These supersede raw role-string
		// comparisons in the client — see `userHasProjectPermission`.
		const canEditSettings = await userHasProjectPermission(
			input.id,
			user.id,
			Permissions.PROJECT_SETTINGS_EDIT,
		);

		// Publishing Suite & Update capabilities: derived via the SAME authoritative
		// resolver `requireProjectPermission` uses (project-authoritative —
		// an active ProjectMember row overrides the org role), NOT the
		// org-first `userHasProjectPermission` above. This keeps the UI
		// capability and the mutation's authorization in agreement — see
		// resolve-effective-project-permissions.ts.
		// `hasProjectAccess` (used by canManageMembers below) is independent of
		// the permission resolver, so run both in parallel — getProject is a hot
		// read path hit on every project load.
		const [effective, hasAccess] = await Promise.all([
			resolveEffectiveProjectPermissions(input.id, user.id),
			hasProjectAccess(input.id, user.id),
		]);
		const canPublish = hasPermission(
			effective?.permissions ?? [],
			ProjectPerms.PUBLISHING_TOPIC_CREATE,
		);
		const canUpdateProject = hasPermission(
			effective?.permissions ?? [],
			Permissions.PROJECT_UPDATE,
		);

		// Member-management capability: definitionally identical to the write
		// gate in `setForProjectMember` — actual project access (ownership or
		// an active membership, not just an org-role grant) AND the
		// PROJECT_MEMBERS_MANAGE permission from the SAME authoritative
		// resolver used for `canPublish`. Computed explicitly (not assumed from
		// this handler's own `getProjectById` load) so it stays drift-proof if
		// either query changes later.
		const canManageMembers =
			hasAccess &&
			hasPermission(
				effective?.permissions ?? [],
				Permissions.PROJECT_MEMBERS_MANAGE,
			);

		// The attachment retention window the purge would actually apply to this
		// project right now, resolved through the same cascade the sweep uses
		// (project -> organization -> server default). Returned so the settings
		// form can show what it inherits without the browser holding its own copy
		// of the default — and so an unusable stored value is displayed the way
		// the purge would treat it, as the default, rather than at face value.
		const windows = await resolveAttachmentRetentionOverrides([project.id]);
		const effectiveAttachmentRetentionDays =
			sanitizeRetentionDays(windows.get(project.id)?.days) ??
			DEFAULT_ATTACHMENT_RETENTION_DAYS;

		return {
			project: {
				...project,
				userRole,
				canEditSettings,
				canUpdateProject,
				canPublish,
				canManageMembers,
				effectiveAttachmentRetentionDays,
			},
		};
	});
