/**
 * Who may change reports and report templates.
 *
 * Reads keep the tenant rules in the queries (`getTemplateInstance`,
 * `getReportTemplate`). These helpers answer the narrower question a mutation
 * asks after the row was found: may THIS caller change it.
 */

import { ORPCError } from "@orpc/server";
import {
	getOrganizationMembership,
	hasProjectAccess,
	isPlatformAdmin,
	isProjectSoftDeleted,
} from "@repo/database";
import type { ReportTemplateScope } from "@repo/database/prisma/generated/client";
import {
	hasPermission,
	ORG_ADMIN_ROLES,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";

export type ReportCaller = { id: string; role?: string | null };

/**
 * Whether the caller is an admin or owner of the organization: who publishes
 * templates to it and sets its report defaults.
 */
export async function isOrganizationReportAdmin(
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const membership = await getOrganizationMembership(organizationId, userId);
	return membership !== null && ORG_ADMIN_ROLES.has(membership.role);
}

/**
 * What the caller's organization role allows for reports: `reader` is a member
 * whose role cannot write them, `null` someone who is not a member. Membership
 * always matters, so a project guest is never a report editor, but a `reader`
 * may still edit a project's reports through an Editor project row, where the
 * ProjectMember row is authoritative as it is elsewhere in Fabric.
 */
async function organizationReportRole(
	organizationId: string,
	userId: string,
): Promise<"admin" | "writer" | "reader" | null> {
	const membership = await getOrganizationMembership(organizationId, userId);
	if (!membership) {
		return null;
	}
	if (ORG_ADMIN_ROLES.has(membership.role)) {
		return "admin";
	}
	const granted = resolveOrgPermissions(membership.role);
	return hasPermission(granted, Permissions.REPORT_CREATE) &&
		hasPermission(granted, Permissions.REPORT_UPDATE)
		? "writer"
		: "reader";
}

/**
 * What both project report checks need, or `null` when the caller has no standing
 * on the project at all: a project that is gone or in the trash, or one they
 * cannot reach. Reaching a project takes having created it, an accepted row, or
 * inheriting Project Editor as a member of its organization (`inherits`: an admin
 * or owner, or a platform admin). `orgRole` is `null` for a project outside any
 * organization as well as for a non-member; `organizationId` tells the two apart.
 */
async function projectReportStanding(projectId: string, user: ReportCaller) {
	const access = await resolveEffectiveProjectPermissions(projectId, user.id);
	if (
		!access ||
		access.source === "none" ||
		access.organizationDeleted ||
		(await isProjectSoftDeleted(projectId))
	) {
		return null;
	}
	const orgRole = access.organizationId
		? await organizationReportRole(access.organizationId, user.id)
		: null;
	const inherits =
		orgRole === "admin" ||
		(orgRole !== null && (await isPlatformAdmin(user)));
	if (!inherits && !(await hasProjectAccess(projectId, user.id))) {
		return null;
	}
	return {
		organizationId: access.organizationId,
		projectAllows: hasPermission(
			access.permissions,
			Permissions.REPORT_UPDATE,
		),
		orgRole,
		inherits,
	};
}

/**
 * Whether the caller can open a project's reports at all, the rule
 * `createReportAccessChecker` applies to each report: a member of the project's
 * organization who reaches the project. A project guest stays out, and so does a
 * member with no row on a project they did not create.
 */
export async function canReachProjectReports(
	projectId: string,
	user: ReportCaller,
): Promise<boolean> {
	const standing = await projectReportStanding(projectId, user);
	return (
		standing !== null &&
		(!standing.organizationId || standing.orgRole !== null)
	);
}

/**
 * Whether the caller may add reports to a project and generate its samples,
 * both of which spend or commit the organization's resources. Granted to a
 * member of the project's organization who inherits Project Editor (an admin or
 * owner, even when a lower ProjectMember row would otherwise be authoritative
 * for them, or a platform admin); and to anyone whose effective project role
 * holds `REPORT_UPDATE` (Owner, Project Admin, Editor, a personal project's
 * owner) while their organization role also lets them write reports. Viewers,
 * Commenters and project guests may not, and neither may a platform admin who is
 * not a member: membership is the tenant boundary. A member with no row on a
 * project they did not create may not either, so nobody adds a report they could
 * not then open.
 */
export async function canCreateProjectReport(
	projectId: string,
	user: ReportCaller,
): Promise<boolean> {
	const standing = await projectReportStanding(projectId, user);
	if (!standing) {
		return false;
	}
	if (!standing.organizationId) {
		return standing.projectAllows;
	}
	return (
		standing.inherits ||
		(standing.orgRole === "writer" && standing.projectAllows)
	);
}

/**
 * Whether the caller may edit the reports a project already has. As
 * {@link canCreateProjectReport}, except that any member of the organization
 * qualifies through their effective project role: an organization Viewer holds
 * `REPORT_UPDATE` only through an explicit Editor row. Project guests may not.
 */
export async function canEditProjectReport(
	projectId: string,
	user: ReportCaller,
): Promise<boolean> {
	const standing = await projectReportStanding(projectId, user);
	if (!standing) {
		return false;
	}
	if (!standing.organizationId) {
		return standing.projectAllows;
	}
	return (
		standing.orgRole !== null &&
		(standing.inherits || standing.projectAllows)
	);
}

/**
 * Whether the caller may change a report instance they can already see. For a
 * project report the project role decides, not who owns it:
 * {@link canEditProjectReport}, so an owner whose project row is Viewer reads
 * their report and no more. A report with no project stays its owner's while
 * their organization role lets them write reports. An admin or owner of the
 * organization, and a platform admin who is a member of it, may change either.
 */
export async function canEditReportInstance(
	instance: {
		userId: string;
		organizationId: string | null;
		projectId: string | null;
	},
	user: ReportCaller,
): Promise<boolean> {
	if (!instance.organizationId) {
		if (instance.userId === user.id || (await isPlatformAdmin(user))) {
			return true;
		}
		return instance.projectId
			? canEditProjectReport(instance.projectId, user)
			: false;
	}
	const orgRole = await organizationReportRole(
		instance.organizationId,
		user.id,
	);
	if (orgRole === null) {
		return false;
	}
	if (orgRole === "admin" || (await isPlatformAdmin(user))) {
		return true;
	}
	return instance.projectId
		? canEditProjectReport(instance.projectId, user)
		: orgRole === "writer" && instance.userId === user.id;
}

type ReportInstanceOwnership = {
	userId: string;
	organizationId: string | null;
	projectId: string | null;
};

/** The caller may edit the report and also holds `permission` in its organization. */
async function mayEditWithOrganizationPermission(
	instance: ReportInstanceOwnership,
	user: ReportCaller,
	permission: Permission,
): Promise<boolean> {
	if (!(await canEditReportInstance(instance, user))) {
		return false;
	}
	return instance.organizationId
		? mayUseReportPermission(instance.organizationId, user, permission)
		: true;
}

/**
 * Whether the report page offers to delete this report: the caller may edit it
 * and their organization role holds `REPORT_DELETE`, which `instances.delete`
 * and `instances.archive` require.
 */
export function canDeleteReportInstance(
	instance: ReportInstanceOwnership,
	user: ReportCaller,
): Promise<boolean> {
	return mayEditWithOrganizationPermission(
		instance,
		user,
		Permissions.REPORT_DELETE,
	);
}

/**
 * Whether the caller may schedule, switch on, archive or restore this report,
 * not only edit it. A schedule later spends the owner's connections and credits,
 * so a project Editor who is an organization Viewer may not, as they may not
 * generate it.
 */
export function canManageReportLifecycle(
	instance: ReportInstanceOwnership,
	user: ReportCaller,
): Promise<boolean> {
	return mayEditWithOrganizationPermission(
		instance,
		user,
		Permissions.REPORT_UPDATE,
	);
}

export async function assertCanEditReportInstance(
	instance: {
		userId: string;
		organizationId: string | null;
		projectId: string | null;
	},
	user: ReportCaller,
): Promise<void> {
	if (!(await canEditReportInstance(instance, user))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You do not have permission to change this report",
		});
	}
}

