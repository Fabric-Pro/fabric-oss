export const runtime = "nodejs";

import { createHash, randomUUID } from "node:crypto";
import { type McpSession, UpstashSessionStore } from "@fabricorg/mcp-server";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	CompleteRequestSchema,
	CreateMessageResultSchema,
	ElicitResultSchema,
	ErrorCode,
	GetPromptRequestSchema,
	isInitializeRequest,
	type JSONRPCMessage,
	JSONRPCMessageSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
	SubscribeRequestSchema,
	UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { verifyUserApiKey } from "@repo/api/modules/users/procedures/api-keys";
import { auth } from "@repo/auth";
import {
	type BrowserAutomationInput,
	type BrowserRagIngestionInput,
	getTemporalClient,
	type HybridExecutionInput,
	type TemplateExecutionInput,
} from "@repo/temporal";
import type { NextRequest } from "next/server";
import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../../modules/saas/mcp/lib/gateway/platform-tools";
import type {
	GatewaySession,
	GatewayToolDefinition,
} from "../../modules/saas/mcp/lib/gateway/types";

const SERVER_NAME = "fabric-mcp-server";
const SERVER_VERSION = "1.1.0";
const BROWSER_TASK_QUEUE = "workflow-builder";
const PUBLIC_SESSION_USER_ID = "__fabric_public_session__";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SUBSCRIPTIONS_KEY_PREFIX = "mcp:session-subscriptions:";

const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnR5i8AAAAASUVORK5CYII=";
const WAV_BASE64 =
	"UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

interface AuthResult {
	userId: string;
	organizationId: string | null;
	userName: string;
	email: string;
	role: "user" | "admin";
}

interface RequestSession {
	server: Server;
	transport: WebStandardStreamableHTTPServerTransport;
	gatewaySession: GatewaySession | null;
	subscriptions: Set<string>;
	sessionId?: string;
	persistSubscriptions?: () => Promise<void>;
}

interface McpToolResult {
	content: Array<Record<string, unknown>>;
	isError?: boolean;
	structuredContent?: unknown;
}

interface DurableMcpSession {
	core: McpSession;
	subscriptions: string[];
}

interface McpRouteOptions {
	enableConformanceFixtures: boolean;
}

const fallbackSessions = new Map<string, McpSession>();
const fallbackSubscriptions = new Map<string, Set<string>>();
let sessionStore: UpstashSessionStore | null | undefined;
let subscriptionsRedis:
	| {
			smembers(key: string): Promise<string[]>;
			sadd(key: string, ...members: string[]): Promise<number>;
			del(key: string): Promise<number>;
			expire(key: string, seconds: number): Promise<number>;
	  }
	| null
	| undefined;

const CONFORMANCE_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
	{
		name: "test_simple_text",
		description: "Returns simple text content for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_image_content",
		description: "Returns image content for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_audio_content",
		description: "Returns audio content for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_embedded_resource",
		description:
			"Returns embedded resource content for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_multiple_content_types",
		description:
			"Returns mixed text, image, and embedded resource content for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_tool_with_logging",
		description:
			"Sends logging notifications during tool execution for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_error_handling",
		description:
			"Returns a structured tool error for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_tool_with_progress",
		description:
			"Sends progress notifications during tool execution for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_sampling",
		description:
			"Requests client sampling during tool execution for MCP conformance testing.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "Prompt to sample" },
			},
			required: ["prompt"],
		},
	},
	{
		name: "test_elicitation",
		description:
			"Requests client elicitation during tool execution for MCP conformance testing.",
		inputSchema: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "Prompt shown to the user",
				},
			},
			required: ["message"],
		},
	},
	{
		name: "test_elicitation_sep1034_defaults",
		description:
			"Exercises elicitation default values for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "test_elicitation_sep1330_enums",
		description:
			"Exercises elicitation enum schema variants for MCP conformance testing.",
		inputSchema: { type: "object", properties: {} },
	},
];

const BROWSER_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
	{
		name: "run_browser_task",
		description:
			"Execute browser automation tasks on web pages. Supports clicking, typing, scrolling, screenshots, and content extraction.",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string", description: "The URL to navigate to" },
				actions: {
					type: "array",
					description:
						"Browser actions to execute (click, type, select, wait, scroll, screenshot, extract, evaluate)",
					items: {
						type: "object",
						properties: {
							type: {
								type: "string",
								enum: [
									"navigate",
									"click",
									"type",
									"select",
									"wait",
									"scroll",
									"screenshot",
									"extract",
									"evaluate",
								],
							},
							selector: {
								type: "string",
								description: "CSS selector",
							},
							value: {
								type: "string",
								description: "Value to type or select",
							},
							timeout: {
								type: "number",
								description: "Timeout in ms",
							},
						},
						required: ["type"],
					},
				},
				extractors: {
					type: "array",
					description: "Content extractors to run after actions",
					items: {
						type: "object",
						properties: {
							name: { type: "string" },
							selector: { type: "string" },
							attribute: { type: "string" },
							multiple: { type: "boolean" },
							transform: {
								type: "string",
								enum: ["text", "html", "markdown"],
							},
						},
						required: ["name", "selector"],
					},
				},
				takeScreenshots: {
					type: "boolean",
					description: "Whether to take screenshots during execution",
				},
			},
			required: ["url"],
		},
	},
	{
		name: "run_hybrid_task",
		description:
			"Execute hybrid API/browser tasks with 5 execution modes: api-first, browser-first, api-only, browser-only, or parallel.",
		inputSchema: {
			type: "object",
			properties: {
				mode: {
					type: "string",
					enum: [
						"api-first",
						"browser-first",
						"api-only",
						"browser-only",
						"parallel",
					],
					description: "Execution mode",
				},
				steps: {
					type: "array",
					description: "Steps to execute",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["api", "browser"] },
							name: { type: "string" },
							url: { type: "string" },
							method: {
								type: "string",
								enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
							},
							headers: { type: "object" },
							body: {},
							actions: {
								type: "array",
								items: {
									type: "object",
									properties: {
										type: {
											type: "string",
											enum: [
												"navigate",
												"click",
												"type",
												"select",
												"wait",
												"scroll",
												"screenshot",
												"extract",
												"evaluate",
											],
										},
										selector: { type: "string" },
										value: { type: "string" },
										timeout: { type: "number" },
									},
									required: ["type"],
								},
							},
							extractors: {
								type: "array",
								items: {
									type: "object",
									properties: {
										name: { type: "string" },
										selector: { type: "string" },
										attribute: { type: "string" },
										multiple: { type: "boolean" },
										transform: {
											type: "string",
											enum: ["text", "html", "markdown"],
										},
									},
									required: ["name", "selector"],
								},
							},
						},
						required: ["type", "url"],
					},
				},
				fallbackOnError: {
					type: "boolean",
					description:
						"Whether to fallback to an alternative method on error",
				},
				variables: {
					type: "object",
					description: "Variables for template substitution",
				},
			},
			required: ["mode", "steps"],
		},
	},
	{
		name: "execute_template",
		description:
			"Execute a saved automation template with parameter substitution. Templates are reusable browser automation workflows.",
		inputSchema: {
			type: "object",
			properties: {
				templateId: {
					type: "string",
					description: "ID of the saved automation template",
				},
				parameters: {
					type: "object",
					description:
						"Parameter values to substitute in the template",
				},
				takeScreenshots: {
					type: "boolean",
					description: "Whether to take screenshots during execution",
				},
			},
			required: ["templateId", "parameters"],
		},
	},
	{
		name: "list_templates",
		description:
			"List available automation templates. Templates can be filtered by category or tags.",
		inputSchema: {
			type: "object",
			properties: {
				category: {
					type: "string",
					description: "Filter templates by category",
				},
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Filter templates by tags",
				},
			},
		},
	},
	{
		name: "extract_web_content",
		description:
			"Extract content from web pages for RAG processing. Useful for ingesting web content into knowledge bases.",
		inputSchema: {
			type: "object",
			properties: {
				urls: {
					type: "array",
					items: { type: "string" },
					description: "URLs to extract content from",
				},
				selectors: {
					type: "object",
					description: "CSS selectors for content extraction",
					properties: {
						content: {
							type: "string",
							description: "Selector for main content",
						},
						title: {
							type: "string",
							description: "Selector for title",
						},
						exclude: {
							type: "array",
							items: { type: "string" },
							description: "Selectors to exclude",
						},
					},
				},
				waitForSelector: {
					type: "string",
					description: "Wait for this selector before extraction",
				},
			},
			required: ["urls"],
		},
	},
];

