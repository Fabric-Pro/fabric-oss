import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectCodeIndexes: vi.fn(),
	getTestCaseAgentRunEvidence: vi.fn(),
	getTestCase: vi.fn(),
	updateTestCase: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn() },
}));

vi.mock("@repo/rag", () => ({
	searchProjectCodeIndex: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		handler: () => chain,
	};
	return {
		Permissions: { PROJECT_SETTINGS_EDIT: "project-settings:edit" },
		requireProjectPermission: vi.fn(),
		tenantProtectedProcedure: chain,
	};
});

vi.mock("../../../lib/test-cases-feature", () => ({
	assertTestCasesFeatureEnabled: vi.fn(),
}));

import {
	buildPlaywrightScriptPrompt,
	rankRelevantPaths,
	stripMarkdownFence,
} from "../generate-playwright-script";

describe("Playwright script generation helpers", () => {
	it("removes a whole JSON markdown fence without changing the plan", () => {
		expect(
			stripMarkdownFence(
				'```json\n{"version":1,"steps":[{"action":"goto","path":"/"}]}\n```',
			),
		).toBe('{"version":1,"steps":[{"action":"goto","path":"/"}]}');
	});

	it("ranks indexed paths that match the case before unrelated paths", () => {
		const ranked = rankRelevantPaths(
			[
				"apps/web/modules/billing/CheckoutForm.tsx",
				"docs/readme.md",
				"apps/web/modules/auth/SignInForm.tsx",
			],
			{
				title: "User signs in",
				description: "Open the auth form",
				steps: [
					{
						action: "Enter an email",
						expected: "The user reaches the dashboard",
					},
				],
			},
		);

		expect(ranked[0]).toBe("apps/web/modules/auth/SignInForm.tsx");
	});

	it("includes the selected historical execution only for agent-run generation", () => {
		const testCase = {
			identifier: "TC-001",
			title: "Sign in",
			description: null,
			steps: [{ order: 0, action: "Submit", expected: "Dashboard" }],
		};
		const evidence = {
			resultEventId: "event-1",
			result: "FAILED",
			occurredAt: new Date("2026-07-28T10:00:00Z"),
			triggeredByActor: "Ada",
			steps: [
				{
					order: 0,
					action: "Submit",
					expected: "Dashboard",
					status: "FAILED",
					observation: "Stayed on sign-in",
				},
			],
		};
		const withRun = buildPlaywrightScriptPrompt(
			testCase,
			["apps/web/sign-in.tsx"],
			[
				{
					filePath: "apps/web/sign-in.tsx",
					content: "export function SignIn() {}",
					language: "typescript",
					symbolName: "SignIn",
				},
			],
			evidence,
		);
		const repoOnly = buildPlaywrightScriptPrompt(
			testCase,
			["apps/web/sign-in.tsx"],
			[],
			null,
		);

		expect(withRun).toContain("Selected historical agent execution");
		expect(withRun).toContain("Stayed on sign-in");
		expect(repoOnly).not.toContain("Selected historical agent execution");
		expect(repoOnly).not.toContain("Stayed on sign-in");
	});
});
