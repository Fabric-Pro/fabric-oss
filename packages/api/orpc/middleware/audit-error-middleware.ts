/**
 * Automatic audit-error middleware (D16).
 *
 * Wraps every oRPC procedure invocation. On any thrown value:
 *  - Classify the error (action + severity).
 *  - Build the `metadata` payload (OTEL `exception` shape + Sentry-style
 *    fingerprint + sanitized input snapshot, with user-written bodies
 *    reduced to a size and hash + cause chain up to depth 5).
 *  - Emit one audit row via `recordAuditFromRequest`.
 *  - Re-throw the ORIGINAL error instance unchanged so the client UX,
 *    error codes, status mappings, and downstream middleware all observe
 *    the same value they would have seen without this middleware.
 *
 * Safety invariants (D16):
 *  1. Never wraps or alters the thrown error — the same instance is
 *     re-thrown so `instanceof ORPCError` etc. still hold downstream.
 *  2. Never throws from the capture path — every step is wrapped in
 *     try/catch so a bug in the metadata builder cannot break the error
 *     response. On internal failure a structured `console.error` lands.
 *  3. Uses `recordAuditFromRequest` (fire-and-forget) so audit writes
 *     do not block the error response.
 *  4. Honors two operator kill switches:
 *     - `FABRIC_AUDIT_ERROR_CAPTURE_DISABLED=true` -> skip ALL capture.
 *     - `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS=path.a,path.b.*` ->
 *       skip the listed procedure paths (prefix match via `*`).
 *
 * Spec: docs/audit-log/README.md
 * D16 (automatic error capture).
 */

import { os } from "@orpc/server";
import { auth } from "@repo/auth";
import { ERROR_CATEGORY, hasOrganizationTie } from "@repo/database";
import { contentIdentity } from "@repo/utils/content-identity";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../lib/audit";
import { peekAuthorizedProject } from "../../lib/authorized-project-binding";
import {
	extractCorrelationId,
	getCorrelationIdFromContext,
} from "../../lib/correlation-id";
import { flushSpansOnFailure } from "../../lib/request-span";
import { classifyError } from "./audit-error-mapping";
import {
	buildException,
	computeFingerprint,
	extractCauseChain,
	sanitizeInput,
} from "./audit-error-sanitize";

const SKIP_PATHS_ENV = "FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS";
const DISABLED_ENV = "FABRIC_AUDIT_ERROR_CAPTURE_DISABLED";

/**
 * Procedure paths whose error captures are ALWAYS suppressed, regardless of
 * env config (#1899). These carry personal calendar data — a join URL is a
 * meeting capability URL — and the audit row would land in the project's ORG
 * tenant, where org admins could read it. That is precisely the disclosure the
 * feature's design forbids (FR4), and the design also states this feature emits
 * no audit entries at all: recording that someone read their own private
 * calendar is itself the privacy risk. Hardcoded rather than left to
 * FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS so a ConfigMap edit cannot re-enable it.
 */
// NOTE: matched against the dotted ROUTER path (see renderProcedurePath). A
// direct `call(procedure, ...)` renders "(root)" and would NOT be skipped —
// so these procedures must only ever be reached through the router.
const ALWAYS_SKIP_PATHS = [
	"projects.meetingDigest.listPersonalMeetings",
	"projects.meetingDigest.getPersonalTranscript",
	// Runs the identical Graph chain as getPersonalTranscript and holds the
	// transcript in memory to summarise it, so it carries the same personal
	// calendar exposure and inherits the same unconditional suppression.
	"projects.meetingDigest.getPersonalInsights",
	// #1901 — agenda content is user prose. `content` is not on the redaction
	// denylist, so a thrown save would persist the whole document to an
	// org-admin-readable AuditLog row. Hardcoded rather than left to
	// FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS so a ConfigMap edit cannot re-enable it.
	"projects.meetingDigest.saveAgenda",
	// #2170 — the personal-meeting import. Unlike the entries above this
	// procedure DOES persist, deliberately, and its successes are audited: the
	// sibling audit-ACTIVITY middleware records every successful import, and
	// that row is lean by design (no input snapshot), which is exactly the
	// record an org admin is entitled to.
	//
	// Only the FAILURE path is suppressed, and only because of what it would
	// capture. This middleware snapshots the request's input, `joinUrl` is not
	// on the sensitive-key denylist, and a Teams join URL is a meeting
	// CAPABILITY url — #1899 went out of its way (DEF-6) to keep it off the
	// error path for precisely this reason. A throw here means the import did
	// NOT happen (a caller without CONTEXT_CREATE, the flag off, an unexpected
	// Graph failure), so the row would publish the address of a still-private
	// meeting into the project's ORG tenant in exchange for nothing.
	"projects.meetingDigest.importPersonalMeeting",
	// Fizzy #2616 — a synced knowledge file's upsert. Same reason as
	// saveAgenda (#1901): `content` is the file's full text, user prose up to
	// 2 MiB, and it is not on the redaction denylist, so a thrown call would
	// persist the file (past 8 KiB, a raw truncated string) to an
	// org-admin-readable AuditLog row. Here a throw is also ROUTINE: CONFLICT
	// is the normal answer when someone else changed the file first, so every
	// lost race would copy the losing version into the ledger. Successful
	// writes are audited by the procedure itself
	// (`project.context_source.content_upserted`), with the path, hash and
	// size but never the content.
	"projects.contexts.upsertSyncedFile",
	// Fizzy #2946 — an answer to an Internal Analysis finding. `text` is a
	// member's free-text answer and is not on the redaction denylist, so a
	// thrown call (a too-long answer, a guest's FORBIDDEN attempt) would copy
	// it into an org-admin-readable AuditLog row. Lost races are already
	// returned as a stale outcome rather than thrown for the same reason.
	// Successful writes are audited by the procedure itself
	// (`project.document_analysis.responded`), with keys and kinds only.
	"projects.proposalArtifact.respondToFinding",
] as const;

