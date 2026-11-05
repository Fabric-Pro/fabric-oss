import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	getTemplateInstance: vi.fn(),
	canEditReportInstance: vi.fn(),
	canDeleteReportInstance: vi.fn(),
	canManageReportLifecycle: vi.fn(),
	canManageReportTemplate: vi.fn(),
	isOrganizationReportAdmin: vi.fn(),
	canEditProjectReport: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getTemplateInstance: mocks.getTemplateInstance,
	getProjectReportSetupReason: () => undefined,
}));

vi.mock("../../../lib/report-access", () => ({
	canDeleteReportInstance: mocks.canDeleteReportInstance,
	canManageReportLifecycle: mocks.canManageReportLifecycle,
	canEditProjectReport: mocks.canEditProjectReport,
	canEditReportInstance: mocks.canEditReportInstance,
	canGenerateReportInstance: (
		instance: { userId: string },
		user: { id: string },
	) => instance.userId === user.id,
	canManageReportTemplate: mocks.canManageReportTemplate,
	isOrganizationReportAdmin: mocks.isOrganizationReportAdmin,
}));

vi.mock("../../../../../orpc/procedures", () => {
	function makeChainable() {
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			use: () => c,
			input: () => c,
			handler: (fn: (...args: unknown[]) => unknown) => {
				mocks.handlers.get = fn;
				return { _handler: fn };
			},
		});
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: { REPORT_READ: "REPORT_READ" },
		requireInputOrgPermission: () => (c: unknown) => c,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? "example-org",
	};
});

import "../get";

const ctx = {
	user: { id: "example-member", role: "user" },
	session: { activeOrganizationId: "example-org" },
};

function instanceFrom(template: Record<string, unknown>) {
	return {
		id: "example-instance",
		organizationId: "example-org",
		projectId: "example-project",
		userId: "example-member",
		name: "Team status",
		description: null,
		templateId: "example-template",
		template: {
			id: "example-template",
			name: "Weekly status",
			description: null,
			heroEmojis: [],
			templateType: "CUSTOM",
			outputFormat: "MARKDOWN",
			definition: {},
			parameters: null,
			connections: null,
			fabricConfig: null,
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			archivedAt: null,
			...template,
		},
		connections: {},
		parameterDefaults: null,
		fabricConfig: null,
		schedule: null,
		scheduleMode: "INHERITED",
		isActive: true,
		lastRunAt: null,
		nextRunAt: null,
		createdAt: new Date("2026-11-01T00:00:00.000Z"),
		updatedAt: new Date("2026-11-01T00:00:00.000Z"),
		_count: { executions: 0 },
		executions: [],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.canEditReportInstance.mockResolvedValue(true);
	mocks.canDeleteReportInstance.mockResolvedValue(true);
	mocks.canManageReportLifecycle.mockResolvedValue(true);
	mocks.canManageReportTemplate.mockResolvedValue(false);
	mocks.isOrganizationReportAdmin.mockResolvedValue(true);
	mocks.canEditProjectReport.mockResolvedValue(false);
});

describe("reports.instances.get — someone who only reads the report", () => {
	it("offers no save, whichever template or organization rights they hold", async () => {
		mocks.canEditReportInstance.mockResolvedValue(false);
		mocks.canManageReportTemplate.mockResolvedValue(true);
		mocks.isOrganizationReportAdmin.mockResolvedValue(true);
		mocks.canEditProjectReport.mockResolvedValue(true);
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({
			canEdit: false,
			canSaveToTemplate: false,
			canSetOrganizationDefault: false,
			canSetOrganizationPrompts: false,
			canSetProjectDefault: false,
		});
	});
});

describe("reports.instances.get — edit and delete", () => {
	it("tells an editor who may not delete apart from one who may", async () => {
		mocks.canDeleteReportInstance.mockResolvedValue(false);
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		await expect(
			mocks.handlers.get({
				input: { id: "example-instance" },
				context: ctx,
			}),
		).resolves.toMatchObject({ canEdit: true, canDelete: false });
		expect(mocks.canDeleteReportInstance).toHaveBeenCalledWith(
			expect.objectContaining({ id: "example-instance" }),
			ctx.user,
		);

		mocks.canDeleteReportInstance.mockResolvedValue(true);
		await expect(
			mocks.handlers.get({
				input: { id: "example-instance" },
				context: ctx,
			}),
		).resolves.toMatchObject({ canEdit: true, canDelete: true });
	});
});

