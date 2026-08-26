import type { ReporterSource } from "@repo/database";
import { db, getBoundPromptForAgent } from "@repo/database";
import { logger } from "@repo/logs";
import { renderTemplate, type TemplateFormat } from "@repo/utils";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import {
	AIProviderNotConfiguredError,
	getAIModelWithMetadata,
} from "./dynamic-model-selector";
import {
	promptGenerateStoryTitle,
	STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY,
} from "./prompts";
import { logModelUsageAsync } from "./usage-logging";

/**
 * Zod schema describing the shape the LLM must return. Passed to
 * `generateObject` so the AI SDK translates it to the provider's native
 * structured-output mode (Azure OpenAI `response_format: json_schema`,
 * OpenAI function calling, Anthropic tool use, etc.) and the provider
 * enforces the shape — regardless of what the prompt body asks for. This
 * is the primary defense against gpt-4.1-mini / gpt-5.4-style markdown-
 * fence wrapping; the three-stage manual JSON parse below it stays as a
 * fallback only for providers that do not support structured outputs.
 */
const TITLE_RESPONSE_SCHEMA = z.object({
	title: z.string(),
	is_insufficient: z.boolean(),
});

type TitleResponse = z.infer<typeof TITLE_RESPONSE_SCHEMA>;

export type StoryTitleSource =
	| "ai"
	| "description-fallback"
	| "untitled-fallback";

export type StoryKindForTitle = "FEATURE" | "BUG";

/**
 * Caller-supplied creation surface. Threaded into the Prompt Library template
 * variable `creation_source` so the LLM can subtly adjust voice (e.g.,
 * "Slack" → casual, "API" → terse). One-way mapping from DB enum values via
 * `mapCreationSource`. Used by both the create-story procedure (default "UI")
 * and the regenerate procedure (`mapCreationSource(story.reporterSource)`)
 * and the agent-tool executor (default "API").
 */
export type CreationSource = "UI" | "Slack" | "Teams" | "Transcript" | "API";

/**
 * Map the kebab-case wire shape used by the helper to the SCREAMING_SNAKE
 * Prisma enum value persisted on `UserStory.titleSource`.
 *
 * NOTE: `DESCRIPTION_FALLBACK` Prisma enum value remains for backward-compat
 * with pre-existing rows. New writes never use it (the helper no longer
 * produces a `description-fallback` source — see `untitledFallback` below).
 * Cleanup of the dead enum value is tracked as a follow-up.
 */
export function mapStoryTitleSourceToEnum(
	source: StoryTitleSource,
): "AI" | "DESCRIPTION_FALLBACK" | "UNTITLED_FALLBACK" {
	switch (source) {
		case "ai":
			return "AI";
		case "description-fallback":
			return "DESCRIPTION_FALLBACK";
		case "untitled-fallback":
			return "UNTITLED_FALLBACK";
	}
}

/**
 * Map a persisted `ReporterSource` enum value (from F-171 reporter tracking)
 * to the human-readable `CreationSource` label the prompt template expects.
 *
 * Mapping:
 *   - SLACK → "Slack"
 *   - TEAMS → "Teams"
 *   - MANUAL / null / undefined → fallback (`"UI"` for the regenerate
 *     procedure; `"API"` for the agent-tool executor)
 */
export function mapCreationSource(
	reporterSource: ReporterSource | null | undefined,
	fallback: CreationSource = "UI",
): CreationSource {
	switch (reporterSource) {
		case "SLACK":
			return "Slack";
		case "TEAMS":
			return "Teams";
		case "MANUAL":
			return fallback;
		default:
			return fallback;
	}
}

/**
 * UTC short ISO 8601 format: `YYYY-MM-DD HH:mm`. Used by `untitledFallback`
 * to construct the timestamped placeholder title when the LLM is unavailable
 * or the description is insufficient.
 */
export function formatTimestamp(now: Date): string {
	const y = now.getUTCFullYear();
	const m = String(now.getUTCMonth() + 1).padStart(2, "0");
	const d = String(now.getUTCDate()).padStart(2, "0");
	const hh = String(now.getUTCHours()).padStart(2, "0");
	const mm = String(now.getUTCMinutes()).padStart(2, "0");
	return `${y}-${m}-${d} ${hh}:${mm}`;
}

export interface StoryTitleResult {
	title: string;
	source: StoryTitleSource;
	isInsufficient?: boolean;
}

