/**
 * What a person is told when they start, retry or regenerate a document and
 * the server answers with something other than a plain new run (Fizzy #2946).
 * One module, so the create dialog, the setup wizard, the documents list, the
 * live Proposal pane, the editor and the prompt binding dialogs say the same
 * thing in both shipped locales instead of each showing the server's English.
 *
 * Pure functions: each caller passes its own translator and organization base
 * path, so nothing here reads a React context and a caller's tests need no
 * extra provider.
 *
 * - `describeGenerationRefusal(error, { t, basePath })`: an error thrown by an
 *   oRPC call. A `PRECONDITION_FAILED` or `BAD_REQUEST` whose `data.code` is
 *   `PROPOSAL_PROMPT_NOT_BOUND` (nothing bound to Client proposal (Main) while
 *   the Proposal artifact is on) or {@link PROPOSAL_ACTION_SUPERSEDED} (a new
 *   organization or project default refused at an action the Proposal artifact
 *   supersedes) becomes a {@link GenerationRefusalFeedback}; anything else is
 *   `null`, so the caller keeps its current fallback. The copy names Client
 *   proposal (Main), so pass only errors from a Main generation or a binding
 *   call: the Internal Analysis re-run reuses `PROPOSAL_PROMPT_NOT_BOUND` for
 *   its own prompt and keeps its own copy.
 * - `describeBatchSkip(reasonKey, { t, basePath })`: the `reasonKey` of one
 *   `skipped` entry of `projects.documents.batchGenerate`, on success or in
 *   the `data.skipped` of the `PRECONDITION_FAILED` it throws when every
 *   document was skipped (that error carries no `data.code`, so
 *   `describeGenerationRefusal` returns `null` for it). Only
 *   `documents.proposal-prompt-not-bound` maps; other reasons are `null`.
 * - `proposalMainCatalogHref(basePath)`: the Prompt Library catalog focused on
 *   Client proposal (Main), the link both feedbacks carry.
 * - `resolveRegenerateToastKey({ outcome, documentStatus, requestedWebResearch,
 *   sameRequest })`: which `projects.documents.regenerateToast.*` key a
 *   finished regenerate request earned, from the dispatcher's `outcome`;
 *   `readSameRequest(result)` reads the result's `sameRequest` flag and
 *   `isRegenerateToastWarning(key)` says which keys are warnings.
 *
 * `t` for the two refusal functions is
 * `useTranslations("projects.proposalArtifact.generationFeedback")`, and
 * `basePath` is `useOrganizationContext().basePath` (`/app/{slug}`).
 */

import {
	PROPOSAL_ACTION_SUPERSEDED,
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	promptActionId,
} from "@repo/utils/prompt-action-catalog";
import type { useTranslations } from "next-intl";
import { getOrpcErrorData } from "../../lib/orpc-error-data";
import { getOrpcCode } from "../field-mapping/orpc-error";

type Translate = ReturnType<typeof useTranslations>;

/**
 * `PROPOSAL_PROMPT_NOT_BOUND` in `@repo/temporal/proposal-artifact-types`,
 * spelled out because the web bundle takes no runtime values from
 * `@repo/temporal`.
 */
const PROPOSAL_PROMPT_NOT_BOUND = "PROPOSAL_PROMPT_NOT_BOUND";

/**
 * The `reasonKey` `projects.documents.batchGenerate` skips a Proposal with when
 * nothing is bound to Client proposal (Main); the server keeps it as a private
 * constant in its procedure.
 */
const PROPOSAL_PROMPT_NOT_BOUND_REASON_KEY =
	"documents.proposal-prompt-not-bound";

/** The oRPC codes the two refusals are thrown with. */
const REFUSAL_ORPC_CODES = new Set(["PRECONDITION_FAILED", "BAD_REQUEST"]);

/** Which refusal it was, for a caller that renders the two differently. */
export type GenerationRefusalKind = "promptNotBound" | "actionSuperseded";

/** A refusal in the reader's locale, with the link that resolves it. */
export type GenerationRefusalFeedback = {
	kind: GenerationRefusalKind;
	/** The localized sentence to show; never the server's words. */
	message: string;
	/** The Prompt Library catalog, focused on Client proposal (Main). */
	catalog: { href: string; label: string };
};

/**
 * What the two refusal functions need from the caller: the translator for
 * `projects.proposalArtifact.generationFeedback` and the organization's base
 * path (`useOrganizationContext().basePath`).
 */
type RefusalCopyContext = { t: Translate; basePath: string };

/**
 * The Prompt Library catalog with Client proposal (Main) focused, in the
 * `?action=` form the catalog page already honours.
 */
export function proposalMainCatalogHref(basePath: string): string {
	const actionId = promptActionId(
		PROPOSAL_CLIENT_MAIN_AGENT_KEY,
		"PROPOSAL",
		null,
	);
	return `${basePath}/prompts/catalog?action=${encodeURIComponent(actionId)}`;
}

