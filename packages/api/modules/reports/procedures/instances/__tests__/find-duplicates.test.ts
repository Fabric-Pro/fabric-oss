/**
 * `reports.instances.findDuplicates`: the project is authorized as the
 * project's report list authorizes it, before anything is compared.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: undefined as undefined | ((args: unknown) => Promise<unknown>),
	assertProject: vi.fn(),
	canReach: vi.fn(),
	find: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findLikelyDuplicateReports: m.find,
}));
vi.mock("../../../lib/report-access", () => ({
	canReachProjectReports: m.canReach,
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
		Permissions: { REPORT_READ: "report:read" },
		assertProjectPermission: m.assertProject,
		requireInputOrgPermission: () => () => chain,
		resolveOrganizationId: (input: string | null | undefined) => input,
	};
});

import "../find-duplicates";

const ORG = "example-org";
const PROJECT = "example-project";
const context = { user: { id: "example-caller", role: "user" }, session: {} };

function call(input: Record<string, unknown> = {}) {
	if (!m.handler) {
		throw new Error("The procedure did not register a handler");
	}
	return m.handler({
		input: {
			organizationId: ORG,
			projectId: PROJECT,
			name: "Weekly status",
			prompt: "Summarize the week.",
			...input,
		},
		context,
	}) as Promise<{ duplicates: Array<Record<string, unknown>> }>;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.assertProject.mockResolvedValue(undefined);
	m.canReach.mockResolvedValue(true);
	m.find.mockResolvedValue([]);
});

describe("reports.instances.findDuplicates", () => {
	it("compares the project's reports for someone who may read them", async () => {
		m.find.mockResolvedValue([
			{
				id: "existing-report",
				name: "Weekly status",
				templateName: "Status template",
				status: "ACTIVE",
				isActive: true,
				ownedByCaller: false,
				createdAt: new Date("2026-11-01T00:00:00.000Z"),
				lastRunAt: null,
				sameTitle: true,
				samePrompt: false,
			},
		]);

		const { duplicates } = await call();

		expect(m.find).toHaveBeenCalledWith({
			userId: "example-caller",
			organizationId: ORG,
			projectId: PROJECT,
			name: "Weekly status",
			prompt: "Summarize the week.",
		});
		expect(duplicates).toEqual([
			expect.objectContaining({
				id: "existing-report",
				createdAt: "2026-11-01T00:00:00.000Z",
				lastRunAt: null,
				sameTitle: true,
			}),
		]);
	});

	it("refuses someone who cannot reach the project's reports, comparing nothing", async () => {
		m.canReach.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.find).not.toHaveBeenCalled();
	});

	it("asks the project first, so nobody learns of a project they cannot read", async () => {
		m.assertProject.mockRejectedValue(new Error("Project access denied"));

		await expect(call()).rejects.toThrow("Project access denied");
		expect(m.canReach).not.toHaveBeenCalled();
		expect(m.find).not.toHaveBeenCalled();
	});

	it("compares the caller's own reports without a project", async () => {
		await call({ projectId: undefined });

		expect(m.assertProject).not.toHaveBeenCalled();
		expect(m.find).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: undefined }),
		);
	});

	it("compares nothing outside an organization", async () => {
		await expect(
			call({ organizationId: null, projectId: undefined }),
		).resolves.toEqual({ duplicates: [] });
		expect(m.find).not.toHaveBeenCalled();
	});
});
