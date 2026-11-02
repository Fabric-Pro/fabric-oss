import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	attachFabricMcpAppMeta,
	buildFabricVisualizePayload,
	executeWithDurableEnvelope,
	FABRIC_BRAND,
	FABRIC_MARK_DATA_URI,
	FABRIC_MCP_APP_RESOURCES,
	FABRIC_TOOL_UI_RESOURCE_MAP,
	isDurableMcpToolRequest,
	isStatelessMcpRequest,
	readFabricMcpAppResource,
} from "../mcp-apps";
import { authorizePlatformToolCall } from "../platform-tools";
import type { GatewaySession } from "../types";

function canonicalArgsHash(args: Record<string, unknown>): string {
	const canonicalize = (value: unknown): unknown =>
		Array.isArray(value)
			? value.map(canonicalize)
			: value && typeof value === "object"
				? Object.fromEntries(
						Object.entries(value as Record<string, unknown>)
							.sort(([left], [right]) =>
								left.localeCompare(right),
							)
							.map(([key, child]) => [key, canonicalize(child)]),
					)
				: value;
	const clean = canonicalize(
		Object.fromEntries(
			Object.entries(args).filter(
				([key]) => key !== "_durable" && key !== "_idempotencyKey",
			),
		),
	);
	return createHash("sha256").update(JSON.stringify(clean)).digest("hex");
}

function memoryDurableStore() {
	type Row = {
		id: string;
		argsHash: string;
		status: "RUNNING" | "COMPLETED" | "FAILED";
		result: Record<string, unknown> | null;
		startedAt: Date;
		completedAt: Date | null;
	};
	const rows = new Map<string, Row>();
	const rowKey = (input: {
		organizationId: string;
		userId: string;
		credentialKind?: string;
		credentialId?: string;
		projectBinding?: string | null;
		serverBinding?: string;
		toolName: string;
		idempotencyKey: string;
	}) =>
		[
			input.organizationId,
			input.userId,
			input.credentialKind,
			input.credentialId,
			input.projectBinding ?? "",
			input.serverBinding,
			input.toolName,
			input.idempotencyKey,
		].join("|");
	let sequence = 0;
	const seed = (
		status: Row["status"],
		organizationId: string,
		userId: string,
		toolName: string,
		idempotencyKey: string,
		args: Record<string, unknown>,
	) => {
		rows.set(
			rowKey({
				organizationId,
				userId,
				credentialKind: "ORGANIZATION_API_KEY",
				credentialId: "key-example-one",
				projectBinding: "project-example-one",
				serverBinding: "platform",
				toolName,
				idempotencyKey,
			}),
			{
				id: `execution-${++sequence}`,
				argsHash: canonicalArgsHash(args),
				status,
				result: null,
				startedAt: new Date(),
				completedAt: status === "RUNNING" ? null : new Date(),
			},
		);
	};
	const store = {
		claims: 0,
		async claim(input: {
			organizationId: string;
			userId: string;
			credentialKind?: string;
			credentialId?: string;
			projectBinding?: string | null;
			serverBinding?: string;
			toolName: string;
			idempotencyKey: string;
			argsHash: string;
		}) {
			store.claims += 1;
			const key = rowKey(input);
			const existing = rows.get(key);
			if (existing && existing.argsHash !== input.argsHash) {
				return { kind: "conflict" as const, call: existing };
			}
			if (existing?.status === "COMPLETED") {
				return { kind: "replay" as const, call: existing };
			}
			if (existing?.status === "RUNNING") {
				return { kind: "in_progress" as const, call: existing };
			}
			const call: Row = {
				id: existing?.id ?? `execution-${++sequence}`,
				argsHash: input.argsHash,
				status: "RUNNING",
				result: null,
				startedAt: new Date(),
				completedAt: null,
			};
			rows.set(key, call);
			return { kind: "claimed" as const, call };
		},
		async complete(input: {
			executionId: string;
			result: Record<string, unknown>;
			status: "COMPLETED" | "FAILED";
		}) {
			const row = [...rows.values()].find(
				(candidate) => candidate.id === input.executionId,
			);
			if (!row) {
				throw new Error("missing execution");
			}
			row.result = input.result;
			row.status = input.status;
			row.completedAt = new Date();
		},
		seedRunning(
			organizationId: string,
			userId: string,
			toolName: string,
			idempotencyKey: string,
			args: Record<string, unknown>,
		) {
			seed(
				"RUNNING",
				organizationId,
				userId,
				toolName,
				idempotencyKey,
				args,
			);
		},
		seedFailed(
			organizationId: string,
			userId: string,
			toolName: string,
			idempotencyKey: string,
			args: Record<string, unknown>,
		) {
			seed(
				"FAILED",
				organizationId,
				userId,
				toolName,
				idempotencyKey,
				args,
			);
		},
	};
	return store;
}

