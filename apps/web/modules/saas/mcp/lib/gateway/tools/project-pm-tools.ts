import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "@repo/temporal/fabric-project-pm-tool-definitions";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { projectPmToolInput } from "./project-pm-input";
import { boundedProjectPmSnapshots } from "./project-pm-snapshot-result";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

export function createProjectPmTools(
	authorize: (
		projectId: string,
		session: GatewaySession,
	) => Promise<{ organizationId: string | null } | null>,
) {
	const handlers = new Map<string, PlatformToolHandler>();
	for (const tool of FABRIC_PROJECT_PM_TOOL_DEFINITIONS) {
		handlers.set(tool.name, async (args, session) => {
			const parsed = projectPmToolInput.safeParse({
				name: tool.name,
				input: args,
			});
			if (!parsed.success) {
				return errorResult(
					"Invalid project PM tool arguments. Use this tool's declared input schema.",
				);
			}
			const access = await authorize(
				parsed.data.input.projectId,
				session,
			);
			if (!access?.organizationId) {
				return errorResult("Project not found or access denied");
			}
			const { resolveProjectPmRead } = await import(
				"@repo/api/modules/projects/lib/project-pm-read"
			);
			const {
				AzureDevOpsProjectReadError,
				listAzureDevOpsProjectMembers,
				listAzureDevOpsWorkItemTypes,
				getAzureDevOpsProjectWorkItemCounts,
				listAzureDevOpsAssignedStories,
				getAzureDevOpsStorySnapshots,
			} = await import("@repo/connectors");
			try {
				const connection = await resolveProjectPmRead({
					projectId: parsed.data.input.projectId,
					userId: session.userId,
					organizationId: access.organizationId,
				});
				if (connection.status === "not_found") {
					return errorResult("Project not found or access denied");
				}
				if (connection.status === "forbidden") {
					return errorResult(connection.message);
				}
				if (connection.status !== "ready") {
					return jsonResult(connection);
				}
				const { pat, ...publicConnection } = connection;
				const call = parsed.data;
				switch (call.name) {
					case "fabric_get_project_pm_connection":
						return jsonResult(publicConnection);
					case "fabric_list_project_pm_assigned_items":
						return jsonResult({
							...publicConnection,
							...(await listAzureDevOpsAssignedStories(
								connection.target,
								pat,
								{ ...call.input, limit: 50 },
							)),
						});
					case "fabric_get_project_pm_item_snapshots":
						return jsonResult(
							boundedProjectPmSnapshots(
								await getAzureDevOpsStorySnapshots(
									connection.target,
									pat,
									call.input,
								),
								call.input.ids,
								publicConnection,
							),
						);
					case "fabric_list_project_pm_work_item_types":
						return jsonResult({
							...publicConnection,
							...(await listAzureDevOpsWorkItemTypes(
								connection.target,
								pat,
							)),
						});
					case "fabric_list_project_pm_members":
						return jsonResult({
							...publicConnection,
							...(await listAzureDevOpsProjectMembers(
								connection.target,
								pat,
							)),
						});
					case "fabric_get_project_work_item_counts":
						return jsonResult({
							...publicConnection,
							...(await getAzureDevOpsProjectWorkItemCounts(
								connection.target,
								pat,
								call.input,
							)),
						});
					default: {
						const unhandled: never = call;
						throw new Error(
							`Unhandled project PM tool: ${unhandled}`,
						);
					}
				}
			} catch (error) {
				return errorResult(
					error instanceof AzureDevOpsProjectReadError
						? error.message
						: "Azure DevOps could not complete the project read. Try again.",
				);
			}
		});
	}
	return toolFamily(FABRIC_PROJECT_PM_TOOL_DEFINITIONS, handlers);
}