const CONFORMANCE_RESOURCES = [
	{
		uri: "test://static-text",
		name: "Static Text Resource",
		description: "Static text resource for MCP conformance testing.",
		mimeType: "text/plain",
	},
	{
		uri: "test://static-binary",
		name: "Static Binary Resource",
		description: "Static binary resource for MCP conformance testing.",
		mimeType: "image/png",
	},
];

const CONFORMANCE_RESOURCE_TEMPLATES = [
	{
		name: "test_template_resource",
		uriTemplate: "test://template/{id}/data",
		description:
			"Parameterized template resource for MCP conformance testing.",
		mimeType: "application/json",
	},
];

const CONFORMANCE_PROMPTS = [
	{
		name: "test_simple_prompt",
		description: "Simple prompt for MCP conformance testing.",
	},
	{
		name: "test_prompt_with_arguments",
		description: "Parameterized prompt for MCP conformance testing.",
		arguments: [
			{
				name: "arg1",
				description: "First test argument",
				required: true,
			},
			{
				name: "arg2",
				description: "Second test argument",
				required: true,
			},
		],
	},
	{
		name: "test_prompt_with_embedded_resource",
		description: "Prompt with embedded resource content for MCP testing.",
		arguments: [
			{
				name: "resourceUri",
				description: "URI of the resource to embed",
				required: true,
			},
		],
	},
	{
		name: "test_prompt_with_image",
		description: "Prompt with image content for MCP conformance testing.",
	},
];

async function authenticateRequest(
	request: NextRequest,
): Promise<AuthResult | null> {
	const authHeader = request.headers.get("authorization");

	if (authHeader?.startsWith("Bearer ")) {
		const rawKey = authHeader.slice(7);
		const keyHash = createHash("sha256").update(rawKey).digest("hex");
		const { db } = await import("@repo/database");

		const orgKey = await db.organizationApiKey.findFirst({
			where: {
				keyHash,
				isActive: true,
				OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
			},
			select: {
				id: true,
				organizationId: true,
				createdByUserId: true,
			},
		});

		if (orgKey) {
			await db.organizationApiKey.update({
				where: { id: orgKey.id },
				data: { lastUsedAt: new Date(), usageCount: { increment: 1 } },
			});

			const user = await db.user.findUnique({
				where: { id: orgKey.createdByUserId },
				select: { name: true, email: true, role: true },
			});

			if (!user) {
				return null;
			}

			return {
				userId: orgKey.createdByUserId,
				organizationId: orgKey.organizationId,
				userName: user.name || "Unknown",
				email: user.email,
				role: (user.role as "user" | "admin") || "user",
			};
		}

		const result = await verifyUserApiKey(rawKey);
		if (!result.valid || !result.userId) {
			return null;
		}

		const user = await db.user.findUnique({
			where: { id: result.userId },
			select: { name: true, email: true, role: true },
		});

		if (!user) {
			return null;
		}

		return {
			userId: result.userId,
			organizationId: request.headers.get("x-organization-id") ?? null,
			userName: user.name || "Unknown",
			email: user.email,
			role: (user.role as "user" | "admin") || "user",
		};
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		return null;
	}

	return {
		userId: session.user.id,
		organizationId: session.session.activeOrganizationId ?? null,
		userName: session.user.name || "Unknown",
		email: session.user.email,
		role: (session.user.role as "user" | "admin") || "user",
	};
}

function subscriptionsKey(sessionId: string): string {
	return `${SUBSCRIPTIONS_KEY_PREFIX}${sessionId}`;
}

function getSessionStore(): UpstashSessionStore | null {
	if (sessionStore !== undefined) {
		return sessionStore;
	}

	if (
		!process.env.UPSTASH_REDIS_REST_URL ||
		!process.env.UPSTASH_REDIS_REST_TOKEN
	) {
		sessionStore = null;
		return sessionStore;
	}

	try {
		sessionStore = new UpstashSessionStore();
	} catch (error) {
		console.error(
			"[Fabric MCP] Failed to initialize session store:",
			error,
		);
		sessionStore = null;
	}

	return sessionStore;
}

