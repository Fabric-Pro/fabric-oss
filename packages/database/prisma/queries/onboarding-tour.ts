import { db } from "../client";
import type { Prisma } from "../generated/client";

/**
 * Per-user "Get started" onboarding tour progress. Stored as a single
 * `User.onboardingTourState` JSON column (mirrors the MFA-prompt state
 * precedent: one helper module, self-service access via `protectedProcedure`,
 * no separate table / RLS policy). The shape is validated here on every
 * read (the column is untyped JSON) and mirrored by the API's Zod schema.
 */

/** Bump when the tour's step set changes materially (see onboarding-steps.ts). */
export const ONBOARDING_TOUR_VERSION = 1;

/**
 * Accounts created on/after this instant auto-launch the tour once. Users who
 * existed before the feature shipped are never interrupted — they reach the
 * tour from the persistent "Get started" entry point (migration /
 * backfill requirement).
 */
export const ONBOARDING_AUTO_LAUNCH_SINCE = new Date(
	"2026-07-08T00:00:00.000Z",
);

export type OnboardingTourStatus =
	| "not_started"
	| "in_progress"
	| "completed"
	| "dismissed";

export type OnboardingStepOutcome = "completed" | "skipped";

export type OnboardingTourState = {
	version: number;
	status: OnboardingTourStatus;
	/** Last-viewed step id, used to resume where the user left off. */
	currentStepId: string | null;
	/** Per-step outcome map keyed by step id. */
	steps: Record<string, OnboardingStepOutcome>;
	/** Whether the one-shot first-login auto-launch has already fired. */
	autoLaunched: boolean;
	/**
	 * Project pages whose first-visit detailed tour has already been shown,
	 * keyed by page id. Ensures a page auto-opens its mini-tour at most once.
	 */
	seenPages: Record<string, boolean>;
	/**
	 * Set when the user dismisses an auto-launched page tour — suppresses all
	 * further first-visit auto-opens (they can still start one manually via
	 * "Tour this page"). One clear "not interested" stops the interruptions.
	 */
	pageToursOptedOut: boolean;
	/** Whether the user permanently opted out of the no-tags prompt (FR4). */
	functionTagsPromptOptOut: boolean;
	/**
	 * Whether the user permanently dismissed the "Get started" pointer — the
	 * marker + callout that points new users at the launcher.
	 * Separate from `status`: dismissing the nudge is not dismissing the tour,
	 * so it must not lie about `dismissedAt`.
	 */
	pointerDismissed: boolean;
	completedAt: string | null;
	dismissedAt: string | null;
};

export const DEFAULT_ONBOARDING_TOUR_STATE: OnboardingTourState = {
	version: ONBOARDING_TOUR_VERSION,
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

export type OnboardingTourAction =
	| { type: "start" }
	| {
			type: "step";
			stepId: string;
			outcome: OnboardingStepOutcome;
			currentStepId?: string | null;
	  }
	| { type: "setCurrent"; stepId: string | null }
	| { type: "complete" }
	| { type: "dismiss" }
	| { type: "markAutoLaunched" }
	| { type: "markPageSeen"; pageId: string }
	/**
	 * Card #1837 companion to `markPageSeen`: when a project tab becomes
	 * visible to a viewer again (admin re-enabled it, or the viewer's own
	 * hidden pref was lifted), their seen-marker for that page is cleared so
	 * the next visit replays the first-visit experience.
	 */
	| { type: "clearPageSeen"; pageId: string }
	| { type: "markPageToursOptedOut" }
	/**
	 * @deprecated Rollout-compat only. Pre-redesign client bundles still POST this
	 * on dismiss/save during a rolling deploy; the server maps it to the permanent
	 * opt-out (the old prompt was one-shot, so "seen" == "never again"). Remove
	 * once old SPA bundles have aged out of browser caches.
	 */
	| { type: "markFunctionTagsPromptSeen" }
	| { type: "optOutFunctionTagsPrompt" }
	| { type: "dismissPointer" }
	| { type: "restart" };

const STATUSES: readonly OnboardingTourStatus[] = [
	"not_started",
	"in_progress",
	"completed",
	"dismissed",
];

/** Coerce the untyped JSON column into a valid, fully-populated state. */
export function normalizeOnboardingTourState(
	raw: Prisma.JsonValue | null | undefined,
): OnboardingTourState {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		return { ...DEFAULT_ONBOARDING_TOUR_STATE };
	}
	const obj = raw as Record<string, unknown>;
	const status = STATUSES.includes(obj.status as OnboardingTourStatus)
		? (obj.status as OnboardingTourStatus)
		: "not_started";

	const steps: Record<string, OnboardingStepOutcome> = {};
	if (
		obj.steps != null &&
		typeof obj.steps === "object" &&
		!Array.isArray(obj.steps)
	) {
		for (const [id, outcome] of Object.entries(
			obj.steps as Record<string, unknown>,
		)) {
			if (outcome === "completed" || outcome === "skipped") {
				steps[id] = outcome;
			}
		}
	}

	const seenPages: Record<string, boolean> = {};
	if (
		obj.seenPages != null &&
		typeof obj.seenPages === "object" &&
		!Array.isArray(obj.seenPages)
	) {
		for (const [id, seen] of Object.entries(
			obj.seenPages as Record<string, unknown>,
		)) {
			if (seen === true) {
				seenPages[id] = true;
			}
		}
	}

	return {
		version:
			typeof obj.version === "number"
				? obj.version
				: ONBOARDING_TOUR_VERSION,
		status,
		currentStepId:
			typeof obj.currentStepId === "string" ? obj.currentStepId : null,
		steps,
		autoLaunched: obj.autoLaunched === true,
		seenPages,
		pageToursOptedOut: obj.pageToursOptedOut === true,
		functionTagsPromptOptOut: obj.functionTagsPromptOptOut === true,
		pointerDismissed: obj.pointerDismissed === true,
		completedAt:
			typeof obj.completedAt === "string" ? obj.completedAt : null,
		dismissedAt:
			typeof obj.dismissedAt === "string" ? obj.dismissedAt : null,
	};
}

