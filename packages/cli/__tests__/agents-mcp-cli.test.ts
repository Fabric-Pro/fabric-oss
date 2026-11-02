import { createFabricMcpServer } from "@fabricorg/sdk-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sdkMcpPackage from "../../sdk-mcp/package.json";
import { buildAgentsCommand } from "../src/commands/agents/index.js";
import {
	buildMcpCommand,
	resolveMcpOrganizationId,
} from "../src/commands/mcp/index.js";
import { saveApiKey, saveOAuth } from "../src/lib/config.js";
import { printOutput, shouldDisableColor } from "../src/lib/output.js";

const originalApiKey = process.env.FABRIC_API_KEY;
const originalBaseUrl = process.env.FABRIC_BASE_URL;
const originalFormat = process.env.FABRIC_FORMAT;

describe("CLI clig.dev compliance, Agent Delegation & MCP commands", () => {
	let stdoutChunks: string[] = [];

	beforeEach(() => {
		stdoutChunks = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			stdoutChunks.push(String(chunk));
			return true;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const [name, value] of [
			["FABRIC_API_KEY", originalApiKey],
			["FABRIC_BASE_URL", originalBaseUrl],
			["FABRIC_FORMAT", originalFormat],
		] as const) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	});

	it("honors NO_COLOR, FABRIC_NO_COLOR, TERM=dumb, and non-TTY stdout per clig.dev", () => {
		expect(shouldDisableColor({}, true)).toBe(false);
		expect(shouldDisableColor({}, false)).toBe(true);
		expect(shouldDisableColor({ NO_COLOR: "1" }, true)).toBe(true);
		expect(shouldDisableColor({ FABRIC_NO_COLOR: "true" }, true)).toBe(
			true,
		);
		expect(shouldDisableColor({ TERM: "dumb" }, true)).toBe(true);
	});

	it("formats plain tab-separated output and quiet ID-only output cleanly for piping", () => {
		printOutput(
			[
				{ id: "claude-max", status: "active" },
				{ id: "codex", status: "active" },
			],
			{ format: "plain", columns: ["id", "status"] },
		);
		expect(stdoutChunks.join("")).toBe(
			"claude-max\tactive\ncodex\tactive\n",
		);

		stdoutChunks = [];
		printOutput(
			[
				{ id: "claude-max", status: "active" },
				{ id: "codex", status: "active" },
			],
			{ format: "quiet", idKey: "id" },
		);
		expect(stdoutChunks.join("")).toBe("claude-max\ncodex\n");
	});

	it("delegates coding tasks to Remote Fabric Agents Server and Fabric Desktop via `fabric agents delegate`", async () => {
		const cmd = buildAgentsCommand();
		await cmd.parseAsync([
			"node",
			"fabric",
			"delegate",
			"--target",
			"remote",
			"--server-url",
			"https://agents.example.com",
			"--harness",
			"claude-max",
			"--fallback",
			"subscription_harnesses",
			"--project-slug",
			"payments-v2",
			"--prompt",
			"Implement OAuth callback",
			"--durable",
			"--format",
			"json",
		]);

		const output = JSON.parse(stdoutChunks.join(""));
		expect(output.target).toBe("remote");
		expect(output.harness).toBe("claude-max");
		expect(output.fallbackPolicy).toBe("subscription_harnesses");
		expect(output.billingMode).toBe("subscription_tokens");
		expect(output.durable).toBe(true);
		expect(output.remoteDelegationUrl).toContain(
			"https://agents.example.com/?",
		);
		expect(output.desktopDeepLink).toContain(
			"fabricagents://action/new-chat?",
		);
	});

	it("generates Fabric Desktop deep links via `fabric agents desktop -q`", async () => {
		const cmd = buildAgentsCommand();
		await cmd.parseAsync([
			"node",
			"fabric",
			"desktop",
			"--project-slug",
			"payments-v2",
			"--view",
			"allSessions",
			"-q",
		]);

		expect(stdoutChunks.join("").trim()).toBe(
			"fabricagents://allSessions?workspace=payments-v2",
		);
	});

	it("lists subscription harnesses via `fabric agents subscriptions`", async () => {
		const cmd = buildAgentsCommand();
		await cmd.parseAsync([
			"node",
			"fabric",
			"subscriptions",
			"--format",
			"json",
		]);

		const harnesses = JSON.parse(stdoutChunks.join(""));
		expect(harnesses.map((h: { id: string }) => h.id)).toEqual([
			"claude-max",
			"codex",
			"droid-cli",
			"grok-cli",
			"kimi-cli",
		]);
	});

	it("lists built-in MCP Apps (`ui://fabric/*`) via `fabric mcp apps`", async () => {
		const cmd = buildMcpCommand();
		await cmd.parseAsync(["node", "fabric", "apps", "-q"]);

		const uris = stdoutChunks.join("").trim().split("\n");
		expect(uris).toContain("ui://fabric/project-dashboard");
		expect(uris).toContain("ui://fabric/agent-delegation");
		expect(uris).toContain("ui://fabric/workflow-visualizer");
		expect(uris).toContain("ui://fabric/genie-insights");
	});

	it("uses authenticated fetch, URL-encodes project IDs, and supports --no-stateless", async () => {
		process.env.FABRIC_API_KEY = "fab_example_cli_key";
		process.env.FABRIC_BASE_URL = "https://app.example.com";
		const fetchMock = vi.fn(async () =>
			Response.json({
				result: { tools: [{ name: "fabric_get_identity" }] },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await buildMcpCommand().parseAsync([
			"node",
			"fabric",
			"tools",
			"--project",
			"project/example one",
			"--no-stateless",
			"--format",
			"json",
		]);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(url).toContain(
			"/api/mcp-gateway/projects/project%2Fexample%20one",
		);
		expect(url).not.toContain("stateless=1");
		const headers = new Headers(init.headers);
		expect(headers.get("authorization")).toBe("Bearer fab_example_cli_key");
		expect(headers.has("x-mcp-stateless")).toBe(false);
	});

	it("sends every documented durable key form to the gateway", async () => {
		process.env.FABRIC_API_KEY = "fab_example_cli_key";
		process.env.FABRIC_BASE_URL = "https://app.example.com";
		const fetchMock = vi.fn(async () =>
			Response.json({
				result: { content: [{ type: "text", text: "ok" }] },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await buildMcpCommand().parseAsync([
			"node",
			"fabric",
			"call",
			"fabric_get_identity",
			"--durable",
			"--idempotency-key",
			"example-call-key",
			"--input",
			'{"_idempotencyKey":"example-argument-key"}',
			"--format",
			"json",
		]);

		const [, init] = fetchMock.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		const headers = new Headers(init.headers);
		expect(headers.get("x-mcp-durable")).toBe("true");
		expect(headers.get("x-mcp-idempotency-key")).toBe("example-call-key");
		const body = JSON.parse(String(init.body));
		expect(body.params._meta).toEqual({
			durable: true,
			idempotencyKey: "example-call-key",
		});
		expect(body.params.arguments._idempotencyKey).toBe(
			"example-argument-key",
		);
	});

	it.each([
		[
			"tools",
			["tools", "--project", "project-example", "--format", "json"],
		],
		[
			"call",
			[
				"call",
				"fabric_get_project",
				"--project",
				"project-example",
				"--format",
				"json",
			],
		],
	] as const)(
		"refuses a project browser sign-in before an MCP %s request or refresh",
		async (_command, commandArgs) => {
			delete process.env.FABRIC_API_KEY;
			process.env.FABRIC_BASE_URL = "https://app.example.com";
			saveOAuth(
				{
					issuer: "https://app.example.com",
					clientId: "example-client",
					redirectUri: "http://127.0.0.1:49152/callback",
					tokenEndpoint:
						"https://app.example.com/api/auth/oauth2/token",
					accessToken: "fat_example_project",
					refreshToken: "frt_example_project",
					expiresAt: Date.now() + 60 * 60 * 1000,
				},
				{
					baseUrl: "https://app.example.com",
					projectId: "project-example",
				},
			);
			const fetchMock = vi.fn(async () =>
				Response.json({
					result: { tools: [{ name: "fabric_get_project" }] },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			const stderr: string[] = [];
			vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
				stderr.push(String(chunk));
				return true;
			});
			vi.spyOn(process, "exit").mockImplementation((code) => {
				throw new Error(`exit:${code}`);
			});

			await expect(
				buildMcpCommand().parseAsync([
					"node",
					"fabric",
					...commandArgs,
				]),
			).rejects.toThrow("exit:3");

			expect(stderr.join("")).toContain("Set FABRIC_API_KEY");
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		["tools", ["tools", "--format", "json"]],
		["call", ["call", "fabric_get_project", "--format", "json"]],
	] as const)(
		"uses a stored API key for MCP %s even when the project has a browser sign-in",
		async (_command, commandArgs) => {
			delete process.env.FABRIC_API_KEY;
			const baseUrl = "https://mcp-key.example.com";
			process.env.FABRIC_BASE_URL = baseUrl;
			saveApiKey("fab_example_stored_key", { baseUrl });
			saveOAuth(
				{
					issuer: baseUrl,
					clientId: "example-client",
					redirectUri: "http://127.0.0.1:49152/callback",
					tokenEndpoint: `${baseUrl}/api/auth/oauth2/token`,
					accessToken: "fat_example_project",
					refreshToken: "frt_example_project",
					expiresAt: Date.now() + 60 * 60 * 1000,
				},
				{ baseUrl, projectId: "project-example" },
			);
			const fetchMock = vi.fn(async () =>
				Response.json({
					result:
						_command === "tools"
							? { tools: [{ name: "fabric_get_project" }] }
							: { content: [{ type: "text", text: "ok" }] },
				}),
			);
			vi.stubGlobal("fetch", fetchMock);

			await buildMcpCommand().parseAsync([
				"node",
				"fabric",
				...commandArgs,
				"--project",
				"project-example",
			]);

			expect(fetchMock).toHaveBeenCalledOnce();
			const [, init] = fetchMock.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(new Headers(init.headers).get("authorization")).toBe(
				"Bearer fab_example_stored_key",
			);
		},
	);

	it("resolves --org slugs to IDs before building the gateway header", async () => {
		const orgs = {
			list: vi.fn(async () => [
				{ id: "org_example", slug: "example-org" },
			]),
		};
		expect(
			await resolveMcpOrganizationId("example-org", { orgs } as never),
		).toBe("org_example");
		expect(
			await resolveMcpOrganizationId("org_example", { orgs } as never),
		).toBe("org_example");
	});

	it("honors FABRIC_FORMAT when agents and MCP commands omit --format", async () => {
		process.env.FABRIC_FORMAT = "json";
		await buildAgentsCommand().parseAsync([
			"node",
			"fabric",
			"delegate",
			"--prompt",
			"Example task",
		]);
		expect(JSON.parse(stdoutChunks.join(""))).toMatchObject({
			status: "link_created",
		});

		stdoutChunks = [];
		await buildMcpCommand().parseAsync(["node", "fabric", "apps"]);
		expect(JSON.parse(stdoutChunks.join(""))).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					uri: "ui://fabric/project-dashboard",
				}),
			]),
		);
	});

	it("registers truthful SDK metadata and uses the sdk-mcp package version", async () => {
		const mcpServer = createFabricMcpServer({
			fabric: {
				integrations: {
					list: async () => [],
				},
				auth: {
					whoami: async () => ({
						user: {
							id: "user_1",
							name: "Example Dev",
							email: "dev@example.com",
						},
						organizations: [{ id: "org_1", name: "Example Org" }],
					}),
				},
				projects: {
					list: async () => [
						{
							id: "proj_1",
							name: "Core Platform",
							slug: "core-platform",
							status: "ACTIVE",
						},
					],
					get: async (id) => ({ id, name: "Core Platform" }),
					listFeatures: async () => [
						{
							id: "feat_1",
							identifier: "FAB-101",
							title: "Implement OAuth 2.1 PKCE",
							kind: "FEATURE",
							priority: "P1_HIGH",
							assigneeId: "user_1",
						},
					],
				},
				frames: {
					list: async () => [
						{
							id: "frame_1",
							title: "Architecture Diagram",
							surface: "artifact",
							kind: "HTML",
						},
					],
					get: async (id) => ({
						id,
						title: "Architecture Diagram",
						surface: "artifact",
					}),
				},
				workspaces: {
					list: async () => [
						{
							id: "ws_1",
							name: "Engineering Knowledge Base",
						},
					],
					get: async (id) => ({
						id,
						name: "Engineering Knowledge Base",
					}),
				},
			},
		});

		const registeredTools = (
			mcpServer as unknown as {
				_registeredTools: Record<
					string,
					{ _meta?: Record<string, unknown> }
				>;
			}
		)._registeredTools;

		expect(registeredTools.fabric_get_identity?._meta).toMatchObject({
			ui: { resourceUri: "ui://fabric/project-dashboard" },
		});
		expect(registeredTools.fabric_list_projects?._meta).toMatchObject({
			ui: { resourceUri: "ui://fabric/project-dashboard" },
		});
		expect(registeredTools.fabric_list_artifacts?._meta).toMatchObject({
			ui: { resourceUri: "ui://fabric/project-dashboard" },
		});
		expect(registeredTools.fabric_get_artifact?._meta).toMatchObject({
			ui: { resourceUri: "ui://fabric/project-dashboard" },
		});
		expect(registeredTools.fabric_list_tickets?._meta).toMatchObject({
			ui: { resourceUri: "ui://fabric/agent-delegation" },
		});
		expect(
			(
				mcpServer as unknown as {
					server: { _serverInfo: { version: string } };
				}
			).server._serverInfo.version,
		).toBe(sdkMcpPackage.version);

		const toolsWithHandlers = registeredTools as Record<
			string,
			{
				handler: (
					args: Record<string, unknown>,
					extra: Record<string, unknown>,
				) => Promise<{ structuredContent?: Record<string, unknown> }>;
			}
		>;
		const delegation =
			await toolsWithHandlers.fabric_delegate_agent.handler(
				{ target: "remote", prompt: "Example task", durable: true },
				{},
			);
		expect(delegation.structuredContent).toMatchObject({
			status: "link_created",
			durableRequested: true,
			durableExecution: {
				durable: false,
				deduplicated: false,
				stored: false,
			},
		});
		expect(delegation.structuredContent?.desktopDeepLink).toContain(
			"durable=true",
		);
		const subscription =
			await toolsWithHandlers.fabric_subscription_status.handler({}, {});
		expect(subscription.structuredContent).toMatchObject({
			status: "not_checked",
			harnesses: expect.arrayContaining([
				expect.objectContaining({
					status: "unknown",
					auth: "not_checked",
				}),
			]),
		});
	});
});
