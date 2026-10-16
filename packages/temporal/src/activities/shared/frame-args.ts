import {
	FRAME_SURFACES,
	type FrameBlock,
	type FrameSurface,
} from "@repo/database";

/**
 * What a caller's arguments to the frame tools mean: the shape a create or an
 * update needs, checked and normalised before anything is read or written.
 * Pure - no I/O - so the service can validate before it touches the database
 * and the tests can run it alone.
 */

export type FrameOutputFormat = "html" | "json" | "mermaid" | "markdown";

/** What a frame with no page of its own is generated from. */
export interface FrameGenerationSpec {
	title: string;
	description: string;
	format: FrameOutputFormat;
	components: Array<{ type: string; label: string }>;
	kind: "frame" | "slideshow";
}

export function getNonEmptyString(
	args: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function getRawString(
	args: Record<string, unknown> | undefined,
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = args?.[key];
		if (typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

function deriveFrameTitle(params: {
	args: Record<string, unknown> | undefined;
	kind: "frame" | "slideshow";
}) {
	const rawDescription =
		getRawString(params.args, ["description", "prompt", "summary"]) || "";
	const cleaned = rawDescription
		.replace(/^create\s+(?:a|an)?\s*/i, "")
		.replace(/^make\s+(?:a|an)?\s*/i, "")
		.replace(/^build\s+(?:a|an)?\s*/i, "")
		.replace(/^generate\s+(?:a|an)?\s*/i, "")
		.replace(/^\d+[- ]slide\s+/i, "")
		.replace(
			/^(?:slideshow|slide deck|presentation)\s+(?:about|for)\s+/i,
			"",
		)
		.replace(/^(?:frame|dashboard|report|visual)\s+(?:about|for)\s+/i, "")
		.replace(/\.$/, "")
		.trim();

	if (!cleaned) {
		return params.kind === "slideshow"
			? "Untitled Slideshow"
			: "Untitled Frame";
	}

	const words = cleaned.split(/\s+/).slice(0, 8);
	const normalized = words
		.map((word) =>
			word.length > 0
				? word.charAt(0).toUpperCase() + word.slice(1)
				: word,
		)
		.join(" ")
		.trim();

	if (!normalized) {
		return params.kind === "slideshow"
			? "Untitled Slideshow"
			: "Untitled Frame";
	}

	return params.kind === "slideshow"
		? normalized.includes("Slideshow") ||
			normalized.includes("Presentation")
			? normalized
			: `${normalized} Slideshow`
		: normalized.includes("Frame")
			? normalized
			: `${normalized} Frame`;
}

export const MAX_FRAME_RUNTIME_TOOLS = 50;
const MAX_FRAME_RUNTIME_TOOL_NAME_LENGTH = 128;

type ParsedOption<T> = { ok: true; value?: T } | { ok: false; error: string };

function parseSurface(
	args: Record<string, unknown> | undefined,
): ParsedOption<FrameSurface> {
	const raw = args?.surface;
	if (raw === undefined || raw === null) {
		return { ok: true };
	}
	const surface = FRAME_SURFACES.find((value) => value === raw);
	return surface
		? { ok: true, value: surface }
		: {
				ok: false,
				error: `\`surface\` must be one of: ${FRAME_SURFACES.join(", ")}.`,
			};
}

/**
 * The Fabric MCP tools a page's own script may call through `window.fabric`.
 * Only the shape is checked here (non-empty names, bounded, no repeats); the
 * gateway, which owns the tool table, rejects names that are not tools.
 */
export function parseRuntimeTools(
	args: Record<string, unknown> | undefined,
): ParsedOption<string[]> {
	const raw = args?.runtimeTools;
	if (raw === undefined || raw === null) {
		return { ok: true };
	}
	if (!Array.isArray(raw)) {
		return {
			ok: false,
			error: "`runtimeTools` must be an array of tool names.",
		};
	}
	if (raw.length > MAX_FRAME_RUNTIME_TOOLS) {
		return {
			ok: false,
			error: `\`runtimeTools\` accepts at most ${MAX_FRAME_RUNTIME_TOOLS} tools.`,
		};
	}
	const tools: string[] = [];
	for (const entry of raw) {
		const name = typeof entry === "string" ? entry.trim() : "";
		if (!name || name.length > MAX_FRAME_RUNTIME_TOOL_NAME_LENGTH) {
			return {
				ok: false,
				error: `Each \`runtimeTools\` entry must be a tool name of 1-${MAX_FRAME_RUNTIME_TOOL_NAME_LENGTH} characters.`,
			};
		}
		if (tools.includes(name)) {
			return {
				ok: false,
				error: `\`runtimeTools\` lists "${name}" more than once.`,
			};
		}
		tools.push(name);
	}
	return { ok: true, value: tools };
}

/**
 * `runtimeTools` decides what a page's script may call as its viewer, so it is
 * never read from a model's raw arguments. It comes only from the caller's own
 * field, which the Fabric MCP gateway fills after checking every name against
 * the tools a page may call; every other caller leaves it unset.
 */
export function withTrustedRuntimeTools(
	args: Record<string, unknown> | undefined,
	runtimeTools: unknown,
): Record<string, unknown> {
	const rest = Object.fromEntries(
		Object.entries(args ?? {}).filter(([key]) => key !== "runtimeTools"),
	);
	return runtimeTools === undefined ? rest : { ...rest, runtimeTools };
}

function normalizeFormat(value?: string): FrameOutputFormat {
	// Always use html — markdown produces plain text which renders poorly as a frame.
	// The HTML generator creates beautifully styled documents for text-heavy content.
	if (value === "json" || value === "mermaid") {
		return value;
	}
	return "html";
}

function normalizeKind(value?: string): "frame" | "slideshow" {
	return value === "slideshow" ? "slideshow" : "frame";
}

function normalizeComponents(
	value: unknown,
): Array<{ type: string; label: string }> {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((component) => {
		if (!component || typeof component !== "object") {
			return [];
		}
		const record = component as Record<string, unknown>;
		const type =
			typeof record.type === "string" && record.type.trim().length > 0
				? record.type.trim()
				: "component";
		const label =
			typeof record.label === "string" && record.label.trim().length > 0
				? record.label.trim()
				: type;
		return [{ type, label }];
	});
}

function normalizeInputBlocks(
	value: unknown,
	defaultFormat: FrameOutputFormat,
): FrameBlock[] | undefined {
	if (!Array.isArray(value) || value.length === 0) {
		return undefined;
	}
	const normalized: FrameBlock[] = [];
	for (let i = 0; i < value.length; i++) {
		const raw = value[i];
		if (!raw || typeof raw !== "object") {
			continue;
		}
		const record = raw as Record<string, unknown>;
		const content =
			typeof record.content === "string" ? record.content : undefined;
		if (!content || content.trim().length === 0) {
			continue;
		}
		const declaredType =
			typeof record.type === "string" ? record.type : undefined;
		const type: FrameOutputFormat =
			declaredType === "html" ||
			declaredType === "json" ||
			declaredType === "mermaid" ||
			declaredType === "markdown"
				? declaredType
				: defaultFormat;
		const id =
			typeof record.id === "string" && record.id.trim().length > 0
				? record.id.trim()
				: `block-${i + 1}`;
		const titleField =
			typeof record.title === "string" ? record.title : undefined;
		const language =
			typeof record.language === "string" ? record.language : undefined;
		const block: FrameBlock = {
			id,
			type,
			content,
			...(titleField ? { title: titleField } : {}),
			...(language ? { language } : {}),
		};
		normalized.push(block);
	}
	return normalized.length > 0 ? normalized : undefined;
}

export function validateCreateFrameArgs(
	args: Record<string, unknown> | undefined,
):
	| {
			ok: true;
			value: FrameGenerationSpec & {
				shareOnCreate: boolean;
				blocks?: FrameBlock[];
				surface?: FrameSurface;
				runtimeTools?: string[];
			};
	  }
	| { ok: false; error: string } {
	const kind = normalizeKind(getNonEmptyString(args, ["kind", "frameType"]));
	const description =
		getRawString(args, ["description", "prompt", "summary"]) || "";
	const explicitTitle = getNonEmptyString(args, [
		"title",
		"frameTitle",
		"name",
	]);
	const title = explicitTitle || deriveFrameTitle({ args, kind });
	const format = normalizeFormat(getNonEmptyString(args, ["format"]));
	const blocks =
		normalizeInputBlocks(args?.blocks, format) ??
		normalizeInputBlocks(args?.components, format);
	const surface = parseSurface(args);
	if (!surface.ok) {
		return surface;
	}
	const runtimeTools = parseRuntimeTools(args);
	if (!runtimeTools.ok) {
		return runtimeTools;
	}

	return {
		ok: true,
		value: {
			title,
			description,
			format,
			components: normalizeComponents(args?.components),
			kind,
			shareOnCreate: Boolean(args?.shareOnCreate),
			...(blocks ? { blocks } : {}),
			...(surface.value ? { surface: surface.value } : {}),
			...(runtimeTools.value ? { runtimeTools: runtimeTools.value } : {}),
		},
	};
}

export function validateUpdateFrameArgs(
	args: Record<string, unknown> | undefined,
):
	| {
			ok: true;
			value: {
				frameId: string;
				title?: string;
				description?: string;
				blocks?: FrameBlock[];
				surface?: FrameSurface;
				runtimeTools?: string[];
			};
	  }
	| { ok: false; error: string } {
	const frameId = getNonEmptyString(args, ["frameId", "id"]);
	if (!frameId) {
		return {
			ok: false,
			error: "Frame ID is required. Provide `frameId` for the frame to update.",
		};
	}

	const title = getNonEmptyString(args, ["title"]);
	const description = getRawString(args, ["description"]);
	const blocks = normalizeInputBlocks(args?.blocks, "html");
	const surface = parseSurface(args);
	if (!surface.ok) {
		return surface;
	}
	const runtimeTools = parseRuntimeTools(args);
	if (!runtimeTools.ok) {
		return runtimeTools;
	}

	if (
		!title &&
		description === undefined &&
		!blocks &&
		!surface.value &&
		!runtimeTools.value
	) {
		return {
			ok: false,
			error: "Provide at least one update field: `title`, `description`, `blocks`, `surface`, or `runtimeTools`.",
		};
	}

	return {
		ok: true,
		value: {
			frameId,
			title,
			description,
			blocks,
			...(surface.value ? { surface: surface.value } : {}),
			...(runtimeTools.value ? { runtimeTools: runtimeTools.value } : {}),
		},
	};
}
