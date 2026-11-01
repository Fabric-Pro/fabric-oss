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
		version: options.version ?? "0.1.16",
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
			if (projectSlug) query.set("workspace", projectSlug);
			if (projectId) query.set("projectId", projectId);
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
					.describe("Card heading shown at the top of the Fabric view."),
				document: z
					.union([z.string(), z.array(z.record(z.string(), z.unknown()))])
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

	return server;
}
