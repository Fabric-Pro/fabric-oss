export interface FrameToolResult {
	frameId: string;
	title?: string;
	description?: string;
	kind?: "frame" | "slideshow";
	contentType?: string;
	frameUrl?: string;
	embedUrl?: string;
	shareUrl?: string;
	shareEmbedUrl?: string;
	response?: string;
	blocks?: unknown[];
}

function parseJsonString(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export function extractFrameToolResult(value: unknown): FrameToolResult | null {
	const parsed = typeof value === "string" ? parseJsonString(value) : value;
	if (!parsed || typeof parsed !== "object") {
		return null;
	}

	const obj = parsed as Record<string, unknown>;
	const frameId = typeof obj.frameId === "string" ? obj.frameId : null;
	if (!frameId) {
		return null;
	}

	return {
		frameId,
		title: typeof obj.title === "string" ? obj.title : undefined,
		description:
			typeof obj.description === "string" ? obj.description : undefined,
		kind:
			obj.kind === "frame" || obj.kind === "slideshow"
				? obj.kind
				: undefined,
		contentType:
			typeof obj.contentType === "string" ? obj.contentType : undefined,
		frameUrl: typeof obj.frameUrl === "string" ? obj.frameUrl : undefined,
		embedUrl: typeof obj.embedUrl === "string" ? obj.embedUrl : undefined,
		shareUrl: typeof obj.shareUrl === "string" ? obj.shareUrl : undefined,
		shareEmbedUrl:
			typeof obj.shareEmbedUrl === "string"
				? obj.shareEmbedUrl
				: undefined,
		response: typeof obj.response === "string" ? obj.response : undefined,
		blocks: Array.isArray(obj.blocks) ? obj.blocks : undefined,
	};
}

export function isFrameToolName(toolName: string): boolean {
	return [
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_share_frame",
		"fabric_create_slideshow",
	].includes(toolName);
}