export function applyOnboardingTourAction(
	prev: OnboardingTourState,
	action: OnboardingTourAction,
	now: string,
): OnboardingTourState {
	switch (action.type) {
		case "start":
			return { ...prev, status: "in_progress" };
		case "step":
			return {
				...prev,
				status: "in_progress",
				steps: { ...prev.steps, [action.stepId]: action.outcome },
				currentStepId:
					action.currentStepId !== undefined
						? action.currentStepId
						: prev.currentStepId,
			};
		case "setCurrent":
			return { ...prev, currentStepId: action.stepId };
		case "complete":
			return {
				...prev,
				status: "completed",
				currentStepId: null,
				completedAt: now,
			};
		case "dismiss":
			return { ...prev, status: "dismissed", dismissedAt: now };
		case "markAutoLaunched":
			return { ...prev, autoLaunched: true };
		case "markPageSeen":
			return {
				...prev,
				seenPages: { ...prev.seenPages, [action.pageId]: true },
			};
		case "clearPageSeen": {
			if (!(action.pageId in prev.seenPages)) {
				return prev;
			}
			const seenPages = { ...prev.seenPages };
			delete seenPages[action.pageId];
			return { ...prev, seenPages };
		}
		case "markPageToursOptedOut":
			return { ...prev, pageToursOptedOut: true };
		// Legacy alias (see OnboardingTourAction) — same effect as the opt-out.
		case "markFunctionTagsPromptSeen":
		case "optOutFunctionTagsPrompt":
			return { ...prev, functionTagsPromptOptOut: true };
		case "dismissPointer":
			return { ...prev, pointerDismissed: true };
		case "restart":
			// `pointerDismissed` is intentionally NOT reset here: replaying the
			// tour is not a request to be nudged toward it again.
			return {
				...prev,
				version: ONBOARDING_TOUR_VERSION,
				status: "in_progress",
				currentStepId: null,
				steps: {},
				completedAt: null,
				dismissedAt: null,
			};
		default: {
			const _exhaustive: never = action;
			void _exhaustive;
			return prev;
		}
	}
}

export async function getOnboardingTourState(userId: string): Promise<{
	state: OnboardingTourState;
	eligibleForAutoLaunch: boolean;
	autoLaunchCohort: boolean;
	eligibleForFunctionTagsPrompt: boolean;
	eligibleForPointer: boolean;
}> {
	const user = await db.user.findUnique({
		where: { id: userId },
		select: {
			onboardingTourState: true,
			createdAt: true,
			defaultFunctionTags: true,
		},
	});
	const state = normalizeOnboardingTourState(user?.onboardingTourState);
	// New-user cohort: independent of tour status, so per-page first-visit
	// tours only fire for accounts created after the feature shipped (existing
	// users are never interrupted on pages they already know).
	const autoLaunchCohort =
		user != null && user.createdAt >= ONBOARDING_AUTO_LAUNCH_SINCE;
	const eligibleForAutoLaunch =
		autoLaunchCohort &&
		state.status === "not_started" &&
		!state.autoLaunched;
	// FR4: prompt any user who has no default function tags and has not opted
	// out — no date cohort, existing tagless users are eligible too. The
	// FABRIC_FEATURE_FUNCTION_TAGS gate is applied by the API layer
	// (get-state.ts), keeping this query env-free and unit-testable.
	const eligibleForFunctionTagsPrompt =
		user != null &&
		user.defaultFunctionTags.length === 0 &&
		!state.functionTagsPromptOptOut;
	// Card 2103 R1: deliberately NO `autoLaunchCohort` gate. Accounts predating
	// ONBOARDING_AUTO_LAUNCH_SINCE never get the first-login drawer, so they are
	// exactly the population the pointer exists for — gating on the cohort would
	// target only users who already receive the drawer.
	const eligibleForPointer =
		user != null &&
		state.status === "not_started" &&
		!state.pointerDismissed;
	return {
		state,
		eligibleForAutoLaunch,
		autoLaunchCohort,
		eligibleForFunctionTagsPrompt,
		eligibleForPointer,
	};
}

export async function updateOnboardingTourState(
	userId: string,
	action: OnboardingTourAction,
): Promise<OnboardingTourState> {
	return db.$transaction(async (tx) => {
		// Serialize concurrent read-modify-writes of the JSON column: lock the
		// user row for the duration of the transaction so a parallel onboarding
		// action (e.g. markPageSeen in another tab) can't clobber this one.
		// Parameterized — never string-interpolate userId into the query text.
		await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
		const user = await tx.user.findUnique({
			where: { id: userId },
			select: { onboardingTourState: true },
		});
		const prev = normalizeOnboardingTourState(user?.onboardingTourState);
		const next = applyOnboardingTourAction(
			prev,
			action,
			new Date().toISOString(),
		);
		await tx.user.update({
			where: { id: userId },
			data: {
				onboardingTourState: next as unknown as Prisma.InputJsonValue,
			},
		});
		return next;
	});
}
