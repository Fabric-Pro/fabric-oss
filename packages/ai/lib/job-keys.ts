/**
 * Canonical job keys for AI invocation tagging (Fizzy #1894).
 *
 * Scheduled and background pipelines that invoke AI pass one of these keys as
 * `jobType` on the `AIOperationContext` given to `getAIModelWithMetadata` /
 * `getAIEmbeddingModelWithMetadata`, so their `AiUsageLog` rows are
 * distinguishable from user-initiated ones. Surfaces billed outside the token
 * economy (image generation, transcription) use the same field on their
 * invocation-marker rows.
 *
 * The DB column is a plain string on purpose: dashboards must tolerate keys
 * this build does not know yet (older/newer app versions write concurrently)
 * — treat the strings as append-only, like {@link AI_FEATURE_KEYS}.
 */
export const AI_JOB_TYPES = [
	/** Scheduled report generation runs. */
	"scheduled-report",
	/** Daily brief summarization (including its release-note summaries). */
	"daily-brief",
	/** Meeting transcript sync and meeting-derived insight pipelines. */
	"meeting-transcript-sync",
	/** Image generation (per-image billing; logged as an invocation marker). */
	"image-generation",
	/** Audio/video transcription (SDK exposes no tokens; marker row only). */
	"transcription",
	/** Scheduled workflow-builder executions. */
	"workflow-builder",
	/** Newsletter stakeholder release-note curation (hourly cron). */
	"newsletter-curation",
	/** Publishing-suggestion topic summarization (daily cron). */
	"publishing-suggestion",
	/**
	 * Publishing-suite topic Planning & Analysis (#1851).
	 *
	 * Separate from `publishing-suggestion` because the spend behaves nothing
	 * like it: this one is user-initiated, on demand, and runs a much longer
	 * prompt over one topic's own sources. Folding the two together would hide a
	 * per-click cost inside a daily cron's line item.
	 */
	"publishing-planning-analysis",
	/**
	 * Publishing-suite Short Post / Tweet drafting (#1853).
	 *
	 * Separate from `publishing-planning-analysis` for the reason that one is
	 * separate from `publishing-suggestion`: the planning worksheet runs once per
	 * topic and this runs every time someone wants three more options to choose
	 * between, so the two have very different per-topic spend. Folding them
	 * together would make a regeneration habit invisible inside the cost of
	 * analysing topics at all.
	 */
	"publishing-short-post",
	/**
	 * Publishing-suite Blog Post drafting (#1853).
	 *
	 * Separate from `publishing-short-post` because it is the expensive one in
	 * the family: long-form output over the same long prompt, so a single run
	 * costs a multiple of three tweet options. Sharing a key would let blog
	 * spend hide inside a short-post line item that looks reasonable.
	 */
	"publishing-blog-post",
	/** Slack channel monitor note summarization. */
	"slack-channel-monitor",
	/** Security scanning grouping/review/scan model calls. */
	"security-scan",
	/** Weave reader agents (Thread, Spindle, Weft, Warp). */
	"weave-reader",
] as const;

export type AiJobKey = (typeof AI_JOB_TYPES)[number];
