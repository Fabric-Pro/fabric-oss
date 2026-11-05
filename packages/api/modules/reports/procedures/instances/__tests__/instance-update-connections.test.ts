/**
 * `reports.instances.update` on a connected report: its owner's connections keep
 * reading what the owner chose, whoever else may edit the report's prompts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: undefined as undefined | ((args: unknown) => Promise<unknown>),
	access: vi.fn(),
	assertCanEdit: vi.fn(),
	instance: vi.fn(),
	update: vi.fn(),
	validate: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		assertPublicReportParameters: real.assertPublicReportParameters,
		canAccessReportInstance: m.access,
		getProjectReportSetupReason: real.getProjectReportSetupReason,
		getTemplateInstance: m.instance,
		publicReportParametersSchema: real.publicReportParametersSchema,
		readReportEvidenceConfig: real.readReportEvidenceConfig,
		reportEvidenceConfigSchema: real.reportEvidenceConfigSchema,
		reportScheduleInputSchema: real.reportScheduleInputSchema,
		updateTemplateInstance: m.update,
	};
});
vi.mock("../../../lib/report-access", () => ({
	assertCanEditReportInstance: m.assertCanEdit,
	canManageReportLifecycle: async () => true,
}));
vi.mock("../../../lib/validate-connections", () => ({
	validateReportConnections: m.validate,
}));
vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		input: () => chain,
		handler: (fn: (args: unknown) => Promise<unknown>) => {
			m.handler = fn;
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_READ: "REPORT_READ" },
		requireInputOrgPermission: () => () => chain,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? "example-org",
	};
});

import "../update";

const OWNER = "example-owner";
const EDITOR = "example-editor";
const board = {
	resourceId: "board-1",
	resourceName: "Example board",
	resourceType: "board",
};
const stored = {
	mcpConfigs: ["example-owner-config"],
	mcpBindings: { fizzy: "example-owner-config" },
	workflows: [],
	agents: [],
	workspaces: [],
	integrations: [],
	integrationBindings: {},
	context: { boardName: "Example board" },
	resourceBindings: { fizzy: board },
	parameterBindings: { fizzy: { team: "Example team" } },
};

function save(
	connections: Record<string, unknown>,
	userId = EDITOR,
	extra: Record<string, unknown> = {},
) {
	if (!m.handler) {
		throw new Error("The procedure did not register a handler");
	}
	return m.handler({
		input: { id: "example-report", connections, ...extra },
		context: {
			user: { id: userId, role: "user" },
			session: { activeOrganizationId: "example-org" },
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.access.mockResolvedValue(true);
	m.assertCanEdit.mockResolvedValue(undefined);
	m.instance.mockResolvedValue({
		id: "example-report",
		userId: OWNER,
		organizationId: "example-org",
		projectId: "example-project",
		status: "ACTIVE",
		connections: stored,
		fabricConfig: null,
		template: { definition: {} },
	});
	m.validate.mockResolvedValue({ valid: true, errors: [] });
	m.update.mockResolvedValue({
		id: "example-report",
		sId: "example-sid",
		version: 1,
		status: "ACTIVE",
		name: "Example report",
		description: null,
		isActive: true,
		updatedAt: new Date(),
	});
});

describe("for someone who does not own a connected report", () => {
	it.each([
		["the context", { context: { boardName: "Another board" } }],
		[
			"the bound resource",
			{
				resourceBindings: {
					fizzy: { ...board, resourceId: "board-2" },
				},
			},
		],
		[
			"the data source parameters",
			{ parameterBindings: { fizzy: { team: "Another team" } } },
		],
		["the context, by removing it", { context: {} }],
	])("refuses a change to %s, and says why", async (_label, change) => {
		await expect(save({ ...stored, ...change })).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: expect.stringContaining("Only the report's owner"),
		});
		expect(m.update).not.toHaveBeenCalled();
	});

	it("saves the stored values sent back unchanged", async () => {
		await save(stored);

		expect(m.update).toHaveBeenCalledTimes(1);
	});

	it("saves stored values the page sent back in another shape", async () => {
		await save({
			...stored,
			context: { boardName: " Example board ", extra: "  " },
		});

		expect(m.update).toHaveBeenCalledTimes(1);
	});

	it("leaves the report's prompts open, which run on the owner's read-only tools", async () => {
		await save(
			{
				...stored,
				promptOverride: "Keep the risks short",
				promptOverrideSource: "user",
			},
			EDITOR,
			{ fabricConfig: { customSystemPrompt: "Answer briefly" } },
		);

		expect(m.update).toHaveBeenCalledTimes(1);
	});
});

it("lets the owner change what their connections read", async () => {
	await save({ ...stored, context: { boardName: "Another board" } }, OWNER);

	expect(m.update).toHaveBeenCalledTimes(1);
});

it("has nothing to protect on a report with no connection", async () => {
	m.instance.mockResolvedValue({
		id: "example-report",
		userId: OWNER,
		organizationId: "example-org",
		projectId: "example-project",
		status: "ACTIVE",
		connections: {},
		fabricConfig: null,
		template: { definition: {} },
	});

	await save({ ...stored, mcpConfigs: [], mcpBindings: {} });

	expect(m.update).toHaveBeenCalledTimes(1);
});
