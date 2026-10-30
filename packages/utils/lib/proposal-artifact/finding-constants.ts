/**
 * The vocabulary of Internal Analysis findings and answers (Fizzy #2946):
 * stored severities and types, answer kinds, derived states and review
 * reasons, and the answer length limit. Dependency-free on purpose, so the
 * browser can import it without pulling the section parser that
 * `finding-state.ts` needs.
 */

/**
 * Finding severities as stored, worst first: the order the analysis tab
 * groups them in. The database and the API share these values; the
 * analysis prompt's names map onto them in this order. Each package's parity
 * test fails when its copy drifts from this one.
 */
export const PROPOSAL_FINDING_SEVERITIES = [
	"BLOCKING",
	"IMPORTANT",
	"INFORMATIONAL",
] as const;

export type FindingSeverity = (typeof PROPOSAL_FINDING_SEVERITIES)[number];

/**
 * Finding types as stored, in the order the database and the analysis prompt
 * list them.
 */
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

export type FindingType = (typeof PROPOSAL_FINDING_TYPES)[number];

/**
 * Longest answer a member may give to a finding, in characters of the
 * trimmed text. The server refuses longer text rather than cutting it, so the
 * answer field stops the submit first.
 */
export const FINDING_ANSWER_MAX_LENGTH = 2000;

/**
 * The kinds a stored answer can have. RESOLVED means the finding's
 * recommendation was applied to its section; only that save writes it.
 */
export const FINDING_RESPONSE_KINDS = [
	"CONFIRMED",
	"RESPONDED",
	"RESOLVED",
] as const;

export type FindingResponseKind = (typeof FINDING_RESPONSE_KINDS)[number];

/** Why an answer needs review, in the order of precedence above. */
export const NEEDS_REVIEW_REASONS = [
	"SECTION_NOT_FOUND",
	"SECTION_CHANGED",
	"RAISED_AGAIN",
] as const;

export type NeedsReviewReason = (typeof NEEDS_REVIEW_REASONS)[number];

/** An answer's derived state: its own kind while it stands. */
export const RESPONSE_STATES = [
	...FINDING_RESPONSE_KINDS,
	"NEEDS_REVIEW",
] as const;

export type ResponseState = (typeof RESPONSE_STATES)[number];

/** A shown finding's state: its answer's, or unaddressed without one. */
export const FINDING_STATES = ["UNADDRESSED", ...RESPONSE_STATES] as const;

export type FindingState = (typeof FINDING_STATES)[number];
