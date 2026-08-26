/**
 * Asana Create Task Step
 * Creates a new task in an Asana project
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeAsanaCreateTaskStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { name, notes, projectId, dueOn } = params.nodeConfig as {
		name?: string;
		notes?: string;
		projectId?: string;
		dueOn?: string;
	};

	if (!name) {
		return { success: false, error: "Task name is required" };
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

	const interpolatedName = interpolateTemplate(name, params.inputs);
	const interpolatedNotes = notes
		? interpolateTemplate(notes, params.inputs)
		: undefined;
	const interpolatedProjectId = projectId
		? interpolateTemplate(projectId, params.inputs)
		: undefined;

	try {
		const body: Record<string, unknown> = { name: interpolatedName };
		if (interpolatedNotes) {
			body.notes = interpolatedNotes;
		}
		if (dueOn) {
			body.due_on = dueOn;
		}
		if (interpolatedProjectId) {
			body.projects = [interpolatedProjectId];
		}

		const response = await fetch("https://app.asana.com/api/1.0/tasks", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.ASANA_ACCESS_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ data: body }),
		});

		const result = (await response.json()) as {
			data?: { gid: string; name: string };
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

		const task = result.data;
		return {
			success: true,
			output: {
				taskId: task?.gid,
				taskUrl: `https://app.asana.com/0/0/${task?.gid}/f`,
				name: task?.name,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Asana task",
		};
	}
}