/**
 * The body fields of one chat message, as the agent conversation procedures
 * take it: the text, the model's reasoning, each tool call's arguments and
 * result (a tool that edits a document takes and returns its text), the
 * clarification a turn asked and answered, and an attachment's signed link.
 */
const CHAT_MESSAGE_BODY_FIELDS = [
	"content",
	"reasoningText",
	"toolCalls[].args",
	"toolCalls[].result",
	"metadata.clarification",
	"attachments[].previewUrl",
] as const;

/**
 * The body fields of one Advisor execution record, as `saveTurn` takes it and
 * a conversation keeps it in `metadata.executions`. The record repeats the
 * transcript the messages carry: the question and the final answer, each
 * clarification asked and answered, the plan and step descriptions the model
 * wrote, each step's reply and tool calls, approval feedback, generated
 * artifacts, the images the question carried, the run's error (a provider's
 * message may repeat the request) and its variables (an open record). Its
 * ids, statuses, timestamps, routing and model stay.
 */
const EXECUTION_RECORD_BODY_FIELDS = [
	"userMessage",
	"finalResponse",
	"imageUrls",
	"error",
	"clarifications[].question",
	"clarifications[].answer",
	"plan.description",
	"plan.steps[].description",
	"stepResults[].stepDescription",
	"stepResults[].response",
	"stepResults[].toolCalls[].args",
	"stepResults[].toolCalls[].result",
	"approvalHistory[].stepDescription",
	"approvalHistory[].feedback",
	"artifacts[].content",
	"variables",
] as const;

/**
 * The body fields of one AI SDK message part: a text or reasoning part's
 * text, a tool part's input (and its raw text while it streams) and output, a
 * file part's URL (a `data:` URL holds the whole file; a hosted one may be a
 * signed link), and a data part's payload.
 */
const MESSAGE_PART_BODY_FIELDS = [
	"text",
	"input",
	"rawInput",
	"output",
	"url",
	"data",
] as const;

/** `fields` under the object or array element at `prefix`. */
function fieldsUnder(prefix: string, fields: readonly string[]): string[] {
	return fields.map((field) => `${prefix}.${field}`);
}

/**
 * The bodies of a backlog change as the review sends it back to be applied:
 * each body's old and new text and the model's reasoning. `sourceContext` is
 * the kind of source (an enum), not its text, so it stays.
 */
const BACKLOG_CHANGE_BODY_FIELDS = fieldsUnder("approvedChanges[]", [
	"description.from",
	"description.to",
	"acceptanceCriteria.from",
	"acceptanceCriteria.to",
	"reasoning",
]);

/** An architecture decision's prose fields, as create and update take them. */
const ARCHITECTURE_DECISION_BODY_FIELDS = [
	"decision",
	"contextProblem",
	"rationale",
	"decisionDrivers",
	"alternativesConsidered",
	"consequences",
];

/**
 * Input fields an error capture records only as a summary, by procedure path
 * (Fizzy #2946). Each holds a whole user-written body (a document, a context
 * source or its summary, a file, a prompt or skill, a publishing draft, a
 * private notebook, a chat transcript or agent run record, a story, task,
 * test case or other work item, a comment, an answer to a question, an
 * architecture decision, a message or feedback to a running agent), which is
 * not on the redaction denylist, so the input snapshot would copy it (past
 * 8 KiB, as a truncated string) into an org-admin-readable AuditLog row.
 *
 * Unlike ALWAYS_SKIP_PATHS the row is still written: these failures are worth
 * recording, and their other fields (ids, versions, kinds, file paths) say
 * what was attempted. Only the bodies give way to `summarizeBodyField`'s
 * size and hash. Hardcoded for the same reason as ALWAYS_SKIP_PATHS, and
 * matched against the same dotted ROUTER path, so a direct
 * `call(procedure, ...)` is not covered either.
 *
 * A field is a path into the input: `a.b` is key `b` of the object at `a`,
 * and `a[].b` is key `b` of every element of the array at `a` (`a[]` alone is
 * every element). See `redactPath`.
 *
 * The middleware runs before input validation, so it sees the request as
 * sent: a request refused by validation is captured with its body too. For
 * the same reason a listed path whose input is not an object is not trusted
 * to be harmless: each element of an array input has the fields redacted as
 * an object input would, and any other value is summarized whole (see
 * `redactBodyFields`).
 */
