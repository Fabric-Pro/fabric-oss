/**
 * @fabricorg/sdk-mcp
 *
 * Builds an MCP (Model Context Protocol) server that exposes a Fabric
 * workspace's whole integration catalog, agent delegation, and Fabric-branded
 * MCP Apps (`ui://fabric/*`) as MCP tools and resources — any MCP-compatible
 * agent (Claude Desktop, claude.ai, ChatGPT, Cursor, Fabric Desktop, …) can
 * point at one endpoint and get every connected vendor plus interactive
 * Fabric UI cards.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type DeliverySourceClient,
	registerDeliverySourceTools,
} from "./delivery-source-tools.js";
import {
	buildFabricVisualizePayload,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	FABRIC_MCP_APP_RESOURCES,
	type FabricMcpAppResourceContent,
	type FabricMcpAppResourceDescriptor,
	type FabricVisualizeResult,
	readFabricMcpAppResource,
	withFabricApp,
} from "./mcp-apps.js";

export {
	buildFabricVisualizePayload,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	FABRIC_MCP_APP_RESOURCES,
	type FabricMcpAppResourceContent,
	type FabricMcpAppResourceDescriptor,
	type FabricVisualizeResult,
	readFabricMcpAppResource,
	withFabricApp,
};

// Avoid importing @fabricorg/sdk concrete types at runtime; we only need its
// shape so the server is decoupled from a specific SDK version. Consumers
// pass an `FabricClient` instance. Exported because the declaration bundler
// drops the `export {}` marker that keeps unexported types in a .d.ts private.
export type FabricLike = {
	integrations: {
		list(): Promise<
			Array<{
				slug: string;
				name: string;
				status: string;
				mode: string;
				source: string;
			}>
		>;
		[slug: string]: unknown;
	};
	auth?: {
		whoami(): Promise<{
			user?: { id: string; name?: string | null; email?: string | null };
			id?: string;
			name?: string | null;
			email?: string | null;
			organizations?: Array<{
				id: string;
				name: string;
				slug?: string;
				role?: string;
			}>;
		}>;
	};
	projects?: DeliverySourceClient & {
		listTriageRuns?(
			projectId: string,
			options?: { before?: string },
		): Promise<unknown>;
		startTriage?(
			projectId: string,
			options: { requestId: string; goal: string; evidenceIds: string[] },
		): Promise<unknown>;
		getTriageRun?(projectId: string, runId: string): Promise<unknown>;
		getTriageResult?(projectId: string, runId: string): Promise<unknown>;
		cancelTriageRun?(projectId: string, runId: string): Promise<unknown>;
		reviewTriageProposal?(
			projectId: string,
			runId: string,
			options: { proposalId: string; decision: "KEEP" | "DISMISS" },
		): Promise<unknown>;

		list(options?: Record<string, unknown>): Promise<
			Array<{
				id: string;
				name: string;
				slug?: string;
				status?: string;
				description?: string | null;
			}>
		>;
		get(id: string, options?: Record<string, unknown>): Promise<object>;
		listFeatures(
			projectId: string,
			options?: Record<string, unknown>,
		): Promise<Array<object>>;
		getFeature?(
			projectId: string,
			featureId: string,
			options?: Record<string, unknown>,
		): Promise<object>;
		listDocuments?(
			projectId: string,
			options?: Record<string, unknown>,
		): Promise<Array<object>>;
		getDocument?(
			documentId: string,
			options?: Record<string, unknown>,
		): Promise<object>;
	};
	frames?: {
		list(options?: Record<string, unknown>): Promise<Array<object>>;
		get(id: string, options?: Record<string, unknown>): Promise<object>;
	};
	workspaces?: {
		list(options?: Record<string, unknown>): Promise<Array<object>>;
		get(id: string, options?: Record<string, unknown>): Promise<object>;
	};
};

export interface CreateFabricMcpServerOptions {
	/** A configured FabricClient (createFabric) instance. Required. */
	fabric: FabricLike;
	/** Server name reported on the MCP handshake. Default `"fabric"`. */
	name?: string;
	/** Server version. Default `"0.1.0"`. */
	version?: string;
}

/**
 * Build a configured `McpServer` exposing the workspace catalog and
 * built-in Fabric MCP App resources (`ui://fabric/*`). Caller is
 * responsible for `.connect(transport)` so the same server works over stdio,
 * HTTP, or any other MCP transport.
 */
