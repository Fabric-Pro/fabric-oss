/**
 * The template procedures admit on membership alone and ask for the permission
 * in the handler, so that a system admin holding a read-only organization role
 * reaches them. These run the real role tables and the real report access rules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	createReportTemplate: vi.fn(),
	getReportTemplate: vi.fn(),
	updateReportTemplate: vi.fn(),
	setReportTemplateArchivedAt: vi.fn(),
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
	setReportTemplateArchivedAt: mocks.setReportTemplateArchivedAt,
	systemReportTemplateNameTaken: mocks.systemReportTemplateNameTaken,
	isPlatformAdmin: mocks.isPlatformAdmin,
	isFeatureEnabled: mocks.isFeatureEnabled,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));

vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: vi.fn(),
}));

// Chainable oRPC procedure stub: captures each handler in module import order.
vi.mock("../../../../../orpc/procedures", () => {
	let callCount = 0;
	const names = ["create", "update", "archive", "unarchive", "savePrompt"];
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
import "../archive";
import "../save-prompt";

const ctx = {
	user: { id: "example-member", role: "user" },
	session: { activeOrganizationId: "example-org" },
};

const systemTemplate = {
	id: "example-system-template",
	scope: "SYSTEM",
	userId: null,
	organizationId: null,
	isPublic: true,
	archivedAt: null,
	definition: { userPrompt: "Original" },
};

const writes = {
	"templates.create": () =>
		mocks.handlers.create({
			input: {
				name: "Weekly status",
				templateType: "CUSTOM",
				definition: {},
				outputFormat: "MARKDOWN",
				scope: "SYSTEM",
				isPublic: false,
			},
			context: ctx,
		}),
	"templates.update": () =>
		mocks.handlers.update({
			input: { id: systemTemplate.id, name: "Renamed" },
			context: ctx,
		}),
	"templates.archive": () =>
		mocks.handlers.archive({
			input: { id: systemTemplate.id },
			context: ctx,
		}),
	"templates.savePrompt": () =>
		mocks.handlers.savePrompt({
			input: { templateId: systemTemplate.id, userPrompt: "Changed" },
			context: ctx,
		}),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isPlatformAdmin.mockResolvedValue(false);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.requireOrganizationMembership.mockResolvedValue({ role: "member" });
	mocks.createReportTemplate.mockResolvedValue({ id: "example-new" });
	mocks.updateReportTemplate.mockResolvedValue({ id: "example-updated" });
	mocks.getReportTemplate.mockResolvedValue(systemTemplate);
	mocks.setReportTemplateArchivedAt.mockResolvedValue({
		id: systemTemplate.id,
		archivedAt: new Date("2026-11-04T12:00:00.000Z"),
	});
});

describe("templates.savePrompt and the system prompt", () => {
	it("makes an edited system prompt the template's own", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });
		mocks.getReportTemplate.mockResolvedValue({
			...systemTemplate,
			fabricConfig: { strategy: "example-strategy" },
		});

		await mocks.handlers.savePrompt({
			input: {
				templateId: systemTemplate.id,
				systemPrompt: "Answer in short sentences",
			},
			context: ctx,
		});

		expect(mocks.updateReportTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				fabricConfig: {
					strategy: "example-strategy",
					defaultSystemPrompt: "Answer in short sentences",
				},
			}),
		);
	});

	it("leaves the template's configuration alone when no system prompt is sent", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });

		await mocks.handlers.savePrompt({
			input: { templateId: systemTemplate.id, userPrompt: "Changed" },
			context: ctx,
		});

		expect(mocks.updateReportTemplate.mock.calls[0][0]).not.toHaveProperty(
			"fabricConfig",
		);
	});
});

describe("template procedures and the organization role", () => {
	it.each(Object.entries(writes))(
		"%s: lets a system admin who is a member, even as a Viewer",
		async (_name, write) => {
			mocks.isPlatformAdmin.mockResolvedValue(true);
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "viewer",
			});

			await expect(write()).resolves.toBeTruthy();
		},
	);

	it.each(Object.entries(writes))(
		"%s: refuses a system admin who is not a member",
		async (_name, write) => {
			mocks.isPlatformAdmin.mockResolvedValue(true);
			mocks.getOrganizationMembership.mockResolvedValue(null);

			await expect(write()).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.createReportTemplate).not.toHaveBeenCalled();
			expect(mocks.updateReportTemplate).not.toHaveBeenCalled();
			expect(mocks.setReportTemplateArchivedAt).not.toHaveBeenCalled();
		},
	);

	it.each(Object.entries(writes))(
		"%s: refuses an organization Viewer who is no system admin",
		async (_name, write) => {
			mocks.getOrganizationMembership.mockResolvedValue({
				role: "viewer",
			});

			await expect(write()).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.getReportTemplate).not.toHaveBeenCalled();
		},
	);
});
