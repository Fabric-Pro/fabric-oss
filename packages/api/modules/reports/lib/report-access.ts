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
import { hasPermission, Permissions } from "@repo/permissions";
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
 * Whether the caller may create and edit the reports of a project.
 *
 * Granted to a platform admin; to an admin or owner of the project's
 * organization, even when a lower ProjectMember row would otherwise be
 * authoritative for them; and to anyone whose effective project role holds
 * `REPORT_UPDATE` (Owner, Project Admin, Editor, a personal project's owner,
 * or an organization member without a ProjectMember row). Viewers and
 * Commenters may not.
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
	if (hasPermission(access.permissions, Permissions.REPORT_UPDATE)) {
		return true;
	}
	return access.organizationId
		? isOrganizationReportAdmin(access.organizationId, user.id)
		: false;
}

/**
 * Whether the caller may change a report instance they can already see: its
 * owner, an admin or owner of its organization, a platform admin, or, for a
 * project report, anyone who may edit the project's reports.
 */
export async function canEditReportInstance(
	instance: {
		userId: string;
		organizationId: string | null;
		projectId: string | null;
	},
	user: ReportCaller,
): Promise<boolean> {
	if (instance.userId === user.id) {
		return true;
	}
	if (await isPlatformAdmin(user)) {
		return true;
	}
	if (
		instance.organizationId &&
		(await isOrganizationReportAdmin(instance.organizationId, user.id))
	) {
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
