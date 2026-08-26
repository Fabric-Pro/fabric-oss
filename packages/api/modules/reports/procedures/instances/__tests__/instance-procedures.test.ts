import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
	handlers,
	mockCreateTemplateInstance,
	mockGetReportTemplate,
	mockGetTemplateInstance,
	mockUpdateTemplateInstance,
	mockValidateReportConnections,
	mockTemplateScheduleForInheritance,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockCreateTemplateInstance: vi.fn(),
	mockGetReportTemplate: vi.fn(),
	mockGetTemplateInstance: vi.fn(),
	mockUpdateTemplateInstance: vi.fn(),
	mockValidateReportConnections: vi.fn(),
	mockTemplateScheduleForInheritance: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	// Pull reportScheduleInputSchema from the real module (pure Zod — no DB).
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		reportScheduleInputSchema: real.reportScheduleInputSchema,
		createTemplateInstance: (...a: unknown[]) =>
			mockCreateTemplateInstance(...a),
		getReportTemplate: (...a: unknown[]) => mockGetReportTemplate(...a),
		getTemplateInstance: (...a: unknown[]) => mockGetTemplateInstance(...a),
		updateTemplateInstance: (...a: unknown[]) =>
			mockUpdateTemplateInstance(...a),
		// Used by resolve-instance-schedule.ts → templateScheduleForInheritance
		ownerScopedTemplateSchedule: (...a: unknown[]) =>
			mockTemplateScheduleForInheritance(...a),
	};
});

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

vi.mock("../../lib/validate-connections", () => ({
	validateReportConnections: (...a: unknown[]) =>
		mockValidateReportConnections(...a),
}));

// Chainable oRPC procedure stub — captures the handler fn by the order modules
// are imported: update first, then create.
vi.mock("../../../../../orpc/procedures", () => {
	let callCount = 0;
	const names = ["update", "create"];
	function makeChainable() {
		const idx = callCount++;
		const name = names[idx] ?? `proc${idx}`;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			use: () => c,
			route: () => c,
			input: () => c,
			handler: (fn: (...args: unknown[]) => unknown) => {
				handlers[name] = fn;
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
			REPORT_UPDATE: "REPORT_UPDATE",
			REPORT_CREATE: "REPORT_CREATE",
		},
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		requireOrganizationMembership: vi.fn().mockResolvedValue(undefined),
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? null,
	};
});

// Import procedure modules AFTER mock declarations so vi.mock hoisting applies.
import "../update";
import "../create";
import { updateInstanceInputSchema } from "../update";

// ── Schema-validation tests (Task 7 TDD) ────────────────────────────────────

describe("updateInstanceInputSchema — scheduleUpdate validation", () => {
	it("accepts inherit and off without a schedule field", () => {
		expect(
			updateInstanceInputSchema.safeParse({
				id: "i1",
				scheduleUpdate: { mode: "inherit" },
			}).success,
		).toBe(true);
		expect(
			updateInstanceInputSchema.safeParse({
				id: "i1",
				scheduleUpdate: { mode: "off" },
			}).success,
		).toBe(true);
	});

	it("accepts custom with a valid schedule", () => {
		expect(
			updateInstanceInputSchema.safeParse({
				id: "i1",
				scheduleUpdate: {
					mode: "custom",
					schedule: { frequency: "daily" },
				},
			}).success,
		).toBe(true);
	});

	it("rejects custom without a schedule", () => {
		expect(
			updateInstanceInputSchema.safeParse({
				id: "i1",
				scheduleUpdate: { mode: "custom" },
			}).success,
		).toBe(false);
	});

	it("rejects custom with an invalid IANA timezone", () => {
		expect(
			updateInstanceInputSchema.safeParse({
				id: "i1",
				scheduleUpdate: {
					mode: "custom",
					schedule: { frequency: "daily", timezone: "Not/AZone" },
				},
			}).success,
		).toBe(false);
	});

	it("treats omitted scheduleUpdate as valid (no-op)", () => {
		expect(
			updateInstanceInputSchema.safeParse({ id: "i1", name: "x" })
				.success,
		).toBe(true);
	});
});

// ── Shared handler context ───────────────────────────────────────────────────

