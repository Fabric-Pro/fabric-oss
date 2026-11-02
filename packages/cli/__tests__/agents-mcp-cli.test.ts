import { createFabricMcpServer } from "@fabricorg/sdk-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentsCommand } from "../src/commands/agents/index.js";
import { buildMcpCommand } from "../src/commands/mcp/index.js";
import { printOutput, shouldDisableColor } from "../src/lib/output.js";

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

	it("registers authenticated MCP tools for projects, artifacts, and assigned tickets with MCP App card metadata in @fabricorg/sdk-mcp", () => {
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
	});
});