function feedbackFor(
	kind: GenerationRefusalKind,
	{ t, basePath }: RefusalCopyContext,
): GenerationRefusalFeedback {
	return {
		kind,
		message: t(kind),
		catalog: {
			href: proposalMainCatalogHref(basePath),
			label: t("openCatalog"),
		},
	};
}

/** See the module comment. `null` for every error it does not recognise. */
export function describeGenerationRefusal(
	error: unknown,
	context: RefusalCopyContext,
): GenerationRefusalFeedback | null {
	const code = getOrpcCode(error);
	if (code === undefined || !REFUSAL_ORPC_CODES.has(code)) {
		return null;
	}
	switch (getOrpcErrorData(error).code) {
		case PROPOSAL_PROMPT_NOT_BOUND:
			return feedbackFor("promptNotBound", context);
		case PROPOSAL_ACTION_SUPERSEDED:
			return feedbackFor("actionSuperseded", context);
		default:
			return null;
	}
}

/** See the module comment. `null` for every other skip reason. */
export function describeBatchSkip(
	reasonKey: string | null | undefined,
	context: RefusalCopyContext,
): GenerationRefusalFeedback | null {
	return reasonKey === PROPOSAL_PROMPT_NOT_BOUND_REASON_KEY
		? feedbackFor("promptNotBound", context)
		: null;
}

/** A `projects.documents.regenerateToast.*` key a regenerate can earn. */
export type RegenerateToastKey =
	| "started"
	| "alreadyQueued"
	| "alreadyRunning"
	| "alreadyQueuedResearchNotApplied"
	| "alreadyRunningResearchNotApplied"
	| "liveRunUnknown";

/**
 * Whether a regenerate key is a warning rather than news: nothing the person
 * asked for happened, either because the live run could not be confirmed or
 * because the run they joined will not research the web they ticked.
 */
export function isRegenerateToastWarning(key: RegenerateToastKey): boolean {
	return (
		key === "liveRunUnknown" ||
		key === "alreadyQueuedResearchNotApplied" ||
		key === "alreadyRunningResearchNotApplied"
	);
}

/**
 * The `sameRequest` flag of a generate result, read without trusting its
 * shape: `true` when an `alreadyInProgress` answer joined a run started by
 * the identical request, `false` when the live run was started with other
 * settings, and `undefined` when the server did not say (a deploy that
 * predates the flag), which callers treat as unknown.
 */
export function readSameRequest(result: unknown): boolean | undefined {
	if (typeof result !== "object" || result === null) {
		return undefined;
	}
	const value = (result as { sameRequest?: unknown }).sameRequest;
	return typeof value === "boolean" ? value : undefined;
}

/**
 * The sentence a finished regenerate has actually earned, as a translation key
 * rather than the copy itself, so the decision stays unit-testable without
 * pinning English and the two shipped locales stay the one place the wording
 * lives.
 *
 * The workflow id is derived from the request instead of salted with the
 * clock, so a duplicate start is a real outcome: the same document
 * regenerated from two tabs, or one impatient double-click, lands on the id a
 * live run already holds and starts nothing. "Regeneration started" is then
 * the one sentence that is definitely false.
 *
 * `alreadyInProgress` is named after the run rather than a state, so the state
 * is READ from the document row: only its status separates a run still waiting
 * on the project's context ("already queued") from one already writing
 * ("already running"). When the request ticked web research and the server
 * says the live run was started with different settings (`sameRequest:
 * false`), that run keeps its own instructions and research choice, so the
 * toast says this request's were not applied. An identical request, an
 * unticked one, or a server that does not say keeps the plain sentence:
 * nothing ticked was lost, or nothing is known to have been. `liveRunUnknown`
 * means a client-document Proposal's row names a live run the server could
 * not confirm, so nothing was started and the person is asked to try again
 * in a moment: it neither claims a run
 * started nor that none is going. `statusUnknown` is a different answer — this
 * request's own start may have registered, and the row is already queued for
 * it — so it reads as started, as it always has.
 *
 * The discriminant is a plain string and an unrecognised arm resolves to the
 * start copy rather than throwing: a response from a deploy this bundle
 * predates still has to leave the list saying something, and the row the
 * caller's invalidation refetches is where the truth lives regardless. Mirrors
 * `resolveCreateOutcomeKey` in `CreateDocumentDialog`.
 */
export function resolveRegenerateToastKey({
	outcome,
	documentStatus,
	requestedWebResearch,
	sameRequest,
}: {
	outcome: string | null | undefined;
	documentStatus: string | null | undefined;
	/** The request asked for web research (`allowWebResearch: true`). */
	requestedWebResearch?: boolean;
	/** The joined run was started by this identical request; unknown when absent. */
	sameRequest?: boolean;
}): RegenerateToastKey {
	if (outcome === "alreadyInProgress") {
		const queued = documentStatus === "QUEUED";
		if (requestedWebResearch === true && sameRequest === false) {
			return queued
				? "alreadyQueuedResearchNotApplied"
				: "alreadyRunningResearchNotApplied";
		}
		return queued ? "alreadyQueued" : "alreadyRunning";
	}
	if (outcome === "liveRunUnknown") {
		return "liveRunUnknown";
	}
	return "started";
}
