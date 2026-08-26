export interface FabricAgentLinkContext {
	basePath: string;
	projectId?: string | null;
	projectName?: string | null;
	storyId?: string | null;
	storyIdentifier?: string | null;
	storyTitle?: string | null;
	taskId?: string | null;
	taskIdentifier?: string | null;
	taskTitle?: string | null;
	prompt?: string | null;
}

export function buildFabricAgentHref({
	basePath,
	projectId,
	projectName,
	storyId,
	storyIdentifier,
	storyTitle,
	taskId,
	taskIdentifier,
	taskTitle,
	prompt,
}: FabricAgentLinkContext): string {
	const params = new URLSearchParams();

	if (projectId) {
		params.set("projectId", projectId);
	}
	if (projectName) {
		params.set("projectName", projectName);
	}
	if (storyId) {
		params.set("storyId", storyId);
	}
	if (storyIdentifier) {
		params.set("storyIdentifier", storyIdentifier);
	}
	if (storyTitle) {
		params.set("storyTitle", storyTitle);
	}
	if (taskId) {
		params.set("taskId", taskId);
	}
	if (taskIdentifier) {
		params.set("taskIdentifier", taskIdentifier);
	}
	if (taskTitle) {
		params.set("taskTitle", taskTitle);
	}
	if (prompt?.trim()) {
		params.set("prompt", prompt.trim());
	}

	const query = params.toString();
	return `${basePath}/agents/fabric-ai${query ? `?${query}` : ""}`;
}