const REDACTED_BODY_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
	// The editor's save, autosave and AI accept. A throw here is ROUTINE:
	// CONFLICT answers every save from a stale base, and a refused AI accept
	// (a SCOPED_REVISION_REFUSAL such as RESPONSE_ECHOED) is refused precisely
	// because its body repeats an internal answer or finding.
	["projects.documents.update", ["content"]],
	// The preview sends the editor's body, the confirm the accepted one; the
	// confirm answers CONFLICT when the document moved on since the preview.
	[
		"projects.documents.updateWithContext",
		["currentContent", "confirmedContent"],
	],
	// A new document's body and the source material pasted to generate it.
	["projects.documents.create", ["content", "sourceText"]],
	// The spec being written, sent whole as the retrieval query.
	["projects.specContext", ["specMarkdown"]],
	// Onboarding artifacts sent in the PM additional context, which
	// `create-project.ts` turns into the PRD, Architecture and Technical Specs
	// documents. The keys mirror its `docSpecs`; the record's other keys (the
	// PM team, the label map) are settings and stay.
	[
		"projects.create",
		[
			"projectManagementAdditionalContext.prdContent",
			"projectManagementAdditionalContext.archContent",
			"projectManagementAdditionalContext.specsContent",
		],
	],
	// The same record, saved from the PM settings. Only create reads these
	// keys, but a client that sends them here would have them captured too.
	[
		"projects.update",
		[
			"projectManagementAdditionalContext.prdContent",
			"projectManagementAdditionalContext.archContent",
			"projectManagementAdditionalContext.specsContent",
		],
	],
	// Project and company context: pasted text, an edited summary, and the
	// files a Living Memory write puts into the repository.
	["projects.contexts.create", ["content"]],
	["projects.contexts.updateSummary", ["content"]],
	["projects.contexts.memoryWrites.validate", ["entries[].content"]],
	["projects.contexts.memoryWrites.submit", ["entries[].content"]],
	["organizations.companyContext.createText", ["content"]],
	// Publishing drafts. The save endpoints answer CONFLICT on a stale
	// `expectedUpdatedAt`, so a lost race would copy the losing draft. The
	// topic notes are the person's private notebook.
	["projects.publishingSuite.saveShortPostBody", ["body"]],
	["projects.publishingSuite.saveLinkedInPostBody", ["body"]],
	["projects.publishingSuite.saveBlogPostBody", ["body"]],
	["projects.publishingSuite.saveCaseStudyBody", ["body"]],
	["projects.publishingSuite.saveStakeholderEmailBody", ["body"]],
	["projects.publishingSuite.saveWebinarScriptBody", ["body"]],
	["projects.publishingSuite.saveNewsletterBlurbBody", ["body"]],
	["projects.publishingSuite.saveAnalysisRevision", ["body"]],
	["projects.publishingSuite.acceptRefinement", ["body"]],
	["projects.publishingSuite.summarizeAnalysisChanges", ["before", "after"]],
	["projects.publishingSuite.setTopicNotes", ["notes"]],
	// A story's private notebook, the same model as the topic notes.
	["projects.stories.maturation.setWorkingNotes", ["content"]],
	// Coding-instruction files committed to the project's repository.
	["projects.instructions.commitChange", ["changes[].content"]],
	["projects.instructions.submitGitChange", ["changes[].content"]],
	// Files, frames, artifacts and agent memory.
	["workspace.createFile", ["content"]],
	["workspace.updateFile", ["content"]],
	["frames.create", ["blocks[].content"]],
	["frames.update", ["blocks[].content"]],
	["artifacts.create", ["content"]],
	["agentMemory.files.write", ["content"]],
	// `files` maps each path to its content, so the whole map gives way.
	["agentMemory.import", ["files"]],
	// Uploads, as base64 of the whole file.
	["documentWorkspaces.documents.serverUpload", ["fileData"]],
	["ai.documents.upload", ["fileData"]],
	// Prompt and skill bodies. A render also takes the document and the
	// retrieved context it injects, and template variables, which carry the
	// same text under names the template chooses.
	["prompts.create", ["initialContent"]],
	["prompts.update", ["content"]],
	["prompts.version.create", ["content"]],
	["prompts.render", ["variables", "ragContexts[]", "currentDocument"]],
	["skills.create", ["content"]],
	["skills.update", ["content"]],
	// Chat transcripts. A conversation save sends the whole thread, so a
	// failed one would copy every message, including what the model read.
	// The metadata is an open record; the Advisor keeps its execution records
	// in `executions`, each repeating the turn's transcript.
	[
		"agents.conversations.create",
		[
			...fieldsUnder("messages[]", CHAT_MESSAGE_BODY_FIELDS),
			...fieldsUnder(
				"metadata.executions[]",
				EXECUTION_RECORD_BODY_FIELDS,
			),
		],
	],
	[
		"agents.conversations.update",
		[
			...fieldsUnder("messages[]", CHAT_MESSAGE_BODY_FIELDS),
			// Each step of an agent run, with what it read and wrote.
			"trajectory.nodes[].input",
			"trajectory.nodes[].output",
			...fieldsUnder(
				"metadata.executions[]",
				EXECUTION_RECORD_BODY_FIELDS,
			),
		],
	],
	[
		"agents.conversations.updateTrajectory",
		["trajectory.nodes[].input", "trajectory.nodes[].output"],
	],
	// The browser sends the turn's execution record with every save, beside
	// its messages.
	[
		"agents.conversations.saveTurn",
		[
			...fieldsUnder("messages[]", CHAT_MESSAGE_BODY_FIELDS),
			...fieldsUnder("execution", EXECUTION_RECORD_BODY_FIELDS),
		],
	],
	[
		"agents.conversations.addMessage",
		fieldsUnder("message", CHAT_MESSAGE_BODY_FIELDS),
	],
	[
		"agents.conversations.appendTurnForDocument",
		fieldsUnder("message", CHAT_MESSAGE_BODY_FIELDS),
	],
	// The summary a long thread is carried into a new chat with.
	["agents.conversations.continueInNewChat", ["summary"]],
	["agents.suggestSkills", ["message"]],
	// An agent draft tried out before it is saved.
	["agents.previewDraft", ["systemPrompt", "userMessage"]],
	[
		"ai.chats.messages.add",
		fieldsUnder("messages[].parts[]", MESSAGE_PART_BODY_FIELDS),
	],
	// The chat's stored messages, whose shape the input leaves open.
	["ai.chats.update", ["messages[]"]],
	["ai.chats.workflows.generateTitle", ["firstMessage"]],
	["atlas.chat", ["messages[].content"]],
	["atlas.systemChat", ["messages[].content"]],
	["weave.chat", ["message"]],
	["weave.plans.create", ["description", "message"]],
	[
		"weave.plans.refine",
		["currentMessage", "refinementInput", "history[].content"],
	],
	["weave.plans.approve", ["feedback"]],
	["weave.plans.revise", ["feedback"]],
	// What a person tells a running agent: an approval's feedback, a coding
	// run's follow-up instruction.
	["weave.executions.signalApproval", ["feedback"]],
	["codingRuns.sendFollowUp", ["message"]],
	[
		"projects.stories.tasks.agent.resolveCheckpoint",
		["feedback", "userData"],
	],
	["projects.backlog.startAnalysis", ["userPrompt"]],
	[
		"projects.backlog.applyChanges",
		["messages[].content", ...BACKLOG_CHANGE_BODY_FIELDS],
	],
	["projects.backlog.approvePendingProposal", BACKLOG_CHANGE_BODY_FIELDS],
	// Stories and other work items: a description or acceptance criteria is
	// a whole body, and the merge, conflict and enrichment paths send two.
	["projects.stories.create", ["description", "acceptanceCriteria"]],
	["projects.stories.update", ["description", "acceptanceCriteria"]],
	[
		"projects.stories.updateWithContext",
		[
			"currentDescription",
			"currentAcceptanceCriteria",
			"confirmedDescription",
			"confirmedAcceptanceCriteria",
		],
	],
	[
		"projects.stories.updateStageWithVersion",
		["description", "acceptanceCriteria"],
	],
	[
		"projects.stories.mergeDuplicate",
		["mergedDescription", "mergedAcceptanceCriteria"],
	],
	["projects.stories.proposeAiMerge", ["fabricDescription", "pmDescription"]],
	["projects.stories.checkDuplicate", ["description"]],
	[
		"projects.stories.previewEnrichment",
		["proposedDescription", "proposedAcceptanceCriteria", "reasoning"],
	],
	[
		"projects.stories.reformatProposalBody",
		["description", "acceptanceCriteria"],
	],
	["projects.stories.resolveConflict", ["overrideDescription"]],
	["projects.stories.maturation.summarizeChanges", ["before", "after"]],
	["projects.pmStateChanges.resolveContentDrift", ["overrideDescription"]],
	["projects.epics.create", ["description"]],
	["projects.epics.update", ["description"]],
	["projects.features.create", ["description"]],
	["projects.features.update", ["description"]],
	["projects.stories.tasks.create", ["description"]],
	["projects.stories.tasks.update", ["description"]],
	// Test cases: the description, each step's action and expected result,
	// and the generated Playwright script.
	["projects.testCases.create", ["description", "steps[]"]],
	[
		"projects.testCases.update",
		["description", "steps[]", "playwrightScript"],
	],
	// Comments on work items and decisions, and operators' notes on an
	// incident.
	["projects.stories.comments.create", ["content"]],
	["projects.stories.tasks.comments.create", ["content"]],
	["projects.architectureDecisions.comments.create", ["content"]],
	["incidents.errorRate.addComment", ["message"]],
	["integrationHealth.addComment", ["message"]],
	// Answers to a story's or a publishing topic's open questions, and the
	// story's decision log. An answer's summary restates it.
	["projects.stories.maturation.answerQuestion", ["answer", "summary"]],
	["projects.stories.maturation.amendAnswer", ["answer"]],
	["projects.stories.maturation.appendDecisionEntry", ["content", "summary"]],
	// An accepted AI update's change summary, which restates the edit.
	["projects.stories.maturation.recordChangeNote", ["bullets[]"]],
	["projects.publishingSuite.answerTopicQuestion", ["answer"]],
	["projects.publishingSuite.amendTopicQuestion", ["answer"]],
	// Architecture decisions. The metadata suggestion is sent the draft.
	[
		"projects.architectureDecisions.create",
		ARCHITECTURE_DECISION_BODY_FIELDS,
	],
	[
		"projects.architectureDecisions.update",
		ARCHITECTURE_DECISION_BODY_FIELDS,
	],
	[
		"projects.architectureDecisions.suggestMetadata",
		["decision", "contextProblem"],
	],
]);

