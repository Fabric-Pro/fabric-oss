/**
 * Asana List Tasks Step
 * Lists tasks from an Asana project
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeAsanaListTasksStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { projectId, completed } = params.nodeConfig as {
		projectId?: string;
		completed?: string | boolean;
	};

	if (!projectId) {
		return { success: false, error: "Project ID is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"ASANA",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.ASANA_ACCESS_TOKEN) {
		return {
			success: false,
			error: "Asana access token not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedProjectId = interpolateTemplate(projectId, params.inputs);
	const includeCompleted = completed === true || completed === "true";

	try {
		const url = new URL("https://app.asana.com/api/1.0/tasks");
		url.searchParams.set("project", interpolatedProjectId);
		url.searchParams.set(
			"completed_since",
			includeCompleted ? "now" : "2000-01-01",
		);
		url.searchParams.set(
			"opt_fields",
			"gid,name,completed,due_on,assignee.name",
		);

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${credentials.ASANA_ACCESS_TOKEN}`,
			},
		});

		const result = (await response.json()) as {
			data?: Array<{
				gid: string;
				name: string;
				completed: boolean;
				due_on?: string;
			}>;
			errors?: Array<{ message: string }>;
		};

		if (!response.ok || result.errors) {
			return {
				success: false,
				error:
					result.errors?.[0]?.message ||
					`Asana returned status ${response.status}`,
			};
		}

		const tasks = (result.data ?? []).filter(
			(t) => includeCompleted || !t.completed,
		);

		return {
			success: true,
			output: {
				tasks: tasks.map((t) => ({
					gid: t.gid,
					name: t.name,
					completed: t.completed,
					dueOn: t.due_on,
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
					: "Failed to list Asana tasks",
		};
	}
}
