/**
 * The contracts the coordinated Proposal job is built against (Fizzy #2801).
 *
 * One user action produces a client-only Main document, live section by
 * section with visuals, then a separate Internal Analysis of the saved Main
 * that only members of the owning organization can read. The child workflow,
 * the generation activity, the plan, visuals and analysis activities and the
 * analysis workflow meet at the shapes below.
 *
 * Workflow-safe: imported by workflow code, so this module holds plain types,
 * constants and pure string functions only. No I/O, no Prisma imports, no
 * Node built-ins; its only runtime import is the dependency-free FNV-1a hash
 * from `@repo/utils/fnv1a`.
 */

import { fnv1aHex64 } from "@repo/utils/fnv1a";
import type {
	PROPOSAL_CLIENT_MAIN_AGENT_KEY,
	PROPOSAL_CLIENT_REVISION_AGENT_KEY,
	PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY,
} from "@repo/utils/prompt-action-catalog";

// =============================================================================
// Failure types
// =============================================================================

/**
 * `ApplicationFailure.type` when nothing is bound to the client-only Main
 * prompt action. Non-retryable: binding a prompt is an administrator's action,
 * and a retry cannot perform it. Raised before the agent is called, so no live
 * section is written and no fallback prompt runs.
 */
export const PROPOSAL_PROMPT_NOT_BOUND = "PROPOSAL_PROMPT_NOT_BOUND";

/**
 * The existing stale-regeneration failure type, reused for a superseded run's
 * refused save and version write. The same string the generation activity
 * throws (`STALE_REGENERATION_FAILURE_TYPE` in
 * `activities/project-document-generation.ts`) and the child workflow already
 * recognises (`isStaleRegenerationFailure`), so a refusal here takes the path
 * a stale regeneration takes today.
 */
export const DOCUMENT_GENERATION_STALE = "DOCUMENT_GENERATION_STALE";

/**
 * `ApplicationFailure.type` the child workflow ends with when a coordinated
 * run lost its document to a newer generation: its plan's claim was refused,
 * or its save or version write was refused as stale. The newer run owns the
 * document, so a parent that sees this type must write nothing to it; the
 * child's own writes were guarded and wrote nothing either.
 *
 * The same string the single-document parent already uses for a run
 * superseded while it waited, so its readable-message handling treats both
 * alike. A recorded history never carries it from a child, which is why the
 * parents can branch on it without a patch marker.
 */
export const DOCUMENT_GENERATION_SUPERSEDED = "DOCUMENT_GENERATION_SUPERSEDED";

/**
 * `ApplicationFailure.type` for a Main that repeats the wording of an
 * internal answer its prompt carried as a settled decision (Fizzy #2946).
 * Non-retryable: a retry renders the same prompt. The generation activity
 * raises it with a message that names no answer, finding or text, so the
 * child's generic failure handling can record it on the document as it is.
 */
export const RESPONSE_ECHOED = "RESPONSE_ECHOED";

// =============================================================================
// Prompts
// =============================================================================

/**
 * The prompt actions a coordinated Proposal resolves: the two of the job, and
 * the client revision its scoped AI writers use (Fizzy #2946).
 */
export type ProposalPromptAction =
	| typeof PROPOSAL_CLIENT_MAIN_AGENT_KEY
	| typeof PROPOSAL_CLIENT_REVISION_AGENT_KEY
	| typeof PROPOSAL_INTERNAL_ANALYSIS_AGENT_KEY;

/**
 * A prompt exactly as it was bound when the run was planned. Every retry
 * renders this version, so an edit made mid-run cannot change what one run
 * produces.
 */
export interface ProposalBoundPrompt {
	/** `Prompt.id` of the bound prompt. */
	promptId: string;
	/** `PromptVersion.version` the binding points at; not the newest version. */
	versionNumber: number;
	/** `PromptVersion.id` of that version, for attribution and provenance. */
	promptVersionId: string;
}

// =============================================================================
// Plan activity (`planProposalArtifact`)
// =============================================================================

