import { describe, expect, it } from "vitest";
import { onboardingTourActionSchema, withLegacyPromptCompat } from "../schema";

describe("onboardingTourActionSchema legacy-action rollout compat", () => {
	it("accepts the deprecated markFunctionTagsPromptSeen action from old client bundles", () => {
		const parsed = onboardingTourActionSchema.safeParse({
			type: "markFunctionTagsPromptSeen",
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts the current optOutFunctionTagsPrompt action", () => {
		const parsed = onboardingTourActionSchema.safeParse({
			type: "optOutFunctionTagsPrompt",
		});
		expect(parsed.success).toBe(true);
	});

	it("accepts the dismissPointer action", () => {
		const parsed = onboardingTourActionSchema.safeParse({
			type: "dismissPointer",
		});
		expect(parsed.success).toBe(true);
	});

	it("still rejects an unknown action type", () => {
		const parsed = onboardingTourActionSchema.safeParse({
			type: "dismissPointerPlease",
		});
		expect(parsed.success).toBe(false);
	});
});

describe("withLegacyPromptCompat", () => {
	it("adds functionTagsPromptSeen:true for legacy clients", () => {
		const out = withLegacyPromptCompat({
			version: 1,
			status: "not_started",
			currentStepId: null,
			steps: {},
			autoLaunched: false,
			seenPages: {},
			pageToursOptedOut: false,
			functionTagsPromptOptOut: false,
			pointerDismissed: false,
			completedAt: null,
			dismissedAt: null,
		});
		expect(out.functionTagsPromptSeen).toBe(true);
		expect(out.functionTagsPromptOptOut).toBe(false);
	});
});
