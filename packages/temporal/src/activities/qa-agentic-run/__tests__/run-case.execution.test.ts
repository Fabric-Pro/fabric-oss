import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserRefusal } from "../browser-driver";

const mocks = vi.hoisted(() => ({
	decide: vi.fn(),
	goto: vi.fn(),
	perform: vi.fn(),
	open: vi.fn(),
	close: vi.fn(),
	capture: vi.fn(),
	upload: vi.fn(),
	preflight: vi.fn(),
	refusals: [] as BrowserRefusal[],
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: async () => ({ model: {}, metadata: null }),
}));
vi.mock("@repo/database", () => ({
	getBoundPromptForAgent: async () => ({
		version: { content: "Runner instructions" },
	}),
	recordRunEvidence: vi.fn(),
	resolveEnvironmentAuth: vi.fn(),
}));
vi.mock("@repo/storage", () => ({
	buildTenantStoragePath: () => "fixture/evidence.png",
	uploadFile: mocks.upload,
}));
vi.mock("@repo/utils/url-security", async (original) => ({
	...(await original<typeof import("@repo/utils/url-security")>()),
	assertSafeOutboundUrlResolved: mocks.preflight,
}));
vi.mock("../model-decision", () => ({
	decideWithModel: mocks.decide,
	describeModelFailure: () => "Model failed",
}));
vi.mock("../browser-driver", async (original) => ({
	...(await original<typeof import("../browser-driver")>()),
	openBrowser: mocks.open,
	closeBrowser: mocks.close,
	performOperation: mocks.perform,
	snapshotPage: async () => "button Save\nSaved",
	captureScreenshot: mocks.capture,
	settleNavigation: async () => {},
}));

import { type RunAgenticCaseInput, runAgenticCase } from "../run-case";

