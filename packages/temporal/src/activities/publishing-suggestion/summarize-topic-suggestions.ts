/**
 * Publishing Suggestion — Summarizer LLM Activity
 *
 * The single LLM call in the 1A suggestion cycle. Mirrors
 * `daily-brief/summarize-daily-brief.ts` and the newsletter curate
 * activities' point-of-use actor-revalidation pattern
 * (`newsletter/curate-newsletter-from-releases.ts`): re-check the actor's org
 * membership immediately before model resolution (org model resolution
 * prefers the actor's PERSONAL provider, so a removed/deleted admin must not
 * keep powering suggestion cycles under their identity — TOCTOU), resolve a
 * COMPLEX-tier model, call `generateObject` against
 * `PublishingTopicSuggestionsSchema`, and fail closed on invalid output.
 *
 * Unlike the newsletter curate activities (which soft-skip on a stale actor),
 * this activity THROWS `PUBLISHING_ACTOR_INVALID` non-retryably — the caller
 * (Task 9's workflow) has no "skip the model, publish an empty section"
 * fallback the way a newsletter send does; a stale actor here must fail the
 * cycle so it can be retried/reclaimed under a valid one.
 *
 * The structured-output schema handed to `generateObject` is a LOCAL zod
 * definition (mirroring `PublishingTopicSuggestionsSchema`'s shape), not the
 * `@repo/database` schema object itself — passing a cross-package schema
 * straight into `generateObject` fails to typecheck (`ai`'s `FlexibleSchema`
 * expects the SAME zod module instance it resolved as a peer dep; a schema
 * built from `@repo/database`'s zod copy is structurally identical but a
 * different `ZodType` instance). Same workaround used by
 * `daily-brief/summarize-daily-brief.ts` and
 * `newsletter/curate-newsletter-from-releases.ts`. The role-aware enrichment
 * fields (`relevantFunctionTags` / `postTypeRecommendations`) are intentionally
 * loose on this raw schema (I4 fail-open) — the model's output first passes
 * through `normalizeTopicEnrichment` (tolerant, per-element normalization that
 * drops malformed entries instead of throwing), and only the NORMALIZED object
 * is then `safeParse`d against the canonical `@repo/database` schema before
 * returning, so fail-closed validation still runs, just past the normalization
 * boundary rather than before it.
 */

import { generateObject, getAIModelWithMetadata } from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
import {
	isCurrentOrgMember,
	normalizeTopicEnrichment,
	type PublishingPreferencesSnapshot,
	type PublishingTopicSuggestions,
	PublishingTopicSuggestionsSchema,
} from "@repo/database";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import { jobStep } from "../lib/job-progress";
import { boundContextToBudget } from "./lib/byte-bound";
import { buildPublishingPreferencesClause } from "./preferences-clause";
import {
	buildTopicSuggestionPrompt,
	stripPrAuthorGithubIdsForPrompt,
} from "./prompt";

// Mirrors TopicProvenanceSchema / PublishingTopicSuggestionsSchema in
// packages/database/src/publishing-suite-schema.ts — kept in sync by hand;
// see file header for why this can't just import that schema object.
const LlmTopicProvenanceSchema = z.object({
	repoPrs: z
		.array(
			z.object({ repoFullName: z.string(), prNumber: z.number().int() }),
		)
		.optional(),
	storyIds: z.array(z.string()).optional(),
	featureVersionIds: z.array(z.string()).optional(),
	transcriptIds: z.array(z.string()).optional(),
	docIds: z.array(z.string()).optional(),
});

export const LlmOutputSchema = z.object({
	topics: z.array(
		z.object({
			title: z.string().min(1).max(200),
			pitch: z.string().min(1).max(500),
			provenance: LlmTopicProvenanceSchema,
			// I4: kept LOOSE (`unknown[]`) on purpose. A per-element strict shape
			// here (e.g. requiring `theme`/`rationale` on every recommendation, or
			// rejecting a `null` array element) would reject a plausible model
			// response BEFORE `normalizeTopicEnrichment` runs, throwing the whole
			// activity non-retryably over one malformed enrichment element. The
			// tolerant, per-element normalization below is where real validation
			// happens; this raw schema only needs to not choke while parsing.
			relevantFunctionTags: z.array(z.unknown()).optional(),
			postTypeRecommendations: z.array(z.unknown()).optional(),
			angle: z.unknown().optional(),
			subject: z.unknown().optional(),
		}),
	),
});

