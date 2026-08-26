const KANBAN_RUNTIME_ORIGIN = "http://localhost:3484";
const KANBAN_BASE_PATH = "/fabric";

export interface KanbanRuntimeStatus {
	mode: "embed" | "standalone";
	parentOrigin: string | null;
}

export interface KanbanLaunchUrlInput {
	projectId: string;
	storyId?: string;
	parentOrigin: string;
	token: string;
	/** Sidebar mode: "collapsed" | "expanded" | false (default: "collapsed") */
	sidebar?: false | "collapsed" | "expanded";
	/** Whether to show TopBar: default true */
	showTopBar?: boolean;
	/** Project name from Fabric Portal */
	projectName?: string;
	/** Repository URL from Fabric Portal */
	repositoryUrl?: string | null;
	/** Whether repository is configured in Fabric Portal */
	repoConfigured?: boolean;
}

function buildBaseRuntimeUrl(): URL {
	return new URL(`${KANBAN_RUNTIME_ORIGIN}${KANBAN_BASE_PATH}/`);
}

function normalizeOrigin(origin: string | null | undefined): string | null {
	const trimmed = origin?.trim();
	if (!trimmed) {
		return null;
	}
	try {
		return new URL(trimmed).origin;
	} catch {
		return trimmed.replace(/\/+$/, "");
	}
}

export function buildKanbanRuntimeStatusUrl(): string {
	return `${KANBAN_RUNTIME_ORIGIN}/api/runtime/status`;
}

export function getKanbanLaunchModeFromStatus(
	status: KanbanRuntimeStatus | null | undefined,
	parentOrigin: string,
): "embed" | "external" {
	if (!status) {
		return "external";
	}
	if (status.mode !== "embed") {
		return "external";
	}
	const runtimeParentOrigin = normalizeOrigin(status.parentOrigin);
	const requestedParentOrigin = normalizeOrigin(parentOrigin);
	if (runtimeParentOrigin && runtimeParentOrigin !== requestedParentOrigin) {
		return "external";
	}
	return "embed";
}

export function buildEmbeddedKanbanUrl({
	projectId,
	storyId,
	parentOrigin,
	token,
	sidebar = "collapsed",
	showTopBar = true,
	projectName,
	repositoryUrl,
	repoConfigured,
}: KanbanLaunchUrlInput): string {
	const url = buildBaseRuntimeUrl();
	url.searchParams.set("embed", "true");
	url.searchParams.set("projectId", projectId);
	url.searchParams.set("parentOrigin", parentOrigin);
	url.searchParams.set("embedToken", token);
	// Show sidebar in collapsed mode by default for better UX in embed mode
	url.searchParams.set("sidebar", sidebar === false ? "false" : sidebar);
	// Show TopBar by default to display Fabric logo and navigation
	url.searchParams.set("topBar", showTopBar ? "true" : "false");
	// Pass project info for embed mode project-not-found handling
	if (projectName) {
		url.searchParams.set("projectName", projectName);
	}
	if (repositoryUrl) {
		url.searchParams.set("repoUrl", repositoryUrl);
	}
	if (repoConfigured !== undefined) {
		url.searchParams.set(
			"repoConfigured",
			repoConfigured ? "true" : "false",
		);
	}
	if (storyId) {
		url.searchParams.set("taskId", storyId);
	}
	return url.toString();
}

export function buildProtocolKanbanUrl({
	projectId,
	storyId,
	parentOrigin,
	token,
}: KanbanLaunchUrlInput): string {
	const url = new URL("fabric-kanban://open");
	url.searchParams.set("projectId", projectId);
	url.searchParams.set("origin", parentOrigin);
	url.searchParams.set("token", token);
	if (storyId) {
		url.searchParams.set("taskId", storyId);
	}
	return url.toString();
}

export function buildStandaloneKanbanUrl(embedUrl: string): string {
	const url = new URL(embedUrl);
	// Strip embed-specific params so kanban loads as a standalone page
	// without waiting for postMessages from a parent portal
	url.searchParams.delete("embed");
	url.searchParams.delete("parentOrigin");
	url.searchParams.delete("sidebar");
	url.searchParams.delete("topBar");
	return url.toString();
}
