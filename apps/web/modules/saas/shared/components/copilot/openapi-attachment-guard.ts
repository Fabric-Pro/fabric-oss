/**
 * Stops a large API spec from reaching the model as a severed fragment.
 *
 * A chat attachment is read as text and bounded at 100,000 characters. For most
 * files a truncated tail is a degraded answer; for an OpenAPI document it is a
 * actively misleading one — the model receives syntactically broken JSON listing
 * the first N endpoints, and then answers "that endpoint does not exist" about
 * everything past the cut. The user is never told which half they got.
 *
 * There is no fix available on this surface. The binding limit is not the
 * character budget but the hosting platform's ~4.5 MB request-body cap, which
 * sits below any spec worth worrying about and cannot be raised; lifting the
 * character budget alone would push large specs into a 413, whose recovery drops
 * the attachment entirely. So the honest move is to decline and point at project
 * context, which chunks a spec by endpoint and therefore has no size ceiling at
 * all.
 *
 * Small specs that already fit are untouched — they work today and keep working.
 * (Fizzy #2236)
 */

// Deliberately the `/describe` subpath, not the package barrel: the barrel also
// re-exports the loader and executor, which reach server-only code and drag
// `node:async_hooks` into this client chunk. Turbopack cannot bundle that and
// fails the whole build. `describe` closes over `js-yaml` and plain types only.
import { looksLikeOpenApiSpec } from "@repo/openapi-tools/describe";
import type { AiChatExtractionOutcome } from "@repo/utils/ai-chat-attachment";

/** Only these extensions can carry a spec; anything else skips the check. */
const SPEC_CANDIDATE = /\.(json|yaml|yml)$/i;

export const OPENAPI_TOO_LARGE_FOR_CHAT =
	"This looks like an API spec and is too large to attach here. " +
	"Add it to the project's context instead — it will be indexed by endpoint, " +
	"with no size limit, and stays available to the whole project.";

export const OPENAPI_MALFORMED_IN_CHAT =
	"This looks like an OpenAPI/Swagger spec but could not be read.";

/**
 * Decide whether an attached file should be refused rather than truncated.
 *
 * Returns a `failed` extraction outcome when the file is a spec that the budget
 * would cut, and `null` when the ordinary text path should proceed. Called with
 * the already-budgeted result so it can see whether truncation actually occurred
 * rather than guessing from length.
 */
export function guardOpenApiAttachment(params: {
	filename: string;
	content: string;
	budgetedOutcome: AiChatExtractionOutcome;
	/**
	 * The resolved `OPENAPI_SPEC_CONTEXT` flag, passed in from
	 * `useFeatureFlag` rather than read here.
	 *
	 * The guard has to be gated too, or "flag off restores today's behaviour
	 * exactly" is false on this surface: with the feature disabled a spec-shaped
	 * attachment would still be refused here while nothing downstream could do
	 * anything better with it. Rolling the feature back has to roll this back
	 * with it — and that rollback is an admin toggle, so this value has to come
	 * from the same resolved flag the server gate reads. It used to be
	 * `NEXT_PUBLIC_FABRIC_FEATURE_OPENAPI_SPEC_CONTEXT`, which Next.js inlines
	 * at build time: the console toggle could never have reached it.
	 */
	enabled: boolean;
}): AiChatExtractionOutcome | null {
	const { filename, content, budgetedOutcome, enabled } = params;

	if (!enabled) {
		return null;
	}

	if (!SPEC_CANDIDATE.test(filename)) {
		return null;
	}

	const detection = looksLikeOpenApiSpec(content);

	if (detection.kind === "malformed") {
		// A document that declares itself a spec and then fails to parse is worth
		// saying out loud even when it fits: silently embedding a broken spec as
		// prose is the same silent loss in a different costume.
		return {
			status: "failed",
			reason: `${OPENAPI_MALFORMED_IN_CHAT} ${detection.reason}`,
		};
	}

	if (detection.kind !== "spec") {
		return null;
	}

	// A spec that fits is fine as-is. Only refuse what would be cut.
	if (budgetedOutcome.status !== "truncated") {
		return null;
	}

	return { status: "failed", reason: OPENAPI_TOO_LARGE_FOR_CHAT };
}
