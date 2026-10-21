import {
	AzureDevOpsProjectReadError,
	getAzureDevOpsProjectWorkItemCounts,
	getAzureDevOpsStorySnapshots,
	listAzureDevOpsAssignedStories,
	listAzureDevOpsProjectMembers,
	listAzureDevOpsWorkItemTypes,
} from "@repo/connectors";
import { resolveProjectPmRead } from "@repo/mcp/lib/project-pm-read";
import type { z } from "zod";
import type { projectPmToolInput } from "../../lib/project-pm-input";
import { boundedProjectPmSnapshots } from "./project-pm-snapshot-result";

export async function readProjectPmTool(
	call: z.infer<typeof projectPmToolInput>,
	actor: { userId: string; organizationId: string },
) {
	try {
		const connection = await resolveProjectPmRead({
			projectId: call.input.projectId,
			...actor,
		});
		if (connection.status === "not_found") {
			return {
				success: false,
				error: "Project not found or access denied",
			} as const;
		}
		if (connection.status === "forbidden") {
			return { success: false, error: connection.message } as const;
		}
		if (connection.status !== "ready") {
			return { success: true, result: connection } as const;
		}
		const { pat, ...publicConnection } = connection;
		switch (call.name) {
			case "fabric_get_project_pm_connection":
				return { success: true, result: publicConnection } as const;
			case "fabric_list_project_pm_assigned_items":
				return {
					success: true,
					result: {
						...publicConnection,
						...(await listAzureDevOpsAssignedStories(
							connection.target,
							pat,
							{ ...call.input, limit: 50 },
						)),
					},
				} as const;
			case "fabric_get_project_pm_item_snapshots":
				return {
					success: true,
					result: boundedProjectPmSnapshots(
						await getAzureDevOpsStorySnapshots(
							connection.target,
							pat,
							call.input,
						),
						call.input.ids,
						publicConnection,
					),
				} as const;
			case "fabric_list_project_pm_work_item_types":
				return {
					success: true,
					result: {
						...publicConnection,
						...(await listAzureDevOpsWorkItemTypes(
							connection.target,
							pat,
						)),
					},
				} as const;
			case "fabric_list_project_pm_members":
				return {
					success: true,
					result: {
						...publicConnection,
						...(await listAzureDevOpsProjectMembers(
							connection.target,
							pat,
						)),
					},
				} as const;
			case "fabric_get_project_work_item_counts":
				return {
					success: true,
					result: {
						...publicConnection,
						...(await getAzureDevOpsProjectWorkItemCounts(
							connection.target,
							pat,
							call.input,
						)),
					},
				} as const;
			default: {
				const unhandled: never = call;
				throw new Error(`Unhandled project PM tool: ${unhandled}`);
			}
		}
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof AzureDevOpsProjectReadError
					? error.message
					: "Azure DevOps could not complete the project read. Try again.",
		} as const;
	}
}