export interface PlanProposalArtifactInput {
	projectId: string;
	documentId: string;
	/** The `ProjectDocumentType` as stored, e.g. `"PROPOSAL"`. */
	documentType: string;
	/** The member who triggered the generation. */
	userId: string;
	/**
	 * The run's tenant organization, passed through from the workflow input.
	 * The activity resolves the project's owning organization from the project
	 * row itself, and reads the gate and resolves prompts for that one.
	 */
	organizationId: string;
	/**
	 * The run token, chosen by the workflow: the child execution's own run
	 * id. Deterministic per execution, so a retried plan claims the document
	 * with the same token instead of minting one nobody holds.
	 */
	liveRunId: string;
	/**
	 * The generation attempt's identity (`ProjectDocument.generationStartedAt`
	 * as the dispatch stamped it), as an ISO-8601 string. When present the
	 * plan takes the live columns over only while the document still carries
	 * it, so a late or retried plan cannot take a document a newer request
	 * owns. Absent for runs started without one (the batch and setup flows),
	 * whose takeover stays unconditional.
	 */
	generationStartedAt?: string;
}

/**
 * Why a run records its Internal Analysis as FAILED without starting it. Each
 * is also a {@link ProposalAnalysisErrorCode}.
 */
export type ProposalAnalysisSkipReason = "PROMPT_NOT_BOUND" | "GUEST_TRIGGERED";

/**
 * A coordinated run, as planned.
 *
 * `analysisPrompt` is null exactly when `analysisSkipReason` is set. A run a
 * project guest triggered carries `triggeredByGuest: true` and the skip reason
 * `GUEST_TRIGGERED`, which wins over `PROMPT_NOT_BOUND`; the analysis prompt is
 * not resolved for a guest at all, so a guest's personal binding is never read
 * for it.
 */
export interface ProposalArtifactPlan {
	/**
	 * The run token of this generation, as the workflow chose it. It owns the
	 * document's live columns, and guards the final save, the version row and
	 * the FAILED write.
	 */
	liveRunId: string;
	/**
	 * The document's version when the run took it over. The final save and
	 * the version row require it, so a person's save landing while the run
	 * generates (it moves the version on) is kept and the run is refused as
	 * stale, slots or none. Absent only from a plan recorded before the field
	 * existed, which replays with the generation's own baseline, as before.
	 */
	baselineVersion?: number;
	/**
	 * The identity of the document's body when the run took it over
	 * (`contentIdentity`). The final save requires it as well: a write that
	 * changes the body without moving the version (a rejected regeneration's
	 * rewind or its fallback) is kept, and the run refused as stale. Absent
	 * only from a plan recorded before the field existed.
	 */
	baselineContentHash?: string;
	/** The client-only Main prompt. Always bound; an unbound one fails the plan. */
	mainPrompt: ProposalBoundPrompt;
	analysisPrompt: ProposalBoundPrompt | null;
	analysisSkipReason: ProposalAnalysisSkipReason | null;
	/** The triggering user is not a member of the owning organization. */
	triggeredByGuest: boolean;
}

/**
 * The plan's claim on the document was refused: a newer generation request
 * owns it. Nothing was written, and the run must stop without writing
 * anything either.
 */
export interface ProposalArtifactPlanSuperseded {
	superseded: true;
}

/**
 * Null when the run takes today's flow: the rollout gate is off for the owning
 * organization, or the document is not a Proposal. Read before any prompt is
 * resolved or anything is written.
 */
export type PlanProposalArtifactResult =
	| ProposalArtifactPlan
	| ProposalArtifactPlanSuperseded
	| null;

// =============================================================================
// Generation activity (`generateDocumentWithAgent`) and its writes
// =============================================================================

/**
 * Passed to `generateDocumentWithAgent` in artifact mode. Its presence is the
 * switch: the activity claims its attempt on the live columns, renders exactly
 * this prompt version, and never falls back to another prompt. Absent, every
 * path is today's.
 */
export interface ProposalArtifactGenerationOptions {
	/** The plan's run token. */
	liveRunId: string;
	/** `ProposalBoundPrompt.promptId` of the Main prompt. */
	promptId: string;
	/** `ProposalBoundPrompt.versionNumber` of the Main prompt. */
	promptVersionNumber: number;
}

/**
 * The run guard in artifact mode, accepted by `saveProjectDocument`,
 * `createDocumentVersion` and the FAILED status write. Each writes only while
 * the document's `liveRunId` is this one, so a superseded run can neither
 * overwrite a newer Main, version it, nor mark it failed. A refused save or
 * version write throws {@link DOCUMENT_GENERATION_STALE}; a refused FAILED
 * write is a no-op.
 */
export interface ProposalLiveRunGuard {
	liveRunId: string;
}

/** What `createDocumentVersion` returns: the version row it wrote. */
export interface CreatedDocumentVersion {
	/** `DocumentVersion.version`, also written to `ProjectDocument.version`. */
	version: number;
	/** `DocumentVersion.id`. */
	versionId: string;
}

