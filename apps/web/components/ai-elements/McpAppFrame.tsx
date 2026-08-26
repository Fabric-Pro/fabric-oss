"use client";

import {
	AppBridge,
	buildAllowAttribute,
	type McpUiHostContext,
	PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { useRouteProjectId } from "@saas/projects/hooks/use-route-project-id";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ExternalLinkIcon,
	MaximizeIcon,
	MinimizeIcon,
	RefreshCwIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExcalidrawEditor } from "./ExcalidrawEditor";
import { ExcalidrawPreview } from "./ExcalidrawPreview";
import { extractCheckpointId, normalizeToolArgs } from "./mcp-scene-utils";

// Module-level HTML cache: keyed by "configId:resourceUri"
// Survives React re-renders/remounts so the same MCP App loads instantly on repeat.
const htmlCache = new Map<string, string>();

// Track in-flight prefetch promises to avoid duplicate requests
const prefetchInFlight = new Map<string, Promise<void>>();

/**
 * Pre-fetch MCP App HTML so it's cached before any tool calls.
 * Call this when you know the user has an MCP server with apps enabled
 * (e.g., when Excalidraw is in the enabled MCP config list).
 *
 * Excalidraw resources are skipped: the public `McpAppFrame` dispatch
 * routes them to `ExcalidrawPreview` (a native-React renderer) instead
 * of the sandboxed iframe, so the iframe's HTML payload is never read.
 * Prefetching it wastes a `POST /api/mcp-app/resource` per visible
 * Excalidraw message in chat history — measurable in staging where a
 * single-thread reload was making one redundant call per Excalidraw
 * artifact.
 */
export function prefetchMcpAppHtml(
	configId: string,
	resourceUri: string,
	organizationId?: string | null,
): void {
	if (resourceUri?.includes("excalidraw")) {
		return;
	}
	const key = `${configId}:${resourceUri}`;
	if (htmlCache.has(key) || prefetchInFlight.has(key)) {
		return;
	}

	const promise = fetch("/api/mcp-app/resource", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ configId, resourceUri, organizationId }),
	})
		.then(async (res) => {
			if (!res.ok) {
				return;
			}
			const payload = await res.json();
			if (payload?.html) {
				htmlCache.set(key, payload.html);
			}
		})
		.catch(() => {})
		.finally(() => {
			prefetchInFlight.delete(key);
		});

	prefetchInFlight.set(key, promise);
}

export interface McpAppFrameProps {
	/** MCP App resource URI (ui://...) — used to fetch the HTML */
	resourceUri: string;
	/** MCP config ID — used to proxy tool calls from the iframe */
	configId: string;
	/** Organization ID for tenant isolation */
	organizationId?: string | null;
	/** The tool call arguments (sent as ui/notifications/tool-input before the result) */
	toolArgs?: Record<string, unknown>;
	/** The tool result to pass to the MCP App on initialization */
	toolResult?: unknown;
	/** Additional CSS classes */
	className?: string;
	/**
	 * Surface hint. Affects two derived defaults that callers usually
	 * want bundled:
	 *   - "chat"  → compact 280-px preview height AND
	 *               `wheelScrollsParent` on (mouse wheel inside the
	 *               canvas scrolls the surrounding chat conversation
	 *               instead of zooming Excalidraw).
	 *   - "page"  → uses ExcalidrawPreview's full 640-px default and
	 *               leaves wheel control to Excalidraw.
	 * The AI Feature Assistant and Nexus both embed the canvas inside a
	 * scrollable chat thread, so both pass "chat" — the only difference
	 * being Nexus may override the height via the `height` prop below.
	 */
	surface?: "chat" | "page";
	/**
	 * Override the surface's default preview height in CSS pixels.
	 * Useful when Nexus wants the chat behaviour (wheel → chat scroll)
	 * but a larger canvas than the AI Feature Assistant sidebar.
	 */
	height?: number;
	/**
	 * Called when the MCP App widget sends an updateModelContext event
	 * (e.g., user edits in fullscreen → diff sent back to agent context).
	 */
	onUpdateModelContext?: (content: unknown[]) => void;
}

interface McpAppHtmlPayload {
	html?: string;
	assetBaseUrl?: string;
	mimeType?: string;
	resourceMeta?: {
		csp?: Record<string, unknown>;
		permissions?: Record<string, unknown>;
		domain?: string;
	};
	contents?: Array<{
		uri: string;
		mimeType?: string;
		text?: string;
		blob?: string;
		_meta?: Record<string, unknown>;
	}>;
}

function shouldInjectBaseHref(
	content: Pick<
		NonNullable<McpAppHtmlPayload["contents"]>[number],
		"mimeType" | "text"
	>,
): boolean {
	if (content.mimeType) {
		return content.mimeType.startsWith("text/html");
	}

	if (typeof content.text !== "string") {
		return false;
	}

	const sample = content.text.trimStart().slice(0, 200).toLowerCase();
	return (
		sample.startsWith("<!doctype html") ||
		sample.startsWith("<html") ||
		sample.includes("<head") ||
		sample.includes("<body")
	);
}

