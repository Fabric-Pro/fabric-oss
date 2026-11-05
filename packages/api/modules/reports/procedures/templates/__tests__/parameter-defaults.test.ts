import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handler: undefined as
		| undefined
		| ((args: unknown) => Promise<Record<string, unknown>>),
	template: vi.fn(),
	flag: vi.fn(),
	defaults: vi.fn(),
	canCreate: vi.fn(),
	starting: vi.fn(),
	suggest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getReportTemplate: m.template,
	isFeatureEnabled: m.flag,
	resolveReportTemplateDefaults: m.defaults,
}));
vi.mock("../../../lib/report-access", () => ({
	canCreateProjectReport: m.canCreate,
}));
vi.mock("../../../lib/report-creation", () => ({
	startingReportParameters: m.starting,
}));
vi.mock("../../../lib/report-parameter-suggestions", () => ({
	suggestReportParameters: m.suggest,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		input: () => chain,
		handler: (fn: typeof m.handler) => {
			m.handler = fn;
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_READ: "report:read" },
		requireInputOrgPermission: () => () => chain,
		assertProjectPermission: async () => undefined,
		enforceAiRateLimit: async () => undefined,
		resolveOrganizationId: (input: string) => input,
	};
});

import "../parameter-defaults";

function call() {
	if (!m.handler) {
		throw new Error("The procedure did not register a handler");
	}
	return m.handler({
		input: {
			templateId: "example-template",
			projectId: "example-project",
			organizationId: "example-org",
		},
		context: { user: { id: "example-caller" }, session: {} },
		path: ["reports", "templates", "parameterDefaults"],
	});
}

const stored = {
	parameterDefaults: {},
	context: {},
	schedule: undefined,
	prompts: { userPrompt: "Effective" },
	projectPrompts: { userPrompt: "Project's own" },
};

beforeEach(() => {
	vi.clearAllMocks();
	m.flag.mockResolvedValue(true);
	m.canCreate.mockResolvedValue(true);
	m.defaults.mockResolvedValue(stored);
	m.starting.mockResolvedValue({});
	m.suggest.mockResolvedValue({});
	m.template.mockResolvedValue({
		id: "example-template",
		scope: "SYSTEM",
		parameters: null,
	});
});

describe("reports.templates.parameterDefaults prompts", () => {
	it("returns the prompts a new report would start with", async () => {
		await expect(call()).resolves.toMatchObject({
			prompts: { userPrompt: "Effective" },
		});
	});

	it("returns only the project's for the organization's own template", async () => {
		m.template.mockResolvedValue({
			id: "example-template",
			scope: "ORGANIZATION",
			organizationId: "example-org",
			parameters: null,
		});

		await expect(call()).resolves.toMatchObject({
			prompts: { userPrompt: "Project's own" },
		});
	});

	it("returns null when no default applies", async () => {
		m.defaults.mockResolvedValue({
			...stored,
			prompts: undefined,
			projectPrompts: undefined,
		});

		await expect(call()).resolves.toMatchObject({ prompts: null });
	});
});