/**
 * Input fields an error capture records as `{ redacted: true }` alone, by
 * procedure path: secrets, where even a size and hash say more than the row
 * needs. The same path form and matching as REDACTED_BODY_FIELDS.
 *
 * An OAuth callback's `code` is exchanged for the connection's tokens. It is
 * short-lived and single-use, but a callback that fails before the exchange
 * leaves it unused, and `code` is not on the sensitive-key denylist (a
 * substring match on it would take every `errorCode` too).
 */
const REDACTED_SECRET_FIELDS: ReadonlyMap<string, readonly string[]> = new Map([
	["integrations.github.callback", ["code"]],
	["integrations.gitlab.callback", ["code"]],
	["integrations.oauth.callback", ["code"]],
	["mcp.oauth.callback", ["code"]],
	["mcp.atlassianCloud.callback", ["code"]],
]);

/** What an error capture records in place of a body field. */
type BodyFieldSummary =
	| { redacted: true; bytes: number; contentHash: string }
	| { redacted: true };

/**
 * The size of a body and its `contentIdentity` hash, never its text: enough to
 * tell whether two failed saves carried the same body. The hash is of the
 * body as sent, before the save normalizes it, so it need not equal the
 * `contentHash` a stored version reports. A value that is not a string (a
 * malformed request, refused by validation) may still hold text, so it is
 * recorded as redacted with nothing else.
 */
