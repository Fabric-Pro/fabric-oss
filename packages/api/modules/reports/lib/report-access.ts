/**
 * Who may change reports and report templates.
 *
 * Reads keep the tenant rules in the queries (`getTemplateInstance`,
 * `getReportTemplate`). These helpers answer the narrower question a mutation
 * asks after the row was found: may THIS caller change it.
 */

import { ORPCError } from "@orpc/server";
import { getOrganizationMembership, isPlatformAdmin } from "@repo/database";
import type { ReportTemplateScope } from "@repo/database/prisma/generated/client";
import {
	hasPermission,
	type Permission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { resolveEffectiveProjectPermissions } from "../../../lib/effective-project-permissions";

export type ReportCaller = { id: string; role?: string | null };

const ORG_REPORT_ADMIN_ROLES = new Set(["admin", "owner"]);

async function isOrganizationReportAdmin(
	organizationId: string,
	userId: string,
): Promise<boolean> {
	const membership = await getOrganizationMembership(organizationId, userId);
	return membership !== null && ORG_REPORT_ADMIN_ROLES.has(membership.role);
}

/**
 * What the caller's organization role allows for reports. Report mutations
 * also check the organization role (`REPORT_CREATE` / `REPORT_UPDATE`), so a
 * project role alone never makes someone a report writer: an organization
 * Viewer with an Editor project row, or a project guest who is not an
 * organization member, is refused by the API and must not see edit controls.
 */
async function organizationReportRole(
	organizationId: string,
	userId: string,
): Promise<"admin" | "writer" | null> {
	const membership = await getOrganizationMembership(organizationId, userId);
	if (!membership) {
		return null;
	}
	if (ORG_REPORT_ADMIN_ROLES.has(membership.role)) {
		return "admin";
	}
	const granted = resolveOrgPermissions(membership.role);
	return hasPermission(granted, Permissions.REPORT_CREATE) &&
		hasPermission(granted, Permissions.REPORT_UPDATE)
		? "writer"
		: null;
}

/**
 * Whether the caller may create and edit the reports of a project.
 *
 * Granted to a platform admin; to an admin or owner of the project's
 * organization, even when a lower ProjectMember row would otherwise be
 * authoritative for them; and to anyone whose effective project role holds
 * `REPORT_UPDATE` (Owner, Project Admin, Editor, a personal project's owner,
 * or an organization member without a ProjectMember row) while their
 * organization role also lets them write reports. Viewers, Commenters and
 * project guests may not.
 */
export async function canEditProjectReport(
	projectId: string,
	user: ReportCaller,
): Promise<boolean> {
	if (await isPlatformAdmin(user)) {
		return true;
	}
	const access = await resolveEffectiveProjectPermissions(projectId, user.id);
	if (!access || access.source === "none" || access.organizationDeleted) {
		return false;
	}
	const projectAllows = hasPermission(
		access.permissions,
		Permissions.REPORT_UPDATE,
	);
	if (!access.organizationId) {
		return projectAllows;
	}
	const orgRole = await organizationReportRole(
		access.organizationId,
		user.id,
	);
	return orgRole === "admin" || (orgRole === "writer" && projectAllows);
}

/**
 * Whether the caller may change a report instance they can already see: a
 * platform admin, an admin or owner of its organization, or a member whose
 * organization role lets them write reports and who either owns the report or,
 * for a project report, may edit the project's reports.
 */
export async function canEditReportInstance(
	instance: {
		userId: string;
		organizationId: string | null;
		projectId: string | null;
	},
	user: ReportCaller,
): Promise<boolean> {
	if (await isPlatformAdmin(user)) {
		return true;
	}
	if (instance.organizationId) {
		const orgRole = await organizationReportRole(
			instance.organizationId,
			user.id,
		);
		if (orgRole === null) {
			return false;
		}
		if (orgRole === "admin") {
			return true;
		}
	}
	if (instance.userId === user.id) {
		return true;
	}
	return instance.projectId
		? canEditProjectReport(instance.projectId, user)
		: false;
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
 * Whether the caller may generate a report. A report runs on its owner's
 * connections, so only the owner may start one; editors may change it.
 */
export function canGenerateReportInstance(
	instance: { userId: string },
	user: ReportCaller,
): boolean {
	return instance.userId === user.id;
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

export const GENERATE_OWNER_ONLY_MESSAGE =
	"Only the report's owner can generate it, because it runs on the owner's connections";

export function assertCanGenerateReportInstance(
	instance: { userId: string },
	user: ReportCaller,
): void {
	if (!canGenerateReportInstance(instance, user)) {
		throw new ORPCError("FORBIDDEN", {
			message: GENERATE_OWNER_ONLY_MESSAGE,
		});
	}
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
 * Whether the caller may change, archive or delete a report template:
 * SYSTEM templates belong to platform admins, ORGANIZATION templates to the
 * organization's admins and owners, USER templates to their author.
 */
async function canManageReportTemplate(
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
