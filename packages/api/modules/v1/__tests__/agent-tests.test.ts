import { AgentTestError } from "@repo/temporal/agent-test-contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalApiVariables } from "../../external-api/types";

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
vi.mock("../../agents/lib/agent-test-commands", () => ({
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
vi.mock("../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../helpers", () => ({
	ok: (data: unknown) => ({ data }),
	resolveV1Context: m.context,
}));
vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope:
		(scope: string) => async (c: any, next: () => Promise<void>) => {
			const scopes = c.get("externalApiContext").scopes;
			if (!scopes.includes(scope) && !scopes.includes("*")) {
				return c.json({ error: { code: "INSUFFICIENT_SCOPE" } }, 403);
			}
			await next();
		},
}));

import { registerAgentTestRoutes } from "../agent-tests";

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
let scopes: string[] = [];
const app = new Hono<{ Variables: ExternalApiVariables }>();
app.use("*", async (c, next) => {
	c.set("externalApiContext", {
		keyType: "organization",
		keyId: "example-key",
		keyPrefix: "org_example",
		userId: "example-user",
		organizationId: "example-org",
		scopes,
	});
	await next();
});
registerAgentTestRoutes(app);
function request(operation: (typeof operations)[number], override?: unknown) {
	let body: unknown = override;
	if (
		override === undefined &&
		operation.http !== "GET" &&
		operation.http !== "DELETE"
	) {
		body =
			operation.method === "cancel"
				? {}
				: operation.method === "updateCase"
					? Object.fromEntries(
							Object.entries(operation.input).filter(
								([key]) => key !== "caseId",
							),
						)
					: operation.input;
	}
	return app.request(`https://example.com${operation.path}`, {
		method: operation.http,
		...(body === undefined
			? {}
			: {
					body: JSON.stringify(body),
					headers: { "Content-Type": "application/json" },
				}),
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	scopes = ["agents:read", "agents:execute"];
	m.context.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org",
	});
	for (const op of operations) {
		m[op.method as "get"].mockResolvedValue({ id: "example-result" });
	}
});
describe("saved agent test REST boundary", () => {
	it.each(operations)(
		"dispatches $method with server-resolved actor and scope policy",
		async (op) => {
			const response = await request(op);
			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe(
				"private, no-store",
			);
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
		scopes = [];
		expect((await request(op)).status).toBe(403);
		expect(m[op.method as "get"]).not.toHaveBeenCalled();
	});
	it.each(operations)(
		"retains source scope ceiling for $method",
		async (op) => {
			m[op.method as "get"].mockImplementation(
				async (...args: unknown[]) => {
					await (
						args[op.write ? 3 : 2] as (scope: {
							workspaceIds: string[];
							skillIds: string[];
						}) => unknown
					)({
						workspaceIds: ["example-workspace"],
						skillIds: [],
					});
					return {};
				},
			);
			const response = await request(op);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				error: { code: "INSUFFICIENT_SCOPE" },
			});
			scopes = ["*"];
			expect((await request(op)).status).toBe(200);
		},
	);
	it("does not let wildcard keys bypass current authority", async () => {
		scopes = ["*"];
		m.get.mockRejectedValue(
			new AgentTestError("FORBIDDEN", "Access revoked"),
		);
		const r = await request(operations[5]);
		expect(r.status).toBe(403);
		expect(await r.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
	});
	it("preserves safe conflicts and service unavailable failures", async () => {
		for (const [code, status] of [
			["CONFLICT", 409],
			["SERVICE_UNAVAILABLE", 503],
		] as const) {
			m.get.mockRejectedValue(new AgentTestError(code, "Try later"));
			expect((await request(operations[5])).status).toBe(status);
		}
	});
	it.each([1, 2, 4, 7, 8])(
		"rejects actor injection in operation %s",
		async (index) => {
			const op = operations[index];
			expect(
				(
					await request(op, {
						...op.input,
						userId: "other-user",
						organizationId: "other-org",
					})
				).status,
			).toBe(400);
			expect(m[op.method as "get"]).not.toHaveBeenCalled();
		},
	);
	it("prevents update body identity overrides", async () => {
		expect((await request(operations[2], operations[2].input)).status).toBe(
			400,
		);
		expect(m.updateCase).not.toHaveBeenCalled();
	});
	it("fails closed on unresolved organization", async () => {
		m.context.mockResolvedValue({ error: "No organization", status: 403 });
		expect((await request(operations[5])).status).toBe(403);
		expect(m.get).not.toHaveBeenCalled();
	});
	it.each([3, 7])(
		"rejects malformed JSON for operation %s",
		async (index) => {
			const op = operations[index];
			expect(
				(
					await app.request(`https://example.com${op.path}`, {
						method: op.http,
						body: "{",
					})
				).status,
			).toBe(400);
			expect(m[op.method as "get"]).not.toHaveBeenCalled();
		},
	);
	it("caps request bytes", async () => {
		expect(
			(await request(operations[1], { input: "x".repeat(132000) }))
				.status,
		).toBe(413);
		expect(m.createCase).not.toHaveBeenCalled();
	});
	it("audits mutations using actual credential actor", async () => {
		m.cancel.mockImplementation(async (_actor, _input, audit) => {
			await audit({
				action: "AGENT_EXECUTE",
				resourceType: "agent",
				resourceId: "example-run",
				organizationId: "example-org",
			});
			return {};
		});
		await request(operations[7]);
		expect(m.audit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				actor: { type: "api_key", userId: "example-user" },
			}),
		);
	});
	it("preserves a trusted definitive not-started admission error", async () => {
		m.start.mockRejectedValue(
			new AgentTestError("CONFLICT", "Test changed before admission", {
				admission: "NOT_STARTED",
			}),
		);
		const response = await request(operations[4]);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "CONFLICT", data: { admission: "NOT_STARTED" } },
		});
	});
	it("omits admission data for unknown or unsafe error payloads", async () => {
		for (const error of [
			new AgentTestError("SERVICE_UNAVAILABLE", "Admission uncertain"),
			Object.assign(new AgentTestError("CONFLICT", "No public payload"), {
				data: { admission: "NOT_STARTED", unexpected: "not public" },
			}),
		]) {
			m.start.mockRejectedValue(error);
			expect(
				(await (await request(operations[4])).json()).error,
			).not.toHaveProperty("data");
		}
	});
	it("cannot accept a caller-provided definitive admission flag", async () => {
		expect(
			(
				await request(operations[4], {
					...operations[4].input,
					data: { admission: "NOT_STARTED" },
				})
			).status,
		).toBe(400);
		expect(m.start).not.toHaveBeenCalled();
	});
});
