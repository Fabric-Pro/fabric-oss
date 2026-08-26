import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeClickUpCreateTaskStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { listId, name, description, assigneeId, assignees, priority } =
		params.nodeConfig as {
			listId?: string;
			name?: string;
			description?: string;
			assigneeId?: string;
			assignees?: string;
			priority?: string;
		};

	if (!listId || !name) {
		return { success: false, error: "List ID and task name are required" };
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

	try {
		const body: Record<string, unknown> = {
			name: interpolateTemplate(name, params.inputs),
		};
		if (description) {
			body.description = interpolateTemplate(description, params.inputs);
		}
		const assigneeSource = assignees ?? assigneeId;
		if (assigneeSource) {
			body.assignees = interpolateTemplate(assigneeSource, params.inputs)
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
		}
		if (priority) {
			body.priority = Number.parseInt(priority, 10);
		}

		const resolvedListId = interpolateTemplate(listId, params.inputs);
		const response = await fetch(
			`https://api.clickup.com/api/v2/list/${resolvedListId}/task`,
			{
				method: "POST",
				headers: {
					Authorization: credentials.CLICKUP_API_TOKEN,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			},
		);

		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.err || `ClickUp returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				taskId: result.id,
				taskUrl: result.url,
				name: result.name,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create ClickUp task",
		};
	}
}
