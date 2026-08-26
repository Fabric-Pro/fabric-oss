/**
 * Daily Brief — Summarizer Activity
 *
 * One LLM call per regenerate. Takes the aggregated section data + deterministic
 * priority actions and asks the model to produce:
 *   - executiveSummary (2–4 sentences across the window)
 *   - whyItMatters prose for each priority action (rules detect targets; LLM
 *     writes the explanation)
 *
 * Output is validated against the shared Zod schema before being returned. If
 * validation fails we throw a non-retryable ApplicationFailure so the workflow
 * flips the brief to FAILED without burning another LLM call.
 */
import {
	generateObject,
	getAIModelWithMetadata,
	getCurrentDateContext,
} from "@repo/ai";
import { getProjectFunctionTagClause } from "@repo/ai/lib/function-tag-context";
// Imported from the SUBPATH (not @repo/ai root) so it stays UNMOCKED in tests
// that mock the @repo/ai root module (uniform rule across the budget sites).
import { computeScaledOutputTokenBudget } from "@repo/ai/lib/output-token-budget";
import {
	type AheadItem,
	DAILY_BRIEF_SCHEMA_VERSION,
	type DailyBriefContent,
	type DailyBriefSections,
	dailyBriefContentSchema,
	type PartialFailure,
	type PriorityAction,
	type Storyline,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure, heartbeat } from "@temporalio/activity";
import { z } from "zod";
import {
	classifyPayloadSize,
	measureSerializedBytes,
	PAYLOAD_WARN_BYTES,
} from "../../lib/payload-size-guard";
import { clusterActivityByStory } from "./reduce-storylines";

export interface SummarizeDailyBriefInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	timeWindowStart: Date | string;
	timeWindowEnd: Date | string;
	sections: DailyBriefSections;
	priorityActions: PriorityAction[];
	partialFailures: PartialFailure[];
	ahead?: AheadItem[];
}

export interface SummarizeDailyBriefOutput {
	content: DailyBriefContent;
	aiUsageTokens: number | null;
}

const LlmOutputSchema = z.object({
	executiveSummary: z
		.string()
		.min(1)
		.describe(
			"A 2–3 sentence top-of-brief summary that says what matters most across the window. No filler.",
		),
	storylineNarratives: z
		.preprocess(
			(val) => {
				if (!Array.isArray(val)) {
					return [];
				}
				return val.filter(
					(
						item,
					): item is {
						storyCuid: string;
						headline: string;
						narrative: string;
					} =>
						typeof item === "object" &&
						item !== null &&
						typeof (item as { storyCuid?: unknown }).storyCuid ===
							"string" &&
						typeof (item as { headline?: unknown }).headline ===
							"string" &&
						typeof (item as { narrative?: unknown }).narrative ===
							"string",
				);
			},
			z.array(
				z.object({
					storyCuid: z
						.string()
						.describe(
							"Must match one of the cluster keys passed in.",
						),
					headline: z
						.string()
						.min(1)
						.max(120)
						.describe(
							"Short headline, e.g. 'F-12 Refund split moved forward'",
						),
					narrative: z
						.string()
						.min(1)
						.describe(
							"Two-sentence narrative connecting the related items in causal/temporal order. Cite specific identifiers.",
						),
				}),
			),
		)
		.describe(
			"One entry per storyline cluster. Empty array if no clusters.",
		),
	priorityActionExplanations: z
		.preprocess(
			(val) => {
				if (!Array.isArray(val)) {
					return [];
				}
				// Models occasionally emit plain strings here instead of
				// { targetCuid, whyItMatters } objects. Drop malformed entries so
				// schema validation doesn't fail the whole brief — the caller has
				// a deterministic fallback for any missing explanation.
				return val.filter(
					(
						item,
					): item is { targetCuid: string; whyItMatters: string } =>
						typeof item === "object" &&
						item !== null &&
						typeof (item as { targetCuid?: unknown }).targetCuid ===
							"string" &&
						typeof (item as { whyItMatters?: unknown })
							.whyItMatters === "string",
				);
			},
			z.array(
				z.object({
					targetCuid: z
						.string()
						.describe(
							"Must match one of the targetCuid values supplied in the input priority actions.",
						),
					whyItMatters: z
						.string()
						.min(1)
						.describe(
							"One concise sentence explaining why this action deserves the PM's attention today, referencing relevant context from the sections.",
						),
				}),
			),
		)
		.describe(
			"Prose explanation for each priority action. Return an empty array [] if the input priority actions list is empty.",
		),
});

const SECTION_ITEM_LIMIT = 25;
// Release-notes bodies persist at up to RELEASE_BODY_CHAR_CAP (10k) for full UI
// rendering, but the summarizer only needs enough to "mention notable releases".
// Trim each body for the PROMPT so a release-heavy window can't bloat the LLM context
// (risking cost/latency or context-window overflow → brief failure). The full body is
// untouched in the persisted `sections.deployments` the workflow saves.
const SUMMARY_DEPLOYMENT_BODY_CAP = 500;

