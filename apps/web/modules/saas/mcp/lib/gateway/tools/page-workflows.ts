import { sessionMayReachProject } from "../project-binding";
import { scopeSatisfied } from "../tool-scope";
import { errorResult, jsonResult } from "../tool-results";
import { accessibleFrame, frameIdOf, NO_PAGE_OPEN } from "./frame-context";
import type { PlatformToolHandler } from "./tool-family";

type Operation = "bind" | "get" | "run" | "history";

function workspaceWorkflowHandler(operation: Operation): PlatformToolHandler {
	return async (args, session) => {
		if (
			operation === "bind" &&
			!scopeSatisfied(
				session.scopes,
				{ scope: "frames:write", kind: "write" },
				session.credential,
			)
		) {
			return errorResult(
				"Workspace binding requires frames:write scope.",
				{
					reason: "insufficient_scope",
				},
			);
		}
		if (!session.organizationId) {
			return errorResult("An organization is required.");
		}
		const frameId = frameIdOf(args, session);
		if (!frameId) {
			return errorResult(NO_PAGE_OPEN);
		}
		const frame = await accessibleFrame(frameId, session);
		if (
			!frame ||
			!frame.projectId ||
			!sessionMayReachProject(session, frame.projectId)
		) {
			return errorResult("Workspace not found or access denied.");
		}
		const commands = await import(
			"@repo/api/modules/workflows/lib/workspace-workflow-commands"
		);
		const { WorkflowCommandError } = await import(
			"@repo/api/modules/workflows/lib/workflow-command-context"
		);
		const actor = {
			userId: session.userId,
			organizationId: session.organizationId,
			projectRestrictionId: frame.projectId,
		};
		const input = { ...args, frameId };
		try {
			switch (operation) {
				case "bind":
					return jsonResult(
						await commands.bindWorkspaceWorkflowCommand(
							actor,
							input,
							{
								userId: session.userId,
								emailSnapshot: session.email,
								nameSnapshot: session.userName,
							},
						),
					);
				case "get":
					return jsonResult(
						await commands.getWorkspaceWorkflowCommand(
							actor,
							input,
						),
					);
				case "run":
					return jsonResult(
						await commands.runWorkspaceWorkflowCommand(
							actor,
							input,
						),
					);
				case "history":
					return jsonResult(
						await commands.listWorkspaceWorkflowRunsCommand(
							actor,
							input,
						),
					);
				default: {
					const exhaustive: never = operation;
					throw new Error(
						`Unsupported workflow operation: ${exhaustive}`,
					);
				}
			}
		} catch (error) {
			return error instanceof WorkflowCommandError
				? errorResult(error.message, { reason: error.code })
				: errorResult("Workspace workflow is unavailable. Try again.");
		}
	};
}

export const handleBindWorkspaceWorkflow = workspaceWorkflowHandler("bind");
export const handleGetWorkspaceWorkflow = workspaceWorkflowHandler("get");
export const handleRunWorkspaceWorkflow = workspaceWorkflowHandler("run");
export const handleListWorkspaceWorkflowRuns =
	workspaceWorkflowHandler("history");