const INPUT: RunAgenticCaseInput = {
	projectId: "fixture-project",
	organizationId: null,
	userId: "fixture-user",
	testCaseId: "fixture-case",
	identifier: "TC-1",
	title: "Save",
	description: null,
	steps: [
		{ order: 1, action: "Click Save", expected: "Saved is visible" },
		{ order: 2, action: "Inspect result", expected: "Saved" },
	],
	targetBaseUrl: "https://app.example.com",
	browser: "chromium",
	resolution: "1920x1080",
	evidencePolicy: "NONE",
	houseRules: null,
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.refusals.length = 0;
	mocks.capture.mockResolvedValue(Buffer.from("fixture screenshot"));
	mocks.upload.mockResolvedValue(undefined);
	mocks.open.mockResolvedValue({
		page: { goto: mocks.goto },
		refusals: mocks.refusals,
	});
	mocks.perform.mockResolvedValue({
		ok: true,
		detail: "No interaction needed — checked the page as it stood.",
	});
	mocks.decide.mockResolvedValue({
		value: { met: true, observation: "Saved", confidence: 100 },
		calls: 1,
		via: "object",
	});
});
describe("runAgenticCase preserves the performed-action contract", () => {
	it.each([
		"Submit the form",
		"Select an item",
		"Click Save",
		"Verify by clicking Save",
		"Confirm by pressing Enter",
		"Check by filling the email field",
	])("cannot pass an unperformed interaction: %s", async (action) => {
		mocks.decide.mockResolvedValueOnce({
			value: { kind: "none", reasoning: "No suitable control" },
			calls: 1,
			via: "object",
		});
		const result = await runAgenticCase({
			...INPUT,
			steps: [{ order: 1, action, expected: "Saved is visible" }],
		});
		expect(result.result).toBe("NEEDS_REVIEW");
		expect(mocks.decide).toHaveBeenCalledTimes(1);
	});
	it.each([
		[
			"connection-refused",
			"ECONNREFUSED",
			"running and accepting connections",
		],
		["host-not-found", "ENOTFOUND", "check the environment's base URL"],
		["certificate-invalid", "CERT_HAS_EXPIRED", "TLS certificate"],
		["tls-failed", "EPROTO", "TLS configuration"],
		["fetch-failed", "TIMEOUT", "runner's own network"],
	] as const)(
		"shows a %s initial navigation explanation, rather than a newer font failure",
		async (kind, detail, sentence) => {
			mocks.goto.mockImplementationOnce(async () => {
				mocks.refusals.push({
					kind,
					url: INPUT.targetBaseUrl,
					detail,
					isNavigation: true,
				});
				mocks.refusals.push({
					kind: "off-origin",
					url: "https://fonts.example.com/file",
					detail: "outside origin",
					isNavigation: false,
				});
				throw new Error("net::ERR_FAILED");
			});
			const result = await runAgenticCase(INPUT);
			expect(result.result).toBe("BLOCKED");
			expect(result.failureMessage).toContain(sentence);
			expect(result.failureMessage).not.toContain("fonts.example");
			expect(result.modelCalls).toBe(0);
		},
	);
	it("uses a neutral timeout diagnosis when opening the app records no refusal", async () => {
		mocks.goto.mockRejectedValueOnce(
			new Error(
				'page.goto: Timeout 30000ms exceeded. navigating to "https://app.example.com/?token=fixture-secret"',
			),
		);
		const result = await runAgenticCase({
			...INPUT,
			targetBaseUrl: "https://app.example.com/?token=fixture-secret",
		});
		expect(result.result).toBe("BLOCKED");
		expect(result.failureMessage).toContain("runner's own network");
		expect(result.failureMessage).not.toContain("page.goto");
		expect(result.failureMessage).not.toContain("fixture-secret");
		expect(result.failureMessage).not.toContain("TLS");
		expect(result.modelCalls).toBe(0);
	});
	it.each([
		{ kind: "click", role: "button" },
		{ kind: "fill", name: "Email" },
		{ kind: "type" },
		{ kind: "press" },
		{ kind: "goto" },
		{ kind: "exec" },
		{},
	])(
		"blocks malformed decisions without an assessment: %j",
		async (value) => {
			mocks.decide.mockResolvedValueOnce({
				value,
				calls: 2,
				via: "text",
			});
			const result = await runAgenticCase(INPUT);
			expect(result.result).toBe("BLOCKED");
			expect(result.modelCalls).toBe(2);
			expect(mocks.decide).toHaveBeenCalledTimes(1);
			expect(mocks.perform).not.toHaveBeenCalled();
			expect(result.steps[0]?.observation).not.toContain(
				"No interaction needed",
			);
			expect(result.steps[1]?.status).toBe("SKIPPED");
		},
	);
	it("requires review when none skips an authored interaction, retaining its reason", async () => {
		mocks.decide.mockResolvedValueOnce({
			value: { kind: "none", reasoning: "The Save button is missing" },
			calls: 1,
			via: "object",
		});
		const result = await runAgenticCase(INPUT);
		expect(result.result).toBe("NEEDS_REVIEW");
		expect(result.steps[0]?.observation).toContain(
			"The Save button is missing",
		);
		expect(mocks.decide).toHaveBeenCalledTimes(1);
	});
	it.each(["Inspect saved message", "Vérifier l’état", "確認結果"])(
		"requires review for an explicit none regardless of step wording: %s",
		async (action) => {
			mocks.decide.mockResolvedValueOnce({
				value: {
					kind: "none",
					reasoning: "This step only inspects the page",
				},
				calls: 1,
				via: "object",
			});
			const result = await runAgenticCase({
				...INPUT,
				steps: [
					{
						order: 1,
						action,
						expected: "Saved is visible",
					},
				],
			});
			expect(result.result).toBe("NEEDS_REVIEW");
			expect(result.modelCalls).toBe(1);
			expect(result.steps[0]?.observation).toContain(
				"This step only inspects the page",
			);
			expect(mocks.decide).toHaveBeenCalledTimes(1);
		},
	);
	it("requires review with an honest explanation when none has no reasoning", async () => {
		mocks.decide.mockResolvedValueOnce({
			value: { kind: "none" },
			calls: 1,
			via: "object",
		});
		const result = await runAgenticCase(INPUT);
		expect(result.result).toBe("NEEDS_REVIEW");
		expect(result.steps[0]?.observation).toContain(
			"The model chose no interaction",
		);
		expect(mocks.decide).toHaveBeenCalledOnce();
	});
	describe.each(["SCREENSHOT_REQUIRED", "OPTIONAL", "NONE"])(
		"terminal step evidence under %s",
		(evidencePolicy) => {
			it.each([
				["none", "NEEDS_REVIEW"],
				["malformed", "BLOCKED"],
				["failed operation", "BLOCKED"],
				["model failure", "BLOCKED"],
				["passed", "PASSED"],
			])(
				"finalizes %s through the evidence policy",
				async (scenario, expectedStatus) => {
					if (scenario === "none") {
						mocks.decide.mockResolvedValueOnce({
							value: { kind: "none", reasoning: "No control" },
							calls: 1,
							via: "object",
						});
					} else if (scenario === "malformed") {
						mocks.decide.mockResolvedValueOnce({
							value: { kind: "click" },
							calls: 1,
							via: "object",
						});
					} else if (scenario === "model failure") {
						mocks.decide.mockRejectedValueOnce(
							new Error("Fixture model unavailable"),
						);
					} else {
						mocks.decide.mockResolvedValueOnce({
							value: {
								kind: "click",
								role: "button",
								name: "Save",
							},
							calls: 1,
							via: "object",
						});
						mocks.perform.mockResolvedValueOnce({
							ok: scenario === "passed",
							detail: "Fixture operation result",
						});
					}
					const result = await runAgenticCase({
						...INPUT,
						evidencePolicy,
						steps: [INPUT.steps[0]],
					});
					expect(result.result).toBe(expectedStatus);
					expect(mocks.decide).toHaveBeenCalledTimes(
						scenario === "passed" ? 2 : 1,
					);
					const capture =
						evidencePolicy === "SCREENSHOT_REQUIRED" ||
						(evidencePolicy === "OPTIONAL" &&
							expectedStatus !== "PASSED");
					expect(mocks.capture).toHaveBeenCalledTimes(
						capture ? 1 : 0,
					);
					expect(mocks.upload).toHaveBeenCalledTimes(capture ? 1 : 0);
					expect(result.steps[0]?.evidenceKey).toBe(
						capture ? "fixture/evidence.png" : null,
					);
				},
			);
		},
	);
	it("keeps a blocked verdict if its screenshot cannot be captured", async () => {
		mocks.decide.mockResolvedValueOnce({
			value: { kind: "click" },
			calls: 1,
			via: "object",
		});
		mocks.capture.mockResolvedValueOnce(null);
		const result = await runAgenticCase({
			...INPUT,
			evidencePolicy: "SCREENSHOT_REQUIRED",
		});
		expect(result.result).toBe("BLOCKED");
		expect(result.steps[0]?.evidenceKey).toBeNull();
		expect(mocks.upload).not.toHaveBeenCalled();
	});
	it.each(["ENOTFOUND", "EAI_AGAIN", "UNSAFE_OUTBOUND_URL"])(
		"explains preflight %s with zero model calls",
		async (code) => {
			mocks.preflight.mockRejectedValueOnce(
				Object.assign(new Error("DNS failed"), { code }),
			);
			const result = await runAgenticCase(INPUT);
			expect(result.result).toBe("BLOCKED");
			expect(result.modelCalls).toBe(0);
			expect(mocks.open).not.toHaveBeenCalled();
			if (code === "ENOTFOUND") {
				expect(result.failureMessage).toContain(
					"check the environment's base URL",
				);
			}
			if (code === "EAI_AGAIN") {
				expect(result.failureMessage).toContain("runner's own network");
			}
			if (code === "UNSAFE_OUTBOUND_URL") {
				expect(result.failureMessage).toContain(
					"environment configuration problem",
				);
			}
		},
	);
	it("reports a refused initial redirect before any model call", async () => {
		mocks.goto.mockImplementationOnce(async () => {
			mocks.refusals.push({
				kind: "off-origin",
				url: "https://other.example.com/login",
				detail: "outside origin",
				isNavigation: true,
			});
			throw new Error("net::ERR_BLOCKED_BY_CLIENT");
		});
		const result = await runAgenticCase(INPUT);
		expect(result.failureMessage).toContain(
			"check the environment's base URL",
		);
		expect(result.modelCalls).toBe(0);
		expect(mocks.decide).not.toHaveBeenCalled();
		expect(mocks.close).toHaveBeenCalledTimes(1);
	});
	it("blocks a mid-run navigation even when Playwright reports the click succeeded", async () => {
		mocks.decide.mockResolvedValueOnce({
			value: { kind: "click", role: "button", name: "Save" },
			calls: 2,
			via: "text",
		});
		mocks.perform.mockImplementationOnce(async () => {
			mocks.refusals.push({
				kind: "off-origin",
				url: "https://other.example.com/login",
				detail: "outside origin",
				isNavigation: true,
			});
			mocks.refusals.push({
				kind: "fetch-failed",
				url: "https://app.example.com/font",
				detail: "timeout",
				isNavigation: false,
			});
			return {
				ok: false,
				detail: "The page redirected to https://other.example.com/login, outside this environment's origin — check the environment's base URL.",
			};
		});
		const result = await runAgenticCase(INPUT);
		expect(result.result).toBe("BLOCKED");
		expect(result.modelCalls).toBe(2);
		expect(mocks.decide).toHaveBeenCalledTimes(1);
		expect(result.steps[0]?.observation).toContain(
			"check the environment's base URL",
		);
		expect(result.steps[0]?.observation).not.toContain("font");
	});
});