export function createFabricMcpServer(
	options: CreateFabricMcpServerOptions,
): McpServer {
	const fabric = options.fabric;
	const server = new McpServer({
		name: options.name ?? "fabric",
		version: options.version ?? "0.1.17",
	});

	// Register all built-in Fabric MCP App resources (`ui://fabric/*`)
	for (const appResource of FABRIC_MCP_APP_RESOURCES) {
		server.registerResource(
			appResource.name,
			appResource.uri,
			{
				title: appResource.name,
				description: appResource.description,
				mimeType: appResource.mimeType,
				_meta: appResource._meta,
			},
			async (uri) => {
				const rendered = readFabricMcpAppResource(uri.href);
				if (!rendered) {
					return { contents: [] };
				}
				return {
					contents: rendered.contents.map((c) => ({
						uri: c.uri,
						mimeType: c.mimeType,
						text: c.text,
						_meta: c._meta,
					})),
				};
			},
		);
	}

	registerDeliverySourceTools(server, fabric.projects);
	const triageProject = fabric.projects;
	if (
		triageProject?.listTriageRuns &&
		triageProject.startTriage &&
		triageProject.getTriageRun &&
		triageProject.getTriageResult &&
		triageProject.cancelTriageRun &&
		triageProject.reviewTriageProposal
	) {
		for (const op of [
			"list",
			"start",
			"status",
			"result",
			"cancel",
			"review",
		] as const) {
			const properties = {
				projectId: z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/),
				...(op !== "start" && op !== "list"
					? { runId: z.string().min(1).max(200) }
					: {}),
				...(op === "list"
					? { before: z.string().max(2048).optional() }
					: {}),
				...(op === "start"
					? {
							requestId: z.uuid(),
							goal: z.string().min(1).max(2000),
							evidenceIds: z
								.array(z.string().min(1).max(200))
								.min(1)
								.max(5),
						}
					: {}),
				...(op === "review"
					? {
							proposalId: z.string().regex(/^[a-f0-9]{64}$/),
							decision: z.enum(["KEEP", "DISMISS"]),
						}
					: {}),
			};
			const write = ["start", "cancel", "review"].includes(op);
			server.registerTool(
				`fabric_triage_${op}`,
				{
					description: `${op} your private selected-evidence signal review. Reuse start requestId and original input after uncertainty. Keeping does not create a ticket or share content.`,
					inputSchema: z.strictObject(properties),
					annotations: {
						readOnlyHint: !write,
						destructiveHint: false,
						idempotentHint: op !== "start",
					},
					_meta: {
						...(write ? { "fabric/confirm": true } : {}),
						...(["result", "review"].includes(op)
							? withFabricApp("ui://fabric/private-triage")
							: {}),
					},
				},
				async (args) => {
					try {
						const a = args as {
							projectId: string;
							runId?: string;
							before?: string;
							requestId?: string;
							goal?: string;
							evidenceIds?: string[];
							proposalId?: string;
							decision?: "KEEP" | "DISMISS";
						};
						let data: unknown;
						switch (op) {
							case "list":
								data = await triageProject.listTriageRuns!(
									a.projectId,
									{ before: a.before },
								);
								break;
							case "start":
								data = await triageProject.startTriage!(
									a.projectId,
									{
										requestId: a.requestId!,
										goal: a.goal!,
										evidenceIds: a.evidenceIds!,
									},
								);
								break;
							case "status":
								data = await triageProject.getTriageRun!(
									a.projectId,
									a.runId!,
								);
								break;
							case "result":
								data = await triageProject.getTriageResult!(
									a.projectId,
									a.runId!,
								);
								break;
							case "cancel":
								data = await triageProject.cancelTriageRun!(
									a.projectId,
									a.runId!,
								);
								break;
							case "review":
								data =
									await triageProject.reviewTriageProposal!(
										a.projectId,
										a.runId!,
										{
											proposalId: a.proposalId!,
											decision: a.decision!,
										},
									);
								break;
						}
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify(data),
								},
							],
							structuredContent: {
								...(data as Record<string, unknown>),
								projectId: a.projectId,
							},
							...(["result", "review"].includes(op)
								? {
										_meta: withFabricApp(
											"ui://fabric/private-triage",
										),
									}
								: {}),
						};
					} catch (error) {
						const code =
							error &&
							typeof error === "object" &&
							"code" in error &&
							typeof error.code === "string"
								? error.code
								: "TRIAGE_UNAVAILABLE";
						return {
							isError: true,
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										code,
										error: "Private signal review unavailable. Check current scope, project and source access.",
									}),
								},
							],
						};
					}
				},
			);
		}
	}
	server.registerTool(
		"fabric_list_integrations",
		{
			title: "List Fabric Integrations",
			description:
				"List integrations connected for the authenticated Fabric workspace. " +
				"Returns slug, display name, current connection status, permission mode " +
				"(open/cautious/strict/readonly), and source (plugin/mcp-server/connector). " +
				"Renders an interactive Fabric MCP App card in MCP App-capable hosts.",
			inputSchema: {},
			_meta: withFabricApp("ui://fabric/agent-delegation"),
		},
		async () => {
			const integrations = await fabric.integrations.list();
			const payload = {
				title: "Connected Fabric Integrations",
				integrations,
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(integrations, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/agent-delegation"),
			};
		},
	);

	server.registerTool(
		"fabric_list_operations",
		{
			title: "List Operations for an Integration",
			description:
				"List the dot-notation operations available on a single Fabric integration. " +
				"Returns an array of `{ operation, riskLevel, description }`. Supply the " +
				"slug from `fabric_list_integrations`.",
			inputSchema: {
				slug: z
					.string()
					.describe(
						'Integration slug, e.g. "slack", "github", "linear".',
					),
			},
			_meta: withFabricApp("ui://fabric/agent-delegation"),
		},
		async ({ slug }) => {
			const integration = (
				fabric.integrations as Record<string, unknown>
			)[slug] as
				| {
						call?: (op: string, args?: unknown) => Promise<unknown>;
				  }
				| undefined;
			if (!integration) {
				return {
					content: [
						{
							type: "text",
							text: `Integration "${slug}" is not registered for this workspace.`,
						},
					],
					isError: true,
				};
			}
			try {
				const ops = await integration.call?.("__operations");
				const operations = Array.isArray(ops) ? ops : [];
				return {
					structuredContent: {
						title: `${slug} Operations`,
						slug,
						operations,
					},
					content: [
						{ type: "text", text: JSON.stringify(ops, null, 2) },
					],
					_meta: withFabricApp("ui://fabric/agent-delegation"),
				};
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Operation listing for "${slug}" requires portal endpoint /api/v1/integrations/${slug}/operations (not yet exposed). Use fabric_call with a known operation path in the meantime.`,
						},
					],
				};
			}
		},
	);

	server.registerTool(
		"fabric_call",
		{
			title: "Call a Fabric Integration Operation",
			description:
				"Execute an operation on a connected Fabric integration. Args is a JSON " +
				"object whose shape depends on the specific operation. Returns the " +
				"upstream response, or { status: 'pending_approval' | 'denied' } when " +
				"the workspace permission policy gates the call.",
			inputSchema: {
				slug: z.string().describe('Integration slug, e.g. "slack".'),
				operation: z
					.string()
					.describe(
						'Dot-notation operation, e.g. "messages.send" or "channels.list".',
					),
				args: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"Arguments object. Shape depends on the operation.",
					),
			},
			_meta: withFabricApp("ui://fabric/agent-delegation"),
		},
		async ({ slug, operation, args }) => {
			const integration = (
				fabric.integrations as Record<string, unknown>
			)[slug] as
				| {
						call?: (op: string, args?: unknown) => Promise<unknown>;
				  }
				| undefined;
			if (!integration?.call) {
				return {
					content: [
						{
							type: "text",
							text: `Integration "${slug}" is not registered for this workspace.`,
						},
					],
					isError: true,
				};
			}
			try {
				const result = await integration.call(operation, args ?? {});
				const structured =
					result && typeof result === "object"
						? (result as Record<string, unknown>)
						: { slug, operation, result };
				return {
					structuredContent: structured,
					content: [
						{ type: "text", text: JSON.stringify(result, null, 2) },
					],
					_meta: withFabricApp("ui://fabric/agent-delegation"),
				};
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"fabric_delegate_agent",
		{
			title: "Delegate Task to Fabric Desktop or Remote Fabric Agents Server",
			description:
				"Delegate a coding or workspace task to either Fabric Desktop (fabricagents:// deep link) " +
				"or a Remote Fabric Agents Server using subscription harnesses (Claude, Codex, Droid, Grok, Kimi) " +
				"with configurable fallback policies.",
			inputSchema: {
				target: z
					.enum(["desktop", "remote"])
					.default("remote")
					.describe(
						'Execution target: "desktop" for local Fabric Desktop app or "remote" for Remote Fabric Agents Server.',
					),
				projectId: z
					.string()
					.optional()
					.describe("Optional Fabric project ID."),
				projectSlug: z
					.string()
					.optional()
					.describe("Optional Fabric project slug."),
				prompt: z
					.string()
					.describe("Task prompt to execute on the target agent."),
				harness: z
					.enum([
						"auto",
						"claude-max",
						"codex",
						"droid-cli",
						"grok-cli",
						"kimi-cli",
						"antigravity-cli",
						"cursor",
					])
					.optional()
					.describe("Subscription harness to run the task with."),
				fallback: z
					.enum([
						"subscription_harnesses",
						"org_paid_api",
						"pause_on_limit",
					])
					.optional()
					.describe("Quota & billing fallback policy."),
				serverUrl: z
					.string()
					.optional()
					.describe(
						"Remote Fabric Agents Server URL (e.g. https://agents.example.com or http://127.0.0.1:9100).",
					),
				durable: z
					.boolean()
					.optional()
					.describe(
						"Whether to track execution inside a durable Temporal workflow envelope.",
					),
			},
			_meta: withFabricApp("ui://fabric/agent-delegation"),
		},
		async ({
			target,
			projectId,
			projectSlug,
			prompt,
			harness,
			fallback,
			serverUrl,
			durable,
		}) => {
			const selectedHarness = harness ?? "claude-max";
			const selectedFallback = fallback ?? "subscription_harnesses";
			const query = new URLSearchParams();
			if (projectSlug) {
				query.set("workspace", projectSlug);
			}
			if (projectId) {
				query.set("projectId", projectId);
			}
			query.set("harness", selectedHarness);
			query.set("fallback", selectedFallback);
			query.set("input", prompt);
			query.set("send", "true");

			const desktopDeepLink = `fabricagents://action/new-chat?${query.toString()}`;
			const baseRemoteUrl = (
				serverUrl || "https://agents.example.com"
			).replace(/\/+$/, "");
			const remoteUrl = `${baseRemoteUrl}/?${query.toString()}`;

			const payload = {
				status: "delegated",
				title: projectSlug
					? `Delegated to ${projectSlug}`
					: "Fabric Agent Delegation Ready",
				target,
				harness: selectedHarness,
				fallbackPolicy: selectedFallback,
				durable: Boolean(durable),
				desktopDeepLink,
				remoteDelegationUrl: remoteUrl,
				uiResourceUri: "ui://fabric/agent-delegation",
			};

			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/agent-delegation"),
			};
		},
	);

	server.registerTool(
		"fabric_subscription_status",
		{
			title: "Check Fabric Remote Server Subscription Credits & Harnesses",
			description:
				"Inspect connected subscription harnesses (Claude, Codex, Droid, Grok, Kimi) and fallback routing on the Fabric Agents Server.",
			inputSchema: {
				serverUrl: z
					.string()
					.optional()
					.describe(
						"Optional Remote Fabric Agents Server URL to inspect.",
					),
			},
			_meta: withFabricApp("ui://fabric/agent-delegation"),
		},
		async ({ serverUrl }) => {
			const payload = {
				title: "Fabric Subscription Harnesses & Credits",
				serverUrl: serverUrl || "https://agents.example.com",
				billingMode: "subscription_tokens",
				fallbackPolicy: "subscription_harnesses",
				harnesses: [
					{
						id: "claude-max",
						label: "Claude (Opus 4.6 / Sonnet 4.6)",
						status: "active",
						auth: "subscription_oauth",
					},
					{
						id: "codex",
						label: "Codex (GPT-5.4 / o3)",
						status: "active",
						auth: "subscription_oauth",
					},
					{
						id: "droid-cli",
						label: "Droid (Factory Multi-Model)",
						status: "active",
						auth: "subscription_oauth",
					},
					{
						id: "grok-cli",
						label: "Grok (Grok 4 Heavy / Fast)",
						status: "active",
						auth: "subscription_oauth",
					},
					{
						id: "kimi-cli",
						label: "Kimi (Kimi K2.5 Thinking)",
						status: "active",
						auth: "subscription_oauth",
					},
				],
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/agent-delegation"),
			};
		},
	);

	server.registerTool(
		"fabric_visualize",
		{
			title: "Draw Interactive Fabric Card (A2UI v0.9.1)",
			description:
				"Render an interactive Fabric-branded MCP App card (comparisons, step-by-step plans, charts with sliders, quizzes, flashcards, tables, or diagrams) from an A2UI v0.9.1 document (`createSurface`, `updateComponents`, `updateDataModel`).",
			inputSchema: {
				title: z
					.string()
					.optional()
					.describe(
						"Card heading shown at the top of the Fabric view.",
					),
				document: z
					.union([
						z.string(),
						z.array(z.record(z.string(), z.unknown())),
					])
					.describe(
						"A2UI v0.9.1 messages as JSONL (one JSON object per line) or a JSON array of messages.",
					),
				sources: z
					.array(z.string())
					.optional()
					.describe("Optional source URLs cited in the card."),
			},
			_meta: withFabricApp("ui://fabric/visualize"),
		},
		async ({ title, document, sources }) => {
			try {
				const built = buildFabricVisualizePayload({
					title,
					document,
					sources,
				});
				return {
					structuredContent: built as unknown as Record<
						string,
						unknown
					>,
					content: [
						{
							type: "text",
							text: built.textSummary,
						},
					],
					_meta: withFabricApp("ui://fabric/visualize"),
				};
			} catch (err) {
				const message =
					err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Error: ${message}` }],
					isError: true,
				};
			}
		},
	);

	server.registerTool(
		"fabric_get_identity",
		{
			title: "Get Authenticated Fabric Identity & Organizations",
			description:
				"Return the currently signed-in Fabric user identity, active credential scopes, and organization memberships.",
			inputSchema: {},
			_meta: withFabricApp("ui://fabric/project-dashboard"),
		},
		async () => {
			if (!fabric.auth?.whoami) {
				return {
					content: [
						{
							type: "text",
							text: "Identity lookup requires an authenticated FabricClient (`fabric login`).",
						},
					],
					isError: true,
				};
			}
			const whoami = await fabric.auth.whoami();
			const payload = {
				title: "Authenticated Fabric Identity",
				...whoami,
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(whoami, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/project-dashboard"),
			};
		},
	);

	server.registerTool(
		"fabric_list_projects",
		{
			title: "List Fabric Projects",
			description:
				"List all Fabric projects accessible to the signed-in user in the active organization. Renders an interactive Fabric Projects MCP App card with 1-click Open in Fabric Desktop and ticket/artifact actions.",
			inputSchema: {
				status: z
					.enum(["DRAFT", "ACTIVE", "COMPLETED", "ARCHIVED"])
					.optional()
					.describe("Optional project status filter."),
				search: z
					.string()
					.optional()
					.describe(
						"Optional search query by project name or description.",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe("Maximum projects to return (default 50)."),
			},
			_meta: withFabricApp("ui://fabric/project-dashboard"),
		},
		async ({ status, search, limit }) => {
			if (!fabric.projects?.list) {
				return {
					content: [
						{
							type: "text",
							text: "Listing projects requires an authenticated FabricClient (`fabric login`).",
						},
					],
					isError: true,
				};
			}
			const projects = await fabric.projects.list({
				status,
				search,
				limit: limit ?? 50,
			});
			const payload = {
				title: "Your Fabric Projects",
				projects,
				total: projects.length,
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/project-dashboard"),
			};
		},
	);

	server.registerTool(
		"fabric_get_project",
		{
			title: "Get Fabric Project Details",
			description:
				"Get detailed metadata, feature/bug counts, and document summary for a specific Fabric project.",
			inputSchema: {
				projectId: z
					.string()
					.describe("Project ID from `fabric_list_projects`."),
			},
			_meta: withFabricApp("ui://fabric/project-dashboard"),
		},
		async ({ projectId }) => {
			if (!fabric.projects?.get) {
				return {
					content: [
						{
							type: "text",
							text: "Project lookup requires an authenticated FabricClient (`fabric login`).",
						},
					],
					isError: true,
				};
			}
			const project = (await fabric.projects.get(projectId)) as Record<
				string,
				unknown
			>;
			return {
				structuredContent: project,
				content: [
					{
						type: "text",
						text: JSON.stringify(project, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/project-dashboard"),
			};
		},
	);

	server.registerTool(
		"fabric_list_artifacts",
		{
			title: "List Fabric Artifacts, Frames, Workspaces & Documents",
			description:
				"List all Fabric artifacts (interactive HTML frames, workspaces, and project documents/specs) accessible to the signed-in user. Renders an interactive Fabric Artifacts & Workspaces MCP App card.",
			inputSchema: {
				projectId: z
					.string()
					.optional()
					.describe(
						"Optional project ID to filter artifacts and include project documents (PRDs, specs, architecture docs).",
					),
				surface: z
					.enum(["all", "artifact", "workspace", "document"])
					.optional()
					.describe(
						"Filter by artifact surface: 'artifact' (frames), 'workspace', 'document', or 'all' (default).",
					),
				search: z
					.string()
					.optional()
					.describe("Optional search query by title."),
			},
			_meta: withFabricApp("ui://fabric/project-dashboard"),
		},
		async ({ projectId, surface, search }) => {
			const effectiveSurface = surface ?? "all";
			const artifacts: Array<Record<string, unknown>> = [];

			if (
				(effectiveSurface === "all" ||
					effectiveSurface === "artifact" ||
					effectiveSurface === "workspace") &&
				fabric.frames?.list
			) {
				try {
					const frames = await fabric.frames.list(
						search ? { search } : {},
					);
					for (const rawFrame of frames) {
						const f = rawFrame as Record<string, unknown>;
						if (
							projectId &&
							f.projectId &&
							f.projectId !== projectId
						) {
							continue;
						}
						const frameSurface =
							typeof f.surface === "string"
								? f.surface
								: f.projectId
									? "artifact"
									: "workspace";
						if (
							effectiveSurface !== "all" &&
							frameSurface !== effectiveSurface
						) {
							continue;
						}
						artifacts.push({
							...f,
							surface: frameSurface,
						});
					}
				} catch {
					// Continue if frames endpoint is unavailable
				}
			}

			if (
				(effectiveSurface === "all" ||
					effectiveSurface === "workspace") &&
				fabric.workspaces?.list
			) {
				try {
					const workspaces = await fabric.workspaces.list();
					for (const rawWorkspace of workspaces) {
						const w = rawWorkspace as Record<string, unknown>;
						artifacts.push({
							...w,
							surface: "workspace",
							kind: w.kind ?? "WORKSPACE",
						});
					}
				} catch {
					// Continue if workspaces endpoint is unavailable
				}
			}

			if (
				projectId &&
				(effectiveSurface === "all" ||
					effectiveSurface === "document") &&
				fabric.projects?.listDocuments
			) {
				try {
					const docs = await fabric.projects.listDocuments(projectId);
					for (const rawDoc of docs) {
						const d = rawDoc as Record<string, unknown>;
						artifacts.push({
							...d,
							projectId,
							surface: "artifact",
							kind: d.type ?? "DOCUMENT",
						});
					}
				} catch {
					// Continue if documents endpoint is unavailable
				}
			}

			const filtered = search
				? artifacts.filter((a) =>
						String(a.title ?? a.name ?? "")
							.toLowerCase()
							.includes(search.toLowerCase()),
					)
				: artifacts;

			const payload = {
				title: "Fabric Artifacts & Workspaces",
				frames: filtered,
				total: filtered.length,
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/project-dashboard"),
			};
		},
	);

	server.registerTool(
		"fabric_get_artifact",
		{
			title: "Get Fabric Artifact, Frame, or Document Content",
			description:
				"Fetch the full content and metadata of a Fabric artifact (interactive HTML frame, workspace, or project document) by ID.",
			inputSchema: {
				artifactId: z
					.string()
					.describe("ID of the frame, workspace, or document."),
				kind: z
					.enum(["frame", "workspace", "document"])
					.optional()
					.describe(
						"Artifact kind hint ('frame' default, 'workspace', or 'document').",
					),
			},
			_meta: withFabricApp("ui://fabric/project-dashboard"),
		},
		async ({ artifactId, kind }) => {
			const effectiveKind = kind ?? "frame";
			let record: Record<string, unknown> | null = null;
			if (effectiveKind === "document" && fabric.projects?.getDocument) {
				record = (await fabric.projects.getDocument(
					artifactId,
				)) as Record<string, unknown>;
			} else if (
				effectiveKind === "workspace" &&
				fabric.workspaces?.get
			) {
				record = (await fabric.workspaces.get(artifactId)) as Record<
					string,
					unknown
				>;
			} else if (fabric.frames?.get) {
				record = (await fabric.frames.get(artifactId)) as Record<
					string,
					unknown
				>;
			}
			if (!record) {
				return {
					content: [
						{
							type: "text",
							text: `Artifact "${artifactId}" could not be loaded.`,
						},
					],
					isError: true,
				};
			}
			const payload = {
				title: String(record.title ?? record.name ?? artifactId),
				frames: [
					{
						...record,
						surface:
							record.surface ??
							(effectiveKind === "workspace"
								? "workspace"
								: "artifact"),
					},
				],
				artifact: record,
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(record, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/project-dashboard"),
			};
		},
	);

	server.registerTool(
		"fabric_list_tickets",
		{
			title: "List Fabric Tickets, Features & Bugs (Including Assigned to Me)",
			description:
				"List tickets (features and bugs) for a project or across all accessible projects, with optional `assignedToMe: true` filtering for tickets assigned to the signed-in user. Renders an interactive Fabric Tickets & Backlog MCP App card with 1-click Start in Fabric Desktop and Remote Agent Delegation.",
			inputSchema: {
				projectId: z
					.string()
					.optional()
					.describe(
						"Optional project ID. When omitted, aggregates tickets across your active projects.",
					),
				assignedToMe: z
					.boolean()
					.optional()
					.describe(
						"When true, filters to tickets assigned to the currently authenticated Fabric user.",
					),
				assigneeId: z
					.string()
					.optional()
					.describe("Optional explicit assignee user ID filter."),
				priority: z
					.enum(["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"])
					.optional()
					.describe("Optional priority filter."),
				kind: z
					.enum(["FEATURE", "BUG"])
					.optional()
					.describe(
						"Optional ticket kind filter ('FEATURE' or 'BUG').",
					),
			},
			_meta: withFabricApp("ui://fabric/agent-delegation"),
		},
		async ({ projectId, assignedToMe, assigneeId, priority, kind }) => {
			if (!fabric.projects?.listFeatures || !fabric.projects?.list) {
				return {
					content: [
						{
							type: "text",
							text: "Listing tickets requires an authenticated FabricClient (`fabric login`).",
						},
					],
					isError: true,
				};
			}
			let effectiveAssigneeId = assigneeId;
			if (assignedToMe && !effectiveAssigneeId && fabric.auth?.whoami) {
				try {
					const me = await fabric.auth.whoami();
					effectiveAssigneeId = me.user?.id ?? me.id;
				} catch {
					// Continue if whoami lookup fails
				}
			}

			const targetProjectIds: string[] = [];
			if (projectId) {
				targetProjectIds.push(projectId);
			} else {
				const projects = await fabric.projects.list({ limit: 10 });
				for (const p of projects) {
					if (p.id) {
						targetProjectIds.push(p.id);
					}
				}
			}

			const allTickets: Array<Record<string, unknown>> = [];
			for (const pid of targetProjectIds) {
				try {
					const items = await fabric.projects.listFeatures(pid, {
						...(priority ? { priority } : {}),
						...(effectiveAssigneeId
							? { assigneeId: effectiveAssigneeId }
							: {}),
					});
					for (const rawItem of items) {
						const item = rawItem as Record<string, unknown>;
						if (kind && item.kind && item.kind !== kind) {
							continue;
						}
						if (
							effectiveAssigneeId &&
							item.assigneeId &&
							item.assigneeId !== effectiveAssigneeId
						) {
							continue;
						}
						allTickets.push({
							...item,
							projectId: item.projectId ?? pid,
						});
					}
				} catch {
					// Skip inaccessible project
				}
			}

			const payload = {
				title: assignedToMe
					? "Tickets Assigned to You"
					: "Fabric Tickets & Backlog",
				features: allTickets,
				total: allTickets.length,
				assignedToMe: Boolean(assignedToMe),
			};
			return {
				structuredContent: payload,
				content: [
					{
						type: "text",
						text: JSON.stringify(payload, null, 2),
					},
				],
				_meta: withFabricApp("ui://fabric/agent-delegation"),
			};
		},
	);

	return server;
}
