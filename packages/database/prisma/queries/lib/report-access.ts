import {
	hasPermission,
	ORG_ADMIN_ROLES,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import { isPlatformAdmin } from "../platform-admin";
import { canEditProject, hasProjectAccess } from "../projects/projects";
import {
	REPORT_EXECUTION_SNAPSHOT_KEY,
	readReportEvidenceConfig,
	reportExecutionSnapshotSchema,
} from "./report-evidence";

export interface ReportCaller {
	userId: string;
	organizationId?: string;
}

/**
 * Whether a member of an organization, holding `role` in it, inherits Project
 * Editor on its reports: its admins and owners, and a platform admin. Read from
 * the user row rather than passed in, so every path to these checks gets one
 * answer, the background ones too.
 */
async function memberInheritsProjectEditor(
	role: string,
	userId: string,
): Promise<boolean> {
	if (ORG_ADMIN_ROLES.has(role)) {
		return true;
	}
	const user = await db.user.findUnique({
		where: { id: userId },
		select: { role: true },
	});
	return isPlatformAdmin({ id: userId, role: user?.role });
}
export interface ReportInstanceScope {
	organizationId: string | null;
	userId: string;
	projectId?: string | null;
	fabricConfig?: unknown;
}

/** Reports require organization membership AND every current/admitted project restriction.
 * Guests never gain Reports access from project membership. A missing caller fails closed.
 * A write needs to reach every bound project and hold edit rights on it, so nobody writes a
 * report they could not then open. An organization role that cannot write reports passes only
 * through those rights, so a report bound to no project stays refused.
 * An organization admin or owner inherits Project Editor: every live project of the organization
 * passes for them, read and write, whatever row they hold or lack there. So does a platform admin
 * who is a member of the organization. Membership stays the tenant boundary: a platform admin who
 * is not a member is refused like anyone else.
 */
export async function createReportAccessChecker(
	caller: ReportCaller | undefined,
	write = false,
): Promise<
	(instance: ReportInstanceScope, parameters?: unknown) => Promise<boolean>
> {
	if (!caller?.organizationId) {
		return async () => false;
	}
	const organizationId = caller.organizationId;
	const member = await db.member.findUnique({
		where: {
			organizationId_userId: { organizationId, userId: caller.userId },
		},
		select: { role: true },
	});
	if (
		!member ||
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.REPORT_READ,
		)
	) {
		return async () => false;
	}
	const inheritsProjectEditor = await memberInheritsProjectEditor(
		member.role,
		caller.userId,
	);
	const needsProjectGrant =
		write &&
		!inheritsProjectEditor &&
		!hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.REPORT_UPDATE,
		);
	// One request/cadence authorization snapshot; repeated report rows must not
	// trigger thousands of identical membership/project lookups before pagination.
	const projects = new Map<string, Promise<boolean>>();
	return async (instance, parameters) => {
		if (instance.organizationId !== organizationId) {
			return false;
		}
		try {
			const projectIds = readReportProjectBindings(
				instance.fabricConfig,
				parameters,
				instance.projectId,
			);
			if (needsProjectGrant && projectIds.length === 0) {
				return false;
			}
			for (const projectId of projectIds) {
				let allowed = projects.get(projectId);
				if (!allowed) {
					allowed = (async () => {
						const project = await db.project.findFirst({
							where: {
								id: projectId,
								organizationId,
								deletedAt: null,
							},
							select: { id: true },
						});
						if (!project) {
							return false;
						}
						if (inheritsProjectEditor) {
							return true;
						}
						return (
							(await hasProjectAccess(
								projectId,
								caller.userId,
								organizationId,
							)) &&
							(!write ||
								(await canEditProject(
									projectId,
									caller.userId,
								)))
						);
					})();
					projects.set(projectId, allowed);
				}
				if (!(await allowed)) {
					return false;
				}
			}
			return true;
		} catch {
			return false;
		}
	};
}