/**
 * The check for a list of reports, asking about each project once. Whether the
 * caller may generate a report: it runs on its owner's connections, so only the
 * owner may start one. For a report with a project the project role also decides,
 * as {@link canCreateProjectReport}: an owner demoted to a Viewer row reads it and
 * no more, and an organization Viewer with an Editor row edits it and no more. A
 * report with no project stays with its owner. `canExecuteReportInstance` holds
 * the scheduled runs to the same rule.
 */
export function reportGenerationChecker(
	user: ReportCaller,
): (instance: {
	userId: string;
	projectId?: string | null;
}) => Promise<boolean> {
	const projects = new Map<string, Promise<boolean>>();
	return async ({ userId, projectId }) => {
		if (userId !== user.id) {
			return false;
		}
		if (!projectId) {
			return true;
		}
		const known = projects.get(projectId);
		if (known) {
			return known;
		}
		const allowed = canCreateProjectReport(projectId, user);
		projects.set(projectId, allowed);
		return allowed;
	};
}

/** {@link reportGenerationChecker} for one report. */
export function canGenerateReportInstance(
	instance: { userId: string; projectId?: string | null },
	user: ReportCaller,
): Promise<boolean> {
	return reportGenerationChecker(user)(instance);
}

/**
 * Whether the caller may set the organization's defaults for the reports it
 * creates from a template: its admins and owners. A project's defaults
 * follow {@link canEditProjectReport}.
 */
