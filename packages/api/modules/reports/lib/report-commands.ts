import { ORPCError } from "@orpc/server";
import {
	getOrganizationMembership,
	getTemplateInstance,
	getTemplateInstanceArtifact,
	getTemplateInstanceExecution,
	readReportProjectBindings,
} from "@repo/database";
import { projectReportDiagnostics } from "@repo/database/prisma/queries/lib/report-public-diagnostics";
import { loadReportDiagnosticSources } from "@repo/database/prisma/queries/report-diagnostic-labels";
import {
	distributeReportArtifact,
	ReportDistributionError,
	reportArtifactHash,
	reportDistributionSchema,
} from "@repo/database/prisma/queries/report-distribution";
import {
	listNativeReportArtifacts,
	listNativeReportExecutions,
	NativeReportHistoryError,
} from "@repo/database/prisma/queries/report-native-history";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { z } from "zod";
import {
	downloadInputSchema,
	handleDownloadReportArtifact,
} from "../procedures/artifacts/download";
import {
	handleListReportDeliveries,
	listDeliveriesInputSchema,
} from "../procedures/artifacts/list-deliveries";
import {
	cancelExecutionInputSchema,
	handleCancelReportExecution,
} from "../procedures/instances/cancel-execution";
import {
	createInstanceInputSchema,
	handleCreateReportInstance,
} from "../procedures/instances/create";
import {
	executeInstanceInputSchema,
	handleExecuteReportInstance,
} from "../procedures/instances/execute";
import {
	getInstanceInputSchema,
	handleGetReportInstance,
} from "../procedures/instances/get";
import {
	handleListReportInstances,
	listInstancesInputSchema,
} from "../procedures/instances/list";
import {
	handleUpdateReportInstance,
	updateInstanceInputSchema,
} from "../procedures/instances/update";
import {
	nativeArtifactHistoryInput,
	nativeExecutionHistoryInput,
} from "./report-history-contract";

