/**
 * Pure parsing helpers for MCP App tool results and Excalidraw scenes.
 *
 * Kept dependency-free on purpose: `McpAppFrame.tsx` / `ExcalidrawPreview.tsx`
 * pull in `@excalidraw/excalidraw` and iframe plumbing, which makes them
 * heavy to import in unit tests. Everything here is plain data-in/data-out.
 *
 * The shapes accepted here are deliberately WIDE. Tool args and results
 * reach the renderers through several adapters (CopilotKit frontend
 * actions, the `__fabricMcpRender` envelope minted by
 * `apps/web/app/api/mcp-app/invoke/route.ts`, Temporal orchestrator tool
 * calls) and arrive as objects on some paths and JSON strings on others.
 * The `create_view` tool schema itself declares `elements` as a
 * JSON-encoded string (the upstream Excalidraw MCP server validates it
 * that way), so a schema-conformant call MUST be renderable from the
 * string form.
 */

const FABRIC_MCP_RENDER_KEY = "__fabricMcpRender";

/**
 * Parse Excalidraw `elements` from a tool-args value. Accepts a real
 * array or a JSON-encoded string of one. Returns `null` unless the
 * result is a non-empty array — an empty scene is never renderable, and
 * callers use `null` to mean "nothing to draw".
 */
export function parseExcalidrawElements(
	raw: unknown,
): Record<string, unknown>[] | null {
	let value: unknown = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (Array.isArray(value) && value.length > 0) {
		return value as Record<string, unknown>[];
	}
	return null;
}

/**
 * Parse Excalidraw `appState` from a tool-args value. Accepts an object
 * or a JSON-encoded string of one; anything else → `undefined` (the
 * canvas falls back to its defaults).
 */
export function parseExcalidrawAppState(
	raw: unknown,
): Record<string, unknown> | undefined {
	let value: unknown = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return undefined;
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

/**
 * Normalize a tool-args value to a plain object. JSON strings are
 * parsed (recursively, in case of double encoding); arrays and scalars
 * have no named args to offer and normalize to `undefined`. Nested
 * values (e.g. a JSON-string `elements`) are left as-is — field-level
 * parsing belongs to the field's consumer.
 */
export function normalizeToolArgs(
	value: unknown,
): Record<string, unknown> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return normalizeToolArgs(parsed);
		} catch {
			return undefined;
		}
	}

	if (Array.isArray(value)) {
		return undefined;
	}

	if (typeof value === "object") {
		return value as Record<string, unknown>;
	}

	return undefined;
}

/**
 * Extract a checkpoint identifier from an MCP tool result. The shape varies
 * across MCP server implementations — some put it at the top level, some
 * nest it under `structuredContent`, and some only mention it in a free-text
 * content block. The chat render paths additionally hand us the result as a
 * JSON string (CopilotKit stringifies tool results, and our own handlers
 * stringify before returning to the agent), so string input is parsed
 * before inspection. Returning `null` is fine; callers degrade gracefully
 * when no checkpoint is available.
 */
export function extractCheckpointId(toolResult: unknown): string | null {
	let value: unknown = toolResult;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (!value || typeof value !== "object") {
		return null;
	}
	const res = value as Record<string, unknown>;
	if (typeof res.checkpointId === "string") {
		return res.checkpointId;
	}
	if (typeof res.checkpoint_id === "string") {
		return res.checkpoint_id;
	}

	const structuredContent =
		typeof res.structuredContent === "object" &&
		res.structuredContent !== null
			? (res.structuredContent as Record<string, unknown>)
			: null;
	if (structuredContent) {
		if (typeof structuredContent.checkpointId === "string") {
			return structuredContent.checkpointId;
		}
		if (typeof structuredContent.checkpoint_id === "string") {
			return structuredContent.checkpoint_id;
		}
	}

	// The invoke route stamps the id onto the render envelope — results
	// that only carry it there (everything minted by
	// `/api/mcp-app/invoke`) resolve through this branch.
	const envelope =
		typeof res[FABRIC_MCP_RENDER_KEY] === "object" &&
		res[FABRIC_MCP_RENDER_KEY] !== null
			? (res[FABRIC_MCP_RENDER_KEY] as Record<string, unknown>)
			: null;
	if (envelope && typeof envelope.checkpointId === "string") {
		return envelope.checkpointId;
	}

	const content = res.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			const text =
				typeof block === "object" && block !== null && "text" in block
					? (block as { text: unknown }).text
					: null;
			if (typeof text === "string") {
				const m = text.match(
					/checkpoint[_\s-]?id[:\s"]+([a-zA-Z0-9_-]+)/i,
				);
				if (m?.[1]) {
					return m[1];
				}
			}
		}
	}
	return null;
}