// =============================================================================
// Visuals activity (`generateProposalVisuals`)
// =============================================================================

export interface GenerateProposalVisualsInput {
	projectId: string;
	documentId: string;
	/** The owning organization; style, palette and model resolve under it. */
	organizationId: string;
	/** The triggering member, for model resolution. */
	userId: string;
	liveRunId: string;
	/** The Main content as generated, before the final save. */
	content: string;
	/** The member's own ChatGPT plan may serve the model calls (Fizzy #2939). */
	planEligible?: boolean;
}

export interface GenerateProposalVisualsResult {
	/** `content` with visuals inserted, or the input unchanged. */
	content: string;
	/** Visuals inserted into `content`; 0 when it is the input unchanged. */
	insertedCount: number;
}

// =============================================================================
// Internal Analysis
// =============================================================================

/**
 * Finding severities, as the analysis prompt names them. The output schema and
 * the prompt must use the same names.
 */
export const PROPOSAL_FINDING_SEVERITIES = [
	"Blocking",
	"Important",
	"Informational",
] as const;

export type ProposalFindingSeverity =
	(typeof PROPOSAL_FINDING_SEVERITIES)[number];

/**
 * Finding types, as the analysis prompt names them. The output schema and the
 * prompt must use the same names.
 */
export const PROPOSAL_FINDING_TYPES = [
	"Scope",
	"Commercial",
	"Assumption",
	"Risk",
	"Gap",
	"Source Validation",
	"Architecture",
	"Branding",
	"Opportunity",
] as const;

export type ProposalFindingType = (typeof PROPOSAL_FINDING_TYPES)[number];

/**
 * Why an analysis run is FAILED. Stored on the run row; its stored message is
 * the fixed string in {@link PROPOSAL_ANALYSIS_ERROR_MESSAGES}, never model
 * output or an exception's text.
 */
export const PROPOSAL_ANALYSIS_ERROR_CODES = [
	/** Nothing is bound to the analysis prompt action. */
	"PROMPT_NOT_BOUND",
	/** A project guest triggered the generation; analysis never runs for one. */
	"GUEST_TRIGGERED",
	/** The organization has no AI provider the analysis can use. */
	"AI_PROVIDER_NOT_CONFIGURED",
	/** The pinned analysis prompt version could not be rendered. */
	"PROMPT_RENDER_FAILED",
	/** The model call failed or returned output the schema refused. */
	"MODEL_ERROR",
	/** The analysis workflow could not be started. */
	"START_FAILED",
	/** The analysis activity ran out of time on its last attempt. */
	"TIMED_OUT",
] as const;

export type ProposalAnalysisErrorCode =
	(typeof PROPOSAL_ANALYSIS_ERROR_CODES)[number];

/**
 * The message stored with each error code. Fixed and short: the run row is
 * read back by the page, and nothing a model or a stack trace produced may
 * reach it.
 */
export const PROPOSAL_ANALYSIS_ERROR_MESSAGES: Readonly<
	Record<ProposalAnalysisErrorCode, string>
> = {
	PROMPT_NOT_BOUND:
		"No prompt is bound to the Proposal internal analysis action. An organization admin can bind one in the Prompt Library.",
	GUEST_TRIGGERED:
		"Internal analysis does not run for a generation started by a project guest.",
	AI_PROVIDER_NOT_CONFIGURED:
		"No AI provider is configured for this organization, so the internal analysis could not run.",
	PROMPT_RENDER_FAILED: "The internal analysis prompt could not be prepared.",
	MODEL_ERROR:
		"The internal analysis could not be completed by the AI model.",
	START_FAILED: "The internal analysis could not be started.",
	TIMED_OUT: "The internal analysis took too long and was stopped.",
};

/**
 * The analysis workflow id, which is also the run row's unique `runKey`. Keyed
 * by the generation's run token, so a regeneration gets a new run and a retried
 * start finds the same one.
 */
export function proposalAnalysisWorkflowId(
	documentId: string,
	liveRunId: string,
): string {
	return `proposal-analysis-${documentId}-${liveRunId}`;
}

// =============================================================================
// Source manifest (Fizzy #2946)
// =============================================================================

/**
 * What one retrieval string is: a project context row (with its type), a
 * company context source, the injected project summary, or anything else
 * (conversation bundles, and every string no row stands for). The same names
 * the stored manifest uses.
 */
