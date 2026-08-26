/**
 * Activity: draft test cases from ONE feature and persist them.
 *
 * This is the whole of what used to run inline in the `aiDraft` procedure —
 * load the feature, generate, persist as DRAFT, mirror into project RAG — moved
 * off the request path so the run is durable. The workflow calls it once per
 * requested feature.
 *
 * It does not throw for a feature that can't be drafted. A batch must survive one
 * bad feature, so every outcome (no criteria, no provider, nothing usable, a
 * failed generation) comes back as a recorded status and the run moves on.
 *
 * Tenant scope travels in the input and is re-applied here: the activity runs in
 * a worker with no request context, so it reads the feature scoped to its
 * project and stamps the same org/user onto every case it writes. It never
 * widens what the caller was allowed to touch.
 */

import {
	countAcceptanceCriteria,
	draftTestCases,
	MAX_DRAFTED_TEST_CASES,
} from "@repo/ai";
import type { TestCaseWorkItemLinkInput } from "@repo/database";
import {
	bulkCreateTestCases,
	createContext,
	fingerprintSpecText,
	getProjectQaSettings,
	setTestCaseContextId,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { logger } from "@repo/logs";
import { resolveScepticRoles } from "@repo/utils/qa-test-types";
import { heartbeat } from "@temporalio/activity";
import { getTemporalClient } from "../../client";
import { buildTestCaseContextContent } from "../../lib/test-case-context-content";
import { dedupeDraftedCases } from "./dedupe-drafted-cases";

/** Mirrors `TestCaseDraftFeatureOutcomeStatus` in @repo/database. */
export type DraftTestCasesFeatureStatus =
	| "DRAFTED"
	| "NO_ACCEPTANCE_CRITERIA"
	| "NO_AI_PROVIDER"
	| "NO_CASES"
	| "NOT_FOUND"
	| "FAILED";

export interface DraftTestCasesForFeatureInput {
	jobId: string;
	projectId: string;
	storyId: string;
	userId: string;
	organizationId?: string;
}

export interface DraftTestCasesForFeatureResult {
	storyId: string;
	storyIdentifier: string;
	storyTitle: string;
	status: DraftTestCasesFeatureStatus;
	caseIds: string[];
	/**
	 * Cases the model produced that the feature already had, so they were not
	 * created again. Reported rather than dropped: "generated 12, created 3"
	 * is information the person who pressed the button needs — silently
	 * creating 3 looks like the model underperformed.
	 */
	skippedDuplicates?: string[];
	error?: string;
}

/**
 * Failures that are about THIS deployment rather than about the request.
 *
 * A user cannot act on any of them, and their messages carry deployment
 * internals — environment-variable names, key versions, hosts. Staging surfaced
 * `Encryption key version "2" not found in ENCRYPTION_KEYS (key may have been
 * retired)` verbatim in a product toast, which told an attacker about the key
 * management and told the user nothing they could do.
 */
const CONFIGURATION_FAULT =
	/ENCRYPTION_KEYS|ENCRYPTION_ACTIVE_KEY_VERSION|BETTER_AUTH_SECRET|Encryption key version|Invalid encrypted API key format|environment variable is required/i;

/** Shapes that are never meaningful to a user, whatever produced them. */
const INTERNAL_DETAIL = [
	/\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g, // SCREAMING_SNAKE env-var names
	/(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/]){2,}[\w.-]+/g, // absolute-ish file paths
	// Stack frames. `[^)]{0,200}` rather than `.*?` on purpose: the lazy dot
	// backtracks superlinearly on repeated "at x (" with no closing paren, which
	// is the exact shape of a truncated stack. A negated class cannot.
	/\bat\s+\S+\s+\([^)]{0,200}\)/g,
	/\bhttps?:\/\/\S+/g, // URLs, which carry hostnames
];