describe("reports.instances.get — lifecycle", () => {
	it("tells an editor who may not schedule the report apart from one who may", async () => {
		mocks.canManageReportLifecycle.mockResolvedValue(false);
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		await expect(
			mocks.handlers.get({
				input: { id: "example-instance" },
				context: ctx,
			}),
		).resolves.toMatchObject({ canEdit: true, canManageLifecycle: false });
		expect(mocks.canManageReportLifecycle).toHaveBeenCalledWith(
			expect.objectContaining({ id: "example-instance" }),
			ctx.user,
		);

		mocks.canManageReportLifecycle.mockResolvedValue(true);
		await expect(
			mocks.handlers.get({
				input: { id: "example-instance" },
				context: ctx,
			}),
		).resolves.toMatchObject({ canEdit: true, canManageLifecycle: true });
	});
});

describe("reports.instances.get — save-to-template choices", () => {
	it("offers an organization admin the organization default for a SYSTEM template", async () => {
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({
			template: { scope: "SYSTEM" },
			canSaveToTemplate: false,
			canSetOrganizationDefault: true,
		});
		expect(mocks.isOrganizationReportAdmin).toHaveBeenCalledWith(
			"example-org",
			"example-member",
		);
	});

	it("offers to update the template to whoever may change it", async () => {
		mocks.canManageReportTemplate.mockResolvedValue(true);
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({ canSaveToTemplate: true });
		expect(mocks.canManageReportTemplate).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "SYSTEM" }),
			ctx.user,
		);
	});

	it("offers an organization default of parameters only for the organization's own template", async () => {
		mocks.getTemplateInstance.mockResolvedValue(
			instanceFrom({
				scope: "ORGANIZATION",
				organizationId: "example-org",
			}),
		);

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({
			canSetOrganizationDefault: true,
			canSetOrganizationPrompts: false,
		});
	});

	it("offers the organization's prompts default for a template it does not own", async () => {
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({ canSetOrganizationPrompts: true });
	});

	it("offers the project default to whoever may edit the project's reports", async () => {
		mocks.canEditProjectReport.mockResolvedValue(true);
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({ canSetProjectDefault: true });
		expect(mocks.canEditProjectReport).toHaveBeenCalledWith(
			"example-project",
			ctx.user,
		);
	});

	it("offers no project default to someone else, or for a report outside a project", async () => {
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));
		await expect(
			mocks.handlers.get({
				input: { id: "example-instance" },
				context: ctx,
			}),
		).resolves.toMatchObject({ canSetProjectDefault: false });

		mocks.canEditProjectReport.mockResolvedValue(true);
		mocks.getTemplateInstance.mockResolvedValue({
			...instanceFrom({}),
			projectId: null,
		});
		await expect(
			mocks.handlers.get({
				input: { id: "example-instance" },
				context: ctx,
			}),
		).resolves.toMatchObject({ canSetProjectDefault: false });
	});

	it("offers no organization default to a member who is not an admin", async () => {
		mocks.isOrganizationReportAdmin.mockResolvedValue(false);
		mocks.getTemplateInstance.mockResolvedValue(instanceFrom({}));

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({ canSetOrganizationDefault: false });
	});

	it("offers no template update once the template is archived", async () => {
		mocks.canManageReportTemplate.mockResolvedValue(true);
		mocks.getTemplateInstance.mockResolvedValue(
			instanceFrom({ archivedAt: new Date("2026-11-04T00:00:00.000Z") }),
		);

		const result = await mocks.handlers.get({
			input: { id: "example-instance" },
			context: ctx,
		});

		expect(result).toMatchObject({ canSaveToTemplate: false });
		expect(mocks.canManageReportTemplate).not.toHaveBeenCalled();
	});
});
