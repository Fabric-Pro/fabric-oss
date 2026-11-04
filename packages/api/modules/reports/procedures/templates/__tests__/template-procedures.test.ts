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
	isPlatformAdmin: vi.fn(),
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
	isPlatformAdmin: mocks.isPlatformAdmin,
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
			REPORT_READ: "REPORT_READ",
			REPORT_CREATE: "REPORT_CREATE",
			REPORT_UPDATE: "REPORT_UPDATE",
			REPORT_DELETE: "REPORT_DELETE",
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

	it("lets a member create a private organization template", async () => {
		await mocks.handlers.create({ input: createInput, context: ctx });
		expect(mocks.createReportTemplate).toHaveBeenCalledWith(
			expect.objectContaining({ scope: "ORGANIZATION", isPublic: false }),
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
});