/**
 * Derive a concise, user-facing reason from a genuine AI generation failure.
 *
 * Prefer the provider's own message — it is typically actionable ("credit
 * balance too low", a rate-limit notice) — but never at the price of leaking
 * how this deployment is configured. A configuration fault gets a fixed message
 * naming who can fix it; anything else is passed through with internal shapes
 * redacted and bounded to a sane length.
 *
 * The raw message is logged either way, so the detail stays diagnosable to
 * operators — the point is that it stops being addressed to the wrong audience.
 */
function aiGenerationFailureMessage(error: unknown): string {
	// Bounded BEFORE the redaction passes, not after. `INTERNAL_DETAIL`'s
	// stack-frame pattern is quadratic on input shaped like repeated "at fn ("
	// with no closing paren — measured at ~37ms for 30K chars and ~3.6s for
	// 300K. A provider that hands back a proxy error page or an echoed
	// completion would stall the event loop, and this activity's own 15s
	// heartbeat runs on that loop: a slow redaction turns a failed-but-cheap
	// run into a heartbeat timeout and a retry. Nothing beyond the first 2K
	// survives the 300-char cap below anyway.
	const raw = (error instanceof Error ? error.message.trim() : "").slice(
		0,
		2000,
	);
	if (!raw) {
		return "AI generation failed. Please try again.";
	}
	if (CONFIGURATION_FAULT.test(raw)) {
		return "This workspace's AI credentials could not be read, so nothing was generated and nothing was billed. This needs an administrator rather than a retry.";
	}
	const redacted = INTERNAL_DETAIL.reduce(
		(text, shape) => text.replace(shape, "…"),
		raw,
	).trim();
	// Redaction can eat a message whole (a bare stack frame, a lone path). An
	// empty string would render as "failed to generate: ", which reads broken.
	if (redacted.replace(/[…\s]/g, "") === "") {
		return "AI generation failed. Please try again.";
	}
	return redacted.length > 300 ? `${redacted.slice(0, 300)}…` : redacted;
}

/**
 * Mirror a freshly-created case into its ProjectContext row and start the
 * embedding. These cases are brand new, so there is never an existing context to
 * reconcile — this is the create-only half of the request path's
 * `syncTestCaseContext`, sharing its content builder.
 *
 * Best-effort by construction: RAG mirroring must never fail the cases it
 * accompanies.
 */
