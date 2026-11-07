import { ORPCError } from "@orpc/server";
import type { ReportOperation } from "@repo/api/modules/reports/lib/report-commands";
import { FABRIC_REPORT_TOOL_DEFINITIONS } from "@repo/temporal/fabric-report-tool-definitions";
import { errorResult, jsonResult } from "../tool-results";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

const operations = {
	fabric_list_reports: "list",
	fabric_create_report: "create",
	fabric_get_report: "get",
	fabric_configure_report: "update",
	fabric_execute_report: "execute",
	fabric_get_report_execution: "status",
	fabric_cancel_report_execution: "cancel",
	fabric_download_report_artifact: "download",
	fabric_distribute_report_artifact: "distribute",
	fabric_get_report_deliveries: "deliveries",
	fabric_list_report_executions: "executions",
	fabric_list_report_artifacts: "artifacts",
} as const satisfies Record<string, ReportOperation>;
export function createReportTools() {
	const family = toolFamily(
		FABRIC_REPORT_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>(
			Object.entries(operations).map(([name, operation]) => [
				name,
				async (args, session) => {
					if (
						!session.organizationId ||
						session.projectId ||
						session.pinnedProjectId ||
						session.pageProjectId ||
						session.credential === "service"
					) {
						return errorResult(
							"Reports require a member organization connection; project-bound and runtime service connections are not supported.",
							{
								code: "FORBIDDEN",
							},
						);
					}
					const input =
						operation === "create" || operation === "update"
							? {
									...(args.settings &&
									typeof args.settings === "object" &&
									!Array.isArray(args.settings)
										? args.settings
										: {}),
									...(operation === "update"
										? { id: args.reportId }
										: {}),
								}
							: operation === "executions"
								? {
										instanceId: args.reportId,
										cursor: args.cursor,
										limit: args.limit,
										status: args.status,
									}
								: operation === "get"
									? { id: args.reportId }
									: operation === "execute"
										? {
												instanceId: args.reportId,
												parameters: args.parameters,
												idempotencyKey:
													args.idempotencyKey,
											}
										: operation === "download"
											? { id: args.artifactId }
											: args;
					try {
						const { runReportCommand } = await import(
							"@repo/api/modules/reports/lib/report-commands"
						);
						return jsonResult(
							await runReportCommand(
								{
									userId: session.userId,
									organizationId: session.organizationId,
									scopes: session.scopes,
									boundProjectId:
										session.pinnedProjectId ??
										session.projectId ??
										session.pageProjectId ??
										undefined,
								},
								operation,
								input,
							),
						);
					} catch (error) {
						return error instanceof ORPCError
							? errorResult(error.message, { code: error.code })
							: errorResult(
									"The report operation could not be confirmed. Inspect the current report before retrying.",
									{ code: "UNAVAILABLE" },
								);
					}
				},
			]),
		),
	);
	return {
		...family,
		scopes: Object.fromEntries(
			Object.entries(family.scopes).map(([name, scope]) => [
				name,
				{ ...scope, exact: true },
			]),
		),
	};
}
