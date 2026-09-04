"use client";

/**
 * Registers default-MCP tool calls with CopilotKit so the AI Feature
 * Assistant (StoryWorkspace) and AI Document Assistant (DocumentEditor)
 * can actually CALL them — and renders the result inline in chat.
 *
 * ## Two concerns this hook handles
 *
 * **1. Tool registration (the actual fix).** Both editors bind to the
 * LangGraph agent `project_document_generator` via `useCoAgent`.
 * CopilotKit's AG-UI protocol forwards only **frontend**
 * `useCopilotAction` registrations to that external agent — backend
 * `actions` on `CopilotRuntime` flow only to the built-in agent path.
 * PR #892 wired the MCP tools as backend actions; the LangGraph agent
 * never saw them, so the LLM couldn't call `create_view` even when
 * explicitly prompted (confirmed locally: agent's `boundTools` was
 * `[confirm_changes, write_document_local, search_project_knowledge]`).
 *
 * The fix is to register `create_view` (and any other MCP-app tools we
 * want to expose to the sidebars) as **frontend** `useCopilotAction`s
 * with a `handler` that POSTs to `/api/mcp-app/invoke`, which executes
 * the MCP call server-side and returns a result enriched with the
 * `__fabricMcpRender` envelope. AG-UI forwards the tool name + schema
 * to the agent, the agent binds it, the LLM calls it, and the handler
 * runs.
 *
 * **2. Inline rendering.** A wildcard `useCopilotAction({ name: "*",
 * render })` picks up tool-call results in the chat, parses the
 * `__fabricMcpRender` envelope, and renders `<McpAppFrame>` — same
 * renderer Nexus uses, so the Excalidraw canvas appears inline (not
 * the raw JSON tool result).
 *
 * ## Hardcoded tool list
 *
 * `useCopilotAction` must be called consistently across renders
 * (rules of hooks), so we can't iterate over a dynamic tool list from
 * a `useState`. The schemas for known managed-default MCP-app tools
 * are stable; hardcoding them is the simplest correct approach. When
 * a new managed-default server ships, add its tools here. Today
 * Excalidraw is the only one.
 *
 * ## Config-id lookup
 *
 * The handler needs the tenant's `configId` to call
 * `/api/mcp-app/invoke`. We fetch the per-tenant managed-default
 * configs from `/api/mcp-app/default-configs` once at mount; the
 * handler closes over the lookup map.
 */

import { useCopilotAction } from "@copilotkit/react-core";
import { useEffect, useRef, useState } from "react";
import { McpAppFrame } from "../../../../components/ai-elements/McpAppFrame";
import { parseExcalidrawElements } from "../../../../components/ai-elements/mcp-scene-utils";
import { useRouteProjectId } from "../../projects/hooks/use-route-project-id";

/**
 * Mirrors the envelope key written by `/api/mcp-app/invoke`. Keep in
 * lockstep — the chat renderer reads exactly this key.
 */
const FABRIC_MCP_RENDER_KEY = "__fabricMcpRender";

interface FabricMcpRenderEnvelope {
	resourceUri: string;
	configId: string;
	checkpointId?: string | null;
	toolArgs?: Record<string, unknown>;
}

function isRenderEnvelope(value: unknown): value is FabricMcpRenderEnvelope {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { resourceUri?: unknown }).resourceUri === "string" &&
		typeof (value as { configId?: unknown }).configId === "string"
	);
}

/**
 * Tool-call result shape we observe at this layer:
 *   - JSON string (CopilotKit stringifies tool results; our handler
 *     also stringifies before returning to the agent).
 *   - Already-parsed object (some adapter paths).
 *   - Partial / streaming chunk (rendered while incomplete).
 */
