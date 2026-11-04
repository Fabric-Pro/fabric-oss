import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	getReportTemplate: vi.fn(),
	getReportTemplateOverrides: vi.fn(),
	setReportTemplateOverride: vi.fn(),
	clearReportTemplateOverride: vi.fn(),
	isFeatureEnabled: vi.fn(),
	assertProjectPermission: vi.fn(),
	canEditProjectReport: vi.fn(),
	canSetOrganizationReportDefaults: vi.fn(),
	hasOrganizationReportPermission: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		reportScheduleInputSchema: real.reportScheduleInputSchema,
		mergeReportTemplateOverrides: real.mergeReportTemplateOverrides,
		getReportTemplate: mocks.getReportTemplate,
		getReportTemplateOverrides: mocks.getReportTemplateOverrides,
		setReportTemplateOverride: mocks.setReportTemplateOverride,
		clearReportTemplateOverride: mocks.clearReportTemplateOverride,
		isFeatureEnabled: mocks.isFeatureEnabled,
	};
});

vi.mock("../../../lib/report-access", () => ({
	canEditProjectReport: mocks.canEditProjectReport,
	canSetOrganizationReportDefaults: mocks.canSetOrganizationReportDefaults,
	hasOrganizationReportPermission: mocks.hasOrganizationReportPermission,
}));

vi.mock("../../../../../orpc/procedures", () => {
	let callCount = 0;
	const names = ["get", "set"];
	function makeChainable() {
		const name = names[callCount++];
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			use: () => c,
			input: () => c,
			handler: (fn: (...args: unknown[]) => unknown) => {
				mocks.handlers[name] = fn;
				return { _handler: fn };
			},
		});
		return c;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: {
			REPORT_READ: "REPORT_READ",
			REPORT_UPDATE: "REPORT_UPDATE",
		},
		assertProjectPermission: mocks.assertProjectPermission,
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? "example-org",
	};
});

import { setTemplateOverrideInputSchema } from "../overrides";

const ctx = {
	user: { id: "example-member", role: "user" },
	session: { activeOrganizationId: "example-org" },
};
const defaults = {
	parameterDefaults: { team: "Example team" },
	context: null,
	schedule: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getReportTemplate.mockResolvedValue({ id: "example-template" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.assertProjectPermission.mockResolvedValue(undefined);
	mocks.canEditProjectReport.mockResolvedValue(true);
	mocks.canSetOrganizationReportDefaults.mockResolvedValue(false);
	mocks.hasOrganizationReportPermission.mockResolvedValue(true);
	mocks.getReportTemplateOverrides.mockResolvedValue({
		organization: null,
		project: null,
	});
});

describe("reports.templates.overrides.set", () => {
	it("lets a project Editor set the project's defaults", async () => {
		await mocks.handlers.set({
			input: {
				templateId: "example-template",
				projectId: "example-project",
				scope: "PROJECT",
				defaults,
			},
			context: ctx,
		});

		expect(mocks.assertProjectPermission).toHaveBeenCalledWith(
			"example-project",
			"example-member",
			"REPORT_READ",
		);
		expect(mocks.setReportTemplateOverride).toHaveBeenCalledWith(
			{
				templateId: "example-template",
				organizationId: "example-org",
				projectId: "example-project",
			},
			expect.objectContaining({
				parameterDefaults: { team: "Example team" },
				updatedById: "example-member",
			}),
		);
	});

	it("refuses the organization's defaults to anyone but its admins and owners", async () => {
		await expect(
			mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "ORGANIZATION",
					defaults,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
	});

	it("writes the organization scope with no project for an admin", async () => {
		mocks.canSetOrganizationReportDefaults.mockResolvedValue(true);

		await mocks.handlers.set({
			input: {
				templateId: "example-template",
				projectId: "example-project",
				scope: "ORGANIZATION",
				defaults,
			},
			context: ctx,
		});

		expect(mocks.setReportTemplateOverride.mock.calls[0][0]).toEqual({
			templateId: "example-template",
			organizationId: "example-org",
			projectId: null,
		});
	});

	it("refuses a project Viewer", async () => {
		mocks.canEditProjectReport.mockResolvedValue(false);

		await expect(
			mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
	});

	it("clears a scope saved empty", async () => {
		await mocks.handlers.set({
			input: {
				templateId: "example-template",
				projectId: "example-project",
				scope: "PROJECT",
				defaults: {
					parameterDefaults: {},
					context: {},
					schedule: null,
				},
			},
			context: ctx,
		});

		expect(mocks.clearReportTemplateOverride).toHaveBeenCalledTimes(1);
		expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
	});

	it("refuses while the report suite is off for the organization", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
	});

	it("refuses a template the caller cannot see", async () => {
		mocks.getReportTemplate.mockResolvedValue(null);

		await expect(
			mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("bounds what a scope may hold", () => {
		expect(
			setTemplateOverrideInputSchema.safeParse({
				templateId: "example-template",
				scope: "ORGANIZATION",
				defaults: {
					parameterDefaults: { team: { nested: true } },
					context: null,
					schedule: null,
				},
			}).success,
		).toBe(false);
	});
});

describe("reports.templates.overrides.get", () => {
	it("returns both scopes' values and what the caller may change", async () => {
		mocks.getReportTemplateOverrides.mockResolvedValue({
			organization: {
				parameterDefaults: { team: "Org team" },
				context: null,
				schedule: { frequency: "weekly", dayOfWeek: 1 },
				updatedAt: new Date("2026-11-04T00:00:00Z"),
			},
			project: null,
		});

		const result = await mocks.handlers.get({
			input: {
				templateId: "example-template",
				projectId: "example-project",
			},
			context: ctx,
		});

		expect(result).toMatchObject({
			organization: {
				parameterDefaults: { team: "Org team" },
				context: {},
				schedule: { frequency: "weekly", dayOfWeek: 1 },
			},
			project: null,
			canSetOrganization: false,
			canSetProject: true,
		});
	});

	it("refuses a project guest who is not a member of the organization", async () => {
		mocks.hasOrganizationReportPermission.mockResolvedValue(false);

		await expect(
			mocks.handlers.get({
				input: {
					templateId: "example-template",
					projectId: "example-project",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.hasOrganizationReportPermission).toHaveBeenCalledWith(
			"example-org",
			"example-member",
			"REPORT_READ",
		);
		expect(mocks.getReportTemplateOverrides).not.toHaveBeenCalled();
	});
});
