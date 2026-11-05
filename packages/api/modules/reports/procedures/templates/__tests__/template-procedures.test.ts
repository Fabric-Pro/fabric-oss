import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	createReportTemplate: vi.fn(),
	getReportTemplate: vi.fn(),
	updateReportTemplate: vi.fn(),
	deleteReportTemplate: vi.fn(),
	listReportTemplates: vi.fn(),
	setReportTemplateArchivedAt: vi.fn(),
	publishReportTemplate: vi.fn(),
	systemReportTemplateNameTaken: vi.fn(),
	isPlatformAdmin: vi.fn(),
	isFeatureEnabled: vi.fn(),
	getOrganizationMembership: vi.fn(),
	requireOrganizationMembership: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createReportTemplate: mocks.createReportTemplate,
	getReportTemplate: mocks.getReportTemplate,
	updateReportTemplate: mocks.updateReportTemplate,
	deleteReportTemplate: mocks.deleteReportTemplate,
	listReportTemplates: mocks.listReportTemplates,
	setReportTemplateArchivedAt: mocks.setReportTemplateArchivedAt,
	publishReportTemplate: mocks.publishReportTemplate,
	systemReportTemplateNameTaken: mocks.systemReportTemplateNameTaken,
	isPlatformAdmin: mocks.isPlatformAdmin,
	isFeatureEnabled: mocks.isFeatureEnabled,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: vi.fn(),
}));

// Chainable oRPC procedure stub — captures each handler in module import order.
vi.mock("../../../../../orpc/procedures", () => {
	let callCount = 0;
	const names = [
		"create",
		"update",
		"delete",
		"list",
		"archive",
		"unarchive",
		"publish",
		"savePrompt",
	];
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
			// The real values: the handlers ask the real role tables for them.
			REPORT_READ: "report:read",
			REPORT_CREATE: "report:create",
			REPORT_UPDATE: "report:update",
			REPORT_DELETE: "report:delete",
		},
		requirePermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
		requireOrganizationMembership: mocks.requireOrganizationMembership,
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? "example-org",
	};
});

import "../create";
import "../update";
import "../delete";
import "../list";
import "../archive";
import "../publish";
import "../save-prompt";

const member = { id: "example-member", role: "user" };
const ctx = {
	user: member,
	session: { activeOrganizationId: "example-org" },
};

const createInput = {
	name: "Weekly status",
	templateType: "CUSTOM",
	definition: {},
	outputFormat: "MARKDOWN",
	scope: "ORGANIZATION",
	isPublic: false,
};

const systemTemplate = {
	id: "example-system-template",
	scope: "SYSTEM",
	userId: null,
	organizationId: null,
	isPublic: true,
	archivedAt: null,
};

const orgTemplate = {
	id: "example-org-template",
	scope: "ORGANIZATION",
	userId: "example-author",
	organizationId: "example-org",
	isPublic: false,
	archivedAt: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isPlatformAdmin.mockResolvedValue(false);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.getOrganizationMembership.mockResolvedValue({ role: "member" });
	mocks.requireOrganizationMembership.mockResolvedValue({ role: "member" });
	mocks.createReportTemplate.mockResolvedValue({ id: "example-new" });
	mocks.updateReportTemplate.mockResolvedValue({ id: "example-updated" });
	mocks.listReportTemplates.mockResolvedValue({ templates: [], total: 0 });
});