function summarizeBodyField(value: unknown): BodyFieldSummary {
	if (typeof value === "string") {
		return {
			redacted: true,
			bytes: Buffer.byteLength(value, "utf8"),
			contentHash: contentIdentity(value),
		};
	}
	return { redacted: true };
}

/** What an error capture records in place of a secret field: nothing of it. */
function summarizeSecretField(): BodyFieldSummary {
	return { redacted: true };
}

type FieldSummarizer = (value: unknown) => BodyFieldSummary;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Replace the value `segments` names inside `value` with its summary (see
 * REDACTED_BODY_FIELDS for the path form). Copies only the objects and arrays
 * on the way to a replaced value, and returns `value` itself when nothing was
 * replaced. A missing or null step, the field itself included, ends the path
 * with nothing to replace: a null body (a field being cleared) holds no text
 * and stays null. A step that is not the object or array the path expects (a
 * malformed request, refused by validation) may still hold text, so it is
 * summarized whole.
 */
function redactPath(
	value: unknown,
	segments: readonly string[],
	summarize: FieldSummarizer,
): unknown {
	if (value === undefined || value === null) {
		return value;
	}
	const [segment, ...rest] = segments;
	if (segment === undefined) {
		return summarize(value);
	}
	if (!isPlainObject(value)) {
		return summarize(value);
	}
	const eachElement = segment.endsWith("[]");
	const key = eachElement ? segment.slice(0, -2) : segment;
	const current = value[key];
	if (current === undefined) {
		return value;
	}
	let next: unknown;
	if (!eachElement) {
		next = redactPath(current, rest, summarize);
	} else if (Array.isArray(current)) {
		const elements = current.map((element) =>
			redactPath(element, rest, summarize),
		);
		next = elements.some((element, index) => element !== current[index])
			? elements
			: current;
	} else {
		next = current === null ? current : summarize(current);
	}
	return next === current ? value : { ...value, [key]: next };
}

