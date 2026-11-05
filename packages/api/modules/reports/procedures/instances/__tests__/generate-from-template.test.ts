import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: undefined as
		| undefined
		| ((args: {
				input: Record<string, unknown>;
				context: Record<string, unknown>;
				path: string[];
		  }) => Promise<unknown>),
	projectPermission: vi.fn(),
	membership: vi.fn(),
	canCreate: vi.fn(),
	orgPermission: vi.fn(),
	flag: vi.fn(),
	generate: vi.fn(),
	rateLimit: vi.fn(),
	runRateLimit: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		input: () => chain,
		handler: (fn: typeof m.handler) => {
			m.handler = fn;
			return {};
		},
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: {
			REPORT_CREATE: "report.create",
			REPORT_READ: "report.read",
			REPORT_EXECUTE: "report.execute",
		},
		requireInputOrgPermission: vi.fn(),
		assertProjectPermission: m.projectPermission,
		requireOrganizationMembership: m.membership,
		resolveOrganizationId: (value: unknown) => value,
		enforceAiRateLimit: m.rateLimit,
		enforceWorkflowRateLimit: m.runRateLimit,
	};
});
vi.mock("@repo/database", () => ({ isFeatureEnabled: m.flag }));
vi.mock("../../../lib/report-access", () => ({
	canCreateProjectReport: m.canCreate,
	mayUseReportPermission: m.orgPermission,
}));
vi.mock("../../../lib/report-one-click", () => ({
	generateReportFromTemplate: m.generate,
}));

import { ReportGenerationError } from "../../../lib/report-refusal";
import "../generate-from-template";

function call() {
	const handler = m.handler;
	if (!handler) {
		throw new Error("The procedure did not register a handler");
	}
	return handler({
		input: {
			templateId: "example-template",
			projectId: "example-project",
			organizationId: "example-org",
		},
		context: { user: { id: "example-user" }, session: {} },
		path: ["reports", "instances", "generateFromTemplate"],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	m.projectPermission.mockResolvedValue(undefined);
	m.membership.mockResolvedValue(undefined);
	m.canCreate.mockResolvedValue(true);
	m.orgPermission.mockResolvedValue(true);
	m.flag.mockResolvedValue(true);
	m.generate.mockResolvedValue({ outcome: "started" });
});

describe("generateFromTemplateProcedure", () => {
	it("generates for someone who may add and run reports here", async () => {
		await expect(call()).resolves.toEqual({ outcome: "started" });
		expect(m.generate).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "example-org",
				projectId: "example-project",
				templateId: "example-template",
			}),
		);
	});

	it("bounds a run by the workflow rate limit, and asks for no idempotency key", async () => {
		await call();

		const request = m.generate.mock.calls[0][0];
		expect(request).not.toHaveProperty("idempotencyKey");
		expect(m.runRateLimit).not.toHaveBeenCalled();
		await request.enforceRunRateLimit();
		expect(m.runRateLimit).toHaveBeenCalledWith("example-user", [
			"reports",
			"instances",
			"generateFromTemplate",
		]);
	});

	it("refuses a viewer who cannot add a report to the project", async () => {
		m.canCreate.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.generate).not.toHaveBeenCalled();
	});

	it("refuses someone outside the project before anything else", async () => {
		m.projectPermission.mockRejectedValue(
			new Error("Project access denied"),
		);

		await expect(call()).rejects.toThrow("Project access denied");
		expect(m.canCreate).not.toHaveBeenCalled();
		expect(m.generate).not.toHaveBeenCalled();
	});

	it("refuses an organization role that cannot add reports", async () => {
		m.orgPermission.mockImplementation(
			async (_organization: string, _user: unknown, permission: string) =>
				permission !== "report.create",
		);

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.generate).not.toHaveBeenCalled();
	});

	it("refuses an organization role that cannot run reports", async () => {
		m.orgPermission.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.generate).not.toHaveBeenCalled();
	});

	it("stays closed with the report suite off", async () => {
		m.flag.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.flag).toHaveBeenCalledWith("REPORT_SUITE_V2", "example-org");
		expect(m.generate).not.toHaveBeenCalled();
	});

	it("turns a refusal written for the person into its error", async () => {
		m.generate.mockRejectedValue(
			new ReportGenerationError("NOT_FOUND", "Example template is gone"),
		);

		await expect(call()).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Example template is gone",
		});
	});
});