function extractEnvelope(result: unknown): FabricMcpRenderEnvelope | null {
	if (result == null) {
		return null;
	}
	let parsed: unknown = result;
	if (typeof result === "string") {
		try {
			parsed = JSON.parse(result);
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object") {
		return null;
	}
	const envelope = (parsed as Record<string, unknown>)[FABRIC_MCP_RENDER_KEY];
	return isRenderEnvelope(envelope) ? envelope : null;
}

interface DefaultConfig {
	configId: string;
	serverKey: string;
}

/**
 * Maps managed-default `serverKey` → tool names we want to surface as
 * `useCopilotAction`. Add tools here when new managed-default servers
 * ship; today only Excalidraw's `create_view` is exposed (the rest of
 * Excalidraw's surface — `read_me`, `read_checkpoint`, etc. — are
 * primarily for internal MCP-app bookkeeping and aren't useful for the
 * LLM to call directly).
 */
const DEFAULT_MCP_TOOLS_BY_SERVER: Record<
	string,
	Array<{
		name: string;
		description: string;
		parameters: Array<{
			name: string;
			type: string;
			description?: string;
			required?: boolean;
		}>;
	}>
> = {
	excalidraw: [
		{
			name: "create_view",
			description:
				"Create an interactive Excalidraw diagram that renders inline in the chat. " +
				"Call this tool ONLY when the user explicitly asks for an Excalidraw diagram, " +
				"a drawing, a flowchart, or an architecture diagram. NEVER call it for " +
				"conversational replies, questions, status updates, feedback, or option " +
				"discussions — when in doubt, do NOT call it and answer in text. For an " +
				"explanatory diagram inside document content, emit a mermaid code block via " +
				"the document tools instead. The diagram renders as a canvas in the " +
				"chat — it does NOT modify the document. Pair with `write_document_local` " +
				"only if the user also asks for the diagram to be referenced in the document body.",
			parameters: [
				{
					// IMPORTANT: the upstream Excalidraw MCP tool validates
					// `elements` as a **JSON-encoded string**, not a raw
					// array (confirmed by direct MCP call:
					// `"expected": "string", "code": "invalid_type"`). The
					// LLM must therefore emit `elements` as a stringified
					// JSON array — declaring this as `string` keeps the
					// tool schema and the MCP server in lockstep.
					name: "elements",
					type: "string",
					description:
						"JSON-encoded string of a NON-EMPTY array of Excalidraw element " +
						"objects (rectangle, ellipse, diamond, arrow, text, line, " +
						'freedraw, etc.) — never send "[]". Each element needs id, type, x, y, width, ' +
						"height, angle, strokeColor, backgroundColor, fillStyle, " +
						"strokeWidth, strokeStyle, roughness, opacity, groupIds, " +
						"frameId, roundness, seed, versionNonce, isDeleted, " +
						"boundElements, updated, link, locked. Pass `JSON.stringify(elements)`. " +
						"Refer to the Excalidraw scene format spec.",
					required: true,
				},
			],
		},
	],
};

interface UseDefaultMcpInlineRenderOptions {
	organizationId?: string | null;
}

/**
 * Calls `useCopilotAction` for each known managed-default MCP tool +
 * a wildcard render handler. Call this from inside any component
 * mounted under a `<CopilotKit>` provider — `useCopilotAction` is a
 * React hook so the rules of hooks apply.
 *
 * **Render rule for action handlers.** Every named `useCopilotAction`
 * below also returns a `render`-time component via the wildcard hook
 * below — keeping the named handlers free of UI logic. The wildcard
 * fires for ALL tool calls including these named ones; for non-MCP
 * tool calls (e.g. `confirm_changes`) it falls through to default
 * rendering by returning an empty fragment.
 */
export function useDefaultMcpInlineRender(
	opts: UseDefaultMcpInlineRenderOptions,
) {
	const { organizationId } = opts;
	const orgIdRef = useRef(organizationId);
	orgIdRef.current = organizationId;

	// Fetch the tenant's managed-default config IDs once on mount.
	// `serverKey → configId` is what the handlers need to call
	// `/api/mcp-app/invoke`. The fetch is best-effort: a missing entry
	// degrades the handler to a clear error message, not a crash.
	const [configsByServer, setConfigsByServer] = useState<
		Record<string, string>
	>({});

	// The request this instance already has in flight, with the org it was
	// issued for. React StrictMode runs effect setup → cleanup → setup on the
	// SAME fiber in development, so this ref survives between the two runs and
	// they share one request instead of firing two identical ones.
	//
	// Per-instance on purpose, not a module-level cache keyed by org: the
	// endpoint scopes its response by session user AND organization, so an
	// org-keyed cache shared across the realm could hand one user's configs to
	// another if the account changed while a request was still in flight.
	const inFlightRef = useRef<{
		key: string;
		promise: Promise<DefaultConfig[] | null>;
	} | null>(null);

	useEffect(() => {
		let cancelled = false;
		const key = organizationId ?? "";
		let entry = inFlightRef.current;
		if (!entry || entry.key !== key) {
			const url = new URL(
				"/api/mcp-app/default-configs",
				window.location.origin,
			);
			if (organizationId) {
				url.searchParams.set("organizationId", organizationId);
			}
			// Held only while in flight. Without the release below a failed or
			// empty response would be pinned for the life of the instance: the
			// personal and unresolved cases share the "" key, so a request
			// issued before the org resolved would be reused rather than
			// retried, leaving the hook permanently without configs.
			//
			// `finally` is chained INTO the stored promise, not attached to it
			// as a separate chain, so the rejection stays handled by each
			// consumer's own `catch` instead of surfacing as an unhandled one.
			// Releasing on settle does not weaken the StrictMode dedup: React
			// runs setup → cleanup → setup synchronously, so the second run
			// attaches long before the request can settle.
			let created: {
				key: string;
				promise: Promise<DefaultConfig[] | null>;
			} | null = null;
			const promise = fetch(url.toString(), { credentials: "include" })
				.then((r) => (r.ok ? r.json() : null))
				.then(
					(data: { configs?: DefaultConfig[] } | null) =>
						data?.configs ?? null,
				)
				.finally(() => {
					// Identity-guarded: a later request for a different org
					// must not be cleared by this one finishing after it.
					if (created && inFlightRef.current === created) {
						inFlightRef.current = null;
					}
				});
			created = { key, promise };
			inFlightRef.current = created;
			entry = created;
		}

		entry.promise
			.then((configs) => {
				if (cancelled || !configs) {
					return;
				}
				const map: Record<string, string> = {};
				for (const c of configs) {
					map[c.serverKey] = c.configId;
				}
				setConfigsByServer(map);
			})
			.catch((err) => {
				console.error(
					"[useDefaultMcpInlineRender] Failed to fetch default-MCP configs",
					err,
				);
			});
		return () => {
			cancelled = true;
		};
	}, [organizationId]);

	// Keep a ref so handlers close over a stable lookup that updates
	// when the fetch resolves (without re-registering useCopilotAction
	// — that would cause CopilotKit to re-emit tool definitions).
	const configsRef = useRef(configsByServer);
	configsRef.current = configsByServer;

	// Owning project id for the Read-only mode write-gate. Held
	// in a ref for the same reason as configs — the tool handlers must not
	// re-register when the route changes.
	const routeProjectId = useRouteProjectId();
	const projectIdRef = useRef(routeProjectId);
	projectIdRef.current = routeProjectId;

	// Consecutive `create_view` guard rejections. The corrective error we
	// feed back to the model is usually enough to stop a misfired call,
	// but nothing else caps a model that keeps retrying with empty args —
	// after the second rejection in a row the message escalates to a hard
	// "stop calling this tool". Reset as soon as a call passes the guard
	// (non-empty elements), so the streak counts strictly consecutive
	// empty calls and a stale streak from an earlier conversation can't
	// escalate a later legitimate request.
	const emptyCreateViewRejectionsRef = useRef(0);

	// Hardcoded tool registration — must be called consistently across
	// renders. The order/names here are static so the rules-of-hooks
	// invariant holds.

	// ── Excalidraw create_view ────────────────────────────────────────
	// Note: we MUST attach `render` here, on the named action — not just
	// on the wildcard `name: "*"` below. When a `useCopilotAction` has a
	// named entry, CopilotKit fires THAT entry's `render` for matching
	// tool calls and skips the wildcard. Without the named-entry render,
	// the chat shows the tool result as the LLM's text reply but never
	// mounts <McpAppFrame>, so the canvas is invisible even though the
	// handler ran successfully and the envelope is present in `result`.
	useCopilotAction({
		name: DEFAULT_MCP_TOOLS_BY_SERVER.excalidraw[0].name,
		description: DEFAULT_MCP_TOOLS_BY_SERVER.excalidraw[0].description,
		parameters: DEFAULT_MCP_TOOLS_BY_SERVER.excalidraw[0].parameters as any,
		handler: async (args: Record<string, unknown>) => {
			// Refuse empty/unparseable `elements` before the server round-trip.
			// An empty scene creates an empty checkpoint, which is exactly the
			// "Couldn't display this diagram / Diagram has no elements." error
			// widget — returning a corrective message the model can act on
			// (with no `__fabricMcpRender` envelope, so nothing renders in
			// chat) is strictly better on every axis.
			if (!parseExcalidrawElements(args.elements)) {
				emptyCreateViewRejectionsRef.current += 1;
				const escalate = emptyCreateViewRejectionsRef.current >= 2;
				return JSON.stringify({
					error:
						"create_view was not executed: `elements` must be a " +
						"JSON-encoded string of a NON-EMPTY array of Excalidraw " +
						"element objects.",
					hint: escalate
						? "Do NOT call create_view again for this request. " +
							"Answer the user in text instead."
						: "If the user did not explicitly ask for a diagram, " +
							"do not call this tool — reply in text without tools.",
				});
			}
			emptyCreateViewRejectionsRef.current = 0;
			const configId = configsRef.current.excalidraw;
			if (!configId) {
				return JSON.stringify({
					error:
						"Excalidraw MCP is not configured for this tenant. " +
						"The managed-default seed may not have run.",
				});
			}
			try {
				const res = await fetch("/api/mcp-app/invoke", {
					method: "POST",
					credentials: "include",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						configId,
						toolName: "create_view",
						args,
						projectId: projectIdRef.current,
					}),
				});
				const json = (await res.json()) as
					| { result: unknown }
					| { error: string };
				if (!res.ok) {
					return JSON.stringify({
						error:
							"error" in json
								? json.error
								: `HTTP ${res.status} from /api/mcp-app/invoke`,
					});
				}
				// The handler returns a STRING to CopilotKit (which feeds
				// the model on the next turn and is passed to the `result`
				// arg of the matching `render`). Stringify the result so
				// the renderer can JSON.parse it back to find the
				// `__fabricMcpRender` envelope.
				return JSON.stringify((json as { result: unknown }).result);
			} catch (err) {
				return JSON.stringify({
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		render: ({
			status,
			args,
			result,
		}: {
			status: string;
			args: unknown;
			result: unknown;
		}) => {
			if (status !== "complete") {
				return <></>;
			}
			const envelope = extractEnvelope(result);
			if (!envelope) {
				return <></>;
			}
			return (
				<McpAppFrame
					resourceUri={envelope.resourceUri}
					configId={envelope.configId}
					organizationId={orgIdRef.current ?? null}
					toolArgs={
						(envelope.toolArgs ??
							(args as Record<string, unknown> | undefined)) ||
						undefined
					}
					toolResult={result}
					className="mt-3"
				/>
			);
		},
	});

	// ── Wildcard inline renderer ───────────────────────────────────
	useCopilotAction({
		name: "*",
		// CopilotKit types this as returning a non-null ReactElement.
		// Empty fragment = "fall through to default rendering".
		render: ({
			status,
			args,
			result,
		}: {
			status: string;
			args: unknown;
			result: unknown;
		}) => {
			if (status !== "complete") {
				return <></>;
			}
			const envelope = extractEnvelope(result);
			if (!envelope) {
				return <></>;
			}

			return (
				<McpAppFrame
					resourceUri={envelope.resourceUri}
					configId={envelope.configId}
					organizationId={orgIdRef.current ?? null}
					toolArgs={
						(envelope.toolArgs ??
							(args as Record<string, unknown> | undefined)) ||
						undefined
					}
					toolResult={result}
					className="mt-3"
				/>
			);
		},
	});
}