/**
 * Replace the fields `REDACTED_BODY_FIELDS` and `REDACTED_SECRET_FIELDS` list
 * for `path` with their summaries, before the input snapshot is sanitized.
 * Returns a copy; the request's own input is never modified. Any other path is
 * returned as it is.
 *
 * Fails closed on a listed path whose input is not the object its fields
 * describe (a malformed request, refused by validation after this runs): each
 * element of an array input has the fields replaced as an object input would,
 * and any other value, an element that is not an object included, is
 * summarized whole, as a secret when the path lists one. A missing or null
 * input stays as it is.
 */
function redactBodyFields(path: string, input: unknown): unknown {
	const bodyFields = REDACTED_BODY_FIELDS.get(path) ?? [];
	const secretFields = REDACTED_SECRET_FIELDS.get(path) ?? [];
	if (bodyFields.length === 0 && secretFields.length === 0) {
		return input;
	}
	const summarizeWhole: FieldSummarizer =
		secretFields.length > 0 ? summarizeSecretField : summarizeBodyField;
	const redactRecord = (value: unknown): unknown => {
		if (value === undefined || value === null) {
			return value;
		}
		if (!isPlainObject(value)) {
			return summarizeWhole(value);
		}
		let redacted: unknown = value;
		for (const field of bodyFields) {
			redacted = redactPath(
				redacted,
				field.split("."),
				summarizeBodyField,
			);
		}
		for (const field of secretFields) {
			redacted = redactPath(
				redacted,
				field.split("."),
				summarizeSecretField,
			);
		}
		return redacted;
	};
	return Array.isArray(input) ? input.map(redactRecord) : redactRecord(input);
}

/**
 * Parse `FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS` into a list of patterns.
 * Trailing `*` indicates a prefix match; otherwise the value matches
 * exactly. We re-parse on every call so tests can flip the env without
 * restarting; in production the value is read once per request which is
 * cheap (<= a few entries typically).
 */
function readSkipPatterns(): { exact: Set<string>; prefixes: string[] } {
	const raw = process.env[SKIP_PATHS_ENV];
	if (!raw || raw.trim().length === 0) {
		return { exact: new Set(), prefixes: [] };
	}
	const exact = new Set<string>();
	const prefixes: string[] = [];
	for (const part of raw.split(",")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) {
			continue;
		}
		if (trimmed.endsWith("*")) {
			prefixes.push(trimmed.slice(0, -1));
		} else {
			exact.add(trimmed);
		}
	}
	return { exact, prefixes };
}