async function mirrorDraftedCaseToContext(params: {
	testCase: {
		id: string;
		identifier: string;
		title: string;
		state: string;
		priority: string;
		description: string | null;
		steps: Array<{ action: string; expected: string }>;
	};
	storyIdentifier: string;
	storyTitle: string;
	acceptanceCriterionRef: string | null;
	projectId: string;
	userId: string;
	organizationId?: string;
}): Promise<void> {
	try {
		const content = buildTestCaseContextContent({
			identifier: params.testCase.identifier,
			title: params.testCase.title,
			state: params.testCase.state,
			priority: params.testCase.priority,
			preconditions: params.testCase.description,
			steps: params.testCase.steps,
			linkedFeatures: [
				{
					identifier: params.storyIdentifier,
					title: params.storyTitle,
					acceptanceCriterionRef: params.acceptanceCriterionRef,
				},
			],
		});
		const sourceTitle =
			`${params.testCase.identifier} ${params.testCase.title}`.trim();

		const context = await createContext({
			projectId: params.projectId,
			type: "TEST_CASE",
			content,
			sourceTitle,
			metadata: { testCaseId: params.testCase.id, sourceTitle },
			userId: params.userId,
			organizationId: params.organizationId,
		});
		await setTestCaseContextId({
			id: params.testCase.id,
			contextId: context.id,
		});

		const client = await getTemporalClient();
		await client.workflow.start("contextEmbeddingWorkflow", {
			taskQueue: "project-documents",
			workflowId: `context-embedding-${context.id}-${Date.now()}`,
			args: [
				{
					contextId: context.id,
					projectId: params.projectId,
					userId: params.userId,
					organizationId: params.organizationId,
					content,
					type: "TEST_CASE",
					metadata: { sourceTitle },
				},
			],
		});
	} catch (error) {
		logger.warn("[draftTestCasesForFeature] RAG mirror failed", {
			testCaseId: params.testCase.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Is the run this activity belongs to still live? By the time a draft activity
 * executes, `beginTestCaseDraftJob` has advanced the row to RUNNING, so RUNNING
 * is the only live state here — CANCELLED (or any other terminal state, or a
 * deleted row) means the user's Stop must win.
 */
async function jobStillLive(
	input: DraftTestCasesForFeatureInput,
): Promise<boolean> {
	const job = await db.testCaseDraftJob.findFirst({
		where: { id: input.jobId, projectId: input.projectId },
		select: { status: true },
	});
	return job?.status === "RUNNING";
}

/**
 * Returns `null` when the job left RUNNING (the user cancelled) — nothing was
 * persisted and the workflow must stop. Checked twice: before the LLM call, so
 * a cancel that lands while the run is queued doesn't bill a generation at
 * all, and again after it, so a cancel that lands DURING the multi-second
 * generation doesn't append cases to a run the user was told is cancelled
 * (live-observed on staging: 14 orphaned cases persisted 20s after CANCELLED).
 * The ledger write was always compare-and-set on RUNNING; the case rows were
 * not — this closes that half. A cancel arriving between the second check and
 * the persist can still slip through, but the window is now milliseconds, not
 * the length of a generation.
 */
export async function draftTestCasesForFeature(
	input: DraftTestCasesForFeatureInput,
): Promise<DraftTestCasesForFeatureResult | null> {
	// Keep the activity live across the LLM call (heartbeatTimeout is the
	// liveness gate, not startToCloseTimeout).
	heartbeat("draft-start");
	const hb = setInterval(() => {
		try {
			heartbeat("drafting");
		} catch {
			// heartbeat throws only outside an activity context; ignore.
		}
	}, 15_000);

	try {
		// Scoped to the project, so a story id from another project resolves to
		// NOT_FOUND here just as it would on the request path.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				identifier: true,
				title: true,
				description: true,
				acceptanceCriteria: true,
			},
		});
		if (!story) {
			return {
				storyId: input.storyId,
				storyIdentifier: "",
				storyTitle: "",
				status: "NOT_FOUND",
				caseIds: [],
			};
		}

		const base = {
			storyId: input.storyId,
			storyIdentifier: story.identifier,
			storyTitle: story.title,
			caseIds: [],
		};

		// Acceptance criteria ARE the drafting contract — every case must name the
		// criterion it validates. Without them the model has nothing falsifiable to
		// test against and invents plausible-looking cases that verify nothing, so
		// skip rather than bill a generation for junk.
		if (!story.acceptanceCriteria?.trim()) {
			return { ...base, status: "NO_ACCEPTANCE_CRITERIA" };
		}

		// Cancel-before-spend: the run may have been stopped while this activity
		// sat in the queue. Nothing is billed for a dead run.
		if (!(await jobStillLive(input))) {
			return null;
		}

		// The project's QA policy shapes the draft. A read failure must not sink
		// the run: drafting without the policy is exactly the old behaviour, and
		// far better than failing the whole job over a settings lookup.
		let qaSettings: Awaited<
			ReturnType<typeof getProjectQaSettings>
		> | null = null;
		try {
			qaSettings = await getProjectQaSettings(input.projectId);
		} catch (error) {
			logger.warn("qa.draft.policy_read_failed", {
				projectId: input.projectId,
				error: error instanceof Error ? error.message : String(error),
			});
		}

		let drafted: Awaited<ReturnType<typeof draftTestCases>>;
		try {
			drafted = await draftTestCases(
				{
					title: story.title,
					description: story.description,
					acceptanceCriteria: story.acceptanceCriteria,
					// "At least one case per criterion" must stay
					// satisfiable for criteria-heavy features: raise the cap to
					// the criteria count when it exceeds the default. Derived
					// from the data here — no workflow-payload change — and
					// hard-clamped by the drafting lib's absolute ceiling.
					maxTestCases: Math.max(
						MAX_DRAFTED_TEST_CASES,
						countAcceptanceCriteria(story.acceptanceCriteria),
					),
					// The project's QA policy (Settings ▸ Testing). Read here
					// rather than threaded through the workflow payload, for the
					// same reason as the cap above — it is data, not a decision
					// the workflow needs to replay deterministically.
					qaPolicy: qaSettings
						? {
								strategyDepth: qaSettings.strategyDepth,
								requiredTestTypes: qaSettings.requiredTestTypes,
								evidencePolicy: qaSettings.evidencePolicy,
								// Capped by depth: a role whose dimension the
								// project's effective test types exclude writes
								// nothing, which is what makes the Light tier
								// mean what it says. An explicit type selection
								// still wins, so a project that ticks security
								// keeps its security lens at any depth.
								scepticRoles: resolveScepticRoles({
									depth: qaSettings.strategyDepth,
									requiredTestTypes:
										qaSettings.requiredTestTypes,
									scepticRoles: qaSettings.scepticRoles,
									scepticRolesEnabled:
										qaSettings.scepticRolesEnabled,
								}),
							}
						: undefined,
				},
				{
					userId: input.userId,
					organizationId: input.organizationId,
					projectId: input.projectId,
				},
			);
		} catch (error) {
			// A provider IS configured but the call failed — billing/credits,
			// rate limit, auth, upstream outage, malformed output, or this
			// deployment's own credential resolution. `draftTestCases` returns
			// `null` (not throws) for the genuine no-provider case, so reaching
			// here always means a real failure worth surfacing.
			//
			// Logged raw and unredacted: some of these fail BEFORE the model is
			// constructed, so they are billed nothing and never reach the AI
			// usage ledger. Without this line a fully broken drafting path is
			// invisible to anything watching spend.
			logger.error("qa.test_cases.draft_failed", {
				projectId: input.projectId,
				storyId: input.storyId,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				...base,
				status: "FAILED",
				error: aiGenerationFailureMessage(error),
			};
		}

		// `null` → the project has no AI provider configured; empty → the model
		// produced nothing usable. Both are advisory non-errors.
		if (drafted === null) {
			return { ...base, status: "NO_AI_PROVIDER" };
		}
		if (drafted.length === 0) {
			return { ...base, status: "NO_CASES" };
		}

		// Cancel-during-generation: the generation is a sunk cost, but the cases
		// must not land on a run the user already stopped.
		if (!(await jobStillLive(input))) {
			return null;
		}

		// Do not re-create what the feature already has. Drafting APPENDS, so a
		// second pass over a changed feature used to produce the whole set again
		// alongside the originals — near-duplicates differing by a word, which a
		// human then reconciles by hand. That is the trap that blocks the
		// test-case update step: an update path is impossible while a re-draft
		// silently doubles the suite.
		//
		// Read fresh here rather than passed in: the workflow may have drafted
		// other features since, and this must see the state as it is now.
		const existingCases = await db.testCase.findMany({
			where: {
				projectId: input.projectId,
				deletedAt: null,
				workItemLinks: { some: { userStoryId: input.storyId } },
			},
			select: {
				title: true,
				workItemLinks: {
					where: { userStoryId: input.storyId },
					select: { acceptanceCriterionRefs: true },
				},
			},
		});
		// The drafter names ONE criterion per case; the link carries an array.
		// Wrap at this seam so both sides of the dedupe speak the plural shape.
		const candidates = drafted.map((c) => ({
			...c,
			acceptanceCriterionRefs: c.acceptanceCriterionRef
				? [c.acceptanceCriterionRef]
				: [],
		}));
		const { toCreate, skippedTitles } = dedupeDraftedCases(
			candidates,
			existingCases.map((c) => ({
				title: c.title,
				acceptanceCriterionRefs:
					c.workItemLinks[0]?.acceptanceCriterionRefs ?? [],
			})),
		);

		if (skippedTitles.length > 0) {
			logger.info("qa.draft.duplicates_skipped", {
				projectId: input.projectId,
				storyId: input.storyId,
				generated: drafted.length,
				skipped: skippedTitles.length,
			});
		}

		// Every case the model produced already exists. Not a failure — it is the
		// correct outcome of re-drafting an unchanged feature — but it must not
		// read as "the model produced nothing".
		if (toCreate.length === 0) {
			return {
				...base,
				status: "DRAFTED",
				caseIds: [],
				skippedDuplicates: skippedTitles,
			};
		}

		// INVARIANT: AI output is DRAFT only — never READY/CLOSED. Each case is
		// created DRAFT and linked to the source feature in one transaction.
		const created = await bulkCreateTestCases({
			projectId: input.projectId,
			createdById: input.userId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			cases: toCreate.map((c) => ({
				title: c.title,
				// `TestCase.description` IS the preconditions field — the PM-sync
				// mapper reads it back as `preconditions: detail.description` —
				// so the drafted preconditions land here, not in a column of
				// their own.
				description: c.preconditions || null,
				// PROPOSED when an adversarial lens invented the case, DRAFT when
				// the acceptance criteria implied it. The drafter decides which;
				// hardcoding DRAFT here is what made every AI suggestion join the
				// suite unreviewed.
				state: c.state,
				priority: c.priority,
				automationStatus: c.automationStatus,
				// The pyramid level the drafter says the case sits at. Null when it
				// declined or answered something unrecognised, which the coverage
				// matrix renders as UNSET — the state every drafted case was in
				// before the drafter was asked at all, so null costs nothing and a
				// real answer saves a person classifying it by hand.
				coverageType: c.coverageType,
				steps: c.steps,
				// Carry the criterion the model says this case validates onto the
				// link in its plural shape, so coverage is traceable per-criterion
				// instead of per-feature. Empty when the model named none. The
				// `satisfies` is load-bearing: an object literal loses its
				// excess-property checks once it flows through `.map()`, which is
				// exactly how a stray singular `acceptanceCriterionRef` key once
				// passed tsc here while storing no criterion on any link.
				workItemLinks: [
					{
						userStoryId: input.storyId,
						acceptanceCriterionRefs: c.acceptanceCriterionRefs,
					} satisfies TestCaseWorkItemLinkInput,
				],
			})),
			// Stamp the birth event as an AI draft so the case's activity
			// timeline shows it was drafted (not hand-authored) and by which run.
			createdVia: { label: "AI draft", draftJobId: input.jobId },
			// Record WHICH version of the feature text these cases were drafted
			// from. Without this a case cannot be told apart from the feature as
			// it stands now, and the suite goes on asserting a flow the product
			// no longer has — coverage that reads as coverage and is not.
			draftedFromSpecHash: fingerprintSpecText(story),
		});

		for (const [index, testCase] of created.entries()) {
			await mirrorDraftedCaseToContext({
				testCase: {
					id: testCase.id,
					identifier: testCase.identifier,
					title: testCase.title,
					state: testCase.state,
					priority: testCase.priority,
					description: testCase.description,
					steps: testCase.steps.map((s) => ({
						action: s.action,
						expected: s.expected,
					})),
				},
				storyIdentifier: story.identifier,
				storyTitle: story.title,
				acceptanceCriterionRef:
					toCreate[index]?.acceptanceCriterionRef ?? null,
				projectId: input.projectId,
				userId: input.userId,
				organizationId: input.organizationId,
			});
		}

		return {
			...base,
			status: "DRAFTED",
			caseIds: created.map((c) => c.id),
			...(skippedTitles.length > 0
				? { skippedDuplicates: skippedTitles }
				: {}),
		};
	} finally {
		clearInterval(hb);
	}
}
