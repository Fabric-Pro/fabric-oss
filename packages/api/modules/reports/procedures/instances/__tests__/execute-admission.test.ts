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
	connectionFailure: vi.fn(),
	flag: vi.fn(),
	admitted: vi.fn(),
	membership: vi.fn(),
	platformAdmin: vi.fn(),
}));
vi.mock("../../../lib/report-connection-test", () => ({
	reportSourceConnectionFailure: m.connectionFailure,
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
		// The real values: the handler asks the real role tables for them.
		Permissions: {
			REPORT_READ: "report:read",
			REPORT_EXECUTE: "report:execute",
		},
		requireInputOrgPermission: m.permission,
		resolveOrganizationId: (value: unknown) => value,
	};
});
vi.mock("@repo/database", async () => ({
	...(await import(
		"../../../../../../database/prisma/queries/lib/report-evidence"
	)),
	getTemplateInstance: m.instance,
	getTemplateInstanceExecution: m.admitted,
	getOrganizationMembership: m.membership,
	isPlatformAdmin: m.platformAdmin,
	isFeatureEnabled: m.flag,
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
	m.membership.mockResolvedValue({ role: "member" });
	m.platformAdmin.mockResolvedValue(false);
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
	m.flag.mockResolvedValue(true);
	m.admitted.mockResolvedValue(null);
	m.connectionFailure.mockResolvedValue(null);
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

it("refuses before admission when a required data source fails the live connection test", async () => {
	m.connectionFailure.mockResolvedValue(
		"A required data source did not connect, so the report was not generated. Example board: its sign-in was refused or has expired. Fix the connection on the report page, then generate again.",
	);
	await expect(m.handler?.({ input, context })).rejects.toMatchObject({
		code: "BAD_REQUEST",
		message: expect.stringContaining("Example board"),
	});
	expect(m.connectionFailure).toHaveBeenCalledWith(
		expect.objectContaining({ id: "instance-1" }),
		{ userId: "user-1", organizationId: "org-1" },
	);
	expect(m.admit).not.toHaveBeenCalled();
	expect(m.start).not.toHaveBeenCalled();
});

it("lets a retry attach to its admitted run even when the connection now fails", async () => {
	m.admitted.mockResolvedValue({ id: "admitted-run" });
	m.connectionFailure.mockResolvedValue("would refuse");

	await m.handler?.({
		input: {
			...input,
			idempotencyKey: "00000000-0000-4000-8000-000000000001",
		},
		context,
	});

	expect(m.admitted).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({
			userId: context.user.id,
			organizationId: expect.any(String),
		}),
	);
	expect(m.connectionFailure).not.toHaveBeenCalled();
	expect(m.admit).toHaveBeenCalled();
});

it("skips the live connection test where the report suite is off", async () => {
	m.flag.mockResolvedValue(false);
	m.connectionFailure.mockResolvedValue("would refuse");

	await m.handler?.({ input, context });

	expect(m.flag).toHaveBeenCalledWith("REPORT_SUITE_V2", "org-1");
	expect(m.connectionFailure).not.toHaveBeenCalled();
	expect(m.admit).toHaveBeenCalled();
});

describe("what the report page refuses", () => {
	const missingValue = {
		id: "instance-1",
		userId: "user-1",
		organizationId: "org-1",
		isActive: true,
		connections: {},
		template: {
			parameters: {
				required: ["audience"],
				properties: { audience: { title: "Audience" } },
			},
		},
	};

	it("is refused before the connection test and admission where the report suite is on", async () => {
		m.instance.mockResolvedValue(missingValue);

		await expect(m.handler?.({ input, context })).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: expect.stringContaining("Audience"),
		});
		expect(m.connectionFailure).not.toHaveBeenCalled();
		expect(m.admit).not.toHaveBeenCalled();
	});

	it("is not refused when the value comes with the request", async () => {
		m.instance.mockResolvedValue(missingValue);

		await m.handler?.({
			input: { ...input, parameters: { audience: "Example" } },
			context,
		});

		expect(m.admit).toHaveBeenCalled();
	});

	it("is not refused when a binding is stale, so a run can still repair itself", async () => {
		m.instance.mockResolvedValue({
			...missingValue,
			connections: { mcpBindings: { fizzy: "example-removed-config" } },
			template: {
				connections: {
					mcpServers: [
						{ key: "fizzy", name: "Fizzy", required: true },
					],
				},
			},
		});

		await m.handler?.({ input, context });

		expect(m.admit).toHaveBeenCalled();
	});

	it("is not checked where the report suite is off", async () => {
		m.flag.mockResolvedValue(false);
		m.instance.mockResolvedValue(missingValue);

		await m.handler?.({ input, context });

		expect(m.admit).toHaveBeenCalled();
	});
});

it("refuses a non-owner before admission, because a report runs on its owner's connections", async () => {
	m.instance.mockResolvedValue({
		id: "instance-1",
		userId: "example-owner",
		organizationId: "org-1",
		isActive: true,
		connections: {},
		template: {},
	});
	await expect(m.handler?.({ input, context })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(m.admit).not.toHaveBeenCalled();
	expect(m.start).not.toHaveBeenCalled();
});

it("refuses an organization Viewer before admission, whoever owns the report", async () => {
	m.membership.mockResolvedValue({ role: "viewer" });
	await expect(m.handler?.({ input, context })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(m.instance).not.toHaveBeenCalled();
	expect(m.admit).not.toHaveBeenCalled();
});

it("lets a system admin who is a member past the role check, so only ownership decides", async () => {
	m.membership.mockResolvedValue({ role: "viewer" });
	m.platformAdmin.mockResolvedValue(true);
	const result = await m.handler?.({ input, context });
	expect(result.startConfirmed).toBe(true);
});

it("refuses a system admin who is not a member", async () => {
	m.membership.mockResolvedValue(null);
	m.platformAdmin.mockResolvedValue(true);
	await expect(m.handler?.({ input, context })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(m.admit).not.toHaveBeenCalled();
});