function shouldSkip(path: string): boolean {
	if ((ALWAYS_SKIP_PATHS as readonly string[]).includes(path)) {
		return true;
	}
	const { exact, prefixes } = readSkipPatterns();
	if (exact.has(path)) {
		return true;
	}
	for (const prefix of prefixes) {
		if (path.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

function isCaptureDisabled(): boolean {
	return process.env[DISABLED_ENV] === "true";
}

/**
 * Project the oRPC `path` tuple into a dotted procedure key. Mirrors the
 * shape the viewer's `action` column shows (e.g. `"projects.create"`).
 */
function renderProcedurePath(path: readonly string[]): string {
	return path.length === 0 ? "(root)" : path.join(".");
}

/**
 * Best-effort HTTP method extraction. oRPC defaults to POST.
 */
function readHttpMethod(headers: Headers | undefined): string | undefined {
	if (!headers) {
		return undefined;
	}
	const candidate = headers.get?.("x-http-method");
	return candidate ?? undefined;
}

/**
 * Read a numeric HTTP status off an ORPCError-like object. Returns
 * `undefined` when the value is not a finite number.
 */
function readHttpStatus(err: unknown): number | undefined {
	if (err && typeof err === "object" && "status" in err) {
		const candidate = (err as { status?: unknown }).status;
		if (typeof candidate === "number" && Number.isFinite(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Read the `code` field off an ORPCError-like object. Falls back to the
 * Error constructor name when no `code` is present (Zod, plain Error).
 */
function readErrorCode(err: unknown): string {
	if (err && typeof err === "object") {
		const code = (err as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) {
			return code;
		}
		const name = (err as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) {
			return name;
		}
	}
	return "UNKNOWN";
}

/**
 * Best-effort projectId read off the input. The middleware does not know
 * what shape the input has, so we duck-type for a `projectId` string at
 * the top level. Falls back to undefined.
 */
export function readProjectIdFromInput(input: unknown): string | undefined {
	if (input && typeof input === "object" && "projectId" in input) {
		const candidate = (input as { projectId?: unknown }).projectId;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Best-effort organizationId read off the input. Same duck-typing pattern
 * as `readProjectIdFromInput`. Returns `null` for explicit personal
 * context (`organizationId: null`) so the row lands in personal tenant.
 * Returns `undefined` when the input doesn't carry the field at all so
 * downstream resolution (session.activeOrganizationId) can still apply.
 */
/**
 * The organization an automatic audit row (error or activity) is attributed to.
 *
 * When the request authorized a project, its organization — never a
 * caller-named one. Otherwise a request that paired a reachable project with
 * another organization's id wrote a row into THAT organization's audit trail,
 * visible to its admins, whether or not the handler then refused it. A project
 * with no organization attributes to null (personal), not to the input.
 *
 * Without an authorized project: explicit input (including explicit null), else
 * the session's active organization, else null. Pure; never throws.
 */
export function auditOrganizationId(
	inputOrg: string | null | undefined,
	sessionOrg: string | null | undefined,
): string | null {
	const authorized = peekAuthorizedProject();
	if (authorized) {
		return authorized.organizationId;
	}
	return inputOrg !== undefined ? inputOrg : (sessionOrg ?? null);
}

export function readOrganizationIdFromInput(
	input: unknown,
): string | null | undefined {
	if (input && typeof input === "object" && "organizationId" in input) {
		const candidate = (input as { organizationId?: unknown })
			.organizationId;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
		if (candidate === null) {
			return null;
		}
	}
	return undefined;
}

/**
 * Resolve actor + org context for an error row when the outer middleware
 * sits OUTSIDE the auth chain (so `context.user` / `context.session` are
 * undefined). Re-runs Better Auth's session resolver against the request
 * headers (cached internally) and merges the result into the AuditRequestContext.
 *
 * Critical for correctness: without this, every error row was orphaned
 * with `userId=null, organizationId=null` and invisible to any viewer.
 * The auth resolver returns `null` for anonymous requests, in which case
 * we leave the actor as "system" — same behavior as before.
 */
async function enrichContextFromHeaders(
	context: AuditRequestContext,
): Promise<AuditRequestContext> {
	if (context.user || !context.headers) {
		return context;
	}
	try {
		const session = await auth.api.getSession({ headers: context.headers });
		if (!session?.user) {
			return context;
		}
		return {
			...context,
			user: {
				id: session.user.id,
				email: session.user.email,
				name: session.user.name,
			},
			session: {
				id: session.session.id,
				impersonatedBy: session.session.impersonatedBy ?? null,
				activeOrganizationId:
					session.session.activeOrganizationId ?? null,
			},
		};
	} catch {
		// Anonymous or session-resolution failure — proceed with the
		// unenriched context. Actor falls back to "system" in
		// resolveActor; orgId falls back to the input-derived value.
		return context;
	}
}

/**
 * Internal: build the metadata payload + emit one audit row. Wrapped in
 * a try/catch so a failure here CANNOT break the error response. On
 * failure we log a structured `console.error` so operators see it.
 */
async function captureError(
	err: unknown,
	rawContext: AuditRequestContext & {
		_auditFailureEmitted?: boolean;
	},
	input: unknown,
	path: readonly string[],
): Promise<void> {
	try {
		// Idempotence (D16): a hand-emitted failure earlier in the chain
		// can set `_auditFailureEmitted = true` on context to suppress us.
		if (rawContext._auditFailureEmitted === true) {
			return;
		}

		const renderedPath = renderProcedurePath(path);

		// Kill switches: env-disabled OR path-matched skip-list.
		if (isCaptureDisabled()) {
			return;
		}
		if (shouldSkip(renderedPath)) {
			return;
		}

		// Re-resolve user + session from headers because this middleware
		// sits OUTSIDE the auth chain (so the outer `context` arg never
		// carries `user`/`session` even when downstream auth middleware
		// successfully resolved them via `next({ context: ... })`).
		const context = await enrichContextFromHeaders(rawContext);

		const classification = classifyError(err);
		const exception = buildException(err);
		const cause = extractCauseChain(err);
		const fingerprint = computeFingerprint(
			exception.type,
			readErrorCode(err),
			exception.stacktrace?.[0],
		);

		// Correlation: AsyncLocalStorage first, then header (D16). We don't
		// fall back to null here because we want operators to be able to
		// trace ANY error back to a request — even one whose middleware
		// chain somehow missed `asyncCorrelationMiddleware`. If both sources
		// are empty, the field is simply omitted.
		const correlationId =
			getCorrelationIdFromContext() ??
			(context.headers ? extractCorrelationId(context.headers) : null);

		const metadata: Record<string, unknown> = {
			exception: {
				...exception,
				// OTEL `exception.escaped` is true once the exception
				// crosses a span boundary. By definition we are catching it
				// at the outermost middleware so `escaped` is always true.
				escaped: true,
			},
			fingerprint,
			procedure: {
				path: renderedPath,
				method: readHttpMethod(context.headers),
				httpStatus: readHttpStatus(err),
			},
			errorCode: readErrorCode(err),
		};
		if (cause) {
			metadata.cause = cause;
		}
		const inputSnapshot = sanitizeInput(
			redactBodyFields(renderedPath, input),
		);
		if (inputSnapshot !== undefined) {
			metadata.input = inputSnapshot;
		}
		// Surface correlation at the top level of metadata (not under
		// `procedure`) so the viewer can filter / display it directly
		// without drilling into the nested OTEL shape.
		if (correlationId) {
			metadata.correlationId = correlationId;
		}

		// Refused inputs identify the attempted target, not a proven FK owner.
		// Keep them in metadata.input; successful activity attribution is separate.
		const authorizedProject = peekAuthorizedProject();
		const candidateOrganizationId = auditOrganizationId(
			readOrganizationIdFromInput(input),
			context.session?.activeOrganizationId,
		);
		let organizationId = authorizedProject?.organizationId ?? null;
		if (!authorizedProject && context.user && candidateOrganizationId) {
			const verified = await hasOrganizationTie(
				context.user.id,
				candidateOrganizationId,
			).catch(() => false);
			if (verified) {
				organizationId = candidateOrganizationId;
			}
		}

		recordAuditFromRequest(context, {
			action: classification.action,
			category: ERROR_CATEGORY,
			severity: classification.severity,
			outcome: "failure",
			organizationId,
			resource: {
				type: "procedure",
				id: renderedPath,
				name: renderedPath,
			},
			projectId: authorizedProject?.projectId ?? null,
			metadata,
			// Pass explicitly too so it lands on the row even if
			// `recordAuditFromRequest`'s own resolution misses (e.g. tests).
			correlationId,
		});

		// v2 item 4: persist any buffered request spans now that the
		// audit row has been emitted. The span buffer was opened by
		// `auditTimingMiddleware` (which sits inside this middleware)
		// and was NOT drained on the failure path. Pass the resolved
		// correlationId so spans share the same trace key as the audit
		// row. The call is awaited so the spans land before the error
		// response completes (still fast — single batched INSERT).
		// Stamp the tenant too, not just the correlationId. The span frame was
		// opened before auth resolved, so its tenant fields are null — and
		// `audit.tracedRequest` scopes the span read to
		// `organizationId IS NULL AND userId = <caller>` in personal context, so
		// null-userId rows were invisible to the only surface that reads them.
		// Same failure shape as the audit rows that were written tenant-less.
		const spanTenant = {
			organizationId,
			userId: context.user?.id ?? null,
		};
		await flushSpansOnFailure(correlationId || undefined, spanTenant);

		// Mark so any downstream hand-rolled emit can opt out via
		// `context._auditFailureEmitted = true` (idempotence flag).
		rawContext._auditFailureEmitted = true;
	} catch (captureErr) {
		// Last-resort: the audit-capture path itself failed. We log to
		// stdout in a structured shape so operators can grep, but we do
		// NOT throw — the original error still has to surface to the
		// client.
		try {
			// eslint-disable-next-line no-console
			console.error({
				event: "audit.error_capture_failed",
				path: renderProcedurePath(path),
				captureErrorMessage:
					captureErr instanceof Error
						? captureErr.message
						: String(captureErr),
			});
		} catch {
			// Truly catastrophic — even console.error blew up. Give up.
		}
	}
}

/**
 * The middleware itself. Wired as the outermost layer on the base public
 * procedure in `procedures.ts` so every procedure (auth, rate-limit,
 * permission, tenant, handler) participates.
 *
 * The second-argument `input` is the request's input as sent. oRPC validates
 * it where a procedure declares `.input(zSchema)`, after the base middleware
 * this one belongs to, so it is not yet parsed: unknown keys and wrong types
 * reach here. For a request without input it is `undefined`, which
 * `sanitizeInput` handles cleanly.
 */
export const auditErrorMiddleware = os
	.$context<
		{
			headers: Headers;
		} & AuditRequestContext
	>()
	.middleware(async ({ context, next, path }, input: unknown) => {
		try {
			// `next()` is the only place we await; on success we never
			// touch the audit path.
			return await next();
		} catch (err) {
			// Best-effort capture. We have access to the request's input
			// via the second arg; user-written bodies are summarized
			// (REDACTED_BODY_FIELDS), then the sanitizer redacts sensitive
			// keys and only then truncates to 8KiB. captureError is async
			// (it re-resolves session via auth.api.getSession) but we MUST
			// re-throw synchronously to preserve error timing for the
			// client — so we fire it without await. The function is
			// self-contained: its own outer try/catch handles all failures,
			// so an unhandled rejection here is impossible.
			void captureError(err, context, input, path);
			throw err;
		}
	});

/**
 * Internal exports for tests.
 *
 * `captureError` is the pure capture function; tests can call it
 * directly to avoid spinning up the full oRPC framework.
 */
export {
	ALWAYS_SKIP_PATHS,
	REDACTED_BODY_FIELDS,
	REDACTED_SECRET_FIELDS,
	captureError as __captureErrorForTest,
	redactBodyFields as __redactBodyFieldsForTest,
	readSkipPatterns as __readSkipPatternsForTest,
	shouldSkip as __shouldSkipForTest,
	isCaptureDisabled as __isCaptureDisabledForTest,
};