async function getSubscriptionsRedis() {
	if (subscriptionsRedis !== undefined) {
		return subscriptionsRedis;
	}

	if (
		!process.env.UPSTASH_REDIS_REST_URL ||
		!process.env.UPSTASH_REDIS_REST_TOKEN
	) {
		subscriptionsRedis = null;
		return subscriptionsRedis;
	}

	try {
		const { Redis } = await import("@upstash/redis");
		subscriptionsRedis = new Redis({
			url: process.env.UPSTASH_REDIS_REST_URL,
			token: process.env.UPSTASH_REDIS_REST_TOKEN,
		});
	} catch (error) {
		console.error(
			"[Fabric MCP] Failed to initialize subscriptions Redis client:",
			error,
		);
		subscriptionsRedis = null;
	}

	return subscriptionsRedis;
}

function authResultToSessionInput(authResult: AuthResult | null) {
	if (authResult) {
		return {
			userId: authResult.userId,
			organizationId: authResult.organizationId,
			userName: authResult.userName,
			email: authResult.email,
			role: authResult.role,
		};
	}

	return {
		userId: PUBLIC_SESSION_USER_ID,
		organizationId: null,
		userName: "Public MCP Session",
		email: "public@fabric.local",
		role: "user" as const,
	};
}

function restoreAuthResult(session: McpSession): AuthResult | null {
	if (session.userId === PUBLIC_SESSION_USER_ID) {
		return null;
	}

	return {
		userId: session.userId,
		organizationId: session.organizationId,
		userName: session.userName,
		email: session.email,
		role: session.role,
	};
}

function getSessionExpiry(expiresAt: string): number {
	const ms = new Date(expiresAt).getTime() - Date.now();
	return Math.max(1, Math.ceil(ms / 1000));
}

async function createDurableSession(
	authResult: AuthResult | null,
	protocolVersion: string,
): Promise<DurableMcpSession> {
	const store = getSessionStore();

	if (store) {
		const core = await store.create({
			...authResultToSessionInput(authResult),
			protocolVersion,
		});
		return { core, subscriptions: [] };
	}

	const sessionId = randomUUID();
	const nowIso = new Date().toISOString();
	const core: McpSession = {
		sessionId,
		...authResultToSessionInput(authResult),
		createdAt: nowIso,
		expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
		lastActivityAt: nowIso,
		protocolVersion,
	};
	fallbackSessions.set(sessionId, core);
	fallbackSubscriptions.set(sessionId, new Set());
	return { core, subscriptions: [] };
}

async function getDurableSession(
	sessionId: string,
): Promise<DurableMcpSession | null> {
	const store = getSessionStore();
	if (store) {
		const core = await store.get(sessionId);
		if (!core) {
			return null;
		}

		const redis = await getSubscriptionsRedis();
		const subscriptions = redis
			? await redis.smembers(subscriptionsKey(sessionId))
			: [...(fallbackSubscriptions.get(sessionId) ?? new Set<string>())];
		return {
			core,
			subscriptions,
		};
	}

	const core = fallbackSessions.get(sessionId);
	if (!core) {
		return null;
	}
	if (new Date(core.expiresAt).getTime() <= Date.now()) {
		fallbackSessions.delete(sessionId);
		fallbackSubscriptions.delete(sessionId);
		return null;
	}

	return {
		core,
		subscriptions: [...(fallbackSubscriptions.get(sessionId) ?? new Set())],
	};
}

async function touchDurableSession(sessionId: string): Promise<void> {
	const store = getSessionStore();
	if (store) {
		await store.touch(sessionId);
		const redis = await getSubscriptionsRedis();
		const session = await store.get(sessionId);
		if (redis && session) {
			await redis.expire(
				subscriptionsKey(sessionId),
				getSessionExpiry(session.expiresAt),
			);
		}
		return;
	}

	const existing = fallbackSessions.get(sessionId);
	if (!existing) {
		return;
	}
	existing.lastActivityAt = new Date().toISOString();
	existing.expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
	fallbackSessions.set(sessionId, existing);
}

async function saveSubscriptions(
	sessionId: string,
	subscriptions: Iterable<string>,
	expiresAt: string,
): Promise<void> {
	const values = [...new Set(subscriptions)];
	const redis = await getSubscriptionsRedis();

	if (redis) {
		const key = subscriptionsKey(sessionId);
		await redis.del(key);
		if (values.length > 0) {
			await redis.sadd(key, ...values);
			await redis.expire(key, getSessionExpiry(expiresAt));
		}
		return;
	}

	fallbackSubscriptions.set(sessionId, new Set(values));
}

async function deleteDurableSession(sessionId: string): Promise<void> {
	const store = getSessionStore();
	if (store) {
		await store.delete(sessionId);
	}
	fallbackSessions.delete(sessionId);

	const redis = await getSubscriptionsRedis();
	if (redis) {
		await redis.del(subscriptionsKey(sessionId));
	}
	fallbackSubscriptions.delete(sessionId);
}

function getSessionIdHeader(request: NextRequest): string | null {
	return request.headers.get("mcp-session-id");
}

function createJsonRpcErrorResponse(
	status: number,
	code: number,
	message: string,
): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			error: { code, message },
			id: null,
		}),
		{
			status,
			headers: {
				"Content-Type": "application/json",
			},
		},
	);
}

function extractMessages(rawBody: unknown): JSONRPCMessage[] | null {
	try {
		if (Array.isArray(rawBody)) {
			return rawBody.map((message) =>
				JSONRPCMessageSchema.parse(message),
			);
		}

		return [JSONRPCMessageSchema.parse(rawBody)];
	} catch {
		return null;
	}
}

function getInitializeProtocolVersion(
	messages: JSONRPCMessage[] | null,
): string | null {
	if (!messages) {
		return null;
	}

	const initializeRequest = messages.find((message) =>
		isInitializeRequest(message),
	);
	return initializeRequest?.params.protocolVersion ?? null;
}

function buildGatewaySession(
	authResult: AuthResult,
	sessionId: string = randomUUID(),
): GatewaySession {
	const now = new Date();
	return {
		sessionId,
		userId: authResult.userId,
		organizationId: authResult.organizationId,
		userName: authResult.userName,
		email: authResult.email,
		role: authResult.role,
		createdAt: now,
		expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
	};
}