export interface SummarizeTopicSuggestionsInput {
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	context: unknown;
	/**
	 * 1C-1b (§7.1(a)): the preferences snapshot the DISPATCHER captured for this
	 * cycle, forwarded verbatim through workflow input.
	 *
	 * Optional because an old history carries none — a workflow started before
	 * this slice forwards nothing, and this activity must cope rather than
	 * throw. Absent means "no guidance", which is also what an empty snapshot
	 * means, so the two paths converge on a byte-identical prompt.
	 */
	preferences?: PublishingPreferencesSnapshot;
}

export interface SummarizeTopicSuggestionsOutput {
	topics: PublishingTopicSuggestions["topics"];
	aiUsageTokens: number | null;
	/**
	 * Capability echo: this implementation CONSUMED `input.preferences`.
	 *
	 * Raised in adversarial review, and the defect it closes is real. The
	 * workflow records a cycle's `preferencesHash` from its OWN input, so before
	 * this field the hash described what the dispatcher INTENDED rather than what
	 * the run did. During a rolling deploy an old worker polling the same task
	 * queue accepts the extra `preferences` field, silently ignores it, and
	 * produces the old prompt — while the workflow still stamps the hash. The
	 * next dispatch then sees no preference change and never fires the corrective
	 * run, so the edit is swallowed until preferences change again. That is
	 * exactly the buried-content failure this whole slice exists to prevent.
	 *
	 * OPTIONAL, and the optionality is the entire mechanism: an old worker's
	 * payload simply lacks the key, so `=== true` is false and the workflow
	 * records no hash. A null hash is a legitimate state the reader already
	 * handles as "changed", so the next dispatch regenerates. Self-healing,
	 * with no marker, no second activity type and no worker-versioning routing.
	 *
	 * ALWAYS `true` here, empty guidance included — it answers "did a
	 * preference-aware implementation run?", never "did this project configure
	 * anything?". Tying it to a non-empty clause would suppress the hash for
	 * every project with no preferences set, which is most of them, and buy each
	 * one a pointless regeneration every cycle.
	 */
	preferencesRead?: boolean;
}

