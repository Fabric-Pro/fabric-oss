import { FABRIC_PROJECT_PM_TOOL_DEFINITIONS } from "@repo/temporal/fabric-project-pm-tool-definitions";
import { projectPmToolInput } from "@repo/temporal/project-pm-input";
import { readProjectPmTool } from "@repo/temporal/project-pm-service";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
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
			const result = await readProjectPmTool(parsed.data, {
				userId: session.userId,
				organizationId: access.organizationId,
			});
			return result.success
				? jsonResult(result.result)
				: errorResult(result.error);
		});
	}
	return toolFamily(FABRIC_PROJECT_PM_TOOL_DEFINITIONS, handlers);
}