export function truncateSections(
	sections: DailyBriefSections,
): DailyBriefSections {
	return {
		github: sections.github?.slice(0, SECTION_ITEM_LIMIT),
		storyChanges: sections.storyChanges?.slice(0, SECTION_ITEM_LIMIT),
		taskChanges: sections.taskChanges?.slice(0, SECTION_ITEM_LIMIT),
		documents: sections.documents?.slice(0, SECTION_ITEM_LIMIT),
		meetings: sections.meetings?.slice(0, SECTION_ITEM_LIMIT),
		teamsProposals: sections.teamsProposals?.slice(0, SECTION_ITEM_LIMIT),
		deployments: sections.deployments
			?.slice(0, SECTION_ITEM_LIMIT)
			.map((d) =>
				d.body && d.body.length > SUMMARY_DEPLOYMENT_BODY_CAP
					? {
							...d,
							body: `${d.body.slice(0, SUMMARY_DEPLOYMENT_BODY_CAP)}…`,
						}
					: d,
			),
	};
}

export function hasAnyItems(sections: DailyBriefSections): boolean {
	return Boolean(
		sections.github?.length ||
			sections.storyChanges?.length ||
			sections.taskChanges?.length ||
			sections.documents?.length ||
			sections.meetings?.length ||
			sections.teamsProposals?.length ||
			sections.deployments?.length,
	);
}

function buildPrompt(
	input: SummarizeDailyBriefInput,
	clusters: ReturnType<typeof clusterActivityByStory>,
): string {
	const { sections, priorityActions } = input;
	const timeWindowStart = new Date(input.timeWindowStart);
	const timeWindowEnd = new Date(input.timeWindowEnd);
	const dateContext = getCurrentDateContext();
	const truncated = truncateSections(sections);
	return `You are writing a morning Daily Brief.

Produce THREE outputs:
1. executiveSummary — 2–3 sentences. State what matters most across the window.
2. storylineNarratives — one entry per cluster below. Each cluster is activity converging on a single story/feature. Write a short headline and a two-sentence causal narrative that ties the items together. Use the specific identifiers (e.g. F-12, PR #412, T-34). The storyCuid field in each output entry MUST match one of the cluster keys from the input.
3. priorityActionExplanations — one-sentence rationale per priority action. Each entry MUST be an object of the form { "targetCuid": "...", "whyItMatters": "..." } — never a plain string.

Rules:
- Never invent. Only cite items present in the input.
- The deployments section lists published GitHub Releases (production deployments). If present, mention notable releases in the executive summary; never invent.
- A cluster with 2 items still deserves a storyline — the narrative may be short, but two related events is a thread.
- If the window is quiet, keep the executive summary short and return empty arrays.
- If the priority actions list is empty, return priorityActionExplanations as []. Do NOT return strings, objects, or omit the field. Do not invent priority actions.

${dateContext}
Activity window: ${timeWindowStart.toISOString()} to ${timeWindowEnd.toISOString()}.

Storyline clusters (${clusters.length}):
${JSON.stringify(clusters, null, 2)}

Priority actions (${priorityActions.length} — each requires a whyItMatters entry keyed by targetCuid):
${JSON.stringify(priorityActions, null, 2)}

Section activity (truncated to ${SECTION_ITEM_LIMIT} most recent per source):
${JSON.stringify(truncated, null, 2)}
`;
}

