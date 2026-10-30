/**
 * Refusal codes of the AI writers that rewrite a whole document body, for a
 * client-document Proposal (Fizzy #2946).
 *
 * "Update using context" and auto-refresh hand the model the whole body and
 * save whatever it returns, so on a client-document Proposal they would
 * rewrite the sections and diagrams a person edited. Those writers refuse it
 * instead; the scoped writers (chat, finding-driven revisions) and
 * regeneration stay. The client-document predicate, judged by the project's
 * OWNING organization, decides which Proposals they refuse.
 *
 * Client-safe: constants only, so the procedures and the web's localized
 * refusal copy share one string.
 */

/**
 * `data.code` of a `PRECONDITION_FAILED` refusing a whole-body rewrite of a
 * client-document Proposal: the preview and the confirm of "Update using
 * context", and accepting a stored auto-refresh proposal. The Proposal is
 * changed from chat or regenerated instead.
 */
export const PROPOSAL_USE_CHAT_OR_REGENERATE =
	"PROPOSAL_USE_CHAT_OR_REGENERATE" as const;

/**
 * `data.code` of a `PRECONDITION_FAILED` refusing to enrol a client-document
 * Proposal in auto-refresh. Turning auto-refresh off is never refused.
 */
export const PROPOSAL_AUTO_REFRESH_UNSUPPORTED =
	"PROPOSAL_AUTO_REFRESH_UNSUPPORTED" as const;