export const PROPOSAL_SOURCE_KINDS = [
	"projectContext",
	"company",
	"summary",
	"other",
] as const;

export type ProposalSourceKind = (typeof PROPOSAL_SOURCE_KINDS)[number];

/**
 * Where one retrieval string came from, in the order retrieval returned the
 * strings. Ids and labels only travel here, never inside the strings, so
 * nothing about them reaches the Main prompt. No text of the source travels
 * here either: evidence is read from the source's current row when it is
 * shown, so text later removed from a source never resurfaces from a
 * manifest.
 */
export interface ProposalRetrievalSource {
	kind: ProposalSourceKind;
	/** The project context id, or the company context `sourceId`. */
	id: string | null;
	/** The project context type, for `projectContext`. */
	contextType: string | null;
	title: string | null;
	/** The company context source's name, for `company`. */
	sourceName: string | null;
	/** {@link proposalSourceFingerprint} of the exact retrieval string. */
	fingerprint: string;
}

/**
 * `retrieveProjectContexts` asked for its source manifest: the same strings
 * it returns otherwise, plus one manifest entry per string, in order.
 */
export interface ProjectContextsWithManifest {
	contexts: string[];
	manifest: ProposalRetrievalSource[];
}

/**
 * A fingerprint of one retrieval string, exactly as it sits in the contexts
 * array: two independently seeded FNV-1a passes plus the length. Retrieval
 * computes it as it returns the string and the analysis run recomputes it on
 * the string it finds at the aligned position, so a manifest entry is
 * trusted only for the string it was written for. Not a section hash (those
 * are `p1:`), and never a security boundary: the strings are the run's own.
 */
export function proposalSourceFingerprint(text: string): string {
	return `fnv1a:${fnv1aHex64(text)}:${text.length}`;
}

/**
 * Input of `createProposalAnalysisRun`, called once the Main document is
 * saved. The activity reads the saved content and version back from the
 * document row itself; nothing here carries Main text.
 */
export interface CreateProposalAnalysisRunInput {
	organizationId: string;
	projectId: string;
	documentId: string;
	/** The triggering member. */
	userId: string;
	liveRunId: string;
	/** From the plan; null exactly when `analysisSkipReason` is set. */
	analysisPrompt: ProposalBoundPrompt | null;
	analysisSkipReason: ProposalAnalysisSkipReason | null;
	/**
	 * From the plan. A guest-triggered run is recorded as `GUEST_TRIGGERED`
	 * even if a prompt is supplied, so internal analysis never runs on a
	 * guest's account.
	 */
	triggeredByGuest: boolean;
	/**
	 * The contexts the generation used. The activity stores a
	 * character-bounded copy on the run row; the analysis workflow never
	 * receives them.
	 */
	contexts: string[];
	/**
	 * Where the retrieval strings at the END of `contexts` came from, one
	 * entry per string, as `retrieveProjectContexts` reported them (Fizzy
	 * #2946). The child prepends supplied, Slack, Teams and episodic context
	 * after retrieval, so the activity aligns these to the tail and checks
	 * each entry's fingerprint against the string at its position. Absent
	 * for a direct-context run, a failed retrieval, and every run recorded
	 * before manifests existed: every source is then `other`.
	 */
	retrievalManifest?: ProposalRetrievalSource[];
}

/**
 * The run row `createProposalAnalysisRun` wrote (or found, on a retry).
 * `ready` is PENDING and the analysis workflow should be started with id
 * `runKey`; `skipped` was recorded FAILED and nothing is started;
 * `superseded` means a newer generation owns the document, so its Main is not
 * this run's to analyse: no row was written and nothing is started.
 */
export type CreateProposalAnalysisRunResult =
	| { kind: "ready"; runId: string; runKey: string }
	| {
			kind: "skipped";
			runId: string;
			runKey: string;
			errorCode: ProposalAnalysisSkipReason;
	  }
	| { kind: "superseded" };

/**
 * Input of `proposalAnalysisWorkflow`: ids only. The analyzed content, its hash
 * and the bounded contexts are already on the run row, so the payload stays
 * small whatever the document's size.
 */
export interface ProposalAnalysisWorkflowInput {
	/** `ProjectDocumentAnalysis.id`. */
	runId: string;
	organizationId: string;
	projectId: string;
	documentId: string;
	/** The triggering member, for model resolution and the update nudge. */
	userId: string;
	/** The member's own ChatGPT plan may serve the model call (Fizzy #2939). */
	planEligible?: boolean;
}
