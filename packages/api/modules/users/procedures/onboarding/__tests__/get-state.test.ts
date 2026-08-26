import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOnboardingTourState } = vi.hoisted(() => ({
	getOnboardingTourState: vi.fn(),
}));

// `importOriginal` lets the procedures' transitive dependencies (tenant
// context helpers, etc.) keep working. We only override the symbol our
// handler calls directly. Mirrors list-users.test.ts / feature-flags.test.ts.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		getOnboardingTourState,
	};
});

// `protectedProcedure` imports lazily from `@repo/payments` only on the
// catch path of the AI-usage-limit error mapper, but the procedures module
// re-exports its types eagerly. Stub the whole package so module load
// doesn't blow up (mirrors list-users.test.ts).
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { getOnboardingTourStateProcedure } from "../get-state";

const BASE = {
	state: {
		version: 1,
		status: "not_started" as const,
		currentStepId: null,
		steps: {},
		autoLaunched: false,
		seenPages: {},
		pageToursOptedOut: false,
		functionTagsPromptOptOut: false,
		pointerDismissed: false,
		completedAt: null,
		dismissedAt: null,
	},
	eligibleForAutoLaunch: false,
	autoLaunchCohort: false,
	eligibleForPointer: false,
};

// oRPC procedures expose their handler via `.handler` on the built procedure;
// call it with a minimal context. If the accessor differs in this codebase,
// invoke through the same test entry the sibling onboarding procedures use.
async function callHandler() {
	const proc = getOnboardingTourStateProcedure as any;
	const handler = proc["~orpc"].handler ?? proc.handler;
	return handler({ context: { user: { id: "user-1" } } });
}

beforeEach(() => {
	getOnboardingTourState.mockReset();
	delete process.env.FABRIC_FEATURE_FUNCTION_TAGS;
});

describe("get-state eligibleForFunctionTagsPrompt flag gate", () => {
	it("is false when the flag is off even if data-eligible", async () => {
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "false";
		getOnboardingTourState.mockResolvedValue({
			...BASE,
			eligibleForFunctionTagsPrompt: true,
		});
		const res = await callHandler();
		expect(res.eligibleForFunctionTagsPrompt).toBe(false);
	});

	it("passes through the data value when the flag is on", async () => {
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "true";
		getOnboardingTourState.mockResolvedValue({
			...BASE,
			eligibleForFunctionTagsPrompt: true,
		});
		const res = await callHandler();
		expect(res.eligibleForFunctionTagsPrompt).toBe(true);
	});

	it("is false when the flag is on but the user is not data-eligible", async () => {
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "true";
		getOnboardingTourState.mockResolvedValue({
			...BASE,
			eligibleForFunctionTagsPrompt: false,
		});
		const res = await callHandler();
		expect(res.eligibleForFunctionTagsPrompt).toBe(false);
	});

	it("passes eligibleForPointer through untouched by the function-tags gate", async () => {
		// The pointer rides the Get-started flag on the client, not this one —
		// turning function tags off must not suppress it.
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "false";
		getOnboardingTourState.mockResolvedValue({
			...BASE,
			eligibleForFunctionTagsPrompt: true,
			eligibleForPointer: true,
		});
		const res = await callHandler();
		expect(res.eligibleForPointer).toBe(true);
		expect(res.eligibleForFunctionTagsPrompt).toBe(false);
	});

	it("includes the legacy functionTagsPromptSeen compat flag in the response state", async () => {
		process.env.FABRIC_FEATURE_FUNCTION_TAGS = "true";
		getOnboardingTourState.mockResolvedValue({
			...BASE,
			eligibleForFunctionTagsPrompt: true,
		});
		const res = await callHandler();
		expect(res.state.functionTagsPromptSeen).toBe(true);
	});
});
