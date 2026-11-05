import { AgentTestError } from "@repo/temporal/agent-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

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
vi.mock("../../lib/agent-test-commands", () => ({
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
vi.mock("../../../../lib/audit", () => ({ recordAuditFromRequest: m.audit }));
vi.mock("../../../../orpc/procedures", () => {
	function chain(permission?: string) {
		return {
			use: (next: string) => chain(next),
			input: (schema: unknown) => ({
				handler: (handler: unknown) => ({
					_schema: schema,
					_handler: handler,
					_permission: permission,
				}),
			}),
		};
	}
	return {
		tenantProtectedProcedure: chain(),
		Permissions: {
			AGENT_READ: "agents:read",
			AGENT_EXECUTE: "agents:execute",
		},
		requireInputOrgPermission: (permission: string, options: unknown) => {
			if (
				!options ||
				!(options as { requireOrganization?: boolean })
					.requireOrganization
			) {
				throw new Error("Organization required");
			}
			return permission;
		},
		resolveOrganizationId: (
			input: string | undefined,
			session: { activeOrganizationId?: string },
		) => input ?? session.activeOrganizationId,
	};
});

import { agentTestProcedures } from "../agent-tests";

const operations = [
	{
		method: "listCases",
		section: "cases",
		procedure: "list",
		input: { instanceId: "example-agent", limit: 20 },
		write: false,
	},
	{
		method: "createCase",
		section: "cases",
		procedure: "create",
		input: {
			instanceId: "example-agent",
			name: "Delivery brief",
			input: "Summarize delivery",
			checks: { requiredPhrases: ["Ready"], forbiddenPhrases: [] },
		},
		write: true,
	},
	{
		method: "updateCase",
		section: "cases",
		procedure: "update",
		input: {
			caseId: "example-case",
			revision: 2,
			name: "Delivery brief",
			input: "Summarize delivery",
			checks: { requiredPhrases: ["Ready"], forbiddenPhrases: [] },
		},
		write: true,
	},
	{
		method: "archiveCase",
		section: "cases",
		procedure: "archive",
		input: { caseId: "example-case", revision: 2 },
		write: true,
	},
	{
		method: "start",
		section: "runs",
		procedure: "start",
		input: {
			caseId: "example-case",
			caseRevision: 2,
			instanceId: "example-agent",
			idempotencyKey: "7279e1aa-5913-44bf-a9ce-e57358f977dd",
		},
		write: true,
	},
	{
		method: "get",
		section: "runs",
		procedure: "get",
		input: { testRunId: "example-run" },
		write: false,
	},
	{
		method: "listRuns",
		section: "runs",
		procedure: "list",
		input: { caseId: "example-case", limit: 20 },
		write: false,
	},
	{
		method: "cancel",
		section: "runs",
		procedure: "cancel",
		input: { testRunId: "example-run" },
		write: true,
	},
	{
		method: "compare",
		section: "runs",
		procedure: "compare",
		input: {
			baselineRunId: "example-base",
			candidateRunId: "example-candidate",
		},
		write: false,
	},
];
const context = {
	user: { id: "example-user" },
	session: { activeOrganizationId: "example-org" },
	headers: new Headers(),
};
function procedure(op: (typeof operations)[number]) {
	return (
		agentTestProcedures as unknown as Record<
			string,
			Record<
				string,
				{
					_schema: z.ZodType;
					_permission: string;
					_handler: (args: {
						input: unknown;
						context: unknown;
					}) => Promise<unknown>;
				}
			>
		>
	)[op.section][op.procedure];
}
beforeEach(() => {
	vi.resetAllMocks();
	for (const op of operations) {
		m[op.method as "get"].mockResolvedValue({ id: "example-result" });
	}
});
describe("saved agent test Portal oRPC adapter", () => {
	it.each(operations)(
		"derives actual actor and strips org selector for $method",
		async (op) => {
			const p = procedure(op);
			expect(p._permission).toBe(
				op.write ? "agents:execute" : "agents:read",
			);
			await p._handler({
				input: p._schema.parse({
					...op.input,
					organizationId: "example-org",
				}),
				context,
			});
			expect(m[op.method as "get"]).toHaveBeenCalledWith(
				{ userId: "example-user", organizationId: "example-org" },
				op.input,
				...(op.write ? [expect.any(Function)] : []),
			);
		},
	);
	it.each(operations)("rejects caller-supplied actor for $method", (op) => {
		expect(
			procedure(op)._schema.safeParse({
				...op.input,
				userId: "other-user",
			}).success,
		).toBe(false);
	});
	it("fails closed without organization context", async () => {
		await expect(
			procedure(operations[5])._handler({
				input: { testRunId: "example-run" },
				context: { user: { id: "example-user" }, session: {} },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.get).not.toHaveBeenCalled();
	});
	it("translates shared command conflicts into oRPC errors", async () => {
		m.get.mockRejectedValue(
			new AgentTestError("CONFLICT", "Wait for assessment"),
		);
		await expect(
			procedure(operations[5])._handler({
				input: operations[5].input,
				context,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: "Wait for assessment",
		});
	});
	it("uses current request context for mutation audit", async () => {
		m.cancel.mockImplementation(async (_actor, _input, audit) => {
			await audit({
				action: "org.agent_test.cancel_requested",
				organizationId: "example-org",
				resource: { type: "agent_test_run", id: "example-run" },
			});
			return {};
		});
		await procedure(operations[7])._handler({
			input: operations[7].input,
			context,
		});
		expect(m.audit).toHaveBeenCalledWith(
			context,
			expect.objectContaining({
				resource: { type: "agent_test_run", id: "example-run" },
			}),
		);
	});
	it("preserves only trusted definitive admission recovery data", async () => {
		m.start.mockRejectedValue(
			new AgentTestError("CONFLICT", "Test changed before admission", {
				admission: "NOT_STARTED",
			}),
		);
		await expect(
			procedure(operations[4])._handler({
				input: operations[4].input,
				context,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { admission: "NOT_STARTED" },
		});
	});
	it("keeps an uncertain start or unsafe payload unclassified", async () => {
		for (const error of [
			new AgentTestError("SERVICE_UNAVAILABLE", "Admission uncertain"),
			Object.assign(new AgentTestError("CONFLICT", "No public payload"), {
				data: { admission: "NOT_STARTED", unexpected: "not public" },
			}),
		]) {
			m.start.mockRejectedValue(error);
			const result = await procedure(operations[4])
				._handler({ input: operations[4].input, context })
				.catch((error) => error);
			expect(result.data).toBeUndefined();
		}
	});
	it("rejects recovery-data injection before the shared command", () => {
		expect(
			procedure(operations[4])._schema.safeParse({
				...operations[4].input,
				data: { admission: "NOT_STARTED" },
			}).success,
		).toBe(false);
		expect(m.start).not.toHaveBeenCalled();
	});
});