export interface StoryTitleGenerationContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
	/**
	 * Optional short snippet describing the surface that triggered creation
	 * (e.g., the user's raw chat request when invoked via the
	 * `fabric_create_story` agent tool). Used by the LLM to clarify intent
	 * when the description is ambiguous — never to add new scope.
	 */
	originContext?: string;
	/** Human-readable creation surface; defaults inside the helper to `"UI"`. */
	creationSource?: CreationSource;
	/** Optional project display name; rendered as the `project_name` variable. */
	projectName?: string;
}

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_INPUT_LENGTH = 1000;
const MAX_PRD_CONTEXT_LENGTH = 2000;
const MAX_ORIGIN_CONTEXT_LENGTH = 2000;

/**
 * Clean an LLM-generated story title:
 *   1. strip a single layer of wrapping single/double quotes
 *   2. trim
 *   3. sentence-case the first letter (rest unchanged)
 *   4. strip a single trailing `.`/`!`/`?`
 *   5. hard-cap at MAX_TITLE_LENGTH (no ellipsis)
 *
 * Cap is applied AFTER sentence-case so we don't truncate mid-word more
 * aggressively than necessary. Raised from 80 → 255 per spec AC-8.
 */
export function cleanGeneratedStoryTitle(raw: string): string {
	const stripped = raw.replace(/^["']|["']$/g, "");
	const trimmed = stripped.trim();
	if (trimmed.length === 0) {
		return "";
	}
	const sentenceCased = trimmed[0].toUpperCase() + trimmed.slice(1);
	const dePunctuated = sentenceCased.replace(/[.!?]$/, "");
	return dePunctuated.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Strip a leading ` ```json ` / ` ```any-lang ` / ` ``` ` opener and a
 * trailing ` ``` ` closer from a string. No-op when there is no fence.
 *
 * LLMs (gpt-4.1-mini in particular, but seen across providers) sometimes
 * wrap JSON in a markdown code fence despite the prompt explicitly forbidding
 * it. The generator's parse path uses this as Stage 2 of three-stage JSON
 * extraction so a fenced response still resolves to the structured shape
 * the helper expects.
 */
function stripCodeFence(text: string): string {
	let s = text;
	// Remove a leading ```<optional-lang>\n? — common forms are
	// ```json\n, ```JSON\n, ``` \n, or ```\n.
	s = s.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
	// Remove a trailing ``` (optionally preceded by a newline) and any
	// remaining trailing whitespace.
	s = s.replace(/\n?```[\s]*$/, "");
	return s.trim();
}

/**
 * Try `JSON.parse` against a single string, returning the parsed object only
 * when the result is a plain object (not a number / string / array). Wrapper
 * around `JSON.parse` that swallows `SyntaxError` and returns `null` instead.
 *
 * Narrower than the raw `JSON.parse` return type because the helper is only
 * interested in the `{title, is_insufficient}` shape; an array or scalar
 * response from a confused model is treated as "not JSON" so the raw-text
 * fallback runs.
 */
function tryParseJsonObject(
	source: string,
): { title?: string; is_insufficient?: boolean } | null {
	try {
		const value = JSON.parse(source);
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return value as { title?: string; is_insufficient?: boolean };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Unified fallback. Always emits the timestamped `Untitled – YYYY-MM-DD HH:mm`
 * string and `source = "untitled-fallback"`.
 *
 * Replaces the legacy `descriptionFallback` which sliced the description into
 * the title for "long enough" inputs. The `description.slice(0, 80)` branch is
 * removed entirely — every non-AI exit path now returns the same shape.
 *
 * `DESCRIPTION_FALLBACK` Prisma enum value remains for backward-compat with
 * pre-existing rows. **New writes never use it.** Cleanup tracked as a
 * follow-up.
 */
function untitledFallback(opts?: {
	isInsufficient?: boolean;
}): StoryTitleResult {
	return {
		title: `Untitled – ${formatTimestamp(new Date())}`,
		source: "untitled-fallback",
		isInsufficient: opts?.isInsufficient === true,
	};
}

/**
 * Best-effort fetch of the project's PRD source-context content. Returns an
 * empty string on any failure (including no `projectId`, no PRD context bound,
 * or DB error). NEVER throws — failure is logged and degrades silently.
 *
 * Per `fabric/standards/backend/queries.md`: single `findUnique`; `select`
 * only the needed fields; no N+1.
 */
async function fetchProjectPrdText(projectId?: string): Promise<string> {
	if (!projectId) {
		return "";
	}
	try {
		const project = await db.project.findUnique({
			where: { id: projectId },
			select: {
				prdSourceContext: { select: { content: true } },
			},
		});
		const content = project?.prdSourceContext?.content ?? "";
		return content.slice(0, MAX_PRD_CONTEXT_LENGTH);
	} catch (error) {
		logger.warn("[story-title-generator] PRD fetch failed", error);
		return "";
	}
}

/**
 * Generate a concise descriptive title for a feature/bug from its description.
 * Never throws — returns a structured fallback instead.
 *
 * Pipeline:
 *   1. Kill-switch check (`AI_TITLE_GENERATION_ENABLED=false` → fallback).
 *      String equality with the literal `"false"` — do NOT use `Boolean(...)`
 *      which would treat the literal string `"false"` as truthy.
 *   2. Resolve the `story_title_generator` Prompt Library binding via
 *      `getBoundPromptForAgent`; degrade to the in-memory
 *      `STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY` if the seed has not run.
 *   3. Best-effort PRD fetch (2000-char cap).
 *   4. Render the prompt (HANDLEBARS) with description + context variables.
 *   5. `generateText` against the SIMPLE-tier model.
 *   6. Defensively parse `{title, is_insufficient}` JSON; on parse failure,
 *      treat raw text as title.
 *   7. `is_insufficient: true` → timestamped fallback with
 *      `isInsufficient: true`.
 *   8. Clean the title; cap at 255.
 *   9. Any thrown error in the pipeline → timestamped fallback.
 *
 * Tenant rate gating is delegated to `assertTenantCanUseAi` (called inside
 * `getAIModelWithMetadata`); no per-feature rate limit is added here.
 */
export async function generateStoryTitleFromDescription(
	description: string,
	kind: StoryKindForTitle,
	context: StoryTitleGenerationContext,
): Promise<StoryTitleResult> {
	// Kill-switch: ops-revertable env var. Defaults to enabled when unset.
	// String equality with the literal "false" only — see fn header comment.
	if (process.env.AI_TITLE_GENERATION_ENABLED === "false") {
		logger.info(
			"[story-title-generator] kill-switch active, using untitled fallback",
		);
		return untitledFallback();
	}

	try {
		const truncatedDescription =
			description.length > MAX_DESCRIPTION_INPUT_LENGTH
				? `${description.substring(0, MAX_DESCRIPTION_INPUT_LENGTH)}...`
				: description;

		// Resolve Prompt Library binding + AI model. Prompt resolution can
		// return null when the seed has not run yet — degrade to the
		// in-memory `STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY` rather than
		// failing creation outright.
		const boundPrompt = await getBoundPromptForAgent({
			agentName: "story_title_generator",
			documentType: "GENERAL",
			storyKind: null,
			userId: context.userId,
			organizationId: context.organizationId,
		});
		if (!boundPrompt?.version?.content) {
			logger.warn(
				"[story-title-generator] prompt not bound; falling back to hardcoded prompt body",
				{
					userId: context.userId,
					organizationId: context.organizationId,
				},
			);
		}

		const { model, metadata, trackUsage } = await getAIModelWithMetadata(
			{ taskType: "SIMPLE" },
			{
				userId: context.userId,
				organizationId: context.organizationId,
				// The interceptor inside getAIModelWithMetadata is the only usage
				// recorder now (logModelUsageAsync is a documented no-op), so a
				// projectId that stops here is a usage row filed under no project.
				projectId: context.projectId,
				featureKey: "regenerate-title",
			},
		);

		const prdText = await fetchProjectPrdText(context.projectId);

		const renderFormat: TemplateFormat =
			(boundPrompt?.format as TemplateFormat | undefined) ?? "HANDLEBARS";
		const renderTemplateBody =
			boundPrompt?.version?.content ??
			STORY_TITLE_GENERATOR_PROMPT_FALLBACK_BODY;

		const rendered = await renderTemplate({
			format: renderFormat,
			template: renderTemplateBody,
			variables: {
				work_item_type: kind === "BUG" ? "Bug" : "Feature",
				project_name: context.projectName ?? "",
				creation_source: context.creationSource ?? "UI",
				description: truncatedDescription,
				origin_context: (context.originContext ?? "").slice(
					0,
					MAX_ORIGIN_CONTEXT_LENGTH,
				),
				project_prd_context: prdText,
			},
		});
		if (rendered.error) {
			logger.warn(
				"[story-title-generator] prompt render failed; using raw body",
				{ error: rendered.error },
			);
		}

		const generationStart = Date.now();

		// Primary path: `generateObject` with a Zod schema. The AI SDK
		// translates the schema to the provider's native structured-output
		// mode (Azure OpenAI `response_format: json_schema`, OpenAI function
		// calling, Anthropic tool use, etc.) so the provider — not the
		// prompt — enforces the response shape. Markdown wrappers, prose
		// preludes, and other "creative" responses are impossible at this
		// layer for compliant providers.
		//
		// Fallback path: a small minority of providers (some OpenRouter
		// passthroughs, older self-hosted models) don't support structured
		// outputs and the SDK throws. Catch, fall back to `generateText`
		// plus the three-stage manual JSON extraction (fence strip + regex
		// object match), and finally raw-text-as-title — same chain as before
		// this refactor, kept verbatim as a safety net.
		let parsed: { title?: string; is_insufficient?: boolean } | null = null;
		let usage:
			| {
					inputTokens?: number;
					outputTokens?: number;
					totalTokens?: number;
			  }
			| undefined;
		let rawTextForFallback = "";

		try {
			const generated = await generateObject({
				model,
				schema: TITLE_RESPONSE_SCHEMA,
				prompt: rendered.rendered,
			});
			parsed = generated.object as TitleResponse;
			usage = generated.usage as typeof usage;
		} catch (generateObjectError) {
			logger.warn(
				"[story-title-generator] generateObject failed; falling back to generateText + manual JSON parse",
				generateObjectError,
			);
			const textResult = await generateText({
				model,
				prompt: rendered.rendered,
			});
			rawTextForFallback = textResult.text;
			usage = textResult.usage as typeof usage;

			// Three-stage JSON extraction (Stage 1: trim, Stage 2: strip
			// markdown fence, Stage 3: regex-match {...} from surrounding
			// chatter). Each stage runs only when the previous one didn't
			// yield a plain-object parse.
			const trimmed = rawTextForFallback.trim();
			const stage1 = tryParseJsonObject(trimmed);
			if (stage1) {
				parsed = stage1;
			} else {
				const fenceStripped = stripCodeFence(trimmed);
				const stage2 = tryParseJsonObject(fenceStripped);
				if (stage2) {
					parsed = stage2;
				} else {
					const objectMatch = fenceStripped.match(/\{[\s\S]*\}/);
					const stage3 = objectMatch
						? tryParseJsonObject(objectMatch[0])
						: null;
					if (stage3) {
						parsed = stage3;
					} else {
						logger.warn(
							"[story-title-generator] JSON parse failed after fence strip + object extract, treating as raw text",
							{ sample: rawTextForFallback.slice(0, 120) },
						);
					}
				}
			}
		}

		trackUsage();

		let result: StoryTitleResult;
		if (parsed?.is_insufficient === true) {
			result = untitledFallback({ isInsufficient: true });
		} else {
			// `parsed?.title` covers the happy `generateObject` path and the
			// successful manual-JSON-parse paths. `rawTextForFallback` (the
			// generateText output, only populated in the fallback branch) is
			// the very-last-resort title source for providers that returned
			// non-JSON noise. Empty-string default keeps the
			// `if (!cleanTitle)` guard below working when neither is set.
			const rawTitle = parsed?.title ?? rawTextForFallback ?? "";
			const cleanTitle = cleanGeneratedStoryTitle(rawTitle);
			if (!cleanTitle) {
				result = untitledFallback();
			} else {
				result = {
					title: cleanTitle,
					source: "ai",
					isInsufficient: false,
				};
			}
		}

		// `logModelUsageAsync` takes the strict `AIModelMetadata` shape (model
		// provider / canonical-name / billing fields). Per-feature observability
		// (`feature`, `titleSample`, `source`, `isInsufficient`) flows through
		// the structured `logger.info` payload below, which is the surface
		// downstream observability tools tap into for the
		// `metadata->>'feature' = 'story_title_generation'` aggregation.
		// `usage` may be undefined if the LLM call resolved without token
		// metadata (rare; certain wrappers return only the object). Fall
		// back to zeros so `logModelUsageAsync` still records the call —
		// cost-tracking dashboards prefer a row with zero tokens over a
		// missing entry.
		logModelUsageAsync({
			context: {
				userId: context.userId,
				organizationId: context.organizationId,
			},
			metadata,
			taskType: "SIMPLE",
			usage: usage ?? {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			},
			latencyMs: Date.now() - generationStart,
			projectId: context.projectId,
		});

		logger.info("[story-title-generator] generated", {
			feature: "story_title_generation",
			titleSample: result.title.slice(0, 120),
			source: result.source,
			isInsufficient: result.isInsufficient ?? false,
		});
		return result;
	} catch (error) {
		if (error instanceof AIProviderNotConfiguredError) {
			logger.info(
				"[story-title-generator] no AI provider configured, using untitled fallback",
			);
		} else {
			logger.warn("[story-title-generator] generation failed", error);
		}
		const result = untitledFallback();
		logger.info("[story-title-generator] fallback", {
			feature: "story_title_generation",
			titleSample: result.title.slice(0, 120),
			source: result.source,
			isInsufficient: result.isInsufficient ?? false,
		});
		return result;
	}
}

// Keep the legacy hardcoded prompt importable for callers that have not yet
// migrated; the helper itself no longer uses it (Prompt Library resolution +
// in-memory fallback body — see top of file). Marked as a legacy export.
export { promptGenerateStoryTitle };
