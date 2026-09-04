import { join } from "node:path";
import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstCallPosition } from "../../activities/publishing-shared/__tests__/_ast-guards";

/**
 * The Case Study workflow's DEGRADATION BOUNDARY (Fizzy #1854, Phase 2C).
 *
 * Everything here is about what happens when something goes wrong, because that
 * is the whole job of this file in production: the workflow is started and not
 * awaited, so a thrown error is invisible to the caller AND strands the row on
 * GENERATING, where it holds the partial unique index against every retry until
 * the deadline sweep reclaims it.
 */

const activityStubs = vi.hoisted(() => ({
	generateCaseStudyActivity: vi.fn(),
	markCaseStudyFailedActivity: vi.fn(),
}));

// Typed with its options argument so the "two bags, not one" case below can
// read what each `proxyActivities` call was actually given.
const proxyActivities = vi.hoisted(() =>
	vi.fn((_options: Record<string, unknown>) => activityStubs),
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

import { generatePublishingCaseStudyWorkflow } from "../generate-publishing-case-study";

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

beforeEach(() => {
	activityStubs.generateCaseStudyActivity.mockReset();
	activityStubs.markCaseStudyFailedActivity.mockReset();
	activityStubs.generateCaseStudyActivity.mockResolvedValue({
		status: "READY",
		seededWorkingDraft: true,
	});
	activityStubs.markCaseStudyFailedActivity.mockResolvedValue(undefined);
	// Reset too: a case that reads `log.error.mock.calls[0]` would otherwise
	// read the previous case's line and pass on the wrong evidence.
	log.error.mockReset();
	log.info.mockReset();
});

describe("generatePublishingCaseStudyWorkflow", () => {
	it("returns READY on the happy path", async () => {
		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "READY", seededWorkingDraft: true });
		expect(
			activityStubs.markCaseStudyFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("reports whether the first run seeded a working draft", async () => {
		// The observable difference between a first generation and a
		// regeneration: one lands the reader in an editor, the other offers an
		// adopt control instead.
		activityStubs.generateCaseStudyActivity.mockResolvedValue({
			status: "READY",
			seededWorkingDraft: false,
		});

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "READY", seededWorkingDraft: false });
	});

	it("passes the run's guidance through to the activity", async () => {
		// Guidance is carried on the workflow input rather than re-read from the
		// row, so it is what the user typed on THIS click even if a later
		// attempt has since rewritten the column.
		await generatePublishingCaseStudyWorkflow({
			...INPUT,
			guidance: "Write it for a technical buyer",
		});

		expect(activityStubs.generateCaseStudyActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				guidance: "Write it for a technical buyer",
			}),
		);
	});

	it("does NOT mark a SUPERSEDED attempt failed", async () => {
		// A deadline sweep reclaimed this attempt while the model ran and a
		// newer one owns the content type. The row is already terminal, so the
		// write would be refused and the log line would be untrue.
		activityStubs.generateCaseStudyActivity.mockResolvedValue({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
			refusalReason: "superseded",
		});

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});
		expect(
			activityStubs.markCaseStudyFailedActivity,
		).not.toHaveBeenCalled();
	});

	it("does not call an archived project's refusal a supersession", async () => {
		// The status is still SUPERSEDED — renaming it would change a branch
		// condition and break replay for anything already in flight — so the
		// truth has to reach the operator some other way. It reaches them here.
		activityStubs.generateCaseStudyActivity.mockResolvedValue({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
			refusalReason: "project_ineligible",
		});

		await generatePublishingCaseStudyWorkflow(INPUT);

		const [line, bag] = log.info.mock.calls.at(-1) as [
			string,
			Record<string, unknown>,
		];
		expect(line).not.toMatch(/supersed/i);
		expect(bag).toMatchObject({ reason: "project_ineligible" });
	});

	it("survives a history recorded before the reason field existed", async () => {
		// The replay case. `refusalReason` is optional precisely so an
		// execution started by the previous build — whose history has no such
		// field — replays without the workflow reading `undefined` into a log
		// line or, worse, branching differently on it.
		activityStubs.generateCaseStudyActivity.mockResolvedValue({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({
			status: "SUPERSEDED",
			seededWorkingDraft: false,
		});
		expect(
			activityStubs.markCaseStudyFailedActivity,
		).not.toHaveBeenCalled();
		expect(log.info.mock.calls.at(-1)?.[1]).toMatchObject({
			reason: "unknown",
		});
	});

	it("marks the row FAILED rather than throwing", async () => {
		// Nobody awaits this workflow. Throwing would be invisible and would
		// leave the row holding the in-flight index for ten minutes.
		activityStubs.generateCaseStudyActivity.mockRejectedValue(
			new Error("provider timed out"),
		);

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		expect(activityStubs.markCaseStudyFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				draftId: "d1",
				projectId: "p1",
				message: NEUTRAL_FAILURE,
			}),
		);
	});

	it("recovers a reason WE authored from inside Temporal's wrapper", async () => {
		// Temporal delivers an activity throw as `ActivityFailure`, whose own
		// `.message` is the generic "Activity task failed" — the reason the
		// activity gave lives on `.cause`. The workflow read `error.message`, so
		// EVERY failed draft in the suite stored and displayed that one string:
		// a revoked actor, a bad bound prompt and a provider outage were
		// indistinguishable to the person looking at the tab.
		//
		// A REAL `ActivityFailure` from `@temporalio/common`, not an object
		// shaped by hand. The neighbouring cases reject with a bare `Error`,
		// which is a shape production never produces — that encodes what the
		// author expected the rejection to look like, which is exactly how this
		// went unnoticed for two phases.
		//
		// This case also pins the ROUND TRIP: the string the activity raises and
		// the string the workflow stores are written in two different files, in
		// two different sandboxes, and nothing else would notice them drifting.
		activityStubs.generateCaseStudyActivity.mockRejectedValue(
			new ActivityFailure(
				"Activity task failed",
				"generateCaseStudyActivity",
				"1",
				RetryState.NON_RETRYABLE_FAILURE,
				undefined,
				ApplicationFailure.nonRetryable(
					"The account that started this draft is no longer authorized to generate on this project",
					"PUBLISHING_ACTOR_INVALID",
				),
			),
		);

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		expect(activityStubs.markCaseStudyFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				message:
					"The account that started this draft is no longer authorized to generate on this project",
			}),
		);
	});

	it("keeps a reason we did NOT author out of the stored row, and in the log", async () => {
		// The disclosure boundary. Walking to the deepest cause reaches text
		// nobody on this side wrote — a provider transport error, a driver
		// error — and the panel renders the stored string verbatim to everyone
		// who can see the tab. So the row gets our words and the log gets theirs.
		activityStubs.generateCaseStudyActivity.mockRejectedValue(
			new ActivityFailure(
				"Activity task failed",
				"generateCaseStudyActivity",
				"1",
				RetryState.NON_RETRYABLE_FAILURE,
				undefined,
				new Error(
					"POST https://provider.example.com/v1/x failed: 401 (request 9f2c)",
				),
			),
		);

		await generatePublishingCaseStudyWorkflow(INPUT);

		const stored =
			activityStubs.markCaseStudyFailedActivity.mock.calls[0]?.[0];
		expect(stored.message).toBe(NEUTRAL_FAILURE);
		expect(stored.message).not.toContain("provider.example.com");
		expect(stored.message).not.toContain("request 9f2c");

		// ...and the operator still gets the real thing.
		expect(log.error.mock.calls[0]?.[1]).toMatchObject({
			errorClass: "Error",
			detail: expect.stringContaining("provider.example.com"),
		});
	});

	it("still does not throw when the failure marker ITSELF fails", async () => {
		// The last-resort path. Throwing here records the failure twice and
		// reads as a crash.
		activityStubs.generateCaseStudyActivity.mockRejectedValue(
			new Error("provider timed out"),
		);
		activityStubs.markCaseStudyFailedActivity.mockRejectedValue(
			new Error("database unreachable"),
		);

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
	});

	it("handles a non-Error rejection without losing the failure", async () => {
		activityStubs.generateCaseStudyActivity.mockRejectedValue("a string");

		const result = await generatePublishingCaseStudyWorkflow(INPUT);

		expect(result).toEqual({ status: "FAILED", seededWorkingDraft: false });
		// Deliberately CHANGED from "Unknown error", and not to the thrown value
		// either: a rejection with no type of ours gets the neutral message,
		// because there is no way to know what a non-Error throw contains. The
		// value itself reaches the log. The thing that must not regress is the
		// line above — the workflow still returns rather than throwing.
		expect(activityStubs.markCaseStudyFailedActivity).toHaveBeenCalledWith(
			expect.objectContaining({ message: NEUTRAL_FAILURE }),
		);
	});

	it("gives the failure marker its OWN short-timeout proxy", async () => {
		// Two `proxyActivities` bags, not one. A failure marker inheriting the
		// 480s generation timeout leaves a failing run sitting on GENERATING for
		// another eight minutes, holding the partial unique index against every
		// retry — which is exactly the state this workflow exists to avoid.
		const bags = proxyActivities.mock.calls.map((call) => call[0]);
		expect(bags).toHaveLength(2);

		const generation = bags[0];
		expect(generation.startToCloseTimeout).toBe("480s");
		expect(generation.heartbeatTimeout).toBe("2 minutes");
		expect(generation.retry).toMatchObject({
			maximumAttempts: 3,
			nonRetryableErrorTypes: [
				"ValidationError",
				"TenantViolation",
				// A tenant with no configured provider gets the same refusal on
				// every attempt — see `ai-non-retryable-errors.ts`.
				"AIProviderNotConfiguredError",
				"AiUsageLimitExceededError",
			],
		});

		const marker = bags[1];
		expect(marker.startToCloseTimeout).toBe("30s");
		expect(marker.heartbeatTimeout).toBeUndefined();
	});
});

describe("every publishing generation workflow unwraps the wrapper", () => {
	// The unwrap is one line, repeated in five files, and only ONE of those
	// files is exercised by the case above — `generate-publishing-stakeholder-email.ts`
	// has no workflow suite at all. A file-by-file structural check is what
	// stops the other four regressing silently.
	//
	// `firstCallPosition` and not a source-text search: the comment ABOVE each
	// call describes the mapping in prose, so a grep would stay green after the
	// call itself was deleted.
	const WORKFLOWS = [
		"generate-publishing-blog-post.ts",
		"generate-publishing-case-study.ts",
		"generate-publishing-planning-analysis.ts",
		"generate-publishing-short-post.ts",
		"generate-publishing-stakeholder-email.ts",
	];

	for (const file of WORKFLOWS) {
		it(`${file} routes its failure through the authored mapping`, () => {
			expect(
				firstCallPosition(
					join(__dirname, "..", file),
					"publishingFailureDetail",
				),
			).toBeGreaterThan(-1);
		});
	}
});
