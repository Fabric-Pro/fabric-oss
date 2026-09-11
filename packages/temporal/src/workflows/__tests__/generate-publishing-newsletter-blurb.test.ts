import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Newsletter Blurb workflow's DEGRADATION BOUNDARY (Fizzy #1988, Phase 2D
 * slice 2D-2).
 *
 * Nobody awaits this workflow, so a thrown error is invisible to the caller AND
 * strands the row on GENERATING, where it holds the partial unique index
 * against every retry until the deadline sweep reclaims it. Everything below is
 * about what happens when something goes wrong, plus the structural properties
 * no discovery guard sees: which options bag actually arms which activity, and
 * the exact input that reaches generation.
 *
 * Registration and the presence of the failure-mapping call are covered by the
 * guards this workflow was added to (`publishing-workflow-registration.test.ts`
 * and the `WORKFLOWS` list in `generate-publishing-case-study.test.ts`).
 * `ai-non-retryable-errors.test.ts` only COUNTS proxies whose retry policy
 * spreads the AI-retryable types — it does not ask which proxy that is — so the
 * identity assertion (generation's bag, not the marker's) belongs here, beside
 * the sibling's precedent. This file exists for what those guards cannot see.
 */

const activityStubs = vi.hoisted(() => ({
	generateNewsletterBlurbActivity: vi.fn(),
	markNewsletterBlurbFailedActivity: vi.fn(),
}));

// Records which options bag armed each activity NAME, not just that two bags
// exist. `proxyActivities` returning the same object for every call makes the
// binding invisible to a positional read (`bags[0]` / `bags[1]`) — a Proxy's
// `get` trap fires when the workflow destructures each name at module scope,
// which is the only moment that binding is ever observable.
const activityOptionsByKey = vi.hoisted(
	() => new Map<string, Record<string, unknown>>(),
);

const proxyActivities = vi.hoisted(() =>
	vi.fn(
		(options: Record<string, unknown>) =>
			new Proxy(activityStubs, {
				get(target, key) {
					if (typeof key === "string") {
						activityOptionsByKey.set(key, options);
					}
					return target[key as keyof typeof target];
				},
			}),
	),
);

// Hoisted so the cases below can read what actually reached the operator log —
// the other half of the failure contract, and the half the panel never shows.
const log = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({ proxyActivities, log }));

import { generatePublishingNewsletterBlurbWorkflow } from "../generate-publishing-newsletter-blurb";

const INPUT = {
	draftId: "d1",
	topicId: "topic_1",
	projectId: "p1",
	organizationId: "org1",
	actorUserId: "u1",
	guidance: null,
};

/** What the panel is allowed to show for a failure we did not author. */
const NEUTRAL_FAILURE =
	"Generation failed. The reason is recorded in the run log for this project.";

/** The authored copy for a failure THIS activity raises itself. */
const AUTHORED_SCHEMA_FAILURE =
	"The model returned a draft that did not match the expected shape. Generating again usually clears it.";

/**
 * The provider's own words, named so the log assertion below can require
 * equality rather than `stringContaining` — a truncated stand-in that keeps
 * only the host would still satisfy a substring check while the operator
 * loses the status code and the request id.
 */
const THIRD_PARTY_FAILURE_DETAIL =
	"POST https://provider.example.com/v1/x failed: 401 (request 9f2c)";

/** A rejection whose deepest cause is text nobody on this side wrote. */
function thirdPartyFailure(): ActivityFailure {
	return new ActivityFailure(
		"Activity task failed",
		"generateNewsletterBlurbActivity",
		"1",
		RetryState.NON_RETRYABLE_FAILURE,
		undefined,
		new Error(THIRD_PARTY_FAILURE_DETAIL),
	);
}

beforeEach(() => {
	activityStubs.generateNewsletterBlurbActivity.mockReset();
	activityStubs.markNewsletterBlurbFailedActivity.mockReset();
	activityStubs.generateNewsletterBlurbActivity.mockResolvedValue({
		status: "READY",
		seededWorkingDraft: true,
	});
	activityStubs.markNewsletterBlurbFailedActivity.mockResolvedValue(
		undefined,
	);
	// Reset too: a case that reads `log.error.mock.calls[0]` would otherwise
	// read the previous case's line and pass on the wrong evidence.
	log.error.mockReset();
	log.info.mockReset();
});