/**
 * The organization of a live project, when the caller is a member who inherits
 * Project Editor there: the inheritance {@link createReportAccessChecker}
 * applies, for a caller that must first decide whether the project is reachable
 * at all.
 */
export async function getReportAdminProjectOrganization(
	projectId: string,
	userId: string,
): Promise<{ organizationId: string } | null> {
	const project = await db.project.findFirst({
		where: { id: projectId, deletedAt: null },
		select: { organizationId: true },
	});
	if (!project?.organizationId) {
		return null;
	}
	const member = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: project.organizationId,
				userId,
			},
		},
		select: { role: true },
	});
	return member && (await memberInheritsProjectEditor(member.role, userId))
		? { organizationId: project.organizationId }
		: null;
}

export async function canAccessReportInstance(
	instance: ReportInstanceScope,
	caller: ReportCaller | undefined,
	executionParameters?: unknown,
	write = false,
): Promise<boolean> {
	if (
		!caller?.organizationId ||
		instance.organizationId !== caller.organizationId
	) {
		return false;
	}
	return (await createReportAccessChecker(caller, write))(
		instance,
		executionParameters,
	);
}

/** Apply the same predicate before pagination/count, so hidden rows do not leak through totals.
 * Bound the discovery pass; an unusually large collection fails closed rather than leaking.
 */
export async function reportScopeWhere(
	caller: ReportCaller,
): Promise<Prisma.TemplateInstanceWhereInput> {
	if (!caller.organizationId) {
		return { id: { in: [] } };
	}
	const rows = await db.templateInstance.findMany({
		where: { organizationId: caller.organizationId, userId: caller.userId },
		select: {
			id: true,
			userId: true,
			organizationId: true,
			projectId: true,
			fabricConfig: true,
		},
		take: 5001,
	});
	if (rows.length === 0 || rows.length > 5000) {
		return { id: { in: [] } };
	}
	const ids: string[] = [];
	const canRead = await createReportAccessChecker(caller);
	for (const row of rows) {
		if (await canRead(row)) {
			ids.push(row.id);
		}
	}
	return { id: { in: ids } };
}

/**
 * Dispatch-time permission check uses current membership, never the creator's old role.
 * A run uses its owner's connections, so only the owner runs a report, and the project role
 * decides whether they still may: an owner demoted to a Viewer row reads and no more. The same
 * rule as `canGenerateReportInstance` in the API, for the runs nobody is waiting on.
 */
export async function canExecuteReportInstance(
	instance: ReportInstanceScope,
	caller: ReportCaller,
	parameters?: unknown,
): Promise<boolean> {
	if (
		!caller.organizationId ||
		instance.userId !== caller.userId ||
		!(await canAccessReportInstance(instance, caller, parameters, true))
	) {
		return false;
	}
	const member = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: caller.organizationId,
				userId: caller.userId,
			},
		},
		select: { role: true },
	});
	if (!member) {
		return false;
	}
	return (
		hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.REPORT_EXECUTE,
		) || memberInheritsProjectEditor(member.role, caller.userId)
	);
}

/** Current and immutable admitted restrictions both apply to a delivery audience.
 * Throws on malformed configuration: callers must deny delivery rather than drop a restriction.
 */
export function readReportProjectBindings(
	fabricConfig: unknown,
	executionParameters?: unknown,
	instanceProjectId?: string | null,
): string[] {
	const ids = new Set<string>();
	if (instanceProjectId) {
		ids.add(instanceProjectId);
	}
	const config = readReportEvidenceConfig(fabricConfig);
	if (config?.projectId) {
		ids.add(config.projectId);
	}
	if (
		executionParameters &&
		typeof executionParameters === "object" &&
		REPORT_EXECUTION_SNAPSHOT_KEY in executionParameters
	) {
		const snapshot = reportExecutionSnapshotSchema.parse(
			(executionParameters as Record<string, unknown>)[
				REPORT_EXECUTION_SNAPSHOT_KEY
			],
		);
		if (snapshot.config?.projectId) {
			ids.add(snapshot.config.projectId);
		}
	}
	return [...ids];
}
