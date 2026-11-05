import { AgentTestError } from "@repo/temporal/agent-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewaySession } from "../types";

const m = vi.hoisted(() => ({
	listCases: vi.fn(),
	createCase: vi.fn(),
	updateCase: vi.fn(),
	archiveCase: vi.fn(),
	start: vi.fn(),
	get: vi.fn(),
	listRuns: vi.fn(),
	cancel: vi.fn(),
	compare: vi.fn(),
	audit: vi.fn(),
	context: vi.fn(),
}));
vi.mock("@repo/api/modules/agents/lib/agent-test-commands", () => ({
	listAgentTestCasesCommand: m.listCases,
	createAgentTestCaseCommand: m.createCase,
	updateAgentTestCaseCommand: m.updateCase,
	archiveAgentTestCaseCommand: m.archiveCase,
	startAgentTestRunCommand: m.start,
	getAgentTestRunCommand: m.get,
	listAgentTestRunsCommand: m.listRuns,
	cancelAgentTestRunCommand: m.cancel,
	compareAgentTestRunsCommand: m.compare,
}));
vi.mock("@repo/database", () => ({ recordAudit: m.audit }));

import { createAgentTestTools } from "../tools/agent-test-tools";

const operations = [
	{
		method: "listCases",
		http: "GET",
		path: "/agent-tests/cases?instanceId=example-agent",
		input: { instanceId: "example-agent", limit: 20 },
		write: false,
		tool: "fabric_list_agent_test_cases",
	},
	{
		method: "createCase",
		http: "POST",
		path: "/agent-tests/cases",
		input: {
			instanceId: "example-agent",
			name: "Delivery brief",
			input: "Summarize delivery",
			checks: { requiredPhrases: ["Ready"], forbiddenPhrases: [] },
		},
		write: true,
		tool: "fabric_create_agent_test_case",
	},
	{
		method: "updateCase",
		http: "PATCH",
		path: "/agent-tests/cases/example-case",
		input: {
			caseId: "example-case",
			revision: 2,
			name: "Delivery brief",
			input: "Summarize delivery",
			checks: { requiredPhrases: ["Ready"], forbiddenPhrases: [] },
		},
		write: true,
		tool: "fabric_update_agent_test_case",
	},
	{
		method: "archiveCase",
		http: "DELETE",
		path: "/agent-tests/cases/example-case?revision=2",
		input: { caseId: "example-case", revision: 2 },
		write: true,
		tool: "fabric_archive_agent_test_case",
	},
	{
		method: "start",
		http: "POST",
		path: "/agent-tests/runs",
		input: {
			caseId: "example-case",
			caseRevision: 2,
			instanceId: "example-agent",
			idempotencyKey: "7279e1aa-5913-44bf-a9ce-e57358f977dd",
		},
		write: true,
		tool: "fabric_start_agent_test_run",
	},
	{
		method: "get",
		http: "GET",
		path: "/agent-tests/runs/example-run",
		input: { testRunId: "example-run" },
		write: false,
		tool: "fabric_get_agent_test_run",
	},
	{
		method: "listRuns",
		http: "GET",
		path: "/agent-tests/runs?caseId=example-case",
		input: { caseId: "example-case", limit: 20 },
		write: false,
		tool: "fabric_list_agent_test_runs",
	},
	{
		method: "cancel",
		http: "POST",
		path: "/agent-tests/runs/example-run/cancel",
		input: { testRunId: "example-run" },
		write: true,
		tool: "fabric_cancel_agent_test_run",
	},
	{
		method: "compare",
		http: "POST",
		path: "/agent-tests/compare",
		input: {
			baselineRunId: "example-base",
			candidateRunId: "example-candidate",
		},
		write: false,
		tool: "fabric_compare_agent_test_runs",
	},
];
const family = createAgentTestTools();
const session: GatewaySession = {
	sessionId: "example-session",
	userId: "example-user",
	organizationId: "example-org",
	userName: "Example",
	email: "dev@example.com",
	role: "user",
	credential: "organization-key",
	scopes: ["agents:read", "agents:execute"],
	createdAt: new Date(0),
	expiresAt: new Date(100000),
};
function invoke(
	op: (typeof operations)[number],
	input: Record<string, unknown> = op.input,
	override: Partial<GatewaySession> = {},
) {
	const handler = family.handlers.get(op.tool);
	if (!handler) {
		throw new Error("Missing agent test handler");
	}
	return handler(input, { ...session, ...override });
}
beforeEach(() => {
	vi.resetAllMocks();
	for (const op of operations) {
		m[op.method as "get"].mockResolvedValue({ id: "example-result" });
	}
});
describe("saved agent test MCP boundary", () => {
	it.each(operations)(
		"dispatches $method through shared authorized command",
		async (op) => {
			expect((await invoke(op)).isError).not.toBe(true);
			expect(m[op.method as "get"]).toHaveBeenCalledWith(
				{
					userId: "example-user",
					organizationId: "example-org",
					external: true,
				},
				op.input,
				...(op.write ? [expect.any(Function)] : []),
				expect.any(Function),
			);
		},
	);
	it.each(operations)("requires declared scope for $method", async (op) => {
		expect(
			(await invoke(op, op.input, { scopes: ["mcp:write"] })).isError,
		).toBe(true);
		expect(m[op.method as "get"]).not.toHaveBeenCalled();
	});
	it.each(operations)(
		"preserves source credential ceilings for $method",
		async (op) => {
			m[op.method as "get"].mockImplementation(
				async (...args: unknown[]) => {
					await (
						args[op.write ? 3 : 2] as (scope: {
							workspaceIds: string[];
							skillIds: string[];
						}) => unknown
					)({
						workspaceIds: [],
						skillIds: ["example-skill"],
					});
					return {};
				},
			);
			const result = await invoke(op);
			expect(result.isError).toBe(true);
			expect(JSON.stringify(result)).toContain("INSUFFICIENT_SCOPE");
			expect(
				(await invoke(op, op.input, { scopes: ["*"] })).isError,
			).not.toBe(true);
		},
	);
	it.each([
		{ projectId: "example-project" },
		{ pinnedProjectId: "example-project" },
		{ pageProjectId: "example-project" },
		{ credential: "service" as const },
		{ organizationId: undefined },
	])("rejects unsupported authority %j", async (override) => {
		expect(
			(await invoke(operations[5], operations[5].input, override))
				.isError,
		).toBe(true);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("rejects actor and tenant injection", async () => {
		expect(
			(
				await invoke(operations[5], {
					...operations[5].input,
					userId: "other",
					organizationId: "other",
				})
			).isError,
		).toBe(true);
		expect(m.get).not.toHaveBeenCalled();
	});
	it("retains live actor authorization with wildcard credentials", async () => {
		m.get.mockRejectedValue(
			Object.assign(new Error("Access revoked"), { code: "FORBIDDEN" }),
		);
		const result = await invoke(operations[5], operations[5].input, {
			scopes: ["*"],
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("Access revoked");
	});
	it("treats in-app session as current user rather than external key", async () => {
		await invoke(operations[5], operations[5].input, {
			credential: "session",
			scopes: [],
		});
		expect(m.get).toHaveBeenCalledWith(
			{
				userId: "example-user",
				organizationId: "example-org",
				external: false,
			},
			operations[5].input,
			undefined,
		);
	});
	it("requires confirmation for all mutations and advertises their true idempotency", () => {
		for (const op of operations) {
			const definition = family.definitions.find(
				(x) => x.name === op.tool,
			);
			if (!definition) {
				throw new Error("Missing definition");
			}
			expect(definition.annotations?.readOnlyHint).toBe(!op.write);
			expect(definition._meta?.["fabric/confirm"]).toBe(
				op.write ? true : undefined,
			);
		}
		expect(
			family.definitions.find(
				(x) => x.name === "fabric_create_agent_test_case",
			)?.annotations?.idempotentHint,
		).toBe(false);
		expect(family.definitions.map((x) => x.name)).toEqual(
			operations.map((x) => x.tool),
		);
	});
	it("audits with actual current actor", async () => {
		m.cancel.mockImplementation(async (_actor, _input, audit) => {
			await audit({
				action: "AGENT_EXECUTE",
				resourceType: "agent",
				resourceId: "example-run",
				organizationId: "example-org",
			});
			return {};
		});
		await invoke(operations[7]);
		expect(m.audit).toHaveBeenCalledWith(
			expect.objectContaining({
				actor: { type: "api_key", userId: "example-user" },
				metadata: { via: "mcp" },
			}),
		);
	});
	it("preserves only trusted definitive admission recovery data", async () => {
		m.start.mockRejectedValue(
			new AgentTestError("CONFLICT", "Test changed before admission", {
				admission: "NOT_STARTED",
			}),
		);
		const result = await invoke(operations[4]);
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
			code: "CONFLICT",
			data: { admission: "NOT_STARTED" },
		});
	});
	it("does not infer no-admission from unknown errors or unsafe payloads", async () => {
		for (const error of [
			Object.assign(new Error("Uncertain"), {
				code: "CONFLICT",
				data: { admission: "NOT_STARTED" },
			}),
			new AgentTestError("SERVICE_UNAVAILABLE", "Admission uncertain"),
			Object.assign(new AgentTestError("CONFLICT", "No public payload"), {
				data: { admission: "NOT_STARTED", unexpected: "not public" },
			}),
		]) {
			m.start.mockRejectedValue(error);
			const result = await invoke(operations[4]);
			expect(
				JSON.parse(result.content[0]?.text ?? "{}"),
			).not.toHaveProperty("data");
		}
	});
	it("rejects caller recovery-data injection", async () => {
		expect(
			(
				await invoke(operations[4], {
					...operations[4].input,
					data: { admission: "NOT_STARTED" },
				})
			).isError,
		).toBe(true);
		expect(m.start).not.toHaveBeenCalled();
	});
});
