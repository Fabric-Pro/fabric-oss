import { unwrapPmSyncError } from "./pm-sync-error-unwrap";

/**
 * What a failed publishing generation run STORES versus what it LOGS.
 *
 * Pure and deterministic, so it is safe inside a workflow, and separate from the
 * five workflows so the mapping is stated once.
 *
 * ## Two audiences, and only one of them is trusted
 *
 * The message a workflow passes to `mark*FailedActivity` is persisted on the
 * draft row and rendered verbatim by the panel to ANYONE who can see the tab.
 * The log line is read by an operator.
 *
 * Temporal delivers an activity throw as `ActivityFailure`, whose own
 * `.message` is the generic "Activity task failed"; the real reason lives on
 * `.cause`. The workflows used to store that wrapper string, so every failure in
 * the suite displayed the same four words whatever went wrong — a revoked actor,
 * a malformed bound prompt and a provider outage were indistinguishable.
 *
 * Walking the cause chain fixes that and opens a different hole: the deepest
 * cause is frequently NOT ours. A provider transport error, a driver error or a
 * fetch failure carries text nobody on this side wrote — endpoints, request
 * fragments, occasionally more — and piping it to a rendered field is a
 * disclosure decision made by whichever library threw last.
 *
 * So the stored message is always AUTHORED HERE, chosen by the failure's type;
 * the unwrapped text goes to the log, where the audience is an operator and the
 * platform's redaction applies. A type absent from the table gets the neutral
 * fallback rather than its own words — the fail-closed direction, so a new
 * failure class cannot start rendering third-party text by being forgotten.
 */

/**
 * Failure types the publishing activities RAISE THEMSELVES, mapped to the copy
 * a reader of the tab should see.
 *
 * An entry here is a promise that the type is thrown only by code in this
 * repository — that is what makes rendering its words safe. The two
 * authorization strings are repeated rather than imported because the activity
 * that raises them runs in a different sandbox from the workflow that stores
 * them; `assert-generation-actor.test.ts` pins the originals, and the
 * round-trip case in `generate-publishing-case-study.test.ts` pins that these
 * agree.
 */
const AUTHORED_MESSAGE: ReadonlyMap<string, string> = new Map([
	[
		"PUBLISHING_TENANT_MISMATCH",
		"This project moved to a different organization after the draft was started",
	],
	[
		"PUBLISHING_ACTOR_INVALID",
		"The account that started this draft is no longer authorized to generate on this project",
	],
	...(
		[
			"PUBLISHING_CASE_STUDY_SCHEMA_VALIDATION_FAILED",
			"PUBLISHING_BLOG_POST_SCHEMA_VALIDATION_FAILED",
			"PUBLISHING_SHORT_POST_SCHEMA_VALIDATION_FAILED",
			"PUBLISHING_STAKEHOLDER_EMAIL_SCHEMA_VALIDATION_FAILED",
			"PUBLISHING_PA_SCHEMA_VALIDATION_FAILED",
		] as const
	).map(
		(type) =>
			[
				type,
				// The activity's own message appends the validator's report,
				// which quotes the model's output. That belongs in the log, not
				// on a shared row.
				"The model returned a draft that did not match the expected shape. Generating again usually clears it.",
			] as [string, string],
	),
]);

const NEUTRAL =
	"Generation failed. The reason is recorded in the run log for this project.";

export interface PublishingFailureDetail {
	/** Authored by us. Safe to persist on the draft and render. */
	message: string;
	/** The failure's type or constructor name, for the operator log. */
	errorClass: string;
	/**
	 * The real, unwrapped reason. For the operator log ONLY — never persisted,
	 * never rendered. Named `detail` rather than `message` so a call site that
	 * mixes the two has to do it on purpose.
	 */
	detail: string;
}

export function publishingFailureDetail(
	error: unknown,
): PublishingFailureDetail {
	const { message: detail, errorClass } = unwrapPmSyncError(error);
	return {
		message: AUTHORED_MESSAGE.get(errorClass) ?? NEUTRAL,
		errorClass,
		detail,
	};
}
