import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: undefined as undefined | ((args: any) => Promise<any>),
	schema: undefined as any,
	instance: vi.fn(),
	admit: vi.fn(),
	receipt: vi.fn(),
	start: vi.fn(),
	describe: vi.fn(),
	permission: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: (schema: unknown) => {
			m.schema = schema;
			return chain;
		},
		handler: (fn: typeof m.handler) => {
			m.handler = fn;
			return {};
		},
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_EXECUTE: "report.execute" },
		requireInputOrgPermission: m.permission,
		resolveOrganizationId: (value: unknown) => value,
	};
});
vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../../database/prisma/queries/lib/report-evidence"
	)),
	getTemplateInstance: m.instance,
	admitTemplateInstanceExecution: m.admit,
	updateTemplateInstanceExecution: m.receipt,
	reportExecutionAdmissionId: (value: string) => `id-${value.length}`,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: m.start,
			getHandle: () => ({ describe: m.describe }),
		},
	}),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (value: unknown) => value,
}));
import "../execute";
const input = {
	instanceId: "instance-1",
	organizationId: "org-1",
	idempotencyKey: "00000000-0000-4000-8000-000000000001",
	parameters: { team: "Example" },
};
const context = { user: { id: "user-1" }, session: {} };
beforeEach(() => {
	vi.clearAllMocks();
	m.instance.mockResolvedValue({
		id: "instance-1",
		userId: "user-1",
		organizationId: "org-1",
		isActive: true,
		connections: {},
		template: {},
	});
	m.admit.mockImplementation(async (value) => ({
		...value,
		status: "PENDING",
	}));
	m.start.mockResolvedValue({ firstExecutionRunId: "run-1" });
	m.receipt.mockResolvedValue({});
});
describe("manual report durable start", () => {
	it("persists a deterministic workflow identity and server snapshot before start", async () => {
		const result = await m.handler?.({ input, context });
		expect(result.startConfirmed).toBe(true);
		expect(m.admit.mock.invocationCallOrder[0]).toBeLessThan(
			m.start.mock.invocationCallOrder[0],
		);
		expect(m.admit.mock.calls[0][0]).toMatchObject({
			organizationId: "org-1",
			parameters: {
				team: "Example",
				__fabricReportExecution: {
					origin: "manual",
					organizationId: "org-1",
				},
			},
		});
		expect(m.start.mock.calls[0][1]).toMatchObject({
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			args: [{ organizationId: "org-1", reportingProtocol: 1 }],
		});
		expect(m.start.mock.calls[0][1].args[0].planEligible).toBe(true);
	});
	it("keeps a confirmed running workflow truthful when receipt persistence fails", async () => {
		m.receipt.mockRejectedValue(new Error("database unavailable"));
		const result = await m.handler?.({ input, context });
		expect(result.startConfirmed).toBe(true);
		expect(result.status).toBe("PENDING");
		expect(
			m.receipt.mock.calls.every(([arg]) => arg.status !== "FAILED"),
		).toBe(true);
	});
	it("returns an admitted pending state on an ambiguous start without recording failure", async () => {
		m.start.mockRejectedValue(new Error("timeout"));
		const result = await m.handler?.({ input, context });
		expect(result.startConfirmed).toBe(false);
		expect(m.receipt).not.toHaveBeenCalled();
	});
	it("attaches retries to a completed execution instead of starting again", async () => {
		m.admit.mockImplementation(async (value) => ({
			...value,
			status: "COMPLETED",
			runId: "run-1",
		}));
		const result = await m.handler?.({ input, context });
		expect(result.status).toBe("COMPLETED");
		expect(m.start).not.toHaveBeenCalled();
	});
	it("rejects null organization and forged reserved parameters before admission", async () => {
		await expect(
			m.handler?.({ input: { ...input, organizationId: null }, context }),
		).rejects.toThrow("organization");
		expect(m.admit).not.toHaveBeenCalled();
		expect(
			m.schema.safeParse({
				...input,
				parameters: { __fabricReportExecution: {} },
			}).success,
		).toBe(false);
	});
});

it("blocks cross-project source publication before provider spend even for an A+B-authorized caller", async () => {
	m.instance.mockResolvedValue({
		id: "instance-1",
		userId: "user-1",
		organizationId: "org-1",
		isActive: true,
		fabricConfig: {
			reporting: { version: 1, period: "weekly", projectId: "project-a" },
		},
		connections: { context: { projectId: "project-a" } },
		template: {
			definition: {
				dataSources: [
					{
						type: "mcp",
						config: {
							projectId: "project-b",
							audience: "project-a",
						},
					},
				],
			},
		},
	});
	await expect(m.handler?.({ input, context })).rejects.toThrow(
		"server-verified project audience binding",
	);
	expect(m.admit).not.toHaveBeenCalled();
	expect(m.start).not.toHaveBeenCalled();
});