const allowed = async () => ({ ok: true as const, context: undefined });

const durableIdentity = {
	credentialKind: "ORGANIZATION_API_KEY",
	credentialId: "key-example-one",
	projectBinding: "project-example-one",
	serverBinding: "platform",
};

const durableDefaults = { identity: durableIdentity, authorize: allowed };

describe("MCP Apps, Stateless MCP & Durable Tool Execution", () => {
	it("exposes built-in ui://fabric/* MCP App resources with text/html;profile=mcp-app mimeType and Fabric + OpenAI widget CSP metadata", () => {
		expect(FABRIC_MCP_APP_RESOURCES.length).toBeGreaterThanOrEqual(5);
		for (const resource of FABRIC_MCP_APP_RESOURCES) {
			expect(resource.uri.startsWith("ui://fabric/")).toBe(true);
			expect(resource.mimeType).toBe("text/html;profile=mcp-app");
			expect(resource._meta?.ui?.csp).toBeDefined();
			expect(resource._meta?.["openai/widgetCSP"]).toBeDefined();
			expect(resource._meta?.["openai/widgetDomain"]).toBe(
				"https://fabric.pro",
			);
		}
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_project).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_features).toBe(
			"ui://fabric/agent-delegation",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_execute_workflow).toBe(
			"ui://fabric/workflow-visualizer",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_query_workspace).toBe(
			"ui://fabric/genie-insights",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_visualize).toBe(
			"ui://fabric/visualize",
		);
	});

	it("renders self-contained Fabric UI Kit MCP App HTML with the hash of every inline script in its CSP", () => {
		for (const resource of FABRIC_MCP_APP_RESOURCES) {
			const res = readFabricMcpAppResource(resource.uri);
			expect(res).not.toBeNull();
			expect(res?.contents).toHaveLength(1);
			const html = res?.contents[0]?.text ?? "";
			expect(res?.contents[0]?.mimeType).toBe(
				"text/html;profile=mcp-app",
			);
			expect(html).toContain('meta http-equiv="Content-Security-Policy"');
			const csp = html.match(
				/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/,
			)?.[1];
			const scripts = [
				...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
			].map((match) => match[1]);
			expect(csp).toBeDefined();
			expect(scripts.length).toBeGreaterThan(0);
			for (const script of scripts) {
				const hash = createHash("sha256")
					.update(script)
					.digest("base64");
				expect(csp).toContain(`'sha256-${hash}'`);
			}
			expect(html).toContain('meta name="ui-kit"');
			expect(html).toContain(FABRIC_BRAND.accent.light);
			expect(html).toContain(FABRIC_BRAND.accent.dark);
			expect(html).toContain(FABRIC_MARK_DATA_URI);
			expect(html).toContain("ui/initialize");
			expect(html).toContain("tools/call");
			expect(html).toContain("fabricagents://action/new-chat");
		}

		expect(readFabricMcpAppResource("ui://unknown/app")).toBeNull();
	});

	it("does not render invented Temporal, workflow-step, or harness status", () => {
		const delegation = readFabricMcpAppResource(
			"ui://fabric/agent-delegation",
		)?.contents[0]?.text;
		const workflows = readFabricMcpAppResource(
			"ui://fabric/workflow-visualizer",
		)?.contents[0]?.text;
		expect(delegation).not.toContain("Durable Temporal Envelope");
		expect(delegation).not.toContain("Subscription OAuth · Primary");
		expect(delegation).not.toContain("Subscription Credits Active");
		expect(delegation).toContain("Stored Durable Call");
		expect(workflows).not.toContain(
			"Tenant-isolated input verified in Temporal activity",
		);
		expect(workflows).not.toContain(
			"Persisted with deterministic replay history",
		);
		expect(workflows).toContain("No workflow steps returned");
	});

	it("validates A2UI v0.9.1 documents for ui://fabric/visualize using the Fabric A2UI catalog", () => {
		const payload = buildFabricVisualizePayload({
			title: "Databricks vs Snowflake Lakehouse Comparison",
			document: [
				{
					version: "v0.9",
					createSurface: {
						surfaceId: "main",
						catalogId:
							"https://agents.fabric.pro/a2ui/v0.9/fabric_catalog.json",
					},
				},
				{
					version: "v0.9",
					updateComponents: {
						surfaceId: "main",
						components: [
							{
								id: "root",
								component: "Column",
								children: ["h1", "stat1"],
							},
							{
								id: "h1",
								component: "Text",
								variant: "h2",
								text: "Lakehouse Throughput",
							},
							{
								id: "stat1",
								component: "Stat",
								label: "Latency Reduction",
								value: "3.4x",
							},
						],
					},
				},
			],
			sources: ["https://fabric.pro/docs"],
		});

		expect(payload.title).toBe(
			"Databricks vs Snowflake Lakehouse Comparison",
		);
		expect(payload.surfaces).toHaveLength(1);
		expect(payload.surfaces[0]?.surfaceId).toBe("main");
		expect(payload.textSummary).toContain("Lakehouse Throughput");
		expect(payload.textSummary).toContain("3.4x");
	});

	it("detects stateless MCP requests from X-Mcp-Stateless header or stateless query parameter", () => {
		const reqHeader = new Request(
			"https://app.example.com/api/mcp-gateway",
			{
				method: "POST",
				headers: { "X-Mcp-Stateless": "true" },
			},
		);
		expect(isStatelessMcpRequest(reqHeader)).toBe(true);

		const reqQuery = new Request(
			"https://app.example.com/api/mcp-gateway?stateless=1",
			{ method: "POST" },
		);
		expect(isStatelessMcpRequest(reqQuery)).toBe(true);

		const reqNormal = new Request(
			"https://app.example.com/api/mcp-gateway",
			{
				method: "POST",
			},
		);
		expect(isStatelessMcpRequest(reqNormal)).toBe(false);
	});

	it("detects every durable request and idempotency-key form", async () => {
		const reqDurable = new Request(
			"https://app.example.com/api/mcp-gateway",
			{
				method: "POST",
				headers: { "X-Mcp-Durable": "true" },
			},
		);
		expect(isDurableMcpToolRequest(reqDurable)).toBe(true);
		expect(
			isDurableMcpToolRequest(null, { _meta: { durable: true } }),
		).toBe(true);
		expect(isDurableMcpToolRequest(null, {}, { _durable: true })).toBe(
			true,
		);
	});

	it("reads idempotency keys from the header, RPC metadata, and tool arguments in that order", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		const cases = [
			{
				request: new Request(
					"https://app.example.com/api/mcp-gateway",
					{
						headers: { "X-Mcp-Idempotency-Key": "header-key" },
					},
				),
				rpcParams: { _meta: { idempotencyKey: "meta-key" } },
				toolArgs: { _idempotencyKey: "argument-key" },
				expected: "header-key",
			},
			{
				rpcParams: { _meta: { idempotencyKey: "meta-key" } },
				toolArgs: { _idempotencyKey: "argument-key" },
				expected: "meta-key",
			},
			{
				toolArgs: { _idempotencyKey: "argument-key" },
				expected: "argument-key",
			},
		] as const;
		for (const [index, testCase] of cases.entries()) {
			const result = await executeWithDurableEnvelope({
				...durableDefaults,
				toolName: `example_tool_${index}`,
				toolArgs: testCase.toolArgs,
				organizationId: "org-example",
				userId: "user-example",
				request: "request" in testCase ? testCase.request : undefined,
				rpcParams:
					"rpcParams" in testCase ? testCase.rpcParams : undefined,
				execute,
				store: memoryDurableStore(),
			});
			expect(result._meta?.durableExecution?.idempotencyKey).toBe(
				testCase.expected,
			);
		}
	});

	it("stores the first keyed call and replays it without executing again", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text", text: '{"id":"proj_123"}' }],
		}));
		const store = memoryDurableStore();

		const first = await executeWithDurableEnvelope({
			toolName: "fabric_get_project",
			toolArgs: { projectId: "proj_123", b: { z: 2, a: 1 }, a: 1 },
			organizationId: "org_example_1",
			userId: "user_1",
			idempotencyKey: "idem_abc123",
			identity: durableIdentity,
			authorize: allowed,
			execute,
			store,
		});
		const replay = await executeWithDurableEnvelope({
			toolName: "fabric_get_project",
			toolArgs: { a: 1, projectId: "proj_123", b: { a: 1, z: 2 } },
			organizationId: "org_example_1",
			userId: "user_1",
			idempotencyKey: "idem_abc123",
			identity: durableIdentity,
			authorize: allowed,
			execute,
			store,
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(replay.content).toEqual(first.content);
		expect(first._meta?.durableExecution).toMatchObject({
			durable: true,
			engine: "fabric-idempotency-store",
			executionId: expect.any(String),
			idempotencyKey: "idem_abc123",
			status: "COMPLETED",
			replayed: false,
			deduplicated: true,
			stored: true,
		});
		expect(replay._meta?.durableExecution).toMatchObject({
			replayed: true,
			deduplicated: true,
			stored: true,
		});
		expect(first._meta?.ui).toEqual({
			resourceUri: "ui://fabric/project-dashboard",
		});
		expect(first._meta?.["ui/resourceUri"]).toBe(
			"ui://fabric/project-dashboard",
		);
	});

	it.each([
		["credential kind", { credentialKind: "oauth-client" }],
		["credential identity", { credentialId: "key-example-two" }],
		["project binding", { projectBinding: "project-example-two" }],
		["server binding", { serverBinding: "config-example-two" }],
	] as const)(
		"does not replay across a different %s",
		async (_label, identityChange) => {
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "fresh" }],
			}));
			const store = memoryDurableStore();
			const common = {
				toolName: "search",
				toolArgs: { query: "example" },
				organizationId: "org-example",
				userId: "user-example",
				idempotencyKey: "same-key",
				authorize: allowed,
				execute,
				store,
			};

			await executeWithDurableEnvelope({
				...common,
				identity: durableIdentity,
			});
			const second = await executeWithDurableEnvelope({
				...common,
				identity: { ...durableIdentity, ...identityChange },
			});

			expect(execute).toHaveBeenCalledTimes(2);
			expect(second._meta?.durableExecution?.replayed).toBe(false);
		},
	);

	it("authorizes before the first claim and before returning a completed receipt", async () => {
		const order: string[] = [];
		let allowedNow = true;
		const authorize = vi.fn(async () => {
			order.push("authorize");
			return allowedNow
				? { ok: true as const, context: undefined }
				: {
						ok: false as const,
						result: {
							isError: true,
							content: [
								{
									type: "text" as const,
									text: "scope was reduced",
								},
							],
						},
					};
		});
		const execute = vi.fn(async () => {
			order.push("execute");
			return { content: [{ type: "text" as const, text: "secret" }] };
		});
		const store = memoryDurableStore();
		const originalClaim = store.claim.bind(store);
		store.claim = async (input) => {
			order.push("claim");
			return originalClaim(input);
		};
		const common = {
			toolName: "search",
			toolArgs: { query: "example" },
			organizationId: "org-example",
			userId: "user-example",
			idempotencyKey: "scope-key",
			identity: durableIdentity,
			authorize,
			execute,
			replayAllowed: false,
			store,
		};

		await executeWithDurableEnvelope(common);
		expect(order).toEqual(["authorize", "claim", "execute"]);

		order.length = 0;
		allowedNow = false;
		const replayAttempt = await executeWithDurableEnvelope(common);

		expect(order).toEqual(["authorize"]);
		expect(replayAttempt.isError).toBe(true);
		expect(JSON.stringify(replayAttempt.content)).toContain(
			"scope was reduced",
		);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("refuses a replay when the same credential is now bound to another project", async () => {
		const store = memoryDurableStore();
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "project one" }],
		}));
		const session = (projectId: string): GatewaySession => ({
			sessionId: `session-${projectId}`,
			userId: "user-example",
			organizationId: "org-example",
			projectId,
			userName: "Example",
			email: "dev@example.com",
			role: "user",
			credential: "organization-key",
			credentialId: "key-example-one",
			scopes: ["projects:read"],
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
		});
		const common = {
			toolName: "fabric_get_project",
			toolArgs: { projectId: "project-example-one" },
			organizationId: "org-example",
			userId: "user-example",
			idempotencyKey: "project-key",
			execute,
			store,
		};

		await executeWithDurableEnvelope({
			...common,
			identity: durableIdentity,
			authorize: async () =>
				authorizePlatformToolCall(
					common.toolName,
					common.toolArgs,
					session("project-example-one"),
				),
		});
		const refused = await executeWithDurableEnvelope({
			...common,
			identity: {
				...durableIdentity,
				projectBinding: "project-example-two",
			},
			authorize: async () =>
				authorizePlatformToolCall(
					common.toolName,
					common.toolArgs,
					session("project-example-two"),
				),
		});

		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain(
			"Project not found or access denied",
		);
		expect(store.claims).toBe(1);
		expect(execute).toHaveBeenCalledOnce();
	});

	it("refuses a replay after the credential loses the required scope", async () => {
		const store = memoryDurableStore();
		const execute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: "project" }],
		}));
		const session = (scopes: string[]): GatewaySession => ({
			sessionId: "session-example",
			userId: "user-example",
			organizationId: "org-example",
			userName: "Example",
			email: "dev@example.com",
			role: "user",
			credential: "organization-key",
			credentialId: "key-example-one",
			scopes,
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
		});
		const common = {
			toolName: "fabric_get_project",
			toolArgs: { projectId: "project-example-one" },
			organizationId: "org-example",
			userId: "user-example",
			idempotencyKey: "scope-key",
			identity: durableIdentity,
			execute,
			store,
		};

		await executeWithDurableEnvelope({
			...common,
			authorize: async () =>
				authorizePlatformToolCall(
					common.toolName,
					common.toolArgs,
					session(["projects:read"]),
				),
		});
		const refused = await executeWithDurableEnvelope({
			...common,
			authorize: async () =>
				authorizePlatformToolCall(
					common.toolName,
					common.toolArgs,
					session([]),
				),
		});

		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain("projects:read");
		expect(store.claims).toBe(1);
		expect(execute).toHaveBeenCalledOnce();
	});

	it("marks a thrown execution failed so the same key retries immediately", async () => {
		const store = memoryDurableStore();
		const execute = vi
			.fn<
				() => Promise<{
					content: Array<{ type: "text"; text: string }>;
				}>
			>()
			.mockRejectedValueOnce(new Error("example network timeout"))
			.mockResolvedValueOnce({
				content: [{ type: "text", text: "retried" }],
			});
		const options = {
			toolName: "search",
			toolArgs: { query: "example" },
			organizationId: "org-example",
			userId: "user-example",
			idempotencyKey: "throw-key",
			identity: durableIdentity,
			authorize: allowed,
			execute,
			store,
		};

		await expect(executeWithDurableEnvelope(options)).rejects.toThrow(
			"example network timeout",
		);
		const retried = await executeWithDurableEnvelope(options);

		expect(execute).toHaveBeenCalledTimes(2);
		expect(retried.content).toEqual([{ type: "text", text: "retried" }]);
	});

	it("returns a receipt without executing when a completed result cannot be replayed", async () => {
		const store = memoryDurableStore();
		const execute = vi.fn(async () => ({
			content: [
				{
					type: "text" as const,
					text: "stored result that must be withheld",
				},
			],
		}));
		const options = {
			toolName: "configured__search",
			toolArgs: { query: "example" },
			organizationId: "org-example",
			userId: "user-example",
			idempotencyKey: "unsafe-replay-key",
			identity: durableIdentity,
			authorize: allowed,
			execute,
			replayAllowed: false,
			store,
		};

		const first = await executeWithDurableEnvelope(options);
		const second = await executeWithDurableEnvelope(options);

		expect(execute).toHaveBeenCalledOnce();
		expect(store.claims).toBe(2);
		expect(first._meta?.durableExecution).toMatchObject({
			status: "COMPLETED",
			deduplicated: true,
			stored: true,
		});
		expect(second.isError).not.toBe(true);
		expect(JSON.stringify(second.content)).toContain("already completed");
		expect(JSON.stringify(second.content)).toContain("Status: COMPLETED");
		expect(JSON.stringify(second.content)).toContain(
			"matching get/list tool",
		);
		expect(JSON.stringify(second.content)).not.toContain(
			"stored result that must be withheld",
		);
		expect(second._meta?.durableExecution).toMatchObject({
			executionId: expect.any(String),
			status: "COMPLETED",
			replayed: false,
			deduplicated: true,
			stored: true,
			resultWithheld: true,
			completedAt: expect.any(String),
		});
	});

	it("refuses key reuse with different arguments and a live RUNNING claim", async () => {
		const store = memoryDurableStore();
		const execute = vi.fn(async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		await executeWithDurableEnvelope({
			...durableDefaults,
			toolName: "fabric_get_project",
			toolArgs: { projectId: "one" },
			organizationId: "org-1",
			userId: "user-1",
			idempotencyKey: "same-key",
			execute,
			store,
		});
		const conflict = await executeWithDurableEnvelope({
			...durableDefaults,
			toolName: "fabric_get_project",
			toolArgs: { projectId: "two" },
			organizationId: "org-1",
			userId: "user-1",
			idempotencyKey: "same-key",
			execute,
			store,
		});
		store.seedRunning("org-1", "user-1", "fabric_get_project", "busy", {
			projectId: "one",
		});
		const running = await executeWithDurableEnvelope({
			...durableDefaults,
			toolName: "fabric_get_project",
			toolArgs: { projectId: "one" },
			organizationId: "org-1",
			userId: "user-1",
			idempotencyKey: "busy",
			execute,
			store,
		});

		expect(conflict.isError).toBe(true);
		expect(JSON.stringify(conflict.content)).toContain(
			"different arguments",
		);
		expect(running.isError).toBe(true);
		expect(JSON.stringify(running._meta)).toContain("retryable");
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it("reclaims FAILED calls while isolating the same key by user and organization", async () => {
		const store = memoryDurableStore();
		store.seedFailed("org-1", "user-1", "fabric_get_project", "retry", {
			projectId: "one",
		});
		const execute = vi.fn(async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		for (const [organizationId, userId] of [
			["org-1", "user-1"],
			["org-1", "user-2"],
			["org-2", "user-1"],
		] as const) {
			const result = await executeWithDurableEnvelope({
				...durableDefaults,
				toolName: "fabric_get_project",
				toolArgs: { projectId: "one" },
				organizationId,
				userId,
				idempotencyKey: "retry",
				execute,
				store,
			});
			expect(result.isError).not.toBe(true);
		}
		expect(execute).toHaveBeenCalledTimes(3);
	});

	it("refuses durable mode without an organization and runs without dedupe when no key is explicit", async () => {
		const execute = vi.fn(async () => ({
			content: [{ type: "text", text: "ok" }],
		}));
		const store = memoryDurableStore();
		const noOrganization = await executeWithDurableEnvelope({
			...durableDefaults,
			toolName: "fabric_get_project",
			toolArgs: {},
			organizationId: null,
			userId: "user-1",
			execute,
			store,
		});
		const noKey = await executeWithDurableEnvelope({
			...durableDefaults,
			toolName: "fabric_get_project",
			toolArgs: {},
			organizationId: "org-1",
			userId: "user-1",
			execute,
			store,
		});

		expect(noOrganization.isError).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(noKey._meta?.durableExecution).toMatchObject({
			deduplicated: false,
			reason: "no_idempotency_key",
			replayed: false,
			stored: false,
		});
		expect(store.claims).toBe(0);
	});

	it("maps projects, artifacts/frames/workspaces, and assigned tickets/features to rich MCP App views and attaches UI metadata on non-durable calls", () => {
		// Projects & Artifacts
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_projects).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_frames).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_frame).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_workspaces).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_workspace).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_artifacts).toBe(
			"ui://fabric/project-dashboard",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_artifact).toBe(
			"ui://fabric/project-dashboard",
		);

		// Tickets / Features / Assigned Backlog
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_features).toBe(
			"ui://fabric/agent-delegation",
		);
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_get_feature).toBe(
			"ui://fabric/agent-delegation",
		);
		expect(
			FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_project_pm_assigned_items,
		).toBe("ui://fabric/agent-delegation");
		expect(FABRIC_TOOL_UI_RESOURCE_MAP.fabric_list_tickets).toBe(
			"ui://fabric/agent-delegation",
		);

		// Standard (non-durable) tool calls receive _meta.ui.resourceUri
		const attached = attachFabricMcpAppMeta("fabric_list_frames", {
			content: [{ type: "text", text: '{"frames":[]}' }],
		});
		expect(attached._meta?.ui).toEqual({
			resourceUri: "ui://fabric/project-dashboard",
		});
		expect(attached._meta?.["ui/resourceUri"]).toBe(
			"ui://fabric/project-dashboard",
		);

		// Verify project-dashboard view renders both Projects and Artifacts & Workspaces cards
		const projectDashboardHtml =
			readFabricMcpAppResource("ui://fabric/project-dashboard")
				?.contents[0]?.text ?? "";
		expect(projectDashboardHtml).toContain("FABRIC ARTIFACTS & WORKSPACES");
		expect(projectDashboardHtml).toContain("Open Artifact in Portal");
		expect(projectDashboardHtml).toContain("My Assigned Tickets");

		// Verify agent-delegation view renders Tickets & Backlog card with Desktop/Remote delegation actions
		const delegationHtml =
			readFabricMcpAppResource("ui://fabric/agent-delegation")
				?.contents[0]?.text ?? "";
		expect(delegationHtml).toContain("FABRIC TICKETS & BACKLOG");
		expect(delegationHtml).toContain("Tickets Assigned to You");
		expect(delegationHtml).toContain("Start Ticket in Fabric Desktop");
		expect(delegationHtml).toContain("Delegate Ticket to Remote Server");
	});
});