describe("generatePublishingNewsletterBlurbWorkflow", () => {
	it.each([true, false])(
		"returns READY, forwards the exact activity input, and reports seededWorkingDraft=%s",
		async (seededWorkingDraft) => {
			activityStubs.generateNewsletterBlurbActivity.mockResolvedValue({
				status: "READY",
				seededWorkingDraft,
			});

			const result =
				await generatePublishingNewsletterBlurbWorkflow(INPUT);

			expect(result).toEqual({ status: "READY", seededWorkingDraft });
			// A literal object, not `objectContaining`: that would not catch a
			// field silently added or dropped, and `currentDraft` is OPTIONAL on
			// the input type, so dropping it from the activity call is legal
			// TypeScript — nothing else here would notice.
			expect(
				activityStubs.generateNewsletterBlurbActivity,
			).toHaveBeenCalledWith({
				draftId: "d1",
				topicId: "topic_1",
				projectId: "p1",
				organizationId: "org1",
				actorUserId: "u1",
				guidance: null,
				currentDraft: null,
			});
			expect(
				activityStubs.markNewsletterBlurbFailedActivity,
			).not.toHaveBeenCalled();
		},
	);

	it("forwards a saved working draft to the activity untouched, for a Refine run", async () => {
		// `currentDraft` feeds `buildRefinementSection` on the activity side; an
		// ordinary generation leaves that section empty. Nothing here BRANCHES on
		// the value, so only a direct assertion on the call catches it being
		// dropped or swapped for another field of the same type.
		const result = await generatePublishingNewsletterBlurbWorkflow({
			...INPUT,
			currentDraft: "the reader's saved blurb",
		});

		expect(result.status).toBe("READY");
		expect(
			activityStubs.generateNewsletterBlurbActivity,
		).toHaveBeenCalledWith({
			draftId: "d1",
			topicId: "topic_1",
			projectId: "p1",
			organizationId: "org1",
			actorUserId: "u1",
			guidance: null,
			currentDraft: "the reader's saved blurb",
		});
	});

	it("does NOT mark a SUPERSEDED attempt failed", async () => {
		// A deadline sweep reclaimed this attempt while the model ran and a
		// newer one owns the content type. The row is already terminal, so the
		// write would be refused and the log line would be untrue.
		activityStubs.generateNewsletterBlurbActivity.mockResolvedValue({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
			refusalReason: "project_ineligible",
		});

		const result = await generatePublishingNewsletterBlurbWorkflow(INPUT);

		expect(result).toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});
		expect(
			activityStubs.markNewsletterBlurbFailedActivity,
		).not.toHaveBeenCalled();
		// The status stays "SUPERSEDED" for every refusal — renaming it would
		// change a branch condition and break replay — so the specific reason
		// has to reach the operator some other way. It reaches them here.
		expect(log.info.mock.calls.at(-1)?.[1]).toMatchObject({
			reason: "project_ineligible",
		});
	});

	it("sends the real unwrapped reason to the LOG", async () => {
		// Temporal delivers an activity throw as `ActivityFailure`, whose own
		// `.message` is the generic "Activity task failed" — the reason lives on
		// `.cause`. The operator gets that reason in full; the row does not.
		activityStubs.generateNewsletterBlurbActivity.mockRejectedValue(
			thirdPartyFailure(),
		);

		await generatePublishingNewsletterBlurbWorkflow(INPUT);

		expect(log.error.mock.calls[0]?.[1]).toMatchObject({
			errorClass: "Error",
			// Equality, not `stringContaining`: a logged value trimmed down to
			// just the host would still contain "provider.example.com" while the
			// operator lost the status code and the request id.
			detail: THIRD_PARTY_FAILURE_DETAIL,
			draftId: "d1",
			topicId: "topic_1",
		});
	});

	it("marks the draft failed with the NEUTRAL message, never the provider's words", async () => {
		// The disclosure boundary. The stored string is rendered verbatim by the
		// panel to everyone who can see the tab, and the deepest cause is
		// frequently text a provider or a driver wrote.
		activityStubs.generateNewsletterBlurbActivity.mockRejectedValue(
			thirdPartyFailure(),
		);

		await generatePublishingNewsletterBlurbWorkflow(INPUT);

		const stored =
			activityStubs.markNewsletterBlurbFailedActivity.mock.calls[0]?.[0];
		expect(stored).toMatchObject({ draftId: "d1", projectId: "p1" });
		expect(stored.message).toBe(NEUTRAL_FAILURE);
		expect(stored.message).not.toContain("provider.example.com");
		expect(stored.message).not.toContain("request 9f2c");
	});

	it("stores OUR authored copy for a failure this activity raises itself", async () => {
		// Without this case the neutral assertion above would stay green if the
		// workflow hardcoded that constant instead of consulting the authored
		// mapping — and every failure would then render the same sentence.
		//
		// It also pins a ROUND TRIP: the type string is raised in
		// `activities/publishing-newsletter-blurb/generate-newsletter-blurb.ts`
		// and keyed in `publishing-failure-message.ts`, two different files in
		// two different sandboxes, and nothing else would notice them drifting.
		activityStubs.generateNewsletterBlurbActivity.mockRejectedValue(
			new ActivityFailure(
				"Activity task failed",
				"generateNewsletterBlurbActivity",
				"1",
				RetryState.NON_RETRYABLE_FAILURE,
				undefined,
				ApplicationFailure.nonRetryable(
					"Newsletter blurb failed schema validation: invalid_type at blurb",
					"PUBLISHING_NEWSLETTER_BLURB_SCHEMA_VALIDATION_FAILED",
				),
			),
		);

		await generatePublishingNewsletterBlurbWorkflow(INPUT);

		const stored =
			activityStubs.markNewsletterBlurbFailedActivity.mock.calls[0]?.[0];
		expect(stored.message).toBe(AUTHORED_SCHEMA_FAILURE);
		// The activity's own message appends the validator's report, which
		// quotes the model's output. That belongs in the log, not on a row.
		expect(stored.message).not.toContain("schema validation");
	});

	it("catches a failure of the MARKER itself, logs it, and still resolves", async () => {
		// The marker's call needs its own try/catch: it runs INSIDE the outer
		// catch block, so a rejection there is not caught by the same `try` and
		// would escape the workflow entirely — recording the failure twice and
		// reading as a crash.
		activityStubs.generateNewsletterBlurbActivity.mockRejectedValue(
			new Error("provider timed out"),
		);
		activityStubs.markNewsletterBlurbFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		const result = await generatePublishingNewsletterBlurbWorkflow(INPUT);

		expect(result.status).toBe("FAILED");
		// ...and the marker's own failure is a line of its own, not swallowed:
		// the row will now sit GENERATING until the deadline sweep reclaims it,
		// which is the one outcome an operator has to be told about.
		const markerLine = log.error.mock.calls.at(-1);
		expect(markerLine?.[0]).toContain("could not mark draft failed");
		expect(markerLine?.[1]).toMatchObject({
			draftId: "d1",
			message: "database unreachable",
		});
	});

	it("returns FAILED rather than rethrowing the generation failure", async () => {
		activityStubs.generateNewsletterBlurbActivity.mockRejectedValue(
			new Error("provider timed out"),
		);

		const result = await generatePublishingNewsletterBlurbWorkflow(INPUT);

		// `seededWorkingDraft` is false and not carried over from anything: a
		// run that failed created no working draft, and a `true` here would put
		// the panel into the editor for a draft that does not exist.
		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
	});

	it("binds the failure marker to its OWN short-timeout bag, distinct from generation's", () => {
		// Two `proxyActivities` bags, not one. A failure marker inheriting the
		// 480s generation timeout leaves a failing run sitting on GENERATING for
		// another eight minutes, holding the partial unique index against every
		// retry — exactly the state this workflow exists to avoid.
		expect(proxyActivities.mock.calls).toHaveLength(2);

		// By BINDING, not position: `bags[0]` / `bags[1]` would still read "480s"
		// then "30s" even if the two destructurings in the workflow were swapped,
		// because a positional read cannot tell which bag armed which name.
		const generation = activityOptionsByKey.get(
			"generateNewsletterBlurbActivity",
		);
		expect(generation?.startToCloseTimeout).toBe("480s");
		expect(generation?.heartbeatTimeout).toBe("2 minutes");
		expect(generation?.retry).toMatchObject({
			maximumAttempts: 3,
			nonRetryableErrorTypes: [
				"ValidationError",
				"TenantViolation",
				// A tenant with no configured provider gets the same refusal on
				// every attempt — see `ai-non-retryable-errors.ts`. The shared
				// guard only counts that one proxy in this file declares these;
				// it cannot say WHICH one, so this is the identity assertion.
				"AIProviderNotConfiguredError",
				"AiUsageLimitExceededError",
			],
		});

		const marker = activityOptionsByKey.get(
			"markNewsletterBlurbFailedActivity",
		);
		expect(marker?.startToCloseTimeout).toBe("30s");
		expect(marker?.heartbeatTimeout).toBeUndefined();
		expect(marker?.retry).toMatchObject({ maximumAttempts: 3 });
	});
});
