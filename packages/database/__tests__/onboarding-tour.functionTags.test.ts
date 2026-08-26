import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("../prisma/client", () => ({ db: { user: { findUnique } } }));

import {
	applyOnboardingTourAction,
	DEFAULT_ONBOARDING_TOUR_STATE,
	getOnboardingTourState,
	normalizeOnboardingTourState,
} from "../prisma/queries/onboarding-tour";

describe("onboarding-tour FR4 opt-out field/action", () => {
	it("defaults functionTagsPromptOptOut to false", () => {
		expect(DEFAULT_ONBOARDING_TOUR_STATE.functionTagsPromptOptOut).toBe(
			false,
		);
	});

	it("normalizes a missing field to false and a present true to true", () => {
		expect(normalizeOnboardingTourState({}).functionTagsPromptOptOut).toBe(
			false,
		);
		expect(
			normalizeOnboardingTourState({ functionTagsPromptOptOut: true })
				.functionTagsPromptOptOut,
		).toBe(true);
	});

	it("ignores a leftover functionTagsPromptSeen key (no migration)", () => {
		const s = normalizeOnboardingTourState({
			functionTagsPromptSeen: true,
		});
		expect(s.functionTagsPromptOptOut).toBe(false);
		expect(
			(s as Record<string, unknown>).functionTagsPromptSeen,
		).toBeUndefined();
	});

	it("optOutFunctionTagsPrompt sets the flag idempotently", () => {
		const once = applyOnboardingTourAction(
			DEFAULT_ONBOARDING_TOUR_STATE,
			{ type: "optOutFunctionTagsPrompt" },
			"2026-07-23T00:00:00.000Z",
		);
		expect(once.functionTagsPromptOptOut).toBe(true);
		const twice = applyOnboardingTourAction(
			once,
			{ type: "optOutFunctionTagsPrompt" },
			"x",
		);
		expect(twice.functionTagsPromptOptOut).toBe(true);
	});

	it("legacy markFunctionTagsPromptSeen maps to functionTagsPromptOptOut (rollout compat)", () => {
		const next = applyOnboardingTourAction(
			DEFAULT_ONBOARDING_TOUR_STATE,
			{ type: "markFunctionTagsPromptSeen" },
			"2026-07-23T00:00:00.000Z",
		);
		expect(next.functionTagsPromptOptOut).toBe(true);
	});
});

describe("getOnboardingTourState eligibleForFunctionTagsPrompt (data level, no flag)", () => {
	beforeEach(() => findUnique.mockReset());

	it("is eligible for a user with no default tags who has not opted out", async () => {
		findUnique.mockResolvedValue({
			onboardingTourState: null,
			createdAt: new Date("2000-01-01T00:00:00.000Z"),
			defaultFunctionTags: [],
		});
		const result = await getOnboardingTourState("user_1");
		expect(result.eligibleForFunctionTagsPrompt).toBe(true);
	});

	it("is NOT eligible when the user already has default tags", async () => {
		findUnique.mockResolvedValue({
			onboardingTourState: null,
			createdAt: new Date("2000-01-01T00:00:00.000Z"),
			defaultFunctionTags: ["DEVELOPER"],
		});
		const result = await getOnboardingTourState("user_1");
		expect(result.eligibleForFunctionTagsPrompt).toBe(false);
	});

	it("is NOT eligible when the user opted out (even with no tags)", async () => {
		findUnique.mockResolvedValue({
			onboardingTourState: { functionTagsPromptOptOut: true },
			createdAt: new Date("2000-01-01T00:00:00.000Z"),
			defaultFunctionTags: [],
		});
		const result = await getOnboardingTourState("user_1");
		expect(result.eligibleForFunctionTagsPrompt).toBe(false);
	});
});
