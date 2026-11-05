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
	mockAssertCanEditReportInstance,
	mockCanCreateProjectReport,
	mockCanManageLifecycle,
	mockAssertProjectPermission,
	mockCanAccess,
	mockFindProject,
	mockOverrides,
} = vi.hoisted(() => ({
	mockFindProject: vi.fn(),
	mockOverrides: vi.fn(),
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockCreateTemplateInstance: vi.fn(),
	mockGetReportTemplate: vi.fn(),
	mockGetTemplateInstance: vi.fn(),
	mockUpdateTemplateInstance: vi.fn(),
	mockValidateReportConnections: vi.fn(),
	mockTemplateScheduleForInheritance: vi.fn(),
	mockAssertCanEditReportInstance: vi.fn(),
	mockCanCreateProjectReport: vi.fn(),
	mockCanManageLifecycle: vi.fn(),
	mockAssertProjectPermission: vi.fn(),
	mockCanAccess: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	// Pull reportScheduleInputSchema from the real module (pure Zod — no DB).
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		reportScheduleInputSchema: real.reportScheduleInputSchema,
		reportEvidenceConfigSchema: real.reportEvidenceConfigSchema,
		readReportEvidenceConfig: real.readReportEvidenceConfig,
		assertPublicReportParameters: real.assertPublicReportParameters,
		publicReportParametersSchema: real.publicReportParametersSchema,
		getProjectReportSetupReason: real.getProjectReportSetupReason,
		hasProjectKnowledgeSource: real.hasProjectKnowledgeSource,
		canAccessReportInstance: mockCanAccess,
		isFeatureEnabled: async () => true,
		db: {
			project: {
				findUnique: (...a: unknown[]) => mockFindProject(...a),
			},
		},
		createTemplateInstance: (...a: unknown[]) =>
			mockCreateTemplateInstance(...a),
		getReportTemplate: (...a: unknown[]) => mockGetReportTemplate(...a),
		resolveReportTemplateDefaults: (...a: unknown[]) => mockOverrides(...a),
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

vi.mock("../../../lib/validate-connections", () => ({
	validateReportConnections: (...a: unknown[]) =>
		mockValidateReportConnections(...a),
}));

vi.mock("../../../lib/report-access", () => ({
	assertReportPermission: async () => undefined,
	assertCanEditReportInstance: (...a: unknown[]) =>
		mockAssertCanEditReportInstance(...a),
	canCreateProjectReport: (...a: unknown[]) =>
		mockCanCreateProjectReport(...a),
	canManageReportLifecycle: (...a: unknown[]) => mockCanManageLifecycle(...a),
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
			REPORT_READ: "REPORT_READ",
			REPORT_UPDATE: "REPORT_UPDATE",
			REPORT_CREATE: "REPORT_CREATE",
		},
		assertProjectPermission: (...a: unknown[]) =>
			mockAssertProjectPermission(...a),
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		requireOrganizationMembership: vi.fn().mockResolvedValue(undefined),
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? "org-1",
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
	user: { id: "u1", email: "u@example.com" },
	session: { id: "s1", activeOrganizationId: "org-1" },
	headers: undefined,
};

const baseInstance = {
	id: "inst-1",
	organizationId: "org-1",
	userId: "u1",
	_count: { executions: 0 },
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
	mockCanAccess.mockResolvedValue(true);
	mockValidateReportConnections.mockResolvedValue({
		valid: true,
		errors: [],
	});
	mockGetTemplateInstance.mockResolvedValue(baseInstance);
	mockUpdateTemplateInstance.mockResolvedValue(baseUpdated);
	mockAssertCanEditReportInstance.mockResolvedValue(undefined);
	mockCanCreateProjectReport.mockResolvedValue(true);
	mockCanManageLifecycle.mockResolvedValue(true);
	mockAssertProjectPermission.mockResolvedValue({
		projectId: "example-project",
		organizationId: "example-org",
	});
	mockOverrides.mockResolvedValue({
		parameterDefaults: {},
		context: {},
		schedule: undefined,
	});
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
			scope: "ORGANIZATION",
			userId: "u1",
			organizationId: "org-1",
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

// ── Authorization ────────────────────────────────────────────────────────────

const emptyConnections = {
	mcpConfigs: [],
	workflows: [],
	agents: [],
	workspaces: [],
	integrations: [],
};

describe("updateInstanceProcedure — who may change a report", () => {
	it("checks the caller against the loaded instance before writing", async () => {
		await handlers.update({
			input: { id: "inst-1", name: "renamed" },
			context: ctx,
		});
		expect(mockAssertCanEditReportInstance).toHaveBeenCalledWith(
			baseInstance,
			ctx.user,
		);
	});

	it("does not write when a same-organization non-owner is refused", async () => {
		mockAssertCanEditReportInstance.mockRejectedValue(
			Object.assign(new Error("forbidden"), { code: "FORBIDDEN" }),
		);
		await expect(
			handlers.update({
				input: { id: "inst-1", name: "renamed" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
	});

	describe("for an editor who may not manage the report's lifecycle", () => {
		beforeEach(() => {
			mockCanManageLifecycle.mockResolvedValue(false);
		});

		it("saves an ordinary edit without asking about the lifecycle", async () => {
			await handlers.update({
				input: { id: "inst-1", name: "renamed" },
				context: ctx,
			});
			expect(mockUpdateTemplateInstance).toHaveBeenCalledTimes(1);
			expect(mockCanManageLifecycle).not.toHaveBeenCalled();
		});

		it.each([
			["set a schedule", { scheduleUpdate: { mode: "inherit" } }],
			["turn a schedule off", { scheduleUpdate: { mode: "off" } }],
			["switch the report on", { isActive: true }],
			["switch the report off", { isActive: false }],
			["start a new active version", { createNewVersion: true }],
			["archive through an edit", { status: "ARCHIVED" }],
		])("refuses to %s", async (_case, change) => {
			await expect(
				handlers.update({
					input: { id: "inst-1", ...change },
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mockCanManageLifecycle).toHaveBeenCalledWith(
				baseInstance,
				ctx.user,
			);
			expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
		});

		it("refuses to restore through an edit", async () => {
			mockGetTemplateInstance.mockResolvedValue({
				...baseInstance,
				status: "ARCHIVED",
			});
			await expect(
				handlers.update({
					input: { id: "inst-1", status: "ACTIVE" },
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
		});

		it.each([
			["start", "DRAFT", "ACTIVE"],
			["stop", "ACTIVE", "DRAFT"],
			["pause", "ACTIVE", "PENDING"],
		])(
			"refuses to %s the report's runs through its status",
			async (_case, from, to) => {
				mockGetTemplateInstance.mockResolvedValue({
					...baseInstance,
					status: from,
				});
				await expect(
					handlers.update({
						input: { id: "inst-1", status: to },
						context: ctx,
					}),
				).rejects.toMatchObject({ code: "FORBIDDEN" });
				expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
			},
		);

		it("saves an edit that resends the report's status", async () => {
			mockGetTemplateInstance.mockResolvedValue({
				...baseInstance,
				status: "DRAFT",
			});
			await handlers.update({
				input: { id: "inst-1", name: "renamed", status: "DRAFT" },
				context: ctx,
			});
			expect(mockUpdateTemplateInstance).toHaveBeenCalledTimes(1);
			expect(mockCanManageLifecycle).not.toHaveBeenCalled();
		});
	});

	it("validates an editor's connection changes against the report owner", async () => {
		const storedConnections = {
			...emptyConnections,
			mcpBindings: { fizzy: "example-owner-config" },
		};
		mockGetTemplateInstance.mockResolvedValue({
			...baseInstance,
			userId: "example-owner",
			connections: storedConnections,
		});
		const editor = { ...ctx, user: { id: "example-editor" } };
		await handlers.update({
			input: { id: "inst-1", connections: storedConnections },
			context: editor,
		});
		expect(mockValidateReportConnections).toHaveBeenCalledWith(
			storedConnections,
			"example-owner",
			"org-1",
			undefined,
			storedConnections,
			{ sameServerOnly: true },
		);
		expect(mockUpdateTemplateInstance).toHaveBeenCalled();
	});
});

describe("createInstanceProcedure — project reports", () => {
	beforeEach(() => {
		mockGetReportTemplate.mockResolvedValue({
			id: "t1",
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			archivedAt: null,
			definition: null,
		});
		mockCreateTemplateInstance.mockResolvedValue({
			id: "inst-new",
			sId: "si-new",
			version: 1,
			name: "Project Report",
			templateId: "t1",
			projectId: "example-project",
			createdAt: new Date(),
		});
		mockTemplateScheduleForInheritance.mockReturnValue(undefined);
	});

	it("stores the project for a project Editor", async () => {
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: emptyConnections,
			},
			context: ctx,
		});
		expect(mockAssertProjectPermission).toHaveBeenCalledWith(
			"example-project",
			ctx.user.id,
			"REPORT_READ",
		);
		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "example-project" }),
		);
	});

	it("fills the Project Name parameter with the project's name", async () => {
		mockGetReportTemplate.mockResolvedValue({
			id: "t1",
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			archivedAt: null,
			definition: null,
			parameters: {
				properties: {
					projectName: { type: "string" },
					sprintId: { type: "string" },
				},
			},
		});
		mockFindProject.mockResolvedValue({ name: "Example Project" });
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: emptyConnections,
			},
			context: ctx,
		});
		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				parameterDefaults: { projectName: "Example Project" },
			}),
		);
	});

	it("starts from the organization's and project's defaults, under what the caller sent", async () => {
		mockGetReportTemplate.mockResolvedValue({
			id: "t1",
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			archivedAt: null,
			definition: null,
			parameters: { properties: { projectName: { type: "string" } } },
		});
		mockFindProject.mockResolvedValue({ name: "Example Project" });
		mockOverrides.mockResolvedValue({
			parameterDefaults: { team: "Example team" },
			context: { teamName: "Default team", boardName: "Example board" },
			schedule: { frequency: "weekly", dayOfWeek: 1 },
		});
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: {
					...emptyConnections,
					context: { teamName: "Chosen team" },
				},
			},
			context: ctx,
		});
		expect(mockOverrides).toHaveBeenCalledWith({
			templateId: "t1",
			organizationId: "org-1",
			projectId: "example-project",
		});
		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				parameterDefaults: {
					projectName: "Example Project",
					team: "Example team",
				},
				connections: expect.objectContaining({
					context: {
						teamName: "Chosen team",
						boardName: "Example board",
					},
				}),
				schedule: expect.objectContaining({
					frequency: "weekly",
					dayOfWeek: 1,
				}),
				scheduleMode: "INHERITED",
			}),
		);
	});

	it("starts from the organization's default prompts, marked as written by a person", async () => {
		mockOverrides.mockResolvedValue({
			parameterDefaults: {},
			context: {},
			schedule: undefined,
			prompts: {
				userPrompt: "Lead with the risks.",
				aiTasks: { summary: "Summarize for leadership." },
			},
		});
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: emptyConnections,
			},
			context: ctx,
		});
		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				connections: expect.objectContaining({
					promptOverride: "Lead with the risks.",
					promptOverrideSource: "user",
				}),
				fabricConfig: {
					customAiTasks: { summary: "Summarize for leadership." },
				},
			}),
		);
	});

	it("ignores stored organization prompts once the organization owns the template", async () => {
		mockGetReportTemplate.mockResolvedValue({
			id: "t1",
			scope: "ORGANIZATION",
			userId: "u1",
			organizationId: "org-1",
			archivedAt: null,
			definition: null,
		});
		mockOverrides.mockResolvedValue({
			parameterDefaults: {},
			context: {},
			schedule: undefined,
			prompts: {
				userPrompt: "Lead with the risks.",
				aiTasks: { summary: "Summarize for leadership." },
			},
		});
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: emptyConnections,
			},
			context: ctx,
		});
		const call = mockCreateTemplateInstance.mock.calls[0][0] as {
			connections: Record<string, unknown>;
			fabricConfig?: unknown;
		};
		expect(call.connections).not.toHaveProperty("promptOverride");
		expect(call.connections).not.toHaveProperty("promptOverrideSource");
		expect(call.fabricConfig).toBeUndefined();
	});

	it("keeps the creator's own instructions over the organization's", async () => {
		mockOverrides.mockResolvedValue({
			parameterDefaults: {},
			context: {},
			schedule: undefined,
			prompts: { userPrompt: "Lead with the risks." },
		});
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: {
					...emptyConnections,
					promptOverride: "Only the blockers.",
					promptOverrideSource: "user",
				},
			},
			context: ctx,
		});
		const call = mockCreateTemplateInstance.mock.calls[0][0] as {
			connections: Record<string, unknown>;
			fabricConfig?: unknown;
		};
		expect(call.connections).toMatchObject({
			promptOverride: "Only the blockers.",
			promptOverrideSource: "user",
		});
		expect(call.fabricConfig).toBeUndefined();
	});

	it("leaves the prompts to the template when the organization sets none", async () => {
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: emptyConnections,
			},
			context: ctx,
		});
		const call = mockCreateTemplateInstance.mock.calls[0][0] as {
			connections: Record<string, unknown>;
			fabricConfig?: unknown;
		};
		expect(call.connections).not.toHaveProperty("promptOverride");
		expect(call.connections).not.toHaveProperty("promptOverrideSource");
		expect(call.fabricConfig).toBeUndefined();
	});

	it("keeps an explicit schedule over the defaults' schedule", async () => {
		mockOverrides.mockResolvedValue({
			parameterDefaults: {},
			context: {},
			schedule: { frequency: "weekly", dayOfWeek: 1 },
		});
		await handlers.create({
			input: {
				templateId: "t1",
				name: "Project Report",
				projectId: "example-project",
				connections: emptyConnections,
				schedule: {
					frequency: "daily",
					hour: 8,
					minute: 0,
					timezone: "UTC",
				},
			},
			context: ctx,
		});
		expect(mockCreateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({ frequency: "daily" }),
				scheduleMode: "CUSTOM",
			}),
		);
	});

	it("refuses a project Viewer and creates nothing", async () => {
		mockCanCreateProjectReport.mockResolvedValue(false);
		await expect(
			handlers.create({
				input: {
					templateId: "t1",
					name: "Project Report",
					projectId: "example-project",
					connections: emptyConnections,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockCreateTemplateInstance).not.toHaveBeenCalled();
	});

	it("refuses an archived template", async () => {
		mockGetReportTemplate.mockResolvedValue({
			id: "t1",
			scope: "SYSTEM",
			userId: null,
			organizationId: null,
			archivedAt: new Date(),
			definition: null,
		});
		await expect(
			handlers.create({
				input: {
					templateId: "t1",
					name: "Project Report",
					connections: emptyConnections,
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockCreateTemplateInstance).not.toHaveBeenCalled();
	});
});

describe("report audience and reserved configuration", () => {
	it("rejects a forged execution snapshot in parameter defaults", () => {
		expect(
			updateInstanceInputSchema.safeParse({
				id: "inst-1",
				parameterDefaults: { __fabricReportExecution: {} },
			}).success,
		).toBe(false);
	});
	it("rejects a project audience change once bound", async () => {
		mockGetTemplateInstance.mockResolvedValue({
			...baseInstance,
			fabricConfig: {
				reporting: {
					version: 1,
					period: "weekly",
					projectId: "project-1",
				},
			},
		});
		await expect(
			handlers.update({
				input: {
					id: "inst-1",
					fabricConfig: {
						reporting: {
							version: 1,
							period: "weekly",
							projectId: "project-2",
						},
					},
				},
				context: ctx,
			}),
		).rejects.toThrow("audience cannot be changed");
		expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
	});
	it("keeps the stored audience when the input carries an undefined one", async () => {
		const reporting = {
			version: 1,
			period: "weekly",
			projectId: "project-1",
		};
		mockGetTemplateInstance.mockResolvedValue({
			...baseInstance,
			fabricConfig: { reporting, strategy: "stored" },
		});
		await handlers.update({
			input: {
				id: "inst-1",
				fabricConfig: { reporting: undefined, strategy: "changed" },
			},
			context: ctx,
		});
		expect(mockUpdateTemplateInstance).toHaveBeenCalledWith(
			expect.objectContaining({
				fabricConfig: { reporting, strategy: "changed" },
			}),
		);
	});
	it("does not make previously indexed organization results private retroactively", async () => {
		mockGetTemplateInstance.mockResolvedValue({
			...baseInstance,
			_count: { executions: 1 },
		});
		await expect(
			handlers.update({
				input: {
					id: "inst-1",
					fabricConfig: {
						reporting: {
							version: 1,
							period: "weekly",
							projectId: "project-1",
						},
					},
				},
				context: ctx,
			}),
		).rejects.toThrow("audience cannot be changed");
		expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
	});
	it("checks project write access before changing an existing project report", async () => {
		mockGetTemplateInstance.mockResolvedValue({
			...baseInstance,
			fabricConfig: {
				reporting: {
					version: 1,
					period: "weekly",
					projectId: "project-1",
				},
			},
		});
		mockCanAccess.mockResolvedValue(false);
		await expect(
			handlers.update({
				input: {
					id: "inst-1",
					fabricConfig: {
						reporting: {
							version: 1,
							period: "weekly",
							projectId: "project-1",
						},
					},
				},
				context: ctx,
			}),
		).rejects.toThrow("access denied");
		expect(mockUpdateTemplateInstance).not.toHaveBeenCalled();
	});
});
