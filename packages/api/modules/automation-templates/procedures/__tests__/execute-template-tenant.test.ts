import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handler: undefined as undefined | ((args: unknown) => Promise<unknown>),
	findTemplate: vi.fn(),
	createTask: vi.fn(),
	updateTemplate: vi.fn(),
	startWorkflow: vi.fn(),
	verifyMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		automationTemplate: {
			findFirst: mocks.findTemplate,
			update: mocks.updateTemplate,
		},
		browserTask: { create: mocks.createTask },
	},
}));
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: async () => true,
	getTemporalClient: async () => ({
		workflow: { start: mocks.startWorkflow },
	}),
}));
vi.mock("../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: mocks.verifyMembership,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../orpc/procedures", () => {
	const procedure: Record<string, unknown> = {};
	Object.assign(procedure, {
		use: () => procedure,
		route: () => procedure,
		input: () => procedure,
		handler: (handler: (args: unknown) => Promise<unknown>) => {
			mocks.handler = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: procedure,
		requirePermission: () => ({}),
		Permissions: { REPORT_TEMPLATE_MANAGE: "report:template:manage" },
		resolveOrganizationId: () => "example-org",
	};
});

import "../execute-template";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.findTemplate.mockResolvedValue({ id: "template-1", parameters: [] });
	mocks.createTask.mockResolvedValue({ id: "task-1" });
	mocks.updateTemplate.mockResolvedValue({});
	mocks.verifyMembership.mockResolvedValue({ role: "admin" });
	mocks.startWorkflow.mockResolvedValue({ workflowId: "workflow-1" });
});

describe("execute template tenant binding", () => {
	it("uses the resolved organization for the task and workflow when input omits it", async () => {
		await mocks.handler?.({
			input: {
				id: "template-1",
				parameterValues: {},
				takeScreenshots: false,
			},
			context: {
				user: { id: "user-1" },
				session: { activeOrganizationId: "example-org" },
			},
		});

		expect(mocks.verifyMembership).toHaveBeenCalledWith(
			"example-org",
			"user-1",
		);
		expect(mocks.findTemplate).toHaveBeenCalledWith({
			where: { id: "template-1", organizationId: "example-org" },
		});
		expect(mocks.createTask).toHaveBeenCalledWith({
			data: expect.objectContaining({ organizationId: "example-org" }),
		});
		expect(mocks.startWorkflow).toHaveBeenCalledWith(
			"templateExecutionWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({ organizationId: "example-org" }),
				],
			}),
		);
	});
});
