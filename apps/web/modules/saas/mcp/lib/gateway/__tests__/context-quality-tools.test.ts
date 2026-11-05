import { createHash } from "node:crypto";
import {
	contextQualityIdSchema,
	projectContextEvaluationSchema,
} from "@repo/api/modules/context-quality/contracts";
import { ContextReadError } from "@repo/api/modules/context-quality/lib/context-reader";
import {
	createSavedEvaluationSchema,
	savedEvaluationListSchema,
} from "@repo/api/modules/context-quality/saved-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GatewaySession } from "../types";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	capabilities: vi.fn(),
	create: vi.fn(),
	list: vi.fn(),
	get: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
}));
vi.mock("@repo/api/modules/context-quality/lib/saved-commands", () => ({
	getContextQualityRunCapabilities: mocks.capabilities,
	createContextQualityRun: mocks.create,
	listContextQualityRuns: mocks.list,
	getContextQualityRun: mocks.get,
	cancelContextQualityRun: mocks.cancel,
	compareContextQualityRuns: mocks.compare,
}));
vi.mock(
	"@repo/api/modules/context-quality/lib/context-reader",
	async (original) => ({
		...(await original<Record<string, unknown>>()),
		readProjectContextSnapshot: mocks.read,
	}),
);

import { createContextQualityTools } from "../tools/context-quality-tools";

function toolHandler(
	family: ReturnType<typeof createContextQualityTools>,
	name: string,
) {
	const handler = family.handlers.get(name);
	if (!handler) {
		throw new Error(`Missing test tool: ${name}`);
	}
	return handler;
}