function getDnsRebindingAllowlist(): {
	allowedHosts: string[];
	allowedOrigins: string[];
} {
	const allowedHosts = new Set<string>();
	const allowedOrigins = new Set<string>();

	const addHostAndOrigin = (origin: string) => {
		try {
			const url = new URL(origin);
			allowedHosts.add(url.host);
			allowedOrigins.add(url.origin);
		} catch {
			// Ignore invalid configured URLs.
		}
	};

	const addSiblingHostVariants = (origin: string) => {
		try {
			const url = new URL(origin);
			const { protocol, hostname, port } = url;

			if (
				hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname === "::1" ||
				hostname === "[::1]"
			) {
				return;
			}

			const normalizedHostname = hostname.replace(/\.$/, "");
			const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalizedHostname);
			const isIpv6 =
				normalizedHostname.includes(":") ||
				normalizedHostname.startsWith("[") ||
				normalizedHostname.endsWith("]");
			if (isIpv4 || isIpv6) {
				return;
			}

			const baseHostname = normalizedHostname.startsWith("www.")
				? normalizedHostname.slice(4)
				: normalizedHostname;
			const labelCount = baseHostname.split(".").filter(Boolean).length;
			if (labelCount !== 2) {
				return;
			}

			const siblingHostname = normalizedHostname.startsWith("www.")
				? baseHostname
				: `www.${baseHostname}`;

			if (!siblingHostname || siblingHostname === hostname) {
				return;
			}

			const siblingOrigin = `${protocol}//${siblingHostname}${port ? `:${port}` : ""}`;
			addHostAndOrigin(siblingOrigin);
		} catch {
			// Ignore invalid configured URLs.
		}
	};

	const configuredSiteUrl =
		process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3001";
	addHostAndOrigin(configuredSiteUrl);
	addSiblingHostVariants(configuredSiteUrl);
	addHostAndOrigin("http://localhost:3001");
	addHostAndOrigin("http://127.0.0.1:3001");
	addHostAndOrigin("http://[::1]:3001");

	return {
		allowedHosts: [...allowedHosts],
		allowedOrigins: [...allowedOrigins],
	};
}

function buildToolsForSession(
	session: RequestSession,
	options: McpRouteOptions,
): GatewayToolDefinition[] {
	const tools = options.enableConformanceFixtures
		? [...CONFORMANCE_TOOL_DEFINITIONS]
		: [];

	if (session.gatewaySession) {
		tools.push(...PLATFORM_TOOL_DEFINITIONS, ...BROWSER_TOOL_DEFINITIONS);
	}

	return tools;
}

function getServerCapabilities(options: McpRouteOptions) {
	if (options.enableConformanceFixtures) {
		return {
			tools: { listChanged: true },
			logging: {},
			completions: {},
			resources: { subscribe: true, listChanged: true },
			prompts: { listChanged: true },
		};
	}
	// No standalone GET SSE stream in production (GET → 405), so a
	// listChanged notification could never reach a client.
	return { tools: {} };
}

function getPromptResult(
	name: string,
	args: Record<string, unknown> | undefined,
): {
	description?: string;
	messages: Array<{
		role: "user";
		content:
			| { type: "text"; text: string }
			| {
					type: "resource";
					resource: {
						uri: string;
						mimeType: string;
						text: string;
					};
			  }
			| { type: "image"; data: string; mimeType: string };
	}>;
} {
	switch (name) {
		case "test_simple_prompt":
			return {
				description: "Simple prompt for conformance testing.",
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: "This is a simple prompt for testing.",
						},
					},
				],
			};
		case "test_prompt_with_arguments": {
			const arg1 = String(args?.arg1 ?? "");
			const arg2 = String(args?.arg2 ?? "");
			return {
				description: "Prompt with arguments for conformance testing.",
				messages: [
					{
						role: "user",
						content: {
							type: "text",
							text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'`,
						},
					},
				],
			};
		}
		case "test_prompt_with_embedded_resource": {
			const resourceUri = String(
				args?.resourceUri ?? "test://example-resource",
			);
			return {
				description: "Prompt with embedded resource content.",
				messages: [
					{
						role: "user",
						content: {
							type: "resource",
							resource: {
								uri: resourceUri,
								mimeType: "text/plain",
								text: "Embedded resource content for testing.",
							},
						},
					},
					{
						role: "user",
						content: {
							type: "text",
							text: "Please process the embedded resource above.",
						},
					},
				],
			};
		}
		case "test_prompt_with_image":
			return {
				description: "Prompt with image content.",
				messages: [
					{
						role: "user",
						content: {
							type: "image",
							data: PNG_BASE64,
							mimeType: "image/png",
						},
					},
					{
						role: "user",
						content: {
							type: "text",
							text: "Please analyze the image above.",
						},
					},
				],
			};
		default:
			throw new McpError(
				ErrorCode.InvalidParams,
				`Prompt ${name} not found`,
			);
	}
}

function getResourceResult(uri: string): {
	contents: Array<
		| { uri: string; mimeType: string; text: string }
		| { uri: string; mimeType: string; blob: string }
	>;
} {
	if (uri === "test://static-text") {
		return {
			contents: [
				{
					uri,
					mimeType: "text/plain",
					text: "This is the content of the static text resource.",
				},
			],
		};
	}

	if (uri === "test://static-binary") {
		return {
			contents: [
				{
					uri,
					mimeType: "image/png",
					blob: PNG_BASE64,
				},
			],
		};
	}

	const templateMatch = /^test:\/\/template\/([^/]+)\/data$/.exec(uri);
	if (templateMatch) {
		const id = templateMatch[1];
		return {
			contents: [
				{
					uri,
					mimeType: "application/json",
					text: JSON.stringify({
						id,
						templateTest: true,
						data: `Data for ID: ${id}`,
					}),
				},
			],
		};
	}

	throw new McpError(ErrorCode.InvalidParams, `Resource ${uri} not found`);
}

