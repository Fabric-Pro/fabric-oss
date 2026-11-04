import { ORPCError } from "@orpc/server";
import { getProjectAccessContext, isProjectSoftDeleted } from "@repo/database";
import { readAgentProjectBinding } from "@repo/database/prisma/queries/lib/agent-project-binding";

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export async function prepareAgentProjectConfiguration(input: {
	userId: string;
	organizationId: string;
	projectId?: string | null;
	expectedOutput?: string;
	customInstructions?: unknown;
	toolConnections?: unknown;
	previousInstructions?: unknown;
	previousToolConnections?: unknown;
}) {
	if (!input.organizationId) {
		throw new ORPCError("FORBIDDEN", {
			message: "An organization is required",
		});
	}
	const previous = object(input.previousInstructions);
	const provided = object(input.customInstructions);
	const customInstructions = { ...previous, ...provided };
	const toolConnections = {
		...object(input.toolConnections ?? input.previousToolConnections),
	};
	if (input.projectId !== undefined) {
		customInstructions.projectId = input.projectId;
		// Keep an already enabled legacy tool consistent, without enabling a new one.
		if ("project-context" in toolConnections) {
			const config = { ...object(toolConnections["project-context"]) };
			if (input.projectId === null) {
				delete config.projectId;
			} else {
				config.projectId = input.projectId;
			}
			toolConnections["project-context"] = config;
		}
	}
	if (input.expectedOutput !== undefined) {
		customInstructions.expectedOutput = input.expectedOutput.trim();
	}
	if (
		customInstructions.expectedOutput !== undefined &&
		(typeof customInstructions.expectedOutput !== "string" ||
			customInstructions.expectedOutput.length > 4000)
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid expected output",
		});
	}
	let projectId: string | undefined;
	try {
		projectId = readAgentProjectBinding(
			customInstructions,
			toolConnections,
		);
	} catch {
		throw new ORPCError("BAD_REQUEST", {
			message: "Invalid agent project binding",
		});
	}
	if (projectId) {
		const access = await getProjectAccessContext(projectId, input.userId);
		if (
			access?.organizationId !== input.organizationId ||
			(await isProjectSoftDeleted(projectId))
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project not found or access denied",
			});
		}
	}
	return { customInstructions, toolConnections, projectId };
}
