import { isProjectToolHidden } from "./project-tools";
import { isWorkspaceToolHidden } from "./workspace-tools";

export function isRunContextToolHidden(
	toolName: string,
	context: { projectId?: string | null; workspaceIds?: string[] },
	configId?: string,
): boolean {
	return (
		isProjectToolHidden(toolName, context.projectId, configId) ||
		isWorkspaceToolHidden(toolName, context.workspaceIds)
	);
}