function getCompletionValues(
	ref: { type?: string; name?: string; uri?: string },
	argument: { name?: string; value?: string } | undefined,
) {
	const value = String(argument?.value ?? "").toLowerCase();

	if (
		ref.type === "ref/prompt" &&
		ref.name === "test_prompt_with_arguments"
	) {
		const values = ["testValue1", "testValue2", "testing", "tester"].filter(
			(candidate) => candidate.toLowerCase().includes(value),
		);
		return {
			completion: {
				values,
				total: values.length,
				hasMore: false,
			},
		};
	}

	if (
		ref.type === "ref/resource" &&
		ref.uri === "test://template/{id}/data"
	) {
		const values = ["123", "456", "789"].filter((candidate) =>
			candidate.includes(value),
		);
		return {
			completion: {
				values,
				total: values.length,
				hasMore: false,
			},
		};
	}

	return {
		completion: {
			values: [],
			total: 0,
			hasMore: false,
		},
	};
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTaskId(toolName: string): string {
	// Used as a workflowId and also as the path prefix for screenshot uploads
	// (`browser-screenshots/${taskId}/...`). Must be unguessable so a
	// neighboring task cannot be targeted or overwritten.
	return `mcp-${toolName}-${randomUUID()}`;
}

async function executeRunBrowserTask(
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	try {
		const client = await getTemporalClient();
		const taskId = createTaskId("browser-task");

		const input: BrowserAutomationInput = {
			taskId,
			userId,
			organizationId,
			url: args.url as string,
			actions: (args.actions as BrowserAutomationInput["actions"]) || [],
			extractors: args.extractors as BrowserAutomationInput["extractors"],
			takeScreenshotAfterEachAction: args.takeScreenshots as boolean,
			takeScreenshotOnError: true,
		};

		const handle = await client.workflow.start(
			"browserAutomationWorkflow",
			{
				taskQueue: BROWSER_TASK_QUEUE,
				workflowId: taskId,
				args: [input],
			},
		);

		return { success: true, result: await handle.result() };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Browser task execution failed",
		};
	}
}

async function executeRunHybridTask(
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	try {
		const client = await getTemporalClient();
		const taskId = createTaskId("hybrid-task");

		const input: HybridExecutionInput = {
			taskId,
			userId,
			organizationId,
			mode: args.mode as HybridExecutionInput["mode"],
			steps: args.steps as HybridExecutionInput["steps"],
			fallbackOnError: args.fallbackOnError as boolean,
			variables: args.variables as Record<string, unknown>,
		};

		const handle = await client.workflow.start("hybridExecutionWorkflow", {
			taskQueue: BROWSER_TASK_QUEUE,
			workflowId: taskId,
			args: [input],
		});

		return { success: true, result: await handle.result() };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Hybrid task execution failed",
		};
	}
}

async function executeTemplate(
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	try {
		const client = await getTemporalClient();
		const taskId = createTaskId("template");

		const input: TemplateExecutionInput = {
			taskId,
			userId,
			organizationId,
			templateId: args.templateId as string,
			parameterValues: args.parameters as Record<string, unknown>,
			takeScreenshots: args.takeScreenshots as boolean,
		};

		const handle = await client.workflow.start(
			"templateExecutionWorkflow",
			{
				taskQueue: BROWSER_TASK_QUEUE,
				workflowId: taskId,
				args: [input],
			},
		);

		return { success: true, result: await handle.result() };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Template execution failed",
		};
	}
}

async function executeListTemplates(
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	try {
		const { db } = await import("@repo/database");
		const where: Record<string, unknown> = {
			OR: [
				{ userId },
				{ isPublic: true },
				...(organizationId ? [{ organizationId }] : []),
			],
		};

		if (args.category) {
			where.category = args.category;
		}

		if (args.tags && Array.isArray(args.tags) && args.tags.length > 0) {
			where.tags = { hasSome: args.tags };
		}

		const templates = await db.automationTemplate.findMany({
			where,
			select: {
				id: true,
				name: true,
				description: true,
				category: true,
				tags: true,
				isPublic: true,
				useCount: true,
				createdAt: true,
			},
			orderBy: { useCount: "desc" },
			take: 50,
		});

		return {
			success: true,
			result: { templates, count: templates.length },
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to list templates",
		};
	}
}

async function executeExtractWebContent(
	args: Record<string, unknown>,
	userId: string,
	organizationId?: string,
): Promise<{ success: boolean; result?: unknown; error?: string }> {
	try {
		const client = await getTemporalClient();
		const taskId = createTaskId("extract-content");

		const input: BrowserRagIngestionInput = {
			urls: args.urls as string[],
			chatId: `mcp-extract-${Date.now()}`,
			userId,
			organizationId,
			selectors: args.selectors as BrowserRagIngestionInput["selectors"],
			waitForSelector: args.waitForSelector as string,
		};

		const handle = await client.workflow.start(
			"browserRagIngestionWorkflow",
			{
				taskQueue: BROWSER_TASK_QUEUE,
				workflowId: taskId,
				args: [input],
			},
		);

		return { success: true, result: await handle.result() };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Web content extraction failed",
		};
	}
}

async function handleBrowserToolCall(
	name: string,
	toolArgs: Record<string, unknown>,
	session: GatewaySession,
): Promise<McpToolResult> {
	let browserResult:
		| { success: boolean; result?: unknown; error?: string }
		| undefined;

	switch (name) {
		case "run_browser_task":
			browserResult = await executeRunBrowserTask(
				toolArgs,
				session.userId,
				session.organizationId ?? undefined,
			);
			break;
		case "run_hybrid_task":
			browserResult = await executeRunHybridTask(
				toolArgs,
				session.userId,
				session.organizationId ?? undefined,
			);
			break;
		case "execute_template":
			browserResult = await executeTemplate(
				toolArgs,
				session.userId,
				session.organizationId ?? undefined,
			);
			break;
		case "list_templates":
			browserResult = await executeListTemplates(
				toolArgs,
				session.userId,
				session.organizationId ?? undefined,
			);
			break;
		case "extract_web_content":
			browserResult = await executeExtractWebContent(
				toolArgs,
				session.userId,
				session.organizationId ?? undefined,
			);
			break;
	}

	if (!browserResult) {
		throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
	}

	if (browserResult.success) {
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(browserResult.result, null, 2),
				},
			],
		};
	}

	return {
		content: [{ type: "text", text: `Error: ${browserResult.error}` }],
		isError: true,
	};
}

