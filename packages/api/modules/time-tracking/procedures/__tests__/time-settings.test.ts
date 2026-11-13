/**
 * The project and organization time-tracking settings procedures.
 *
 * Same seams as `time-tracking.test.ts`: the permission and visibility
 * middleware are pinned by their declaration, the query functions of
 * `@repo/database` and the audit helper are mocked, and the pure policy rules
 * run for real.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loadTimeTrackingProject: vi.fn(),
	updateProjectTimeSettings: vi.fn(),
	loadOrganizationTimePolicy: vi.fn(),
	updateOrganizationTimePolicy: vi.fn(),
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		loadTimeTrackingProject: mocks.loadTimeTrackingProject,
		updateProjectTimeSettings: mocks.updateProjectTimeSettings,
		loadOrganizationTimePolicy: mocks.loadOrganizationTimePolicy,
		updateOrganizationTimePolicy: mocks.updateOrganizationTimePolicy,
	};
});

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

type Declaration = {
	kind: string;
	permission?: string;
	options?: { requireOrganization?: boolean };
};

const VISIBLE: Declaration = { kind: "visible" };

vi.mock("../../../../orpc/middleware/project-visibility", () => ({
	PROJECT_NOT_FOUND_MESSAGE: "Project not found",
	projectNotFoundUnlessVisible: { kind: "visible" },
}));
type Handler = (args: { input: unknown; context: unknown }) => Promise<any>;

vi.mock("../../../../orpc/procedures", async () => {
	const { Permissions } = await import("@repo/permissions");
	const builder = (declared: Declaration[]): any => ({
		use: (declaration: Declaration) => builder([...declared, declaration]),
		route: () => builder(declared),
		input: () => builder(declared),
		output: () => builder(declared),
		handler: (fn: Handler) => ({ __handler: fn, __declared: declared }),
	});
	return {
		Permissions,
		tenantProtectedProcedure: builder([]),
		requireProjectPermission: (permission: string) => ({
			kind: "project",
			permission,
		}),
		requireInputOrgPermission: (
			permission: string,
			options?: { requireOrganization?: boolean },
		) => ({ kind: "input-org", permission, options }),
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

const { Permissions } = await import("@repo/permissions");
const {
	getProjectTimeSettingsInputSchema,
	getProjectTimeSettingsProcedure,
	updateProjectTimeSettingsInputSchema,
	updateProjectTimeSettingsProcedure,
} = await import("../project-settings");
const {
	getOrganizationTimeSettingsInputSchema,
	getOrganizationTimeSettingsProcedure,
	updateOrganizationTimeSettingsInputSchema,
	updateOrganizationTimeSettingsProcedure,
} = await import("../organization-settings");

type StubbedProcedure = { __handler: Handler; __declared: Declaration[] };

function stub(procedure: unknown): StubbedProcedure {
	return procedure as StubbedProcedure;
}

const ORG_ID = "org-1";
const PROJECT_ID = "project-1";
const context = {
	user: { id: "user-1" },
	session: { activeOrganizationId: ORG_ID },
};

function call(
	procedure: unknown,
	schema: { parse: (input: unknown) => unknown },
	input: unknown,
) {
	return stub(procedure).__handler({ input: schema.parse(input), context });
}

type Policy = {
	timeRequireStartStop: boolean;
	timeDefaultBillable: boolean | null;
};

function projectRow(
	overrides: Partial<
		{
			billingModel: "FIXED_BID" | "TIME_AND_MATERIALS";
			deletedAt: Date | null;
			organizationId: string | null;
			organization: Policy | null;
		} & Policy
	> = {},
) {
	return {
		id: PROJECT_ID,
		name: "Example project",
		organizationId: ORG_ID,
		deletedAt: null,
		status: "ACTIVE",
		billingModel: "FIXED_BID",
		timeRequireStartStop: false,
		timeDefaultBillable: null,
		organization: {
			timeRequireStartStop: false,
			timeDefaultBillable: null,
		},
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.loadTimeTrackingProject.mockResolvedValue(projectRow());
	mocks.updateProjectTimeSettings.mockImplementation(
		async ({ values }: { values: Parameters<typeof projectRow>[0] }) =>
			projectRow(values),
	);
	mocks.loadOrganizationTimePolicy.mockResolvedValue({
		timeRequireStartStop: false,
		timeDefaultBillable: null,
	});
	mocks.updateOrganizationTimePolicy.mockImplementation(
		async ({ values }: { values: Partial<Policy> }) => ({
			timeRequireStartStop: false,
			timeDefaultBillable: null,
			...values,
		}),
	);
});

describe("getProjectSettings", () => {
	it("is gated on seeing the project, then PROJECT_SETTINGS_READ", () => {
		expect(stub(getProjectTimeSettingsProcedure).__declared).toEqual([
			VISIBLE,
			{ kind: "project", permission: Permissions.PROJECT_SETTINGS_READ },
		]);
	});

	it("returns the project's settings, the organization's, and the effective policy", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			projectRow({
				billingModel: "TIME_AND_MATERIALS",
				timeRequireStartStop: false,
				timeDefaultBillable: null,
				organization: {
					timeRequireStartStop: true,
					timeDefaultBillable: false,
				},
			}),
		);

		const result = await call(
			getProjectTimeSettingsProcedure,
			getProjectTimeSettingsInputSchema,
			{ projectId: PROJECT_ID },
		);

		expect(result).toEqual({
			projectId: PROJECT_ID,
			billingModel: "TIME_AND_MATERIALS",
			timeRequireStartStop: false,
			timeDefaultBillable: null,
			organization: {
				timeRequireStartStop: true,
				timeDefaultBillable: false,
			},
			effective: { startStopRequired: true, defaultBillable: false },
		});
	});

	it("refuses a soft-deleted project as not found", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			projectRow({ deletedAt: new Date("2026-01-01T00:00:00Z") }),
		);

		await expect(
			call(
				getProjectTimeSettingsProcedure,
				getProjectTimeSettingsInputSchema,
				{
					projectId: PROJECT_ID,
				},
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("refuses a personal project as not found", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			projectRow({ organizationId: null, organization: null }),
		);

		await expect(
			call(
				getProjectTimeSettingsProcedure,
				getProjectTimeSettingsInputSchema,
				{
					projectId: PROJECT_ID,
				},
			),
		).rejects.toBeInstanceOf(ORPCError);
	});
});

describe("updateProjectSettings", () => {
	it("is gated on seeing the project, then PROJECT_SETTINGS_EDIT", () => {
		expect(stub(updateProjectTimeSettingsProcedure).__declared).toEqual([
			VISIBLE,
			{ kind: "project", permission: Permissions.PROJECT_SETTINGS_EDIT },
		]);
	});

	it("accepts null for the billable default and refuses an unknown billing model", () => {
		expect(
			updateProjectTimeSettingsInputSchema.safeParse({
				projectId: PROJECT_ID,
				timeDefaultBillable: null,
			}).success,
		).toBe(true);
		expect(
			updateProjectTimeSettingsInputSchema.safeParse({
				projectId: PROJECT_ID,
				billingModel: "RETAINER",
			}).success,
		).toBe(false);
	});

	it("writes only the fields given that change something", async () => {
		await call(
			updateProjectTimeSettingsProcedure,
			updateProjectTimeSettingsInputSchema,
			{
				projectId: PROJECT_ID,
				billingModel: "TIME_AND_MATERIALS",
				timeRequireStartStop: false,
			},
		);

		expect(mocks.updateProjectTimeSettings).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			values: { billingModel: "TIME_AND_MATERIALS" },
		});
	});

	it("records the change with its before and after values", async () => {
		await call(
			updateProjectTimeSettingsProcedure,
			updateProjectTimeSettingsInputSchema,
			{
				projectId: PROJECT_ID,
				billingModel: "TIME_AND_MATERIALS",
				timeDefaultBillable: false,
			},
		);

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(context, {
			action: "project.updated",
			category: "project",
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
			resource: {
				type: "project",
				id: PROJECT_ID,
				name: "Example project",
			},
			metadata: {
				operation: "time_settings_updated",
				changedFields: ["billingModel", "timeDefaultBillable"],
				changes: {
					billingModel: {
						before: "FIXED_BID",
						after: "TIME_AND_MATERIALS",
					},
					timeDefaultBillable: { before: null, after: false },
				},
			},
		});
	});

	it("writes nothing and records nothing when no value changes", async () => {
		const result = await call(
			updateProjectTimeSettingsProcedure,
			updateProjectTimeSettingsInputSchema,
			{
				projectId: PROJECT_ID,
				billingModel: "FIXED_BID",
				timeRequireStartStop: false,
				timeDefaultBillable: null,
			},
		);

		expect(mocks.updateProjectTimeSettings).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(result.billingModel).toBe("FIXED_BID");
	});

	it("sets the billable default back to null to inherit the organization's", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			projectRow({
				timeDefaultBillable: false,
				organization: {
					timeRequireStartStop: false,
					timeDefaultBillable: true,
				},
			}),
		);
		mocks.updateProjectTimeSettings.mockResolvedValue(
			projectRow({
				timeDefaultBillable: null,
				organization: {
					timeRequireStartStop: false,
					timeDefaultBillable: true,
				},
			}),
		);

		const result = await call(
			updateProjectTimeSettingsProcedure,
			updateProjectTimeSettingsInputSchema,
			{ projectId: PROJECT_ID, timeDefaultBillable: null },
		);

		expect(mocks.updateProjectTimeSettings).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			values: { timeDefaultBillable: null },
		});
		expect(result.timeDefaultBillable).toBeNull();
		expect(result.effective.defaultBillable).toBe(true);
	});

	it("keeps the organization's start/stop requirement in force when the project drops its own", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			projectRow({
				timeRequireStartStop: true,
				organization: {
					timeRequireStartStop: true,
					timeDefaultBillable: null,
				},
			}),
		);
		mocks.updateProjectTimeSettings.mockResolvedValue(
			projectRow({
				timeRequireStartStop: false,
				organization: {
					timeRequireStartStop: true,
					timeDefaultBillable: null,
				},
			}),
		);

		const result = await call(
			updateProjectTimeSettingsProcedure,
			updateProjectTimeSettingsInputSchema,
			{ projectId: PROJECT_ID, timeRequireStartStop: false },
		);

		expect(result.timeRequireStartStop).toBe(false);
		expect(result.effective.startStopRequired).toBe(true);
	});

	it("refuses a soft-deleted project before writing", async () => {
		mocks.loadTimeTrackingProject.mockResolvedValue(
			projectRow({ deletedAt: new Date("2026-01-01T00:00:00Z") }),
		);

		await expect(
			call(
				updateProjectTimeSettingsProcedure,
				updateProjectTimeSettingsInputSchema,
				{ projectId: PROJECT_ID, billingModel: "TIME_AND_MATERIALS" },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.updateProjectTimeSettings).not.toHaveBeenCalled();
	});
});

describe("getOrganizationSettings", () => {
	it("is gated on reading the organization", () => {
		expect(stub(getOrganizationTimeSettingsProcedure).__declared).toEqual([
			{
				kind: "input-org",
				permission: Permissions.ORG_READ,
				options: { requireOrganization: true },
			},
		]);
	});

	it("returns the policy and what a project with no settings resolves to", async () => {
		const result = await call(
			getOrganizationTimeSettingsProcedure,
			getOrganizationTimeSettingsInputSchema,
			{ organizationId: ORG_ID },
		);

		expect(result).toEqual({
			organizationId: ORG_ID,
			timeRequireStartStop: false,
			timeDefaultBillable: null,
			effective: { startStopRequired: false, defaultBillable: true },
		});
	});

	it("is not found for an organization that does not exist", async () => {
		mocks.loadOrganizationTimePolicy.mockResolvedValue(null);

		await expect(
			call(
				getOrganizationTimeSettingsProcedure,
				getOrganizationTimeSettingsInputSchema,
				{ organizationId: ORG_ID },
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("updateOrganizationSettings", () => {
	it("is gated on updating the organization", () => {
		expect(
			stub(updateOrganizationTimeSettingsProcedure).__declared,
		).toEqual([
			{
				kind: "input-org",
				permission: Permissions.ORG_UPDATE,
				options: { requireOrganization: true },
			},
		]);
	});

	it("writes only the fields given that change something", async () => {
		await call(
			updateOrganizationTimeSettingsProcedure,
			updateOrganizationTimeSettingsInputSchema,
			{
				organizationId: ORG_ID,
				timeRequireStartStop: true,
			},
		);

		expect(mocks.updateOrganizationTimePolicy).toHaveBeenCalledWith({
			organizationId: ORG_ID,
			values: { timeRequireStartStop: true },
		});
	});

	it("records the change with its before and after values", async () => {
		const result = await call(
			updateOrganizationTimeSettingsProcedure,
			updateOrganizationTimeSettingsInputSchema,
			{
				organizationId: ORG_ID,
				timeRequireStartStop: true,
				timeDefaultBillable: false,
			},
		);

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditFromRequest).toHaveBeenCalledWith(context, {
			action: "org.settings.updated",
			category: "org",
			organizationId: ORG_ID,
			resource: { type: "organization", id: ORG_ID, name: null },
			metadata: {
				setting: "time_tracking",
				changes: {
					timeRequireStartStop: { before: false, after: true },
					timeDefaultBillable: { before: null, after: false },
				},
			},
		});
		expect(result.effective).toEqual({
			startStopRequired: true,
			defaultBillable: false,
		});
	});

	it("writes nothing and records nothing when no value changes", async () => {
		mocks.loadOrganizationTimePolicy.mockResolvedValue({
			timeRequireStartStop: true,
			timeDefaultBillable: false,
		});

		await call(
			updateOrganizationTimeSettingsProcedure,
			updateOrganizationTimeSettingsInputSchema,
			{
				organizationId: ORG_ID,
				timeRequireStartStop: true,
				timeDefaultBillable: false,
			},
		);

		expect(mocks.updateOrganizationTimePolicy).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("does not take null for the organization's billable default", () => {
		expect(
			updateOrganizationTimeSettingsInputSchema.safeParse({
				organizationId: ORG_ID,
				timeDefaultBillable: null,
			}).success,
		).toBe(false);
	});
});
