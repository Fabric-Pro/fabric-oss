import { describe, expect, it, vi } from "vitest";

const { resolveEnvironmentAuth } = vi.hoisted(() => ({
	resolveEnvironmentAuth: vi.fn(async () => ({
		authKind: "FORM",
		username: "qa@example.com",
		headerName: null,
		secret: "super-secret",
		baseUrl: "https://app.example.com",
		signInUrl: "https://app.example.com/login",
		isProduction: false,
	})),
}));

vi.mock("@repo/database", () => ({
	AGENTIC_RUN_PROVIDER: "FABRIC_AGENTIC",
	attachAgenticStepLogs: vi.fn(),
	finishAgenticRun: vi.fn(),
	getProjectQaSettings: vi.fn(async () => ({
		rulesMarkdown: null,
		implementationNotes: null,
		evidencePolicy: "OPTIONAL",
	})),
	ingestPipelineRun: vi.fn(),
	listCasesForAgenticRun: vi.fn(async () => [
		{
			id: "case-1",
			identifier: "TC-001",
			title: "Sign in",
			description: null,
			steps: [
				{
					order: 1,
					action: "Open the app",
					expected: "Home is visible",
				},
			],
		},
	]),
	markAgenticRunStarted: vi.fn(async () => true),
	recordAgenticCaseProgress: vi.fn(),
	recordFindingsForRun: vi.fn(),
	resolveAgenticRunActor: vi.fn(),
	resolveEnvironmentAuth,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { prepareAgenticRun } from "../run-lifecycle";

describe("prepareAgenticRun credential boundary", () => {
	it("puts only the environment id in replayable activity output", async () => {
		const prepared = await prepareAgenticRun({
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			runId: "run-1",
			environmentId: "environment-1",
			targetBaseUrl: "https://app.example.com",
			testCaseIds: ["case-1"],
			browser: "chromium",
			resolution: "1920x1080",
			workflowId: "workflow-1",
		});

		expect(resolveEnvironmentAuth).not.toHaveBeenCalled();
		expect(prepared.cases).toHaveLength(1);
		expect(prepared.cases[0]).toMatchObject({
			environmentId: "environment-1",
			targetBaseUrl: "https://app.example.com",
		});
		expect(prepared.cases[0]).not.toHaveProperty("auth");
		expect(prepared.cases[0]).not.toHaveProperty("signInUrl");
		expect(JSON.stringify(prepared)).not.toContain("super-secret");
	});
});