async function runSummarizeTopicSuggestions(
	input: SummarizeTopicSuggestionsInput,
): Promise<SummarizeTopicSuggestionsOutput> {
	const { projectId, organizationId, actorUserId } = input;

	// Point-of-use actor re-validation (TOCTOU) — identical rationale to the
	// newsletter curate activities, but fail-closed via throw (see file header).
	if (organizationId != null) {
		const stillMember = await isCurrentOrgMember(
			actorUserId,
			organizationId,
		);
		if (!stillMember) {
			throw ApplicationFailure.nonRetryable(
				"AI actor is no longer an org member",
				"PUBLISHING_ACTOR_INVALID",
			);
		}
	}

	const { model, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: actorUserId,
			organizationId: organizationId ?? undefined,
			jobType: "publishing-suggestion",
		},
	);

	// Codex round-2 N1: each collector is byte-bounded individually
	// (PER_SOURCE_MAX_BYTES), but nothing bounded the AGGREGATE context — a
	// busy project with all 5 sources near their per-source cap could still
	// assemble a prompt large enough to overflow the model's context window
	// and fail the cycle. Bound the whole context object before serializing
	// the prompt. Collectors return items recency-DESC and the bounding
	// cascade truncates from the tail of the largest array, so this keeps
	// the newest items across sources "for free" (recency preserved without
	// a separate decay pass — 30-day soft-decay ranking remains deferred to
	// 1C).
	const { context: boundedContext } = boundContextToBudget(
		input.context as Record<string, unknown>,
	);
	// Copilot review (#2148): the numeric PR-author github id is needed only by
	// the workflow's contributor map, never by the model. Strip it from the
	// serialized CONTEXT so it is not sent to the provider or written to prompt
	// logs (the id remains available to the resolver via the workflow map).
	const prompt = buildTopicSuggestionPrompt(
		stripPrAuthorGithubIdsForPrompt(boundedContext),
	);
	// FR2 (#1767): append the project's function-tag role-composition clause so
	// the model can stamp relevantFunctionTags / role-aware post-type themes.
	// Flag-gated + self-authorizing inside the helper → no-op when function-tags
	// are off or no roster member holds a tag.
	const roleClause = await getProjectFunctionTagClause({
		projectId,
		requesterUserId: actorUserId,
		surface: "publishing-suite",
	});
	// 1C-1b (§7.1(a), FR8–FR10): the project's recommendation preferences,
	// built from the snapshot the DISPATCHER took rather than from a fresh read
	// of the settings row. A second read would let a mid-run edit make this
	// prompt disagree with the `preferencesHash` recorded for this cycle — the
	// cycle would claim to have run under preferences it did not use. One
	// snapshot, one hash, one prompt.
	//
	// Empty string when nothing is configured, appended with the same guarded
	// concatenation as the role clause so an unconfigured project's prompt
	// stays byte-identical to what it was before this slice — no dangling
	// separator (FR10).
	const preferencesClause = input.preferences
		? buildPublishingPreferencesClause(input.preferences)
		: "";
	const finalPrompt =
		prompt +
		(roleClause ? `\n\n${roleClause}` : "") +
		(preferencesClause ? `\n\n${preferencesClause}` : "");
	const heartbeatInterval = setInterval(
		() => Context.current().heartbeat(),
		10_000,
	);
	let result: Awaited<
		ReturnType<typeof generateObject<typeof LlmOutputSchema>>
	>;
	try {
		result = await generateObject({
			model,
			schema: LlmOutputSchema,
			prompt: finalPrompt,
		});
	} finally {
		clearInterval(heartbeatInterval);
	}

	trackUsage();

	const normalizedObject = {
		topics: result.object.topics.map((t) => {
			const enrichment = normalizeTopicEnrichment({
				relevantFunctionTags: t.relevantFunctionTags,
				postTypeRecommendations: t.postTypeRecommendations,
				angle: t.angle,
				subject: t.subject,
			});
			return {
				title: t.title,
				pitch: t.pitch,
				provenance: t.provenance,
				suggestedPostTypes: enrichment.suggestedPostTypes,
				relevantFunctionTags: enrichment.relevantFunctionTags,
				postTypeRecommendations: enrichment.postTypeRecommendations,
				angle: enrichment.angle,
				subject: enrichment.subject,
			};
		}),
	};

	const parsed = PublishingTopicSuggestionsSchema.safeParse(normalizedObject);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Topic suggestions failed schema validation: ${parsed.error.message}`,
			"PUBLISHING_SCHEMA_VALIDATION_FAILED",
		);
	}

	const aiUsageTokens =
		(result.usage?.totalTokens as number | undefined) ?? null;

	return {
		topics: parsed.data.topics,
		aiUsageTokens,
		// Constant by design — see the field's doc comment. Its ABSENCE from an
		// old worker's payload is the signal, not its value.
		preferencesRead: true,
	};
}

/**
 * Job Hub reporting wrapper (Fizzy #1850).
 *
 * `collect` is completed HERE as well as in `persistCycleTerminal`, and both are
 * needed. On the READY / NO_TOPICS path the summarizer runs, so completing
 * `collect` here stops the panel showing `collect: running` beside
 * `summarize: completed` — an ordering a reader would take for a bug. On the
 * INSUFFICIENT_CONTEXT path the summarizer never runs at all, so persist has to
 * do it instead. `applyStepTransition` overwrites by key, so the double write is
 * idempotent.
 *
 * The FAILED marking is not decoration. `skipUnreachedSteps` maps `pending` and
 * `running` alike to `skipped` when the job closes, so a summarizer that
 * exhausts its retries would otherwise be reported as never attempted — on the
 * one card where a reader needs to know it WAS attempted and failed.
 *
 * Marking is per attempt: a Temporal retry re-enters here and writes `running`
 * again, which also refreshes the heartbeat. That is what keeps the largest gap
 * between two writes at one attempt's 10-minute budget rather than the whole
 * two-attempt one, comfortably inside the watchdog's 45-minute window.
 *
 * Every write is best-effort inside `job-progress`, so none of this can change
 * what this activity returns or throws.
 */
export async function summarizeTopicSuggestions(
	input: SummarizeTopicSuggestionsInput,
): Promise<SummarizeTopicSuggestionsOutput> {
	await jobStep("collect", "completed", { sourceId: null });
	await jobStep("summarize", "running", { sourceId: null });
	try {
		const result = await runSummarizeTopicSuggestions(input);
		await jobStep("summarize", "completed", { sourceId: null });
		return result;
	} catch (error) {
		await jobStep("summarize", "failed", {
			sourceId: null,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}