export const REPORT_OPERATIONS = [
	"list",
	"executions",
	"artifacts",
	"create",
	"get",
	"update",
	"execute",
	"status",
	"cancel",
	"download",
	"deliveries",
	"distribute",
] as const;
export type ReportOperation = (typeof REPORT_OPERATIONS)[number];
export interface ReportCommandActor {
	userId: string;
	organizationId: string;
	scopes: readonly string[];
	boundProjectId?: string;
}
const permissions = {
	list: Permissions.REPORT_READ,
	executions: Permissions.REPORT_READ,
	artifacts: Permissions.REPORT_READ,
	get: Permissions.REPORT_READ,
	status: Permissions.REPORT_READ,
	download: Permissions.REPORT_READ,
	deliveries: Permissions.REPORT_READ,
	create: Permissions.REPORT_CREATE,
	update: Permissions.REPORT_UPDATE,
	execute: Permissions.REPORT_EXECUTE,
	cancel: Permissions.REPORT_EXECUTE,
	distribute: Permissions.REPORT_SHARE,
} as const;
export function reportOperationScope(operation: ReportOperation) {
	return [
		"list",
		"get",
		"status",
		"download",
		"deliveries",
		"executions",
		"artifacts",
	].includes(operation)
		? "reports:read"
		: "reports:write";
}
async function assertBinding(
	actor: ReportCommandActor,
	instance: { fabricConfig?: unknown },
	parameters?: unknown,
) {
	if (!actor.boundProjectId) {
		return;
	}
	let bindings: string[];
	try {
		bindings = readReportProjectBindings(instance.fabricConfig, parameters);
	} catch {
		throw new ORPCError("BAD_REQUEST", {
			message:
				"Report audience or execution parameters are invalid. Review the report settings before trying again.",
		});
	}
	if (bindings.length !== 1 || bindings[0] !== actor.boundProjectId) {
		throw new ORPCError("NOT_FOUND", { message: "Report not found" });
	}
}
const idSchema = z.object({ executionId: z.string().min(1) });
/** Same Portal handlers, with the key's scope AND its creator's live role rechecked independently. */
export async function runReportCommand(
	actor: ReportCommandActor,
	operation: ReportOperation,
	raw: unknown,
) {
	if (!actor.organizationId || !actor.userId) {
		throw new ORPCError("FORBIDDEN");
	}
	const scope = reportOperationScope(operation);
	if (!actor.scopes.includes("*") && !actor.scopes.includes(scope)) {
		throw new ORPCError("FORBIDDEN", {
			message: `Missing scope: ${scope}`,
			data: { reason: "SCOPE_REQUIRED" },
		});
	}
	const membership = await getOrganizationMembership(
		actor.organizationId,
		actor.userId,
	);
	if (
		!membership ||
		!hasPermission(
			resolveOrgPermissions(membership.role),
			permissions[operation],
		)
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "Your current role cannot perform this report operation",
			data: { reason: "PERMISSION_REQUIRED" },
		});
	}
	const record = z.record(z.string(), z.unknown()).safeParse(raw);
	if (!record.success) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Provide a report operation object",
		});
	}
	const value = record.data;
	if ("userId" in value || "actor" in value || "scopes" in value) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Actor and credentials are resolved by Fabric",
		});
	}
	if (
		value.organizationId !== undefined &&
		value.organizationId !== actor.organizationId
	) {
		throw new ORPCError("NOT_FOUND");
	}
	const input: Record<string, unknown> = {
		...value,
		organizationId: actor.organizationId,
	};
	const context: import("./report-command-context").ReportCommandContext = {
		user: { id: actor.userId },
		session: { activeOrganizationId: actor.organizationId },
	};
	try {
		if (operation === "executions") {
			return await listNativeReportExecutions(
				actor,
				nativeExecutionHistoryInput.parse(
					Object.fromEntries(
						Object.entries(input).filter(
							([key]) => key !== "organizationId",
						),
					),
				),
			);
		}
		if (operation === "artifacts") {
			return await listNativeReportArtifacts(
				actor,
				nativeArtifactHistoryInput.parse(
					Object.fromEntries(
						Object.entries(input).filter(
							([key]) => key !== "organizationId",
						),
					),
				),
			);
		}
		if (operation === "create") {
			const parsed = createInstanceInputSchema.parse(input);
			if (
				actor.boundProjectId &&
				parsed.reporting?.projectId !== actor.boundProjectId
			) {
				throw new ORPCError("NOT_FOUND");
			}
			return await handleCreateReportInstance({ input: parsed, context });
		}
		if (operation === "list") {
			if (
				actor.boundProjectId &&
				input.projectId !== undefined &&
				input.projectId !== actor.boundProjectId
			) {
				throw new ORPCError("NOT_FOUND");
			}
			const parsed = listInstancesInputSchema.parse({
				...input,
				...(actor.boundProjectId
					? { projectId: actor.boundProjectId }
					: {}),
			});
			return await handleListReportInstances({ input: parsed, context });
		}
		if (
			operation === "get" ||
			operation === "update" ||
			operation === "execute"
		) {
			const id = z
				.string()
				.min(1)
				.parse(operation === "execute" ? input.instanceId : input.id);
			const instance = await getTemplateInstance({
				id,
				userId: actor.userId,
				organizationId: actor.organizationId,
			});
			if (!instance) {
				throw new ORPCError("NOT_FOUND", {
					message: "Report not found",
				});
			}
			await assertBinding(
				actor,
				instance,
				operation === "execute" ? input.parameters : undefined,
			);
			if (operation === "get") {
				return await handleGetReportInstance({
					input: getInstanceInputSchema.parse(input),
					context,
				});
			}
			if (operation === "update") {
				const parsed = updateInstanceInputSchema
					.extend({
						expectedVersion: z.number().int().positive(),
						expectedUpdatedAt: z.coerce.date(),
					})
					.parse(input);
				return await handleUpdateReportInstance({
					input: parsed,
					context,
				});
			}
			return await handleExecuteReportInstance({
				input: executeInstanceInputSchema.parse(input),
				context,
			});
		}
		if (operation === "status" || operation === "cancel") {
			const { executionId } = idSchema.parse(input);
			const execution = await getTemplateInstanceExecution(
				executionId,
				actor,
			);
			if (!execution) {
				throw new ORPCError("NOT_FOUND", {
					message: "Report execution not found",
				});
			}
			await assertBinding(
				actor,
				execution.instance,
				execution.parameters,
			);
			if (operation === "cancel") {
				return await handleCancelReportExecution({
					input: cancelExecutionInputSchema.parse(input),
					context,
				});
			}
			const diagnosticSources = await loadReportDiagnosticSources(
				actor,
				execution.instance,
			);
			return {
				executionId: execution.id,
				instanceId: execution.instanceId,
				status: execution.status,
				startedAt: execution.startedAt?.toISOString() ?? null,
				completedAt: execution.completedAt?.toISOString() ?? null,
				duration: execution.duration,
				mcpDiagnostics: projectReportDiagnostics(
					execution.mcpDiagnostics,
					diagnosticSources,
				),
				error: execution.error
					? "The report did not finish. Review its run details before trying again."
					: null,
				artifacts:
					execution.status === "CANCELLED"
						? []
						: execution.artifacts.map((artifact) => ({
								id: artifact.id,
								name: artifact.name,
								artifactType: artifact.artifactType,
								mimeType: artifact.mimeType,
								size: artifact.size,
								createdAt: artifact.createdAt.toISOString(),
								artifactHash: reportArtifactHash(artifact),
								linkedFrameId:
									artifact.metadata &&
									typeof artifact.metadata === "object" &&
									!Array.isArray(artifact.metadata) &&
									typeof artifact.metadata.linkedFrameId ===
										"string"
										? artifact.metadata.linkedFrameId
										: null,
							})),
			};
		}
		const id = z
			.string()
			.min(1)
			.parse(operation === "download" ? input.id : input.artifactId);
		const artifact = await getTemplateInstanceArtifact(id, actor);
		if (!artifact || artifact.execution.status === "CANCELLED") {
			throw new ORPCError("NOT_FOUND", {
				message: "Report artifact not found",
			});
		}
		await assertBinding(
			actor,
			artifact.execution.instance,
			artifact.execution.parameters,
		);
		if (operation === "distribute") {
			const { organizationId: _, ...request } = input;
			return await distributeReportArtifact(
				actor,
				reportDistributionSchema.parse(request),
			);
		}
		if (operation === "download") {
			return await handleDownloadReportArtifact({
				input: downloadInputSchema.parse(input),
				context,
			});
		}
		if (operation === "deliveries") {
			return await handleListReportDeliveries({
				input: listDeliveriesInputSchema.parse(input),
				context,
			});
		}
		throw new ORPCError("BAD_REQUEST", {
			message: "Unsupported report operation",
		});
	} catch (error) {
		if (error instanceof NativeReportHistoryError) {
			throw new ORPCError(error.code, { message: error.message });
		}
		if (error instanceof ReportDistributionError) {
			throw new ORPCError(error.code, { message: error.message });
		}
		if (error instanceof z.ZodError) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Report settings are invalid. Read the current report and review the required fields.",
			});
		}
		throw error;
	}
}
