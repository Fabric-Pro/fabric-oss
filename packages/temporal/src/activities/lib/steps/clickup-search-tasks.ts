import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeClickUpSearchTasksStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query, listId, teamId, includeClosed, limit } =
		params.nodeConfig as {
			query?: string;
			listId?: string;
			teamId?: string;
			includeClosed?: string | boolean;
			limit?: string | number;
		};

	if (!query) {
		return { success: false, error: "Search query is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"CLICKUP",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.CLICKUP_API_TOKEN) {
		return {
			success: false,
			error: "ClickUp API token not configured. Please configure it in Settings > Integrations.",
		};
	}

	const searchText = interpolateTemplate(query, params.inputs).toLowerCase();
	const resolvedListId = listId
		? interpolateTemplate(listId, params.inputs)
		: undefined;
	const resolvedTeamId =
		(teamId ? interpolateTemplate(teamId, params.inputs) : undefined) ||
		credentials.CLICKUP_TEAM_ID;

	if (!resolvedListId && !resolvedTeamId) {
		return {
			success: false,
			error: "Provide a ClickUp list ID or save a default team ID in the integration settings.",
		};
	}

	try {
		const url = resolvedListId
			? `https://api.clickup.com/api/v2/list/${resolvedListId}/task?include_closed=${String(includeClosed === true || includeClosed === "true")}`
			: `https://api.clickup.com/api/v2/team/${resolvedTeamId}/task?include_closed=${String(includeClosed === true || includeClosed === "true")}`;
		const response = await fetch(url, {
			headers: {
				Authorization: credentials.CLICKUP_API_TOKEN,
				Accept: "application/json",
			},
		});
		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.err || `ClickUp returned status ${response.status}`,
			};
		}

		const tasks = ((result.tasks as Array<Record<string, unknown>>) ?? [])
			.filter(
				(task) =>
					String(task.name || "")
						.toLowerCase()
						.includes(searchText) ||
					String(task.text_content || "")
						.toLowerCase()
						.includes(searchText),
			)
			.slice(0, Number(limit) || 10);

		return {
			success: true,
			output: {
				tasks: tasks.map((task) => ({
					id: task.id,
					name: task.name,
					status: (task.status as Record<string, unknown> | undefined)
						?.status,
					url: task.url,
				})),
				count: tasks.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search ClickUp tasks",
		};
	}
}
