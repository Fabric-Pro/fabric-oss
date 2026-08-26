import type { OnboardingTourState } from "@repo/database";

/**
 * Shared test fixture for the per-user onboarding state.
 *
 * Typed against `OnboardingTourState` deliberately: three suites build this
 * shape (the controller, the pointer, and the navigation), and a plain object
 * literal in each let a new field land in the schema while a fixture silently
 * kept the old shape. Typing it turns that drift into a compile error.
 */
export const DEFAULT_TOUR_STATE: OnboardingTourState = {
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
};

export type OnboardingStateOverrides = {
	state?: Partial<OnboardingTourState>;
	eligibleForAutoLaunch?: boolean;
	autoLaunchCohort?: boolean;
	eligibleForFunctionTagsPrompt?: boolean;
	eligibleForPointer?: boolean;
};

/** Build what `users.onboarding.getState` returns, with per-test overrides. */
export function makeOnboardingStateData(overrides?: OnboardingStateOverrides): {
	state: OnboardingTourState;
	eligibleForAutoLaunch: boolean;
	autoLaunchCohort: boolean;
	eligibleForFunctionTagsPrompt: boolean;
	eligibleForPointer: boolean;
} {
	return {
		state: { ...DEFAULT_TOUR_STATE, ...overrides?.state },
		eligibleForAutoLaunch: overrides?.eligibleForAutoLaunch ?? false,
		autoLaunchCohort: overrides?.autoLaunchCohort ?? false,
		eligibleForFunctionTagsPrompt:
			overrides?.eligibleForFunctionTagsPrompt ?? false,
		eligibleForPointer: overrides?.eligibleForPointer ?? false,
	};
}
