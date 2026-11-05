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
	canReachProjectReports: vi.fn(),
	canSetOrganizationReportDefaults: vi.fn(),
	hasOrganizationReportPermission: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const real = await importOriginal<typeof import("@repo/database")>();
	return {
		assertPublicReportParameters: real.assertPublicReportParameters,
		reportScheduleInputSchema: real.reportScheduleInputSchema,
		mergeReportTemplateOverrides: real.mergeReportTemplateOverrides,
		readReportTemplatePromptDefaults: real.readReportTemplatePromptDefaults,
		getReportTemplate: mocks.getReportTemplate,
		getReportTemplateOverrides: mocks.getReportTemplateOverrides,
		setReportTemplateOverride: mocks.setReportTemplateOverride,
		clearReportTemplateOverride: mocks.clearReportTemplateOverride,
		isFeatureEnabled: mocks.isFeatureEnabled,
	};
});

vi.mock("../../../lib/report-access", () => ({
	canEditProjectReport: mocks.canEditProjectReport,
	canReachProjectReports: mocks.canReachProjectReports,
	canSetOrganizationReportDefaults: mocks.canSetOrganizationReportDefaults,
	hasOrganizationReportPermission: mocks.hasOrganizationReportPermission,
	mayUseReportPermission: mocks.hasOrganizationReportPermission,
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
		requireInputOrgPermission: () => (c: unknown) => c,
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
	mocks.canReachProjectReports.mockResolvedValue(true);
	mocks.canSetOrganizationReportDefaults.mockResolvedValue(false);
	mocks.hasOrganizationReportPermission.mockResolvedValue(true);
	mocks.getReportTemplateOverrides.mockResolvedValue({
		organization: null,
		project: null,
	});
});

describe("setTemplateOverrideInputSchema", () => {
	it("rejects a reserved execution key in the parameter defaults", () => {
		const parsed = setTemplateOverrideInputSchema.safeParse({
			templateId: "example-template",
			scope: "ORGANIZATION",
			defaults: {
				...defaults,
				parameterDefaults: { __fabricReportExecution: "forged" },
			},
		});

		expect(parsed.success).toBe(false);
	});

	it("takes ordinary parameter defaults, and none", () => {
		for (const parameterDefaults of [{ team: "Example team" }, null]) {
			expect(
				setTemplateOverrideInputSchema.safeParse({
					templateId: "example-template",
					scope: "ORGANIZATION",
					defaults: { ...defaults, parameterDefaults },
				}).success,
			).toBe(true);
		}
	});
});

describe("a project the caller cannot open the reports of", () => {
	const scope = {
		templateId: "example-template",
		projectId: "example-project",
	};

	beforeEach(() => {
		mocks.canReachProjectReports.mockResolvedValue(false);
	});

	it("gives nothing on get", async () => {
		await expect(
			mocks.handlers.get({ input: scope, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.canReachProjectReports).toHaveBeenCalledWith(
			"example-project",
			ctx.user,
		);
		expect(mocks.getReportTemplateOverrides).not.toHaveBeenCalled();
	});

	it("writes nothing on set", async () => {
		await expect(
			mocks.handlers.set({
				input: { ...scope, scope: "PROJECT", defaults },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
	});
});

describe("reports.templates.overrides.set", () => {
	it("acts on the organization the page names, not the session's", async () => {
		mocks.canSetOrganizationReportDefaults.mockResolvedValue(true);

		await mocks.handlers.set({
			input: {
				organizationId: "example-report-org",
				templateId: "example-template",
				scope: "ORGANIZATION",
				defaults,
			},
			context: ctx,
		});

		expect(mocks.setReportTemplateOverride).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-report-org" }),
			expect.anything(),
		);
	});

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

	describe("the project's default schedule", () => {
		const weekly = {
			frequency: "weekly",
			hour: 9,
			minute: 0,
			timezone: "UTC",
		};
		const save = (scheduleDefaults: unknown) =>
			mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults: scheduleDefaults,
				},
				context: ctx,
			});
		const projectRowWithSchedule = (schedule: unknown) =>
			mocks.getReportTemplateOverrides.mockResolvedValue({
				organization: null,
				project: {
					parameterDefaults: null,
					context: null,
					schedule,
					prompts: null,
					updatedAt: new Date("2026-11-04T00:00:00Z"),
				},
			});
		// The organization Viewer with an Editor row: reads, but does not write.
		const organizationRoleCannotWrite = () =>
			mocks.hasOrganizationReportPermission.mockImplementation(
				async (_org: string, _user: string, permission: string) =>
					permission !== "REPORT_UPDATE",
			);

		it("refuses to set one for an editor whose organization role cannot write reports", async () => {
			organizationRoleCannotWrite();

			await expect(
				save({ ...defaults, schedule: weekly }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it("refuses to change one for that editor", async () => {
			organizationRoleCannotWrite();
			projectRowWithSchedule(weekly);

			await expect(
				save({
					...defaults,
					schedule: { ...weekly, frequency: "daily" },
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it.each([
			["clearing the row", null],
			[
				"saving it empty",
				{ parameterDefaults: {}, context: {}, schedule: null },
			],
			["removing only the schedule", defaults],
		])("refuses %s when it holds a schedule", async (_case, cleared) => {
			organizationRoleCannotWrite();
			projectRowWithSchedule(weekly);

			await expect(save(cleared)).rejects.toMatchObject({
				code: "FORBIDDEN",
				message: expect.stringContaining("not its schedule"),
			});
			expect(mocks.clearReportTemplateOverride).not.toHaveBeenCalled();
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it("saves that editor's other defaults when the stored schedule comes back unchanged, in any key order", async () => {
			organizationRoleCannotWrite();
			projectRowWithSchedule({
				timezone: "UTC",
				minute: 0,
				hour: 9,
				frequency: "weekly",
			});

			await save({ ...defaults, schedule: weekly });

			expect(mocks.setReportTemplateOverride).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ schedule: weekly }),
			);
		});

		it("lets a caller whose organization role writes reports change it", async () => {
			projectRowWithSchedule(weekly);

			await save({
				...defaults,
				schedule: { ...weekly, frequency: "daily" },
			});

			expect(mocks.hasOrganizationReportPermission).toHaveBeenCalledWith(
				"example-org",
				ctx.user,
				"REPORT_UPDATE",
			);
			expect(mocks.setReportTemplateOverride).toHaveBeenCalledTimes(1);
		});

		it("leaves the organization scope to its own check", async () => {
			mocks.canSetOrganizationReportDefaults.mockResolvedValue(true);
			organizationRoleCannotWrite();

			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					scope: "ORGANIZATION",
					defaults: { ...defaults, schedule: weekly },
				},
				context: ctx,
			});

			expect(mocks.setReportTemplateOverride).toHaveBeenCalledTimes(1);
		});
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

	describe("default prompts", () => {
		const definition = {
			aiAgents: [
				{
					agentId: "default",
					task: "Summarize.",
					outputVariable: "summary",
				},
			],
		};
		const prompts = {
			userPrompt: "Lead with the risks.",
			aiTasks: { summary: "Summarize for leadership." },
		};

		beforeEach(() => {
			mocks.canSetOrganizationReportDefaults.mockResolvedValue(true);
			mocks.getReportTemplate.mockResolvedValue({
				id: "example-template",
				scope: "SYSTEM",
				organizationId: null,
				definition,
			});
		});

		it("stores the organization's default prompts for an admin", async () => {
			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					scope: "ORGANIZATION",
					defaults: { ...defaults, prompts },
				},
				context: ctx,
			});
			expect(mocks.setReportTemplateOverride).toHaveBeenCalledWith(
				{
					templateId: "example-template",
					organizationId: "example-org",
					projectId: null,
				},
				expect.objectContaining({ prompts }),
			);
		});

		it("stores a project's default prompts for whoever may edit its reports", async () => {
			mocks.canSetOrganizationReportDefaults.mockResolvedValue(false);

			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults: { ...defaults, prompts },
				},
				context: ctx,
			});

			expect(mocks.setReportTemplateOverride).toHaveBeenCalledWith(
				{
					templateId: "example-template",
					organizationId: "example-org",
					projectId: "example-project",
				},
				expect.objectContaining({ prompts }),
			);
		});

		it("refuses a project's default prompts for someone who may not edit its reports", async () => {
			mocks.canEditProjectReport.mockResolvedValue(false);

			await expect(
				mocks.handlers.set({
					input: {
						templateId: "example-template",
						projectId: "example-project",
						scope: "PROJECT",
						defaults: { ...defaults, prompts },
					},
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it("lets a project hold prompts for the organization's own template", async () => {
			mocks.getReportTemplate.mockResolvedValue({
				id: "example-template",
				scope: "ORGANIZATION",
				organizationId: "example-org",
				definition,
			});

			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults: { ...defaults, prompts },
				},
				context: ctx,
			});

			expect(mocks.setReportTemplateOverride).toHaveBeenCalledTimes(1);
		});

		it("refuses a project's prompt for a task the template does not have", async () => {
			await expect(
				mocks.handlers.set({
					input: {
						templateId: "example-template",
						projectId: "example-project",
						scope: "PROJECT",
						defaults: {
							...defaults,
							prompts: { aiTasks: { "agent-3": "Not a task" } },
						},
					},
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it("keeps a project's row when a save empties it and leaves its stored prompts out", async () => {
			mocks.getReportTemplateOverrides.mockResolvedValue({
				organization: null,
				project: {
					parameterDefaults: null,
					context: null,
					schedule: null,
					prompts: { userPrompt: "Stored" },
					updatedAt: new Date(),
				},
			});

			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					projectId: "example-project",
					scope: "PROJECT",
					defaults: {
						parameterDefaults: null,
						context: null,
						schedule: null,
					},
				},
				context: ctx,
			});

			expect(mocks.clearReportTemplateOverride).not.toHaveBeenCalled();
			expect(mocks.setReportTemplateOverride).toHaveBeenCalledTimes(1);
		});

		it("says on read whether the organization's row applies to this template", async () => {
			mocks.getReportTemplate.mockResolvedValue({
				id: "example-template",
				scope: "ORGANIZATION",
				organizationId: "example-org",
				definition,
			});

			const owned = (await mocks.handlers.get({
				input: { templateId: "example-template" },
				context: ctx,
			})) as { organizationPromptsApply: boolean };

			expect(owned.organizationPromptsApply).toBe(false);
		});

		it("refuses prompts for the organization's own template, which it edits directly", async () => {
			mocks.getReportTemplate.mockResolvedValue({
				id: "example-template",
				scope: "ORGANIZATION",
				organizationId: "example-org",
				definition,
			});
			await expect(
				mocks.handlers.set({
					input: {
						templateId: "example-template",
						scope: "ORGANIZATION",
						defaults: { ...defaults, prompts },
					},
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it("refuses a task key the template does not have", async () => {
			await expect(
				mocks.handlers.set({
					input: {
						templateId: "example-template",
						scope: "ORGANIZATION",
						defaults: {
							...defaults,
							prompts: { aiTasks: { "agent-3": "Not a task" } },
						},
					},
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});

		it("keeps the stored prompts when a save leaves them out", async () => {
			mocks.getReportTemplateOverrides.mockResolvedValue({
				organization: {
					parameterDefaults: null,
					context: null,
					schedule: null,
					prompts,
					updatedAt: new Date("2026-11-04T00:00:00Z"),
				},
				project: null,
			});
			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					scope: "ORGANIZATION",
					defaults: {
						parameterDefaults: {},
						context: {},
						schedule: null,
					},
				},
				context: ctx,
			});
			expect(mocks.clearReportTemplateOverride).not.toHaveBeenCalled();
			expect(mocks.setReportTemplateOverride).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ prompts: undefined }),
			);
		});

		it("clears an organization row once its prompts are cleared too", async () => {
			await mocks.handlers.set({
				input: {
					templateId: "example-template",
					scope: "ORGANIZATION",
					defaults: {
						parameterDefaults: {},
						context: {},
						schedule: null,
						prompts: { userPrompt: "   " },
					},
				},
				context: ctx,
			});
			expect(mocks.clearReportTemplateOverride).toHaveBeenCalledTimes(1);
			expect(mocks.setReportTemplateOverride).not.toHaveBeenCalled();
		});
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
			canSetProjectSchedule: true,
		});
	});

	it("says a project Editor whose organization role cannot write reports may not set the schedule", async () => {
		mocks.hasOrganizationReportPermission.mockImplementation(
			async (_org: string, _user: string, permission: string) =>
				permission !== "REPORT_UPDATE",
		);

		const result = await mocks.handlers.get({
			input: {
				templateId: "example-template",
				projectId: "example-project",
			},
			context: ctx,
		});

		expect(result).toMatchObject({
			canSetProject: true,
			canSetProjectSchedule: false,
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
