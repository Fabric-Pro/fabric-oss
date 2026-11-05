import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import { canEditProject, hasProjectAccess } from "../projects/projects";
import { assertPinnedSkillAccess } from "../skills";
import {
	REPORT_EXECUTION_SNAPSHOT_KEY,
	readReportEvidenceConfig,
	reportExecutionSnapshotSchema,
} from "./report-evidence";

export interface ReportCaller {
	userId: string;
	organizationId?: string;
}
export interface ReportInstanceScope {
	organizationId: string | null;
	userId: string;
	fabricConfig?: unknown;
}

/** Reports require organization membership AND every current/admitted project restriction.
 * Guests never gain Reports access from project membership. A missing caller fails closed.
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
			write ? Permissions.REPORT_UPDATE : Permissions.REPORT_READ,
		)
	) {
		return async () => false;
	}
	// One request/cadence authorization snapshot; repeated report rows must not
	// trigger thousands of identical membership/project lookups before pagination.
	const projects = new Map<string, Promise<boolean>>();
	return async (instance, parameters) => {
		if (instance.organizationId !== organizationId) {
			return false;
		}
		try {
			if (
				parameters &&
				typeof parameters === "object" &&
				REPORT_EXECUTION_SNAPSHOT_KEY in parameters
			) {
				const snapshot = reportExecutionSnapshotSchema.parse(
					(parameters as Record<string, unknown>)[
						REPORT_EXECUTION_SNAPSHOT_KEY
					],
				);
				await assertPinnedSkillAccess(caller, snapshot.skills);
			}
			for (const projectId of readReportProjectBindings(
				instance.fabricConfig,
				parameters,
			)) {
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
						return (
							!!project &&
							(write
								? canEditProject(projectId, caller.userId)
								: hasProjectAccess(
										projectId,
										caller.userId,
										organizationId,
									))
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
			fabricConfig: true,
		},
		take: 5001,
	});
	if (rows.length > 5000) {
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

/** Dispatch-time permission check uses current membership, never the creator's old role. */
export async function canExecuteReportInstance(
	instance: ReportInstanceScope,
	caller: ReportCaller,
	parameters?: unknown,
): Promise<boolean> {
	if (
		!caller.organizationId ||
		!(await canAccessReportInstance(instance, caller, parameters))
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
	return (
		!!member &&
		hasPermission(
			resolveOrgPermissions(member.role),
			Permissions.REPORT_EXECUTE,
		)
	);
}

/** Current and immutable admitted restrictions both apply to a delivery audience.
 * Throws on malformed configuration: callers must deny delivery rather than drop a restriction.
 */
export function readReportProjectBindings(
	fabricConfig: unknown,
	executionParameters?: unknown,
): string[] {
	const ids = new Set<string>();
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
