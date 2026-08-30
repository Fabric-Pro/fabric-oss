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
	/** Slack channel monitor note summarization. */
	"slack-channel-monitor",
	/** Security scanning grouping/review/scan model calls. */
	"security-scan",
	/** Weave reader agents (Thread, Spindle, Weft, Warp). */
	"weave-reader",
] as const;

export type AiJobKey = (typeof AI_JOB_TYPES)[number];