describe("templates.create", () => {
	it("refuses a member creating a SYSTEM template", async () => {
		await expect(
			mocks.handlers.create({
				input: { ...createInput, scope: "SYSTEM" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a member creating a public template", async () => {
		await expect(
			mocks.handlers.create({
				input: { ...createInput, isPublic: true },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.createReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a member creating an organization template, which every member would see", async () => {
		await expect(
			mocks.handlers.create({ input: createInput, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
			"example-org",
			member.id,
		);
		expect(mocks.createReportTemplate).not.toHaveBeenCalled();
	});

	it.each(["admin", "owner"])(
		"lets an organization %s create a private organization template",
		async (role) => {
			mocks.getOrganizationMembership.mockResolvedValue({ role });
			await mocks.handlers.create({ input: createInput, context: ctx });
			expect(mocks.createReportTemplate).toHaveBeenCalledWith(
				expect.objectContaining({
					scope: "ORGANIZATION",
					organizationId: "example-org",
					isPublic: false,
				}),
			);
		},
	);

	it("lets a member create their own template in the organization", async () => {
		await mocks.handlers.create({
			input: { ...createInput, scope: "USER" },
			context: ctx,
		});
		expect(mocks.createReportTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "USER",
				userId: member.id,
				organizationId: "example-org",
			}),
		);
	});

	it("lets a platform admin create a public SYSTEM template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await mocks.handlers.create({
			input: { ...createInput, scope: "SYSTEM", isPublic: true },
			context: ctx,
		});
		expect(mocks.createReportTemplate).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "SYSTEM", isPublic: true }),
		);
	});
});

describe("templates.update", () => {
	it("refuses a member editing a SYSTEM template", async () => {
		mocks.getReportTemplate.mockResolvedValue(systemTemplate);
		await expect(
			mocks.handlers.update({
				input: { id: systemTemplate.id, name: "Renamed" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("lets a platform admin edit a SYSTEM template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getReportTemplate.mockResolvedValue(systemTemplate);
		await mocks.handlers.update({
			input: { id: systemTemplate.id, name: "Renamed" },
			context: ctx,
		});
		expect(mocks.updateReportTemplate).toHaveBeenCalled();
	});

	it("refuses an organization admin making a template public", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue(orgTemplate);
		await expect(
			mocks.handlers.update({
				input: { id: orgTemplate.id, isPublic: true },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("lets an organization admin edit an organization template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue(orgTemplate);
		await mocks.handlers.update({
			input: { id: orgTemplate.id, name: "Renamed", isPublic: false },
			context: ctx,
		});
		expect(mocks.updateReportTemplate).toHaveBeenCalled();
	});
});

describe("templates.delete", () => {
	it("refuses a member deleting a SYSTEM template", async () => {
		mocks.getReportTemplate.mockResolvedValue(systemTemplate);
		await expect(
			mocks.handlers.delete({
				input: { id: systemTemplate.id },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a platform admin deleting a SYSTEM template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getReportTemplate.mockResolvedValue(systemTemplate);
		await expect(
			mocks.handlers.delete({
				input: { id: systemTemplate.id },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.deleteReportTemplate).not.toHaveBeenCalled();
	});

	it("lets an organization admin delete an organization template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue(orgTemplate);
		await mocks.handlers.delete({
			input: { id: orgTemplate.id },
			context: ctx,
		});
		expect(mocks.deleteReportTemplate).toHaveBeenCalledWith(orgTemplate.id);
	});
});

describe("templates.archive / templates.unarchive", () => {
	it("refuses a member archiving an organization template", async () => {
		mocks.getReportTemplate.mockResolvedValue(orgTemplate);
		await expect(
			mocks.handlers.archive({
				input: { id: orgTemplate.id },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.setReportTemplateArchivedAt).not.toHaveBeenCalled();
	});

	it("lets an organization owner archive an organization template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });
		mocks.getReportTemplate.mockResolvedValue(orgTemplate);
		const archivedAt = new Date("2026-11-04T12:00:00.000Z");
		mocks.setReportTemplateArchivedAt.mockResolvedValue({
			id: orgTemplate.id,
			archivedAt,
		});
		await expect(
			mocks.handlers.archive({
				input: { id: orgTemplate.id },
				context: ctx,
			}),
		).resolves.toEqual({
			id: orgTemplate.id,
			archivedAt: archivedAt.toISOString(),
		});
		expect(mocks.setReportTemplateArchivedAt).toHaveBeenCalledWith(
			orgTemplate.id,
			expect.any(Date),
		);
	});

	it("lets a platform admin unarchive a SYSTEM template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getReportTemplate.mockResolvedValue(systemTemplate);
		mocks.setReportTemplateArchivedAt.mockResolvedValue({
			id: systemTemplate.id,
			archivedAt: null,
		});
		await expect(
			mocks.handlers.unarchive({
				input: { id: systemTemplate.id },
				context: ctx,
			}),
		).resolves.toEqual({ id: systemTemplate.id, archivedAt: null });
		expect(mocks.setReportTemplateArchivedAt).toHaveBeenCalledWith(
			systemTemplate.id,
			null,
		);
	});

	it("answers NOT_FOUND for a template the caller cannot see", async () => {
		mocks.getReportTemplate.mockResolvedValue(null);
		await expect(
			mocks.handlers.archive({
				input: { id: "example-missing" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("templates.list", () => {
	it("hides archived templates unless asked", async () => {
		await mocks.handlers.list({
			input: { limit: 50, offset: 0, includeArchived: false },
			context: ctx,
		});
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({ includeArchived: false }),
		);
	});

	it("ignores a request for unproven templates from anyone but a platform admin", async () => {
		await mocks.handlers.list({
			input: { limit: 50, offset: 0, includeUnproven: true },
			context: ctx,
		});
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({ includeUnproven: false }),
		);
	});

	it("lists unproven templates for a platform admin who asks", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await mocks.handlers.list({
			input: { limit: 50, offset: 0, includeUnproven: true },
			context: ctx,
		});
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({ includeUnproven: true }),
		);
	});

	it("keeps the list it had for an organization without the report suite", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);
		await mocks.handlers.list({
			input: { limit: 50, offset: 0, includeUnproven: false },
			context: ctx,
		});
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"REPORT_SUITE_V2",
			"example-org",
		);
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({
				includeUnproven: true,
				excludeSuiteOnly: true,
			}),
		);
	});

	it("lists the suite's standard templates where the report suite is on", async () => {
		await mocks.handlers.list({
			input: { limit: 50, offset: 0 },
			context: ctx,
		});
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({ excludeSuiteOnly: false }),
		);
	});

	it("keeps the catalog rule for a platform admin who does not ask", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await mocks.handlers.list({
			input: { limit: 50, offset: 0, includeUnproven: false },
			context: ctx,
		});
		expect(mocks.listReportTemplates).toHaveBeenCalledWith(
			expect.objectContaining({ includeUnproven: false }),
		);
	});
});

describe("templates.publish", () => {
	const ownTemplate = {
		id: "example-own-template",
		scope: "USER",
		userId: member.id,
		organizationId: "example-org",
		isPublic: false,
		archivedAt: null,
		definition: { dataSources: [] },
	};

	beforeEach(() => {
		mocks.systemReportTemplateNameTaken.mockResolvedValue(false);
		mocks.publishReportTemplate.mockImplementation(
			async (params: { id: string; target: string }) => ({
				id: params.id,
				scope: params.target,
			}),
		);
	});

	it("lets the author publish their template to the organization as its admin", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue(ownTemplate);

		await expect(
			mocks.handlers.publish({
				input: { templateId: ownTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			}),
		).resolves.toEqual({ id: ownTemplate.id, scope: "ORGANIZATION" });
		expect(mocks.publishReportTemplate).toHaveBeenCalledWith({
			id: ownTemplate.id,
			target: "ORGANIZATION",
			organizationId: "example-org",
		});
	});

	it("refuses an organization Viewer before reading the template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });
		mocks.getReportTemplate.mockClear();

		await expect(
			mocks.handlers.publish({
				input: { templateId: ownTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getReportTemplate).not.toHaveBeenCalled();
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses an author who is a plain member of the organization", async () => {
		mocks.getReportTemplate.mockResolvedValue(ownTemplate);
		await expect(
			mocks.handlers.publish({
				input: { templateId: ownTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses an organization admin publishing someone else's template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });
		mocks.getReportTemplate.mockResolvedValue({
			...ownTemplate,
			userId: "example-author",
			isPublic: true,
		});
		await expect(
			mocks.handlers.publish({
				input: { templateId: ownTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a template made in another organization or in personal context", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		for (const organizationId of ["example-other-org", null]) {
			mocks.getReportTemplate.mockResolvedValue({
				...ownTemplate,
				organizationId,
			});
			await expect(
				mocks.handlers.publish({
					input: {
						templateId: ownTemplate.id,
						target: "ORGANIZATION",
					},
					context: ctx,
				}),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses an archived template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...ownTemplate,
			archivedAt: new Date("2026-11-04T12:00:00.000Z"),
		});
		await expect(
			mocks.handlers.publish({
				input: { templateId: ownTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a template that is already the organization's", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			userId: member.id,
		});
		await expect(
			mocks.handlers.publish({
				input: { templateId: orgTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND for a template the caller cannot see", async () => {
		mocks.getReportTemplate.mockResolvedValue(null);
		await expect(
			mocks.handlers.publish({
				input: {
					templateId: "example-missing",
					target: "ORGANIZATION",
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("lets a platform admin publish an organization template to every tenant", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition: { dataSources: [] },
		});
		await expect(
			mocks.handlers.publish({
				input: { templateId: orgTemplate.id, target: "SYSTEM" },
				context: ctx,
			}),
		).resolves.toEqual({ id: orgTemplate.id, scope: "SYSTEM" });
		expect(mocks.publishReportTemplate).toHaveBeenCalledWith({
			id: orgTemplate.id,
			target: "SYSTEM",
		});
	});

	it("refuses a system publish whose name another system template already has", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.systemReportTemplateNameTaken.mockResolvedValue(true);
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			name: "Weekly status",
			definition: { dataSources: [] },
		});
		await expect(
			mocks.handlers.publish({
				input: { templateId: orgTemplate.id, target: "SYSTEM" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.systemReportTemplateNameTaken).toHaveBeenCalledWith(
			"Weekly status",
			orgTemplate.id,
		);
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses system publishing to an organization owner", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });
		mocks.getReportTemplate.mockResolvedValue(orgTemplate);
		await expect(
			mocks.handlers.publish({
				input: { templateId: orgTemplate.id, target: "SYSTEM" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a template that is already a system template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getReportTemplate.mockResolvedValue(systemTemplate);
		await expect(
			mocks.handlers.publish({
				input: { templateId: systemTemplate.id, target: "SYSTEM" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();
	});
});

describe("templates.savePrompt", () => {
	const definition = {
		userPrompt: "Summarize the sprint.",
		aiAgents: [
			{
				agentId: "default",
				task: "Write the summary.",
				outputVariable: "summary",
			},
			{ agentId: "default", task: "List the risks." },
		],
		sections: [{ title: "Highlights" }],
	};

	it("writes the report instructions and named AI task prompts into the template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
		});
		mocks.updateReportTemplate.mockResolvedValue({
			id: orgTemplate.id,
			version: 3,
		});

		await expect(
			mocks.handlers.savePrompt({
				input: {
					templateId: orgTemplate.id,
					userPrompt: "Summarize the sprint for leadership.",
					aiTasks: { "agent-1": "List the top three risks." },
				},
				context: ctx,
			}),
		).resolves.toEqual({ id: orgTemplate.id, version: 3 });
		// Writing `definition` is what bumps the template's version.
		expect(mocks.updateReportTemplate).toHaveBeenCalledWith({
			id: orgTemplate.id,
			definition: {
				userPrompt: "Summarize the sprint for leadership.",
				aiAgents: [
					definition.aiAgents[0],
					{ agentId: "default", task: "List the top three risks." },
				],
				sections: [{ title: "Highlights" }],
			},
		});
	});

	it("writes parameter values as the template's defaults, keeping the rest of each parameter", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
			parameters: {
				required: ["team"],
				properties: {
					team: { type: "string", title: "Team" },
					weeks: { type: "number", default: 2 },
				},
			},
		});
		mocks.updateReportTemplate.mockResolvedValue({
			id: orgTemplate.id,
			version: 4,
		});

		await mocks.handlers.savePrompt({
			input: {
				templateId: orgTemplate.id,
				parameterDefaults: { team: "Example team" },
			},
			context: ctx,
		});

		expect(mocks.updateReportTemplate).toHaveBeenCalledWith({
			id: orgTemplate.id,
			// Still written, so the save bumps the version.
			definition,
			parameters: {
				required: ["team"],
				properties: {
					team: {
						type: "string",
						title: "Team",
						default: "Example team",
					},
					weeks: { type: "number", default: 2 },
				},
			},
		});
	});

	it("rejects a parameter named after an inherited object property", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
			parameters: { properties: { team: { type: "string" } } },
		});

		await expect(
			mocks.handlers.savePrompt({
				input: {
					templateId: orgTemplate.id,
					parameterDefaults: { constructor: "example" },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("reads the template in the organization the page names, not the session's", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
		});

		await mocks.handlers.savePrompt({
			input: {
				organizationId: "example-report-org",
				templateId: orgTemplate.id,
				userPrompt: "Shorter",
			},
			context: ctx,
		});

		expect(mocks.getReportTemplate).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-report-org" }),
		);
	});

	it("rejects a parameter the template does not have", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
			parameters: { properties: { team: { type: "string" } } },
		});

		await expect(
			mocks.handlers.savePrompt({
				input: {
					templateId: orgTemplate.id,
					parameterDefaults: { board: "example-board" },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses an organization member saving parameters to an organization template", async () => {
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
			parameters: { properties: { team: { type: "string" } } },
		});

		await expect(
			mocks.handlers.savePrompt({
				input: {
					templateId: orgTemplate.id,
					parameterDefaults: { team: "Example team" },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses an organization member saving to an organization template", async () => {
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
		});
		await expect(
			mocks.handlers.savePrompt({
				input: { templateId: orgTemplate.id, userPrompt: "Changed" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("limits a SYSTEM template to platform admins", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "owner" });
		mocks.getReportTemplate.mockResolvedValue({
			...systemTemplate,
			definition,
		});
		await expect(
			mocks.handlers.savePrompt({
				input: { templateId: systemTemplate.id, userPrompt: "Changed" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		mocks.isPlatformAdmin.mockResolvedValue(true);
		await mocks.handlers.savePrompt({
			input: { templateId: systemTemplate.id, userPrompt: "Changed" },
			context: ctx,
		});
		expect(mocks.updateReportTemplate).toHaveBeenCalledTimes(1);
	});

	it("limits a USER template to its author", async () => {
		const personal = {
			id: "example-personal-template",
			scope: "USER",
			userId: "example-author",
			organizationId: "example-org",
			isPublic: true,
			archivedAt: null,
			definition,
		};
		mocks.getReportTemplate.mockResolvedValue(personal);
		await expect(
			mocks.handlers.savePrompt({
				input: { templateId: personal.id, userPrompt: "Changed" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		mocks.getReportTemplate.mockResolvedValue({
			...personal,
			userId: member.id,
		});
		await mocks.handlers.savePrompt({
			input: { templateId: personal.id, userPrompt: "Changed" },
			context: ctx,
		});
		expect(mocks.updateReportTemplate).toHaveBeenCalledTimes(1);
	});

	it("rejects a task key the template does not have", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
		});
		await expect(
			mocks.handlers.savePrompt({
				input: {
					templateId: orgTemplate.id,
					aiTasks: { "agent-7": "Not a task of this template" },
				},
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses an archived template", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
			archivedAt: new Date("2026-11-04T12:00:00.000Z"),
		});
		await expect(
			mocks.handlers.savePrompt({
				input: { templateId: orgTemplate.id, userPrompt: "Changed" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
	});

	it("refuses a save that names no prompt", async () => {
		await expect(
			mocks.handlers.savePrompt({
				input: { templateId: orgTemplate.id, aiTasks: {} },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.getReportTemplate).not.toHaveBeenCalled();
	});

	it("is not available where the report suite is off, and is where it is on", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue({
			...orgTemplate,
			definition,
		});
		const save = () =>
			mocks.handlers.savePrompt({
				input: { templateId: orgTemplate.id, userPrompt: "Changed" },
				context: ctx,
			});

		mocks.isFeatureEnabled.mockResolvedValue(false);
		await expect(save()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"REPORT_SUITE_V2",
			"example-org",
		);
		expect(mocks.updateReportTemplate).not.toHaveBeenCalled();

		mocks.isFeatureEnabled.mockResolvedValue(true);
		await save();
		expect(mocks.updateReportTemplate).toHaveBeenCalledTimes(1);
	});
});

describe("templates.publish and the report suite", () => {
	it("is not available where the report suite is off, and is where it is on", async () => {
		const ownTemplate = {
			id: "example-own-template",
			scope: "USER",
			userId: member.id,
			organizationId: "example-org",
			isPublic: false,
			archivedAt: null,
			definition: { dataSources: [] },
		};
		mocks.getOrganizationMembership.mockResolvedValue({ role: "admin" });
		mocks.getReportTemplate.mockResolvedValue(ownTemplate);
		mocks.publishReportTemplate.mockResolvedValue({
			id: ownTemplate.id,
			scope: "ORGANIZATION",
		});
		const publish = () =>
			mocks.handlers.publish({
				input: { templateId: ownTemplate.id, target: "ORGANIZATION" },
				context: ctx,
			});

		mocks.isFeatureEnabled.mockResolvedValue(false);
		await expect(publish()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.publishReportTemplate).not.toHaveBeenCalled();

		mocks.isFeatureEnabled.mockResolvedValue(true);
		await publish();
		expect(mocks.publishReportTemplate).toHaveBeenCalledTimes(1);
	});
});