async function handleConformanceToolCall(
	name: string,
	args: Record<string, unknown>,
	_session: RequestSession,
	extra: any,
): Promise<McpToolResult> {
	switch (name) {
		case "test_simple_text":
			return {
				content: [
					{
						type: "text",
						text: "This is a simple text response for testing.",
					},
				],
			};
		case "test_image_content":
			return {
				content: [
					{
						type: "image",
						data: PNG_BASE64,
						mimeType: "image/png",
					},
				],
			};
		case "test_audio_content":
			return {
				content: [
					{
						type: "audio",
						data: WAV_BASE64,
						mimeType: "audio/wav",
					},
				],
			};
		case "test_embedded_resource":
			return {
				content: [
					{
						type: "resource",
						resource: {
							uri: "test://embedded-resource",
							mimeType: "text/plain",
							text: "This is an embedded resource content.",
						},
					},
				],
			};
		case "test_multiple_content_types":
			return {
				content: [
					{
						type: "text",
						text: "Multiple content types test:",
					},
					{
						type: "image",
						data: PNG_BASE64,
						mimeType: "image/png",
					},
					{
						type: "resource",
						resource: {
							uri: "test://mixed-content-resource",
							mimeType: "application/json",
							text: JSON.stringify({ test: "data", value: 123 }),
						},
					},
				],
			};
		case "test_tool_with_logging":
			await extra.sendNotification({
				method: "notifications/message",
				params: { level: "info", data: "Tool execution started" },
			});
			await sleep(50);
			await extra.sendNotification({
				method: "notifications/message",
				params: { level: "info", data: "Tool processing data" },
			});
			await sleep(50);
			await extra.sendNotification({
				method: "notifications/message",
				params: { level: "info", data: "Tool execution completed" },
			});
			return {
				content: [
					{
						type: "text",
						text: "Logging test tool completed successfully.",
					},
				],
			};
		case "test_error_handling":
			return {
				isError: true,
				content: [
					{
						type: "text",
						text: "This tool intentionally returns an error for testing",
					},
				],
			};
		case "test_tool_with_progress": {
			const progressToken = extra._meta?.progressToken;
			if (progressToken !== undefined) {
				await extra.sendNotification({
					method: "notifications/progress",
					params: { progressToken, progress: 0, total: 100 },
				});
			}
			await sleep(50);
			if (progressToken !== undefined) {
				await extra.sendNotification({
					method: "notifications/progress",
					params: { progressToken, progress: 50, total: 100 },
				});
			}
			await sleep(50);
			if (progressToken !== undefined) {
				await extra.sendNotification({
					method: "notifications/progress",
					params: { progressToken, progress: 100, total: 100 },
				});
			}
			return {
				content: [
					{
						type: "text",
						text: "Progress test tool completed successfully.",
					},
				],
			};
		}
		case "test_sampling": {
			const prompt = String(args.prompt ?? "");
			const result = (await extra.sendRequest(
				{
					method: "sampling/createMessage",
					params: {
						messages: [
							{
								role: "user",
								content: {
									type: "text",
									text: prompt,
								},
							},
						],
						maxTokens: 100,
					},
				},
				CreateMessageResultSchema,
			)) as {
				content?:
					| { type?: string; text?: string }
					| Array<{ text?: string }>;
			};

			const responseText = Array.isArray(result.content)
				? (result.content[0]?.text ?? "")
				: (result.content?.text ?? "");

			return {
				content: [
					{
						type: "text",
						text: `LLM response: ${responseText}`,
					},
				],
			};
		}
		case "test_elicitation": {
			const result = await extra.sendRequest(
				{
					method: "elicitation/create",
					params: {
						message: String(args.message ?? ""),
						requestedSchema: {
							type: "object",
							properties: {
								username: {
									type: "string",
									description: "User's response",
								},
								email: {
									type: "string",
									description: "User's email address",
								},
							},
							required: ["username", "email"],
						},
					},
				},
				ElicitResultSchema,
			);

			return {
				content: [
					{
						type: "text",
						text: `User response: ${JSON.stringify(result)}`,
					},
				],
			};
		}
		case "test_elicitation_sep1034_defaults": {
			const result = await extra.sendRequest(
				{
					method: "elicitation/create",
					params: {
						message: "Collect defaults test values",
						requestedSchema: {
							type: "object",
							properties: {
								name: { type: "string", default: "John Doe" },
								age: { type: "integer", default: 30 },
								score: { type: "number", default: 95.5 },
								status: {
									type: "string",
									enum: ["active", "inactive", "pending"],
									default: "active",
								},
								verified: { type: "boolean", default: true },
							},
							required: [
								"name",
								"age",
								"score",
								"status",
								"verified",
							],
						},
					},
				},
				ElicitResultSchema,
			);

			return {
				content: [
					{
						type: "text",
						text: `Elicitation completed: ${JSON.stringify(result)}`,
					},
				],
			};
		}
		case "test_elicitation_sep1330_enums": {
			const result = await extra.sendRequest(
				{
					method: "elicitation/create",
					params: {
						message: "Collect enum test values",
						requestedSchema: {
							type: "object",
							properties: {
								untitledSingle: {
									type: "string",
									enum: ["option1", "option2", "option3"],
								},
								titledSingle: {
									type: "string",
									oneOf: [
										{
											const: "value1",
											title: "First Option",
										},
										{
											const: "value2",
											title: "Second Option",
										},
										{
											const: "value3",
											title: "Third Option",
										},
									],
								},
								legacyEnum: {
									type: "string",
									enum: ["opt1", "opt2", "opt3"],
									enumNames: [
										"Option One",
										"Option Two",
										"Option Three",
									],
								},
								untitledMulti: {
									type: "array",
									items: {
										type: "string",
										enum: ["option1", "option2", "option3"],
									},
								},
								titledMulti: {
									type: "array",
									items: {
										anyOf: [
											{
												const: "value1",
												title: "First Choice",
											},
											{
												const: "value2",
												title: "Second Choice",
											},
											{
												const: "value3",
												title: "Third Choice",
											},
										],
									},
								},
							},
							required: [
								"untitledSingle",
								"titledSingle",
								"legacyEnum",
								"untitledMulti",
								"titledMulti",
							],
						},
					},
				},
				ElicitResultSchema,
			);

			return {
				content: [
					{
						type: "text",
						text: `Elicitation completed: ${JSON.stringify(result)}`,
					},
				],
			};
		}
		default:
			throw new McpError(
				ErrorCode.InvalidParams,
				`Tool ${name} not found`,
			);
	}
}