export function canSetOrganizationReportDefaults(
	organizationId: string,
	user: ReportCaller,
): Promise<boolean> {
	return isOrganizationReportAdmin(organizationId, user.id);
}

const GENERATE_OWNER_ONLY_MESSAGE =
	"Only the report's owner can generate it, because it runs on the owner's connections";

/** Why {@link canGenerateReportInstance} said no. */
export function reportGenerationRefusal(
	instance: { userId: string },
	user: ReportCaller,
): string {
	return instance.userId === user.id
		? "Your role on this project lets you read this report, but not generate it"
		: GENERATE_OWNER_ONLY_MESSAGE;
}

/**
 * Whether the caller's organization role grants a report permission: the
 * check `requireInputOrgPermission` makes for a procedure, for a caller that
 * does not come through one (Fabric Agent's tools).
 */
export async function hasOrganizationReportPermission(
	organizationId: string,
	userId: string,
	permission: Permission,
): Promise<boolean> {
	const membership = await getOrganizationMembership(organizationId, userId);
	return (
		membership !== null &&
		hasPermission(resolveOrgPermissions(membership.role), permission)
	);
}

/**
 * What a platform admin holds on top of {@link hasOrganizationReportPermission}:
 * every report permission in an organization they are a member of. A platform
 * admin who is not a member holds none, because membership is the tenant boundary.
 */
export async function mayUseReportPermission(
	organizationId: string,
	user: ReportCaller,
	permission: Permission,
): Promise<boolean> {
	const membership = await getOrganizationMembership(organizationId, user.id);
	if (!membership) {
		return false;
	}
	return (
		hasPermission(resolveOrgPermissions(membership.role), permission) ||
		isPlatformAdmin(user)
	);
}

/**
 * The check for a procedure admitted on membership alone, so that a platform
 * admin holding a read-only organization role reaches it: everyone else still
 * needs `permission` from their role, as the stricter middleware asked. With no
 * organization there is no role to evaluate, as in `requirePermission`.
 */
export async function assertReportPermission(
	organizationId: string | null | undefined,
	user: ReportCaller,
	permission: Permission,
): Promise<void> {
	if (
		organizationId &&
		!(await mayUseReportPermission(organizationId, user, permission))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: `Missing required permission: ${permission}`,
		});
	}
}

/**
 * Whether the caller inherits Project Editor on every live project's reports in
 * the organization: its admins and owners, and a platform admin who is a member.
 */
export async function inheritsOrganizationReportEditor(
	organizationId: string,
	user: ReportCaller,
): Promise<boolean> {
	const membership = await getOrganizationMembership(organizationId, user.id);
	if (!membership) {
		return false;
	}
	return ORG_ADMIN_ROLES.has(membership.role) || isPlatformAdmin(user);
}

/**
 * Whether the caller may change, archive or delete a report template:
 * SYSTEM templates belong to platform admins, ORGANIZATION templates to the
 * organization's admins and owners, USER templates to their author.
 */
export async function canManageReportTemplate(
	template: {
		scope: ReportTemplateScope;
		userId: string | null;
		organizationId: string | null;
	},
	user: ReportCaller,
): Promise<boolean> {
	switch (template.scope) {
		case "SYSTEM":
			return isPlatformAdmin(user);
		case "ORGANIZATION":
			return template.organizationId
				? isOrganizationReportAdmin(template.organizationId, user.id)
				: false;
		case "USER":
			return template.userId === user.id;
		default: {
			const unreachable: never = template.scope;
			return unreachable;
		}
	}
}

export async function assertCanManageReportTemplate(
	template: {
		scope: ReportTemplateScope;
		userId: string | null;
		organizationId: string | null;
	},
	user: ReportCaller,
): Promise<void> {
	if (!(await canManageReportTemplate(template, user))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You do not have permission to change this template",
		});
	}
}

/** SYSTEM scope and public visibility reach every tenant, so only platform admins set them. */
export async function assertCanPublishReportTemplate(
	request: { scope?: ReportTemplateScope; isPublic?: boolean },
	user: ReportCaller,
): Promise<void> {
	if (request.scope !== "SYSTEM" && request.isPublic !== true) {
		return;
	}
	if (!(await isPlatformAdmin(user))) {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only platform administrators can create system or public templates",
		});
	}
}