const CONTENT = "Example approved context.";
const REVISION = createHash("sha256").update(CONTENT).digest("hex");
const session: GatewaySession = {
	sessionId: "session-example",
	userId: "user-example",
	organizationId: "org-example",
	userName: "Example User",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["projects:read"],
	createdAt: new Date(),
	expiresAt: new Date(Date.now() + 60_000),
};
const evaluation = {
	version: 1,
	sources: [{ sourceId: "source-example", expectedRevision: REVISION }],
	cases: [
		{
			id: "case-example",
			recordedAnswer: CONTENT,
			retrievedSourceIds: ["source-example"],
			citedSourceIds: ["source-example"],
			expectations: {
				expectedSourceIds: ["source-example"],
				requiredPhrases: ["approved"],
				forbiddenPhrases: [],
			},
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.read.mockResolvedValue({
		sourceId: "source-example",
		sourceKind: "project_context",
		projectId: "project-example",
		organizationId: "org-example",
		title: "Example source",
		content: CONTENT,
		revision: REVISION,
		byteLength: Buffer.byteLength(CONTENT),
		readMode: "direct",
		indexingExcluded: false,
	});
	mocks.capabilities.mockResolvedValue({
		configured: true,
		canCreate: true,
		canCancel: true,
		canConfigure: false,
		bindingId: "example-binding",
		reason: null,
	});
	mocks.create.mockResolvedValue({
		run: { id: "example-run", status: "QUEUED" },
	});
	mocks.list.mockResolvedValue({ runs: [], nextCursor: null });
	mocks.get.mockResolvedValue({
		run: {
			id: "example-run",
			status: "SUCCEEDED",
			evidenceAvailable: false,
			report: null,
			remoteRunUrl: null,
			mlflowRunUrl: null,
		},
	});
	mocks.cancel.mockResolvedValue({
		run: { id: "example-run", status: "CANCEL_REQUESTED" },
	});
	mocks.compare.mockResolvedValue({
		compatible: false,
		passedDelta: null,
		differences: { dataset: true, configuration: false, scorer: false },
	});
});

describe("saved context-quality MCP commands", () => {
	const key = "example-stable-key";
	const actor = {
		projectId: "project-example",
		organizationId: "host-org-example",
		userId: "user-example",
	};
	const createInput = {
		bindingId: "example-binding",
		idempotencyKey: key,
		evaluation,
	};
	function family() {
		const read = vi
			.fn()
			.mockResolvedValue({ organizationId: "host-org-example" });
		const write = vi.fn().mockResolvedValue({
			status: "allowed",
			organizationId: "host-org-example",
		});
		return { read, write, tools: createContextQualityTools(read, write) };
	}

	it("uses the hosting tenant from the live PROJECT_UPDATE resolver on create and cancel", async () => {
		const { tools, read, write } = family();
		const create = toolHandler(tools, "fabric_create_context_quality_run");
		const cancel = toolHandler(tools, "fabric_cancel_context_quality_run");
		const created = await create(
			{ projectId: "project-example", ...createInput },
			session,
		);
		expect(created.isError).not.toBe(true);
		expect(mocks.create).toHaveBeenCalledWith(actor, createInput);
		const cancelled = await cancel(
			{ projectId: "project-example", runId: "example-run" },
			session,
		);
		expect(cancelled.isError).not.toBe(true);
		expect(JSON.parse(cancelled.content[0]?.text ?? "{}")).toMatchObject({
			run: { status: "CANCEL_REQUESTED" },
		});
		expect(mocks.cancel).toHaveBeenCalledWith(actor, {
			runId: "example-run",
		});
		expect(write.mock.calls).toEqual([
			["project-example", session, "PROJECT_UPDATE"],
			["project-example", session, "PROJECT_UPDATE"],
		]);
		expect(read).not.toHaveBeenCalled();
	});

	it("passes a caller's identical key and input unchanged across ambiguous retries", async () => {
		const { tools } = family();
		mocks.create.mockRejectedValueOnce(
			new Error("synthetic-private-provider-body"),
		);
		const create = toolHandler(tools, "fabric_create_context_quality_run");
		const first = await create(
			{ projectId: "project-example", ...createInput },
			session,
		);
		expect(first.isError).toBe(true);
		expect(JSON.stringify(first)).not.toContain(
			"synthetic-private-provider-body",
		);
		expect(JSON.stringify(first)).toContain(
			"same input and idempotency key",
		);
		const second = await create(
			{ projectId: "project-example", ...createInput },
			session,
		);
		expect(second.isError).not.toBe(true);
		expect(mocks.create.mock.calls).toEqual([
			[actor, createInput],
			[actor, createInput],
		]);
	});

	it.each(["forbidden", "not-found"])(
		"refuses writes when live access is %s, even for wildcard scopes",
		async (status) => {
			const { tools, write } = family();
			write.mockResolvedValue({ status });
			const wildcard = { ...session, scopes: ["*"] };
			for (const [name, args] of [
				["fabric_create_context_quality_run", createInput],
				["fabric_cancel_context_quality_run", { runId: "example-run" }],
			] as const) {
				const result = await toolHandler(tools, name)(
					{ projectId: "project-example", ...args },
					wildcard,
				);
				expect(result.isError).toBe(true);
			}
			expect(mocks.create).not.toHaveBeenCalled();
			expect(mocks.cancel).not.toHaveBeenCalled();
			expect(write).toHaveBeenCalledWith(
				"project-example",
				wildcard,
				"PROJECT_UPDATE",
			);
		},
	);

	it("never falls back to a visibility guard when write wiring is absent", async () => {
		const read = vi
			.fn()
			.mockResolvedValue({ organizationId: "org-example" });
		const tools = createContextQualityTools(read);
		const result = await toolHandler(
			tools,
			"fabric_create_context_quality_run",
		)(
			{
				projectId: "project-example",
				...createInput,
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(read).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("repeats shared-command authorization after the gateway gate", async () => {
		const { tools, write } = family();
		mocks.create.mockRejectedValueOnce({
			code: "FORBIDDEN",
			message: "synthetic private detail",
		});
		const result = await toolHandler(
			tools,
			"fabric_create_context_quality_run",
		)(
			{
				projectId: "project-example",
				...createInput,
			},
			session,
		);
		expect(write).toHaveBeenCalledTimes(1);
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("access was denied");
		expect(JSON.stringify(result)).not.toContain(
			"synthetic private detail",
		);
	});

	it("uses shared authorized read commands with bounded pagination and comparison", async () => {
		const { tools, read, write } = family();
		await toolHandler(tools, "fabric_context_quality_run_capabilities")(
			{ projectId: "project-example" },
			session,
		);
		await toolHandler(tools, "fabric_list_context_quality_runs")(
			{
				projectId: "project-example",
				limit: 15,
				cursor: "example-cursor",
			},
			session,
		);
		const detail = await toolHandler(
			tools,
			"fabric_get_context_quality_run",
		)(
			{
				projectId: "project-example",
				runId: "example-run",
			},
			session,
		);
		const comparison = await toolHandler(
			tools,
			"fabric_compare_context_quality_runs",
		)(
			{
				projectId: "project-example",
				baselineId: "example-baseline",
				candidateId: "example-candidate",
			},
			session,
		);
		expect(mocks.capabilities).toHaveBeenCalledWith(actor);
		expect(mocks.list).toHaveBeenCalledWith(actor, {
			limit: 15,
			cursor: "example-cursor",
		});
		expect(mocks.get).toHaveBeenCalledWith(actor, { runId: "example-run" });
		expect(mocks.compare).toHaveBeenCalledWith(actor, {
			baselineId: "example-baseline",
			candidateId: "example-candidate",
		});
		expect(JSON.parse(detail.content[0]?.text ?? "{}")).toMatchObject({
			run: {
				evidenceAvailable: false,
				report: null,
				remoteRunUrl: null,
				mlflowRunUrl: null,
			},
		});
		expect(JSON.parse(comparison.content[0]?.text ?? "{}")).toMatchObject({
			compatible: false,
			passedDelta: null,
		});
		expect(read).toHaveBeenCalledTimes(4);
		expect(write).not.toHaveBeenCalled();
	});

	it("rejects actor, tenant, remote-location and missing-key injection before authorization", async () => {
		const { tools, read, write } = family();
		const create = toolHandler(tools, "fabric_create_context_quality_run");
		for (const extra of [
			{ organizationId: "other-org" },
			{ userId: "other-user" },
			{ remoteRunUrl: "https://example.com" },
			{ idempotencyKey: undefined },
		]) {
			const result = await create(
				{ projectId: "project-example", ...createInput, ...extra },
				session,
			);
			expect(result.isError).toBe(true);
		}
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("rejects oversized evaluation inputs and invalid page bounds before any authorization", async () => {
		const { tools, read, write } = family();
		const oversized = await toolHandler(
			tools,
			"fabric_create_context_quality_run",
		)(
			{
				projectId: "project-example",
				...createInput,
				evaluation: {
					...evaluation,
					cases: [
						{
							...evaluation.cases[0],
							recordedAnswer: "界".repeat(50_000),
						},
					],
				},
			},
			session,
		);
		expect(oversized.isError).toBe(true);
		for (const limit of [0, 51, 1.5]) {
			const result = await toolHandler(
				tools,
				"fabric_list_context_quality_runs",
			)(
				{
					projectId: "project-example",
					limit,
				},
				session,
			);
			expect(result.isError).toBe(true);
		}
		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("does not call shared reads when project scope is refused", async () => {
		const { tools, read } = family();
		read.mockResolvedValue(null);
		const result = await toolHandler(
			tools,
			"fabric_get_context_quality_run",
		)(
			{
				projectId: "other-project",
				runId: "example-run",
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(mocks.get).not.toHaveBeenCalled();
	});
});

describe("context quality MCP tools", () => {
	it("compacts discovery without changing any schema validation keyword", () => {
		const scope = z.strictObject({ projectId: contextQualityIdSchema });
		const run = scope.extend({ runId: contextQualityIdSchema });
		const schemas: Record<string, z.ZodType> = {
			fabric_inspect_context_quality_source: scope.extend({
				sourceId: contextQualityIdSchema,
			}),
			fabric_evaluate_context_quality: scope.extend({
				evaluation: projectContextEvaluationSchema,
			}),
			fabric_context_quality_run_capabilities: scope,
			fabric_create_context_quality_run: scope.extend(
				createSavedEvaluationSchema.shape,
			),
			fabric_list_context_quality_runs: scope.extend(
				savedEvaluationListSchema.shape,
			),
			fabric_get_context_quality_run: run,
			fabric_cancel_context_quality_run: run,
			fabric_compare_context_quality_runs: scope.extend({
				baselineId: contextQualityIdSchema,
				candidateId: contextQualityIdSchema,
			}),
		};
		const family = createContextQualityTools(vi.fn());
		for (const tool of family.definitions) {
			const schema = schemas[tool.name];
			if (!schema)
				throw new Error(`Missing canonical schema: ${tool.name}`);
			const { $schema: _dialect, ...expected } = z.toJSONSchema(schema);
			expect(tool.inputSchema, tool.name).toEqual(expected);
		}
	});

	it("keeps quick checks read-only and classifies saved reads and writes separately", () => {
		const family = createContextQualityTools(vi.fn());
		expect(family.definitions.map((tool) => tool.name)).toEqual([
			"fabric_inspect_context_quality_source",
			"fabric_evaluate_context_quality",
			"fabric_context_quality_run_capabilities",
			"fabric_create_context_quality_run",
			"fabric_list_context_quality_runs",
			"fabric_get_context_quality_run",
			"fabric_cancel_context_quality_run",
			"fabric_compare_context_quality_runs",
		]);
		for (const tool of family.definitions) {
			const write = [
				"fabric_create_context_quality_run",
				"fabric_cancel_context_quality_run",
			].includes(tool.name);
			expect(tool.annotations?.readOnlyHint).toBe(!write);
			expect(family.scopes[tool.name]).toEqual({
				scope: write ? "projects:write" : "projects:read",
				kind: write ? "write" : "read",
			});
			if (write) {
				expect(tool._meta).toMatchObject({ "fabric/confirm": true });
				expect(tool.annotations?.idempotentHint).toBe(true);
			}
		}
	});

	it("derives actor/organization from authorized session and project, then runs the shared scorer", async () => {
		const authorize = vi
			.fn()
			.mockResolvedValue({ organizationId: "org-example" });
		const family = createContextQualityTools(authorize);
		const handler = toolHandler(family, "fabric_evaluate_context_quality");
		const result = await handler(
			{ projectId: "project-example", evaluation },
			session,
		);
		expect(authorize).toHaveBeenCalledWith("project-example", session);
		expect(mocks.read).toHaveBeenCalledTimes(2);
		expect(mocks.read).toHaveBeenCalledWith({
			organizationId: "org-example",
			projectId: "project-example",
			userId: "user-example",
			sourceId: "source-example",
			expectedRevision: REVISION,
		});
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
			status: "passed",
			mode: "recorded-output",
			projectId: "project-example",
		});
		expect(JSON.stringify(result)).not.toContain(CONTENT);
	});

	it("cannot read after project binding denies the requested project", async () => {
		const family = createContextQualityTools(
			vi.fn().mockResolvedValue(null),
		);
		const result = await family.handlers.get(
			"fabric_inspect_context_quality_source",
		)?.(
			{ projectId: "other-project", sourceId: "source-example" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("rejects actor, tenant and raw source injection before any reads", async () => {
		const authorize = vi.fn();
		const family = createContextQualityTools(authorize);
		const result = await family.handlers.get(
			"fabric_evaluate_context_quality",
		)?.(
			{
				projectId: "project-example",
				organizationId: "other-org",
				evaluation,
			},
			session,
		);
		expect(result.isError).toBe(true);
		expect(authorize).not.toHaveBeenCalled();
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it.each(["NOT_FOUND", "FORBIDDEN", "STALE_REVISION"] as const)(
		"propagates safe %s refusal",
		async (code) => {
			mocks.read.mockRejectedValue(new ContextReadError(code));
			const family = createContextQualityTools(
				vi.fn().mockResolvedValue({ organizationId: "org-example" }),
			);
			const result = await family.handlers.get(
				"fabric_evaluate_context_quality",
			)?.({ projectId: "project-example", evaluation }, session);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).not.toContain(CONTENT);
		},
	);

	it("never exposes unexpected provider/database error text", async () => {
		mocks.read.mockRejectedValue(
			new Error("private-token-and-source-text"),
		);
		const family = createContextQualityTools(
			vi.fn().mockResolvedValue({ organizationId: "org-example" }),
		);
		const result = await family.handlers.get(
			"fabric_inspect_context_quality_source",
		)?.(
			{ projectId: "project-example", sourceId: "source-example" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private-token");
	});
});