function createRequestSession(
	authResult: AuthResult | null,
	options?: {
		sessionId?: string;
		subscriptions?: Iterable<string>;
		enableSessionManagement?: boolean;
		sessionExpiresAt?: string;
		hydrateExistingSession?: boolean;
		routeOptions?: McpRouteOptions;
	},
): RequestSession {
	const subscriptions = new Set(options?.subscriptions ?? []);
	const { allowedHosts, allowedOrigins } = getDnsRebindingAllowlist();
	const routeOptions = options?.routeOptions ?? {
		enableConformanceFixtures: false,
	};

	const sessionId = options?.sessionId;
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: options?.enableSessionManagement
			? () => {
					if (!sessionId) {
						throw new Error(
							"Session ID is required in stateful mode",
						);
					}
					return sessionId;
				}
			: undefined,
		enableDnsRebindingProtection: true,
		allowedHosts,
		allowedOrigins,
	});

	const session: RequestSession = {
		server: new Server(
			{
				name: SERVER_NAME,
				version: SERVER_VERSION,
			},
			{
				capabilities: getServerCapabilities(routeOptions),
				instructions: authResult
					? "Fabric MCP server exposing authenticated Fabric capabilities."
					: routeOptions.enableConformanceFixtures
						? "Fabric MCP public conformance surface."
						: "Fabric MCP server exposing public Fabric capabilities.",
			},
		),
		transport,
		gatewaySession: null,
		subscriptions,
		sessionId,
	};

	if (authResult) {
		session.gatewaySession = buildGatewaySession(
			authResult,
			sessionId ?? randomUUID(),
		);
	}

	if (sessionId && options?.sessionExpiresAt) {
		session.persistSubscriptions = async () => {
			const expiresAt = options.sessionExpiresAt;
			if (!expiresAt) {
				return;
			}
			await saveSubscriptions(
				sessionId,
				session.subscriptions,
				expiresAt,
			);
		};
	}

	session.server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: buildToolsForSession(session, routeOptions),
	}));

	session.server.setRequestHandler(
		CallToolRequestSchema,
		async (requestMessage, extra) => {
			const name = requestMessage.params.name;
			const args = (requestMessage.params.arguments ?? {}) as Record<
				string,
				unknown
			>;

			if (
				routeOptions.enableConformanceFixtures &&
				CONFORMANCE_TOOL_DEFINITIONS.some((tool) => tool.name === name)
			) {
				return (await handleConformanceToolCall(
					name,
					args,
					session,
					extra,
				)) as any;
			}

			if (!session.gatewaySession) {
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: "Authentication required for Fabric platform tools.",
						},
					],
				} as any;
			}

			if (BROWSER_TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
				return (await handleBrowserToolCall(
					name,
					args,
					session.gatewaySession,
				)) as any;
			}

			if (PLATFORM_TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
				return (await executePlatformTool(
					name,
					args,
					session.gatewaySession,
				)) as any;
			}

			throw new McpError(
				ErrorCode.InvalidParams,
				`Tool ${name} not found`,
			);
		},
	);

	if (routeOptions.enableConformanceFixtures) {
		session.server.setRequestHandler(
			ListResourcesRequestSchema,
			async () => ({
				resources: CONFORMANCE_RESOURCES,
			}),
		);

		session.server.setRequestHandler(
			ListResourceTemplatesRequestSchema,
			async () => ({
				resourceTemplates: CONFORMANCE_RESOURCE_TEMPLATES,
			}),
		);

		session.server.setRequestHandler(
			ReadResourceRequestSchema,
			async (request) => getResourceResult(request.params.uri),
		);

		session.server.setRequestHandler(
			SubscribeRequestSchema,
			async (request) => {
				session.subscriptions.add(request.params.uri);
				await session.persistSubscriptions?.();
				return {};
			},
		);

		session.server.setRequestHandler(
			UnsubscribeRequestSchema,
			async (request) => {
				session.subscriptions.delete(request.params.uri);
				await session.persistSubscriptions?.();
				return {};
			},
		);

		session.server.setRequestHandler(
			ListPromptsRequestSchema,
			async () => ({
				prompts: CONFORMANCE_PROMPTS,
			}),
		);

		session.server.setRequestHandler(
			GetPromptRequestSchema,
			async (request) =>
				getPromptResult(
					request.params.name,
					request.params.arguments as
						| Record<string, unknown>
						| undefined,
				),
		);

		session.server.setRequestHandler(
			CompleteRequestSchema,
			async (request) =>
				getCompletionValues(
					request.params.ref,
					request.params.argument,
				),
		);
	}

	transport.onerror = (error) => {
		console.error("[Fabric MCP] transport error:", error);
	};

	if (sessionId && options?.hydrateExistingSession) {
		transport.sessionId = sessionId;
		(transport as any)._initialized = true;
	}

	return session;
}