const ctx = {
	user: { id: "u1", email: "u@x.com" },
	session: { id: "s1", activeOrganizationId: null },
	headers: undefined,
};

const baseInstance = {
	id: "inst-1",
	template: { definition: null },
};

const baseUpdated = {
	id: "inst-1",
	sId: "si-1",
	version: 1,
	status: "ACTIVE",
	name: "n",
	description: null,
	isActive: true,
	updatedAt: new Date(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mockValidateReportConnections.mockResolvedValue({
		valid: true,
		errors: [],
	});
	mockGetTemplateInstance.mockResolvedValue(baseInstance);
	mockUpdateTemplateInstance.mockResolvedValue(baseUpdated);
});

// ── Handler regression test (Task 7) ────────────────────────────────────────
// Confirms the handler forwards scheduleUpdate (not a raw schedule) to the query.

describe("updateInstanceProcedure handler — scheduleUpdate forwarding", () => {
	it("forwards scheduleUpdate:inherit to updateTemplateInstance (not raw schedule)", async () => {
		await handlers.update({
			input: { id: "inst-1", scheduleUpdate: { mode: "inherit" } },
			context: ctx,
		});
		expect(mockUpdateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({ scheduleUpdate: { mode: "inherit" } }),
		);
		// Must NOT contain a bare `schedule` key (the regression path).
		const call = mockUpdateTemplateInstance.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(call).not.toHaveProperty("schedule");
	});

	it("does not pass scheduleUpdate when omitted (no-op)", async () => {
		await handlers.update({
			input: { id: "inst-1", name: "renamed" },
			context: ctx,
		});
		const call = mockUpdateTemplateInstance.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(call).not.toHaveProperty("scheduleUpdate");
		expect(call).not.toHaveProperty("schedule");
	});
});

// ── Create-provenance test (Task 4 deferred, D2/§7.1) ───────────────────────
// Asserts that omitting input.schedule yields scheduleMode:"INHERITED" even when
// the template has a schedule, and that providing input.schedule yields "CUSTOM".

describe("createInstanceProcedure — scheduleMode provenance (D2/§7.1)", () => {
	beforeEach(() => {
		mockGetReportTemplate.mockResolvedValue({
			id: "t1",
			scope: "USER",
			userId: "u1",
			organizationId: null,
			// Template has its own schedule — should be inherited but mode must still
			// reflect the INSTANCE's own provenance, not the merged effectiveSchedule.
			schedule: {
				frequency: "weekly",
				dayOfWeek: 1,
				hour: 9,
				minute: 0,
				timezone: "UTC",
			},
			definition: null,
		});
		mockCreateTemplateInstance.mockResolvedValue({
			id: "inst-new",
			sId: "si-new",
			version: 1,
			name: "My Report",
			templateId: "t1",
			createdAt: new Date(),
		});
		// templateScheduleForInheritance returns the template's schedule for the
		// matching owner — simulates the template-inheritance path.
		mockTemplateScheduleForInheritance.mockReturnValue({
			frequency: "weekly",
			dayOfWeek: 1,
			hour: 9,
			minute: 0,
			timezone: "UTC",
		});
	});

	it("passes scheduleMode:INHERITED when input.schedule is omitted (template schedule is inherited)", async () => {
		await handlers.create({
			input: {
				templateId: "t1",
				name: "My Report",
				connections: {
					mcpConfigs: [],
					workflows: [],
					agents: [],
					workspaces: [],
					integrations: [],
				},
				// deliberately NO `schedule` key
			},
			context: ctx,
		});

		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({ scheduleMode: "INHERITED" }),
		);
		// Even though effectiveSchedule was inherited from the template, the mode
		// must reflect the INSTANCE's own provenance (i.e. the caller did not supply one).
		const call = mockCreateTemplateInstance.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(call).not.toHaveProperty("scheduleMode", "CUSTOM");
	});

	it("passes scheduleMode:CUSTOM when input.schedule is explicitly provided", async () => {
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Custom-scheduled Report",
				connections: {
					mcpConfigs: [],
					workflows: [],
					agents: [],
					workspaces: [],
					integrations: [],
				},
				schedule: { frequency: "daily" },
			},
			context: ctx,
		});

		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({ scheduleMode: "CUSTOM" }),
		);
	});
});