export async function summarizeDailyBriefActivity(
	input: SummarizeDailyBriefInput,
): Promise<SummarizeDailyBriefOutput> {
	const {
		projectId,
		organizationId,
		userId,
		priorityActions,
		sections,
		partialFailures,
	} = input;

	// The sections aggregate carries every collector's output across this
	// boundary, and it crosses at SCHEDULING time — an oversized one fails
	// before this body runs, so all this can do is make the size visible
	// (#1997). The collectors' own per-item caps are what keep the brief
	// under the frame; this warns when they stop being comfortably enough.
	const bytes = measureSerializedBytes(input);
	if (bytes > PAYLOAD_WARN_BYTES) {
		logger.warn(
			"[Daily Brief] Summarizer input nearing the Temporal frame",
			{
				projectId,
				bytes,
				sizeClass: classifyPayloadSize(bytes),
			},
		);
	}

	heartbeat("summarizeDailyBrief: resolving AI model");

	const clusters = clusterActivityByStory(sections);

	if (
		!hasAnyItems(sections) &&
		priorityActions.length === 0 &&
		(!input.ahead || input.ahead.length === 0)
	) {
		// Nothing to summarize — let the workflow mark the brief EMPTY without
		// spending tokens.
		const content: DailyBriefContent = {
			schemaVersion: DAILY_BRIEF_SCHEMA_VERSION,
			executiveSummary: "",
			priorityActions: [],
			sections: {},
			partialFailures:
				partialFailures.length > 0 ? partialFailures : undefined,
			...(input.ahead && input.ahead.length > 0
				? { ahead: input.ahead }
				: {}),
		};
		return { content, aiUsageTokens: null };
	}

	const { model, metadata, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId,
			organizationId: organizationId ?? undefined,
			projectId,
			jobType: "daily-brief",
		},
	);

	logger.info("[Daily Brief] Using AI model", {
		projectId,
		modelString: metadata.modelString,
		provider: metadata.provider,
		selectionSource: metadata.selectionSource,
	});

	const prompt = buildPrompt(input, clusters);

	// Append the project's function-tag role-composition
	// clause (flag-gated, self-authorizing — see getProjectFunctionTagClause)
	// so the model knows who's on the project and in what capacity. No-op
	// when the flag is off, or when no roster member holds a tag.
	const roleClause = input.projectId
		? await getProjectFunctionTagClause({
				projectId: input.projectId,
				requesterUserId: input.userId,
				surface: "daily-brief",
			})
		: "";
	const finalPrompt = prompt + (roleClause ? `\n\n${roleClause}` : "");

	heartbeat("summarizeDailyBrief: waiting for LLM response");
	const heartbeatInterval = setInterval(() => {
		try {
			heartbeat("summarizeDailyBrief: waiting for LLM response");
		} catch {
			// Activity may have been cancelled — clearInterval handles cleanup.
		}
	}, 30_000);

	// Bounded summary (executiveSummary + per-cluster narratives) — but that
	// still exceeds the 4,096 Anthropic unrecognized-model fallback and can clip
	// under Databricks' 8,192 default. Scaled mode with inputChars 0 requests the
	// floor (16,384), clamped to the provider cap and context window. `undefined`
	// leaves other providers on their SDK defaults.
	const maxOutputTokens = computeScaledOutputTokenBudget(metadata, {
		inputChars: 0,
		promptChars: finalPrompt.length,
	});

	let llmResult: Awaited<
		ReturnType<typeof generateObject<typeof LlmOutputSchema>>
	>;
	try {
		llmResult = await generateObject({
			model,
			schema: LlmOutputSchema,
			prompt: finalPrompt,
			...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		});
	} finally {
		clearInterval(heartbeatInterval);
	}

	trackUsage();

	type StorylineNarrativeEntry = {
		storyCuid: string;
		headline: string;
		narrative: string;
	};
	const narrativeByKey = new Map<string, StorylineNarrativeEntry>(
		(llmResult.object.storylineNarratives as StorylineNarrativeEntry[]).map(
			(n) => [n.storyCuid, n],
		),
	);

	const storylines: Storyline[] = clusters.map((c) => {
		const narrative = c.storyCuid
			? narrativeByKey.get(c.storyCuid)
			: undefined;
		return {
			storyCuid: c.storyCuid,
			storyIdentifier: c.storyIdentifier,
			headline:
				narrative?.headline ?? c.storyIdentifier ?? c.storyCuid ?? "",
			narrative: narrative?.narrative ?? "(no narrative generated)",
			relatedItems: c.relatedItems,
		};
	});

	const explanationByTarget = new Map(
		llmResult.object.priorityActionExplanations.map((e) => [
			e.targetCuid,
			e.whyItMatters,
		]),
	);

	const enrichedPriorityActions: PriorityAction[] = priorityActions.map(
		(action) => ({
			...action,
			whyItMatters:
				explanationByTarget.get(action.targetCuid) ??
				// Fall back to a deterministic placeholder if the model missed one.
				`Flagged as ${action.kind.replace(/_/g, " ")}.`,
		}),
	);

	const content: DailyBriefContent = {
		schemaVersion: DAILY_BRIEF_SCHEMA_VERSION,
		executiveSummary: llmResult.object.executiveSummary,
		priorityActions: enrichedPriorityActions,
		sections,
		partialFailures:
			partialFailures.length > 0 ? partialFailures : undefined,
		...(storylines.length > 0 ? { storylines } : {}),
		...(input.ahead && input.ahead.length > 0
			? { ahead: input.ahead }
			: {}),
	};

	const parsed = dailyBriefContentSchema.safeParse(content);
	if (!parsed.success) {
		throw ApplicationFailure.nonRetryable(
			`Daily brief content failed schema validation: ${parsed.error.message}`,
			"DAILY_BRIEF_SCHEMA_VALIDATION_FAILED",
		);
	}

	const aiUsageTokens =
		(llmResult.usage?.totalTokens as number | undefined) ??
		(llmResult.usage?.inputTokens ?? 0) +
			(llmResult.usage?.outputTokens ?? 0);

	return {
		content: parsed.data,
		aiUsageTokens: aiUsageTokens || null,
	};
}