async function handlePostRequest(
	request: NextRequest,
	routeOptions: McpRouteOptions,
): Promise<Response> {
	const authResult = await authenticateRequest(request);
	let parsedBody: unknown;

	try {
		parsedBody = await request.clone().json();
	} catch {
		const sessionId = getSessionIdHeader(request);
		if (sessionId) {
			const durableSession = await getDurableSession(sessionId);
			if (durableSession) {
				const storedAuthResult = restoreAuthResult(durableSession.core);
				if (
					authResult &&
					storedAuthResult &&
					(authResult.userId !== storedAuthResult.userId ||
						authResult.organizationId !==
							storedAuthResult.organizationId)
				) {
					return createJsonRpcErrorResponse(
						401,
						-32000,
						"Authentication failed for MCP session",
					);
				}

				const session = createRequestSession(
					storedAuthResult ?? authResult,
					{
						sessionId,
						enableSessionManagement: true,
						hydrateExistingSession: true,
						subscriptions: durableSession.subscriptions,
						sessionExpiresAt: durableSession.core.expiresAt,
						routeOptions,
					},
				);
				await session.server.connect(session.transport);
				return session.transport.handleRequest(request);
			}
		}

		const session = createRequestSession(authResult, {
			routeOptions,
		});
		await session.server.connect(session.transport);
		return session.transport.handleRequest(request);
	}

	const messages = extractMessages(parsedBody);
	const isInitializationRequest =
		messages?.some((message) => isInitializeRequest(message)) ?? false;

	if (isInitializationRequest) {
		const protocolVersion =
			getInitializeProtocolVersion(messages) ?? "2025-06-18";
		const durableSession = await createDurableSession(
			authResult,
			protocolVersion,
		);
		const session = createRequestSession(authResult, {
			sessionId: durableSession.core.sessionId,
			enableSessionManagement: true,
			sessionExpiresAt: durableSession.core.expiresAt,
			routeOptions,
		});

		await session.server.connect(session.transport);
		const response = await session.transport.handleRequest(request, {
			parsedBody,
		});

		if (!response.ok) {
			await deleteDurableSession(durableSession.core.sessionId);
			return response;
		}

		return response;
	}

	const sessionId = getSessionIdHeader(request);
	if (!sessionId) {
		return createJsonRpcErrorResponse(
			400,
			-32000,
			"Bad Request: Mcp-Session-Id header is required",
		);
	}

	const durableSession = await getDurableSession(sessionId);
	if (!durableSession) {
		return createJsonRpcErrorResponse(404, -32001, "Session not found");
	}

	const storedAuthResult = restoreAuthResult(durableSession.core);
	if (
		authResult &&
		storedAuthResult &&
		(authResult.userId !== storedAuthResult.userId ||
			authResult.organizationId !== storedAuthResult.organizationId)
	) {
		return createJsonRpcErrorResponse(
			401,
			-32000,
			"Authentication failed for MCP session",
		);
	}

	const effectiveAuthResult = storedAuthResult ?? authResult;
	const session = createRequestSession(effectiveAuthResult, {
		sessionId,
		enableSessionManagement: true,
		hydrateExistingSession: true,
		subscriptions: durableSession.subscriptions,
		sessionExpiresAt: durableSession.core.expiresAt,
		routeOptions,
	});
	await session.server.connect(session.transport);
	const response = await session.transport.handleRequest(request, {
		parsedBody,
	});
	if (response.ok) {
		await touchDurableSession(sessionId);
	}
	return response;
}

async function handleGetRequest(
	request: NextRequest,
	routeOptions: McpRouteOptions,
): Promise<Response> {
	const sessionId = getSessionIdHeader(request);
	if (!sessionId) {
		return createJsonRpcErrorResponse(
			400,
			-32000,
			"Bad Request: Mcp-Session-Id header is required",
		);
	}

	const durableSession = await getDurableSession(sessionId);
	if (!durableSession) {
		return createJsonRpcErrorResponse(404, -32001, "Session not found");
	}

	const requestAuthResult = await authenticateRequest(request);
	const storedAuthResult = restoreAuthResult(durableSession.core);
	if (
		requestAuthResult &&
		storedAuthResult &&
		(requestAuthResult.userId !== storedAuthResult.userId ||
			requestAuthResult.organizationId !==
				storedAuthResult.organizationId)
	) {
		return createJsonRpcErrorResponse(
			401,
			-32000,
			"Authentication failed for MCP session",
		);
	}

	const session = createRequestSession(
		storedAuthResult ?? requestAuthResult,
		{
			sessionId,
			enableSessionManagement: true,
			hydrateExistingSession: true,
			subscriptions: durableSession.subscriptions,
			sessionExpiresAt: durableSession.core.expiresAt,
			routeOptions,
		},
	);
	await session.server.connect(session.transport);
	const response = await session.transport.handleRequest(request);
	if (response.ok) {
		await touchDurableSession(sessionId);
	}
	return response;
}

async function handleDeleteRequest(
	request: NextRequest,
	routeOptions: McpRouteOptions,
): Promise<Response> {
	const sessionId = getSessionIdHeader(request);
	if (!sessionId) {
		return createJsonRpcErrorResponse(
			400,
			-32000,
			"Bad Request: Mcp-Session-Id header is required",
		);
	}

	const durableSession = await getDurableSession(sessionId);
	if (!durableSession) {
		return createJsonRpcErrorResponse(404, -32001, "Session not found");
	}

	const requestAuthResult = await authenticateRequest(request);
	const storedAuthResult = restoreAuthResult(durableSession.core);
	if (
		requestAuthResult &&
		storedAuthResult &&
		(requestAuthResult.userId !== storedAuthResult.userId ||
			requestAuthResult.organizationId !==
				storedAuthResult.organizationId)
	) {
		return createJsonRpcErrorResponse(
			401,
			-32000,
			"Authentication failed for MCP session",
		);
	}

	const session = createRequestSession(
		storedAuthResult ?? requestAuthResult,
		{
			sessionId,
			enableSessionManagement: true,
			hydrateExistingSession: true,
			subscriptions: durableSession.subscriptions,
			sessionExpiresAt: durableSession.core.expiresAt,
			routeOptions,
		},
	);
	await session.server.connect(session.transport);
	const response = await session.transport.handleRequest(request);
	if (response.ok) {
		await deleteDurableSession(sessionId);
	}
	return response;
}

export async function POST(request: NextRequest): Promise<Response> {
	return handlePostRequest(request, {
		enableConformanceFixtures: false,
	});
}

export async function GET(_request: NextRequest): Promise<Response> {
	// The Streamable HTTP spec lets a server refuse the standalone GET
	// SSE stream with 405. Every request here builds a fresh in-memory
	// Server with no event store or cross-instance bridge, so a GET
	// stream can never carry a message — holding one open only burns
	// the full Vercel function budget and logs a 504 timeout (issue
	// #2254). Official SDK clients treat 405 as "standalone SSE
	// unsupported" and carry on. The conformance surface
	// (/mcp/conformance) keeps the real SSE stream.
	return new Response(null, {
		status: 405,
		headers: { Allow: "POST, DELETE" },
	});
}

export async function DELETE(request: NextRequest): Promise<Response> {
	return handleDeleteRequest(request, {
		enableConformanceFixtures: false,
	});
}

export async function postConformance(request: NextRequest): Promise<Response> {
	return handlePostRequest(request, {
		enableConformanceFixtures: true,
	});
}

export async function getConformance(request: NextRequest): Promise<Response> {
	return handleGetRequest(request, {
		enableConformanceFixtures: true,
	});
}

export async function deleteConformance(
	request: NextRequest,
): Promise<Response> {
	return handleDeleteRequest(request, {
		enableConformanceFixtures: true,
	});
}
