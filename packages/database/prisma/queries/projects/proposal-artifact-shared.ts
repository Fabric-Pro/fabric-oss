/**
 * Proposal artifact (Fizzy #2801) — the vocabulary the sibling
 * `proposal-artifact-*` modules share: statuses, kinds, limits, the guarded
 * write outcome, and the tenant error and check.
 *
 * Every guarded write returns an outcome (`written`, `cleared`, `superseded`,
 * `stale`, `conflict`, …), never a bare count, so a caller never has to guess
 * what a zero meant.
 *
 * Tenant columns are never taken from the caller. Writers copy them from the
 * document's project (or from the run row, for findings), and readers take the
 * owning organization's id and put it in `where`, so a read can never return
 * another organization's row. The Temporal worker bypasses RLS, so this is
 * what keeps its writes in the right tenant; `org_only` RLS and
 * ORG_ONLY_TABLES enforce the same for sessions.
 */

/** The answer of the run and live-section guarded writes. */
export type ProposalArtifactGuardedOutcome = "written" | "superseded";

export const PROPOSAL_ANALYSIS_STATUSES = [
	"PENDING",
	"RUNNING",
	"COMPLETE",
	"FAILED",
] as const;
export type ProposalAnalysisStatus =
	(typeof PROPOSAL_ANALYSIS_STATUSES)[number];

export const PROPOSAL_ANALYSIS_KINDS = ["GENERATION", "RERUN"] as const;
export type ProposalAnalysisKind = (typeof PROPOSAL_ANALYSIS_KINDS)[number];

/**
 * The kinds a member can give an answer. Needs Review is derived at read
 * time and never stored.
 */
export const PROPOSAL_FINDING_RESPONSE_KINDS = [
	"CONFIRMED",
	"RESPONDED",
] as const;
export type ProposalFindingResponseKind =
	(typeof PROPOSAL_FINDING_RESPONSE_KINDS)[number];

export const PROPOSAL_FINDING_SEVERITIES = [
	"BLOCKING",
	"IMPORTANT",
	"INFORMATIONAL",
] as const;
export type ProposalFindingSeverity =
	(typeof PROPOSAL_FINDING_SEVERITIES)[number];

export const PROPOSAL_FINDING_TYPES = [
	"SCOPE",
	"COMMERCIAL",
	"ASSUMPTION",
	"RISK",
	"GAP",
	"SOURCE_VALIDATION",
	"ARCHITECTURE",
	"BRANDING",
	"OPPORTUNITY",
] as const;
export type ProposalFindingType = (typeof PROPOSAL_FINDING_TYPES)[number];

/**
 * Hard ceiling on the source context stored with an analysis run. The caller
 * owns the real budget for the model window; this only keeps the row bounded
 * whatever the caller passes.
 */
export const PROPOSAL_ANALYSIS_SOURCE_CONTEXT_MAX_LENGTH = 200_000;

/** Longest error message persisted on an analysis run. */
export const PROPOSAL_ANALYSIS_ERROR_MESSAGE_MAX_LENGTH = 500;

/**
 * How long a PENDING or RUNNING run may go without an update before it counts
 * as timed out. The analysis activity bumps `updatedAt` on every attempt
 * (`markAnalysisRunning`), so this measures silence, never the run's age: one
 * attempt and its backoff stay well under it, while a legitimate run may last
 * about half an hour over three attempts.
 */
export const PROPOSAL_ANALYSIS_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * What a re-run claim records on a run it finds timed out: the code and the
 * fixed message the analysis workflow stores when its activity times out.
 */
export const PROPOSAL_ANALYSIS_TIMED_OUT_FAILURE = {
	errorCode: "TIMED_OUT",
	errorMessage: "The internal analysis took too long and was stopped.",
} as const;

/**
 * How many of a document's newest COMPLETE runs a read searches, hashing each
 * analyzed body whose stored prose hash is missing or from another normalizer
 * version, for the one that describes the current content — and only after no
 * run's stored hash matched it anywhere in the document's history. A run with
 * no usable stored hash older than this is never shown in its place; the
 * newest COMPLETE run is shown as stale instead. A re-run claim searches as
 * many of its source candidates the same way.
 */
export const PROPOSAL_ANALYSIS_MATCH_WINDOW = 10;

/** Longest answer a member may give to a finding. Longer text is refused. */
export const PROPOSAL_FINDING_RESPONSE_TEXT_MAX_LENGTH = 2000;

export const PROPOSAL_STYLE_MAX_ACCENT_COLORS = 3;
export const PROPOSAL_STYLE_MAX_DIRECTION_LENGTH = 500;

/**
 * The document is missing, or its project has no organization, or the
 * organization the caller expected is not the document's. Every caller has
 * already resolved the owning organization; reaching this means the caller and
 * the data disagree, so it fails closed.
 */
export class ProposalArtifactTenantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposalArtifactTenantError";
	}
}

/**
 * Fail closed unless the document is in an organization project and, when
 * `expected` is given, that organization is the caller's. Pass `actual` as
 * read off the document (`document?.project.organizationId`) so the check
 * narrows the document as well. A caller whose check is optional passes
 * `organizationId || undefined`: an empty id is no organization to check.
 */
export function assertDocumentOrganization(
	actual: string | null | undefined,
	expected: string | undefined,
): asserts actual is string {
	if (!actual) {
		throw new ProposalArtifactTenantError(
			"The document is not in an organization project",
		);
	}
	if (expected !== undefined && expected !== actual) {
		throw new ProposalArtifactTenantError(
			"The document belongs to another organization",
		);
	}
}