function stableSerialize(value: unknown): string | null {
	if (value === undefined) {
		return null;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function injectBaseHref(html: string, assetBaseUrl?: string): string {
	if (!assetBaseUrl) {
		return html;
	}

	const normalizedBase = assetBaseUrl.endsWith("/")
		? assetBaseUrl
		: `${assetBaseUrl}/`;
	const baseTag = `<base href="${normalizedBase}">`;

	if (/<base\s/i.test(html)) {
		return html;
	}

	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
	}

	if (/<html[^>]*>/i.test(html)) {
		return html.replace(
			/<html([^>]*)>/i,
			`<html$1><head>${baseTag}</head>`,
		);
	}

	return `<!DOCTYPE html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

function isMcpDebugEnabled(): boolean {
	if (typeof window === "undefined") {
		return false;
	}

	try {
		return (
			window.localStorage.getItem("fabric:mcp-debug") === "1" ||
			window.sessionStorage.getItem("fabric:mcp-debug") === "1"
		);
	} catch {
		return false;
	}
}

/**
 * McpAppIframeFrame — the iframe-based MCP App renderer.
 *
 * Loads the MCP server's HTML UI into a sandboxed iframe and bridges its
 * tool calls back through Fabric. The iframe is NEVER moved in the DOM (no
 * portals) to avoid reload/blank issues. Fullscreen is achieved by adding
 * a class to <body> that overrides stacking contexts.
 *
 * Excalidraw resources are NOT routed through here — the public
 * `McpAppFrame` wrapper at the bottom of this file dispatches them to
 * `ExcalidrawPreview` (a native-React renderer that owns the canvas, the
 * toolbar layout, and auto-fit-to-content). The Excalidraw-related code in
 * this inner function (default 560px height, bottom toolbar gated on
 * `isExcalidraw`, the `excalidraw-workspace` postMessage listener, the
 * `openFullEditor` → `ExcalidrawEditor` flow) is now reachable only when
 * the dispatch is bypassed, which keeps the iframe path bug-compatible
 * with the small fraction of users still relying on it for testing
 * workflows.
 */
function McpAppIframeFrame({
	resourceUri,
	configId,
	organizationId,
	toolArgs,
	toolResult,
	className,
	onUpdateModelContext,
}: McpAppFrameProps) {
	const tTooltips = useTranslations("tooltips.common");
	const tFrames = useTranslations("tooltips.frames");
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Owning project id for the Read-only mode write-gate, read
	// from the route (present only inside a /projects/[id] workspace). Held in a
	// ref so the fetch closures below see the current value without re-running.
	const routeProjectId = useRouteProjectId();
	const projectIdRef = useRef(routeProjectId);
	projectIdRef.current = routeProjectId;
	const cacheKey = `${configId}:${resourceUri}`;
	const [html, setHtml] = useState<string | null>(
		htmlCache.get(cacheKey) ?? null,
	);
	const [isLoading, setIsLoading] = useState(!htmlCache.has(cacheKey));
	const [error, setError] = useState<string | null>(null);
	const isExcalidraw = resourceUri?.includes("excalidraw");
	const [isExpanded, setIsExpanded] = useState(false);
	// Compact default height for the inline chat canvas. Users still get
	// the full surface via the fullscreen "Edit in chat" expand affordance
	// or by adding the diagram to the document. Per UX feedback the chat
	// thumbnail should be a preview, not consume the whole chat column.
	const [iframeHeight, setIframeHeight] = useState(isExcalidraw ? 320 : 480);
	const [iframeAllow, setIframeAllow] = useState("");
	const [fullEditorData, setFullEditorData] = useState<{
		elements: Record<string, unknown>[];
		appState?: Record<string, unknown>;
	} | null>(null);
	// Incremented when returning from the editor to force iframe remount + bridge reconnect
	const [iframeGeneration, setIframeGeneration] = useState(0);
	// Flag: when true, reconnect the inline widget after the fullscreen editor closes.
	// Keep sending the original create_view result on reconnect; the Excalidraw MCP app
	// expects that payload shape, and substituting read_checkpoint output leaves the
	// inline canvas empty until a full page refresh.
	const pendingCheckpointRefreshRef = useRef(false);
	const blobUrlRef = useRef<string | null>(null);
	const bridgeRef = useRef<AppBridge | null>(null);
	const appInitializedRef = useRef(false);
	const lastPartialArgsRef = useRef<string | null>(null);
	const lastFinalArgsRef = useRef<string | null>(null);
	const lastResultRef = useRef<string | null>(null);
	const directToolArgs = normalizeToolArgs(toolArgs);
	// Args fetched via `read_checkpoint` when `toolArgs` is missing/garbage
	// (e.g., the workflow output truncated them and the sentinel was
	// rejected upstream). Set lazily by the effect below.
	const [fallbackArgs, setFallbackArgs] = useState<
		Record<string, unknown> | undefined
	>(undefined);
	const normalizedToolArgs = directToolArgs ?? fallbackArgs;

	// Keep latest toolArgs/toolResult in refs so bridge callbacks can access them
	// without stale closures (bridge setup effect captures these refs once).
	const toolArgsRef = useRef<Record<string, unknown> | undefined>(
		normalizedToolArgs,
	);
	const toolResultRef = useRef(toolResult);
	useEffect(() => {
		toolArgsRef.current = normalizedToolArgs;
	}, [normalizedToolArgs]);
	useEffect(() => {
		toolResultRef.current = toolResult;
	}, [toolResult]);

	// Stable refs so bridge callbacks always use latest functions without causing bridge recreation.
	// Initialized with no-ops because syncToolStateToBridge/debugLog are declared later in the component.
	// The useEffects below keep them up to date.
	const syncToolStateToBridgeRef = useRef<() => Promise<void>>(
		async () => {},
	);
	const onUpdateModelContextRef = useRef(onUpdateModelContext);
	useEffect(() => {
		onUpdateModelContextRef.current = onUpdateModelContext;
	}, [onUpdateModelContext]);
	const debugLogRef = useRef<
		(message: string, data?: Record<string, unknown>) => void
	>(() => {});

	// Extract checkpointId from the create_view tool result. Shape varies
	// across MCP server implementations — see `extractCheckpointId` for the
	// full list of probed locations.
	const checkpointId = extractCheckpointId(toolResult);

	const debugLog = useCallback(
		(message: string, data?: Record<string, unknown>) => {
			if (!isMcpDebugEnabled()) {
				return;
			}
			console.info("[McpAppFrame debug]", message, {
				resourceUri,
				configId,
				checkpointId,
				...data,
			});
		},
		[checkpointId, configId, resourceUri],
	);

	// Checkpoint-based fallback for missing args.
	//
	// When `toolArgs` is missing — because the workflow output truncated it
	// and the sentinel was rejected by the streaming hooks, or because an
	// older chat persisted the sentinel and we just dropped it on reload —
	// the inline iframe would render an empty canvas: the bridge's
	// `sendToolInput` is called with `{}` and the Excalidraw widget has no
	// elements to draw. Re-fetch the diagram from the MCP server's
	// `read_checkpoint` (the same activity the dedicated panel uses) and
	// synthesize a `create_view`-shaped args object so the inline widget
	// renders identically to the panel.
	useEffect(() => {
		if (directToolArgs) {
			return;
		}
		if (!checkpointId) {
			return;
		}
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/mcp-app/call-tool", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						configId,
						toolName: "read_checkpoint",
						args: { id: checkpointId },
						organizationId,
						projectId: projectIdRef.current,
					}),
				});
				if (!res.ok) {
					return;
				}
				const data = await res.json();
				let elements: unknown[] | undefined;
				let appState: Record<string, unknown> | undefined;
				if (Array.isArray(data?.elements)) {
					elements = data.elements as unknown[];
					appState = (data as { appState?: Record<string, unknown> })
						.appState;
				} else if (Array.isArray(data?.content)) {
					const firstText = (
						data.content[0] as { text?: string } | undefined
					)?.text;
					if (firstText) {
						try {
							const parsed = JSON.parse(firstText) as {
								elements?: unknown[];
								appState?: Record<string, unknown>;
							};
							elements = parsed.elements;
							appState = parsed.appState;
						} catch {
							// not JSON — leave undefined; fallback gives up
						}
					}
				}
				if (cancelled) {
					return;
				}
				if (Array.isArray(elements) && elements.length > 0) {
					setFallbackArgs({
						elements,
						...(appState !== undefined ? { appState } : {}),
					});
				}
			} catch {
				// Network / parse failure — leave fallback undefined.
				// The dedicated panel still works via its own openFullEditor.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [directToolArgs, checkpointId, configId, organizationId]);

	const openFullEditor = useCallback(async () => {
		if (!checkpointId) {
			return;
		}
		try {
			const res = await fetch("/api/mcp-app/call-tool", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					configId,
					toolName: "read_checkpoint",
					args: { id: checkpointId },
					organizationId,
					projectId: projectIdRef.current,
				}),
			});
			if (!res.ok) {
				return;
			}
			const data = await res.json();
			// The checkpoint result may be in data.elements or data.content[0].text (JSON)
			let elements: Record<string, unknown>[] = [];
			let appState: Record<string, unknown> | undefined;
			if (Array.isArray(data.elements)) {
				elements = data.elements as Record<string, unknown>[];
				appState = data.appState as Record<string, unknown> | undefined;
			} else {
				// Try to parse from text content
				const firstText = Array.isArray(data.content)
					? (data.content[0] as { text?: string })?.text
					: null;
				if (firstText) {
					try {
						const parsed = JSON.parse(firstText) as {
							elements?: Record<string, unknown>[];
							appState?: Record<string, unknown>;
						};
						elements = parsed.elements ?? [];
						appState = parsed.appState;
					} catch {
						// ignore
					}
				}
			}
			setFullEditorData({ elements, appState });
		} catch (err) {
			console.error("[McpAppFrame] Failed to open full editor:", err);
		}
	}, [checkpointId, configId, organizationId]);

	const buildHostContext = useCallback((): McpUiHostContext => {
		const isDark =
			typeof document !== "undefined" &&
			document.documentElement.classList.contains("dark");

		return {
			theme: isDark ? "dark" : "light",
			displayMode: isExpanded ? "fullscreen" : "inline",
			availableDisplayModes: ["inline", "fullscreen"],
			containerDimensions: isExpanded
				? undefined
				: {
						height: iframeHeight,
						width: containerRef.current?.clientWidth,
					},
			locale:
				typeof navigator !== "undefined" ? navigator.language : "en-US",
			timeZone:
				typeof Intl !== "undefined"
					? Intl.DateTimeFormat().resolvedOptions().timeZone
					: undefined,
			userAgent:
				typeof navigator !== "undefined"
					? navigator.userAgent
					: undefined,
			platform: "web",
			deviceCapabilities: {
				touch:
					typeof window !== "undefined"
						? navigator.maxTouchPoints > 0
						: false,
				hover:
					typeof window !== "undefined"
						? window.matchMedia?.("(hover: hover)").matches
						: undefined,
			},
		};
	}, [iframeHeight, isExpanded]);

	// Track when bridge is initialized to trigger re-sync
	const [isBridgeInitialized, setIsBridgeInitialized] = useState(false);

	const syncToolStateToBridge = useCallback(async () => {
		const bridge = bridgeRef.current;
		if (!bridge || !appInitializedRef.current) {
			return;
		}

		const partialArgsKey = stableSerialize(normalizedToolArgs);
		if (toolResult === undefined && normalizedToolArgs && partialArgsKey) {
			if (partialArgsKey !== lastPartialArgsRef.current) {
				lastPartialArgsRef.current = partialArgsKey;
				debugLog("sendToolInputPartial", {
					keys: Object.keys(normalizedToolArgs),
					serializedLength: partialArgsKey.length,
				});
				await bridge.sendToolInputPartial({
					arguments: normalizedToolArgs,
				});
			}
		}

		if (toolResult !== undefined) {
			const finalArgs = normalizedToolArgs ?? {};
			const finalArgsKey = stableSerialize(finalArgs);
			if (finalArgsKey !== lastFinalArgsRef.current) {
				lastFinalArgsRef.current = finalArgsKey;
				debugLog("sendToolInput", {
					keys: Object.keys(finalArgs),
					serializedLength: finalArgsKey?.length ?? 0,
				});
				await bridge.sendToolInput({
					arguments: finalArgs,
				});
			}

			const resultKey = stableSerialize(toolResult);
			if (resultKey !== lastResultRef.current) {
				lastResultRef.current = resultKey;
				debugLog("sendToolResult", {
					serializedLength: resultKey?.length ?? 0,
				});
				await bridge.sendToolResult(toolResult as any);
			}
		}
	}, [debugLog, normalizedToolArgs, toolResult]);

	// Keep stable refs current whenever the functions change
	useEffect(() => {
		syncToolStateToBridgeRef.current = syncToolStateToBridge;
	}, [syncToolStateToBridge]);
	useEffect(() => {
		debugLogRef.current = debugLog;
	}, [debugLog]);

	const fetchHtml = useCallback(
		async (bypassCache = false) => {
			const key = `${configId}:${resourceUri}`;
			if (!bypassCache && htmlCache.has(key)) {
				const cached = htmlCache.get(key);
				if (cached) {
					setHtml(cached);
					setIsLoading(false);
					return;
				}
			}

			setIsLoading(true);
			setError(null);
			appInitializedRef.current = false;
			try {
				const response = await fetch("/api/mcp-app/resource", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						configId,
						resourceUri,
						organizationId,
					}),
				});
				if (!response.ok) {
					const data = await response.json().catch(() => ({}));
					throw new Error(
						data.error ||
							`Failed to load MCP App (${response.status})`,
					);
				}
				const payload = (await response.json()) as McpAppHtmlPayload;
				if (!payload.html) {
					throw new Error(
						"MCP App resource returned no HTML payload",
					);
				}
				debugLog("resourceLoaded", {
					hasAssetBaseUrl: Boolean(payload.assetBaseUrl),
					mimeType: payload.mimeType,
					htmlLength: payload.html.length,
					contentCount: payload.contents?.length ?? 0,
				});
				const hydratedHtml = injectBaseHref(
					payload.html,
					payload.assetBaseUrl,
				);
				setIframeAllow(
					buildAllowAttribute(
						payload.resourceMeta?.permissions as
							| Parameters<typeof buildAllowAttribute>[0]
							| undefined,
					),
				);
				htmlCache.set(key, hydratedHtml);
				setHtml(hydratedHtml);
			} catch (err) {
				debugLog("resourceLoadFailed", {
					error:
						err instanceof Error
							? err.message
							: "Failed to load MCP App",
				});
				setError(
					err instanceof Error
						? err.message
						: "Failed to load MCP App",
				);
			} finally {
				setIsLoading(false);
			}
		},
		[configId, resourceUri, organizationId],
	);

	useEffect(() => {
		fetchHtml();
	}, [fetchHtml]);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !html) {
			return;
		}
		appInitializedRef.current = false;
		lastPartialArgsRef.current = null;
		lastFinalArgsRef.current = null;
		lastResultRef.current = null;
		// Reset bridge initialization state when iframe remounts
		setIsBridgeInitialized(false);

		if (blobUrlRef.current) {
			URL.revokeObjectURL(blobUrlRef.current);
		}

		const blob = new Blob([html], { type: "text/html" });
		const blobUrl = URL.createObjectURL(blob);
		blobUrlRef.current = blobUrl;
		iframe.src = blobUrl;
	}, [html, iframeGeneration]);

	useEffect(() => {
		return () => {
			appInitializedRef.current = false;
			bridgeRef.current?.close().catch(() => {});
			bridgeRef.current = null;
			if (blobUrlRef.current) {
				URL.revokeObjectURL(blobUrlRef.current);
			}
		};
	}, []);

	useEffect(() => {
		const iframe = iframeRef.current;
		const contentWindow = iframe?.contentWindow;
		if (!iframe || !contentWindow || !html) {
			return;
		}

		let cancelled = false;

		const bridge = new AppBridge(
			null,
			{ name: "Fabric", version: "1.0.0" },
			{
				openLinks: {},
				downloadFile: {},
				serverTools: {},
				serverResources: {},
				logging: {},
				sandbox: {},
			},
			{
				hostContext: buildHostContext(),
			},
		);

		bridge.onsizechange = ({ height }) => {
			debugLogRef.current("onsizechange", { height });
			if (height && height > 0) {
				setIframeHeight(height);
			}
		};

		bridge.oninitialized = async () => {
			appInitializedRef.current = true;
			debugLogRef.current("oninitialized");

			// If returning from the full editor, force a clean reconnect but keep
			// the original create_view payload shape for the widget.
			if (pendingCheckpointRefreshRef.current) {
				pendingCheckpointRefreshRef.current = false;
				debugLogRef.current("reconnecting after editor close", {
					checkpointId,
				});
			}

			// Send current tool state from refs immediately.
			const currentArgs = toolArgsRef.current;
			const currentResult = toolResultRef.current;
			try {
				if (currentResult !== undefined && currentArgs) {
					await bridge.sendToolInput({
						arguments: currentArgs,
					});
					await bridge.sendToolResult(currentResult as any);
				} else if (currentArgs) {
					await bridge.sendToolInputPartial({
						arguments: currentArgs,
					});
				}
			} catch (err) {
				debugLogRef.current("oninitialized send failed", {
					error: String(err),
				});
			}

			// Trigger a re-sync to ensure any missed state is sent
			// This handles the race condition where toolResult arrived before initialization
			void syncToolStateToBridgeRef.current();
			// Update state to trigger the sync effect
			setIsBridgeInitialized(true);
		};

		bridge.onsandboxready = () => {
			debugLogRef.current("onsandboxready");
			void bridge.sendSandboxResourceReady({
				html,
				sandbox:
					"allow-scripts allow-forms allow-modals allow-same-origin",
			});
		};

		bridge.onopenlink = async ({ url }) => {
			debugLogRef.current("onopenlink", { url });
			window.open(url, "_blank", "noopener,noreferrer");
			return {};
		};

		bridge.onloggingmessage = ({ level, data, logger }) => {
			const prefix = logger ? `[MCP App:${logger}]` : "[MCP App]";
			const log =
				level === "error"
					? console.error
					: level === "warning"
						? console.warn
						: console.info;
			log(prefix, data);
		};

		bridge.onrequestdisplaymode = async ({ mode }) => {
			debugLogRef.current("onrequestdisplaymode", { mode });
			if (mode === "fullscreen") {
				setIsExpanded(true);
				return { mode: "fullscreen" };
			}
			setIsExpanded(false);
			return { mode: "inline" };
		};

		bridge.oncalltool = async ({ name, arguments: args }) => {
			debugLogRef.current("oncalltool", {
				name,
				argKeys:
					args && typeof args === "object"
						? Object.keys(args as Record<string, unknown>)
						: [],
			});
			const response = await fetch("/api/mcp-app/call-tool", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					configId,
					toolName: name,
					args: args || {},
					organizationId,
					projectId: projectIdRef.current,
				}),
			});
			const result = await response.json();
			if (!response.ok) {
				throw new Error(
					typeof result?.error === "string"
						? result.error
						: "Tool call failed",
				);
			}
			return result;
		};

		bridge.onreadresource = async ({ uri }) => {
			debugLogRef.current("onreadresource", { uri });
			const response = await fetch("/api/mcp-app/resource", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					configId,
					resourceUri: uri,
					organizationId,
				}),
			});
			const result = await response.json();
			if (!response.ok) {
				throw new Error(
					typeof result?.error === "string"
						? result.error
						: "Failed to read resource",
				);
			}

			if (Array.isArray(result.contents) && result.contents.length > 0) {
				return {
					contents: result.contents.map(
						(content: Record<string, unknown>) => {
							const maybeMimeType =
								typeof content.mimeType === "string"
									? content.mimeType
									: undefined;
							const _maybeUri =
								typeof content.uri === "string"
									? content.uri
									: uri;
							const text =
								typeof content.text === "string" &&
								shouldInjectBaseHref({
									mimeType: maybeMimeType,
									text: content.text,
								})
									? injectBaseHref(
											content.text,
											result.assetBaseUrl,
										)
									: content.text;
							return {
								...content,
								text,
							};
						},
					),
				};
			}

			return {
				contents: [
					{
						uri,
						mimeType: "text/html;profile=mcp-app",
						text: injectBaseHref(result.html, result.assetBaseUrl),
					},
				],
			};
		};

		bridge.onmessage = async ({ role, content }) => {
			debugLogRef.current("onmessage", {
				role,
				contentType: Array.isArray(content) ? "array" : typeof content,
			});
			return {};
		};

		bridge.onupdatemodelcontext = async ({
			content,
			structuredContent,
		}) => {
			debugLogRef.current("onupdatemodelcontext", {
				contentType: Array.isArray(content) ? "array" : typeof content,
				hasStructuredContent: structuredContent !== undefined,
			});
			// Forward edit diffs to the parent chat so the agent can see user edits
			if (Array.isArray(content) && content.length > 0) {
				onUpdateModelContextRef.current?.(content);
			}
			return {};
		};

		bridge.ondownloadfile = async ({ contents }) => {
			for (const content of contents) {
				const resource =
					"type" in content && content.type === "resource"
						? content.resource
						: content;

				if (!("blob" in resource) && !("text" in resource)) {
					continue;
				}

				const href =
					"blob" in resource && typeof resource.blob === "string"
						? URL.createObjectURL(
								new Blob(
									[
										Uint8Array.from(
											atob(resource.blob),
											(char) => char.charCodeAt(0),
										),
									],
									{
										type:
											resource.mimeType ??
											"application/octet-stream",
									},
								),
							)
						: URL.createObjectURL(
								new Blob(
									[
										"text" in resource &&
										typeof resource.text === "string"
											? resource.text
											: "",
									],
									{
										type: resource.mimeType ?? "text/plain",
									},
								),
							);
				const anchor = document.createElement("a");
				anchor.href = href;
				anchor.download =
					resource.uri.split("/").pop() || "mcp-app-download";
				anchor.click();
				setTimeout(() => URL.revokeObjectURL(href), 0);
			}
			return {};
		};

		const transport = new PostMessageTransport(
			contentWindow,
			contentWindow,
		);
		bridgeRef.current = bridge;
		debugLogRef.current("bridgeConnectStart", {
			hasHtml: Boolean(html),
			hasToolArgs: normalizedToolArgs !== undefined,
			hasToolResult: toolResult !== undefined,
		});

		void bridge.connect(transport).catch((err) => {
			if (!cancelled) {
				debugLogRef.current("bridgeConnectFailed", {
					error:
						err instanceof Error
							? err.message
							: "Failed to connect MCP App bridge",
				});
				setError(
					err instanceof Error
						? err.message
						: "Failed to connect MCP App bridge",
				);
			}
		});

		return () => {
			cancelled = true;
			appInitializedRef.current = false;
			debugLogRef.current("bridgeCleanup");
			if (bridgeRef.current === bridge) {
				bridgeRef.current = null;
			}
			void bridge.close().catch(() => {});
		};
	}, [
		// Only recreate the bridge when the iframe content or connection config changes.
		// toolArgs/toolResult/syncToolStateToBridge are intentionally excluded — they
		// are handled by the syncToolStateToBridge effect below, using refs to stay fresh.
		buildHostContext,
		configId,
		html,
		organizationId,
		iframeGeneration,
		// eslint-disable-next-line react-hooks/exhaustive-deps
	]);

	useEffect(() => {
		void syncToolStateToBridge();
	}, [syncToolStateToBridge, isBridgeInitialized]);

	useEffect(() => {
		bridgeRef.current?.setHostContext(buildHostContext());
	}, [buildHostContext]);

	// Fullscreen: inject/remove a <style> tag that makes our container fixed-position.
	// This avoids portals (which remount the iframe and cause blank screens).
	useEffect(() => {
		if (!isExpanded) {
			return;
		}
		const id = "mcp-app-fullscreen-style";
		let style = document.getElementById(id) as HTMLStyleElement | null;
		if (!style) {
			style = document.createElement("style");
			style.id = id;
			document.head.appendChild(style);
		}
		style.textContent = `
			[data-mcp-expanded="true"] {
				position: fixed !important;
				inset: 16px !important;
				z-index: 9999 !important;
				width: auto !important;
				height: auto !important;
				max-width: none !important;
				max-height: none !important;
				box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5) !important;
			}
			[data-mcp-expanded="true"] iframe {
				height: 100% !important;
				flex: 1 !important;
			}
			.mcp-app-backdrop {
				position: fixed;
				inset: 0;
				z-index: 9998;
				background: rgba(0,0,0,0.6);
			}
		`;
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setIsExpanded(false);
			}
		};
		document.addEventListener("keydown", handleEscape);
		return () => {
			document.removeEventListener("keydown", handleEscape);
			if (style) {
				style.textContent = "";
			}
		};
	}, [isExpanded]);

	// Handle "excalidraw-workspace" messages from the MCP App widget.
	// The widget's "Open in Workspace" button sends this when the user wants
	// to edit the diagram in a dedicated editor (outside the iframe).
	useEffect(() => {
		const handler = (e: MessageEvent) => {
			// Validate the message comes from our iframe
			if (e.source !== iframeRef.current?.contentWindow) {
				return;
			}
			if (
				e.data?.type === "excalidraw-workspace" &&
				e.data?.checkpointId
			) {
				openFullEditor();
			}
		};
		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [openFullEditor]);

	if (fullEditorData) {
		return (
			<ExcalidrawEditor
				elements={fullEditorData.elements}
				appState={fullEditorData.appState}
				checkpointId={checkpointId}
				configId={configId}
				organizationId={organizationId}
				onClose={() => {
					setFullEditorData(null);
					// Signal the iframe to reconnect after the editor closes.
					pendingCheckpointRefreshRef.current = true;
					// Bump generation to force iframe remount + bridge reconnect.
					setIframeGeneration((g) => g + 1);
				}}
				onElementsChange={() => {
					// Elements saved to checkpoint by the editor's auto-save
				}}
			/>
		);
	}

	if (error) {
		return (
			<div
				className={cn(
					"rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive",
					className,
				)}
			>
				<p className="font-medium">Failed to load MCP App</p>
				<p className="mt-1 text-xs opacity-80">{error}</p>
				<button
					type="button"
					onClick={() => fetchHtml(true)}
					className="mt-2 flex items-center gap-1 text-xs underline underline-offset-2 hover:opacity-80"
				>
					<RefreshCwIcon className="size-3" /> Retry
				</button>
			</div>
		);
	}

	return (
		<>
			{/* Backdrop rendered as sibling — only when expanded */}
			{isExpanded && (
				<button
					type="button"
					className="mcp-app-backdrop"
					onClick={() => setIsExpanded(false)}
					tabIndex={-1}
					aria-label="Close expanded view"
				/>
			)}

			<div
				ref={containerRef}
				data-mcp-expanded={isExpanded ? "true" : undefined}
				className={cn(
					"relative w-full overflow-hidden rounded-lg border bg-background flex flex-col",
					className,
				)}
				style={isExpanded ? undefined : { height: `${iframeHeight}px` }}
			>
				{isLoading && (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 pointer-events-none">
						<div className="flex flex-col items-center gap-3">
							<div className="size-6 rounded-full border-2 border-primary border-t-transparent animate-spin" />
							<span className="text-xs text-muted-foreground">
								Loading app...
							</span>
						</div>
					</div>
				)}

				{/* Controls */}
				<div className="absolute top-2 right-2 z-20 flex items-center gap-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => fetchHtml(true)}
								className="rounded p-1.5 bg-background/70 backdrop-blur-sm border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
								aria-label={tTooltips("reload")}
							>
								<RefreshCwIcon className="size-3.5" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{tTooltips("reload")}</TooltipContent>
					</Tooltip>
					{checkpointId && (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={openFullEditor}
									className="rounded p-1.5 bg-background/70 backdrop-blur-sm border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
									aria-label={tFrames("openInExcalidraw")}
								>
									<ExternalLinkIcon className="size-3.5" />
								</button>
							</TooltipTrigger>
							<TooltipContent>
								{tFrames("openInExcalidraw")}
							</TooltipContent>
						</Tooltip>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={() => setIsExpanded((v) => !v)}
								className="rounded p-1.5 bg-background/70 backdrop-blur-sm border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
								aria-label={
									isExpanded
										? tFrames("collapsePanel")
										: tFrames("expandPanel")
								}
							>
								{isExpanded ? (
									<MinimizeIcon className="size-3.5" />
								) : (
									<MaximizeIcon className="size-3.5" />
								)}
							</button>
						</TooltipTrigger>
						<TooltipContent>
							{isExpanded
								? tFrames("collapsePanel")
								: tFrames("expandPanel")}
						</TooltipContent>
					</Tooltip>
				</div>

				<iframe
					key={iframeGeneration}
					ref={iframeRef}
					sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
					allow={iframeAllow || undefined}
					style={{ height: `${iframeHeight}px` }}
					className="w-full border-none block flex-1"
					title="MCP App"
				/>

				{/* Excalidraw Studio toolbar — shown below the diagram for quick actions */}
				{isExcalidraw && !isExpanded && checkpointId && (
					<div className="flex items-center justify-between border-t bg-card/50 px-3 py-1.5">
						<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="currentColor"
								className="text-[#6965DB]"
								role="img"
								aria-label="Excalidraw"
							>
								<title>Excalidraw</title>
								<path d="M23.9428 19.8058a.1962.1962 0 0 0-.1679-.0337c-1.26-1.8552-2.8727-3.6104-4.4186-5.3152l-.2521-.284c-.0016-.0732-.0667-.1207-.1342-.1504-.0284-.0277-.0562-.0558-.0843-.0837-.0505-.1005-.1685-.1673-.2858-.1005-.4706.2347-.9068.5855-1.3274.9195-.5536.4345-1.1085.8695-1.6296 1.354a5.0577 5.0577 0 0 0-.5879.6185c-.0842.1168-.0168.2172.0843.2672-.3701.3677-.7402.736-1.109 1.1198a.1896.1896 0 0 0-.0506.1342c0 .05.0337.1.0668.1168l.6559.5012v.0169c.9237.9194 2.5538 2.1729 4.2844 3.5268.2515.201.5205.4014.7727.6017.1173.1342.2346.2847.3357.4182.0506.0662.1685.0837.2353.0331.0337.0337.0843.0668.118.1005a.2395.2395 0 0 0 .1004.0337.1534.1534 0 0 0 .1348-.0668.2371.2371 0 0 0 .0331-.1004c.0175 0 .0169.0168.0337.0168a.1915.1915 0 0 0 .1348-.0505l3.058-3.3265c.1198-.1159.0135-.2668-.0005-.2672z" />
							</svg>
							<span className="font-medium text-[#6965DB]">
								Excalidraw
							</span>
						</div>
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => setIsExpanded(true)}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<MaximizeIcon className="size-3" />
								Fullscreen
							</button>
							<button
								type="button"
								onClick={openFullEditor}
								className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<ExternalLinkIcon className="size-3" />
								Edit in Excalidraw
							</button>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

/**
 * Public entry point for MCP App rendering inside a chat message.
 *
 * Dispatches Excalidraw resources to a native-React renderer
 * (`ExcalidrawPreview`) that owns the canvas + toolbar layout, calls
 * `scrollToContent({ fitToViewport: true })` so the diagram is fully
 * visible without manual zoom, and exposes a Fit / Refresh / Edit /
 * Fullscreen toolbar that lives in a proper header (no overlay clipping).
 * All other MCP App resources continue to render in the sandboxed iframe
 * via `McpAppIframeFrame` — those are unchanged.
 *
 * Centralising the dispatch here means every consumer of `McpAppFrame`
 * (Nexus, the orchestrator chats, the AI assistant copilot, etc.) picks
 * up the new Excalidraw renderer with no changes at the call site.
 */
export function McpAppFrame(props: McpAppFrameProps) {
	const isExcalidraw = props.resourceUri?.includes("excalidraw");
	// Memoize the derived Excalidraw props so they stay referentially stable
	// across parent re-renders. Without this, `normalizeToolArgs` and
	// `extractCheckpointId` would return fresh object references every render,
	// retripping `ExcalidrawPreview`'s data-fetch effect and re-converting the
	// scene on every chat-message-list update — which would manifest as the
	// canvas re-running its font-load + auto-fit pass on every render.
	const excalidrawToolArgs = useMemo(
		() => (isExcalidraw ? normalizeToolArgs(props.toolArgs) : null),
		[isExcalidraw, props.toolArgs],
	);
	const excalidrawCheckpointId = useMemo(
		() => (isExcalidraw ? extractCheckpointId(props.toolResult) : null),
		[isExcalidraw, props.toolResult],
	);

	if (isExcalidraw) {
		// Chat surfaces (AI Feature Assistant sidebar + Nexus) want a
		// compact preview AND the wheel-scrolls-chat behaviour. The
		// default heights differ by surface but the wheel rule is the
		// same for both. Callers can override the height explicitly.
		const isChat = props.surface === "chat";
		const defaultHeight = props.height ?? (isChat ? 280 : undefined);
		return (
			<ExcalidrawPreview
				toolArgs={excalidrawToolArgs}
				checkpointId={excalidrawCheckpointId}
				configId={props.configId}
				organizationId={props.organizationId}
				className={props.className}
				defaultHeight={defaultHeight}
				wheelScrollsParent={isChat}
			/>
		);
	}
	return <McpAppIframeFrame {...props} />;
}
