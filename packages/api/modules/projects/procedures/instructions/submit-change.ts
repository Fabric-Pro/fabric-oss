/**
 * One server entry point for changing a project's coding instructions from
 * OUTSIDE the browser, with the file bytes carried inline (Fizzy #2539).
 *
 * The tab's flow is three round trips — `derive` registers the change set,
 * `createUploadUrls` signs a PUT per changed file, the browser uploads, and
 * `finalize` starts the workflow. That shape exists because a browser can
 * stream a whole folder straight into object storage. A coding agent or the
 * CLI is sending a handful of small text files it already holds in memory, so
 * here the same three steps happen server-side inside one call: the bytes
 * arrive in the request, the server hashes them, writes them to the exact
 * staging keys the presigned flow would have used, and starts the same
 * workflow.
 *
 * Nothing about that shortens the checks. It is the SAME
 * `createDerivedInstructionSnapshot` the tab uses, the same payload validation
 * (`change-set.ts`), the same `projectInstructionSnapshotWorkflow`, and so the
 * same verify → scan → publish gate reads every file — inherited ones
 * included. What is skipped is the TRANSFER, not a gate.
 *
 * ## Repeating a call is safe
 *
 * None of the surfaces that reach here can tell a request that never arrived
 * from one whose response was lost, and all three retry. So the query
 * identifies a proposal by its CONTENT — the base plus the set of (op, path,
 * sha256) — and answers a change set it has already admitted with the row it
 * wrote (Fizzy #2605). Content rather than an `Idempotency-Key` table because
 * the MCP tool never sees an HTTP header: the key would exist for the REST
 * caller and not for the agent, and the agent is the caller most likely to
 * repeat itself.
 *
 * A duplicate is REPORTED, never taken over. One writer per row: this request
 * did not create that snapshot, and the list of things that can be writing to
 * it — the creating request, still running server-side long after its client
 * hung up; the scheduled reaper; the tab's "Try again"; the validation
 * workflow's own promotion and cleanup — is too long for a second writer to
 * join safely without an ownership protocol none of them share. So no upload,
 * no finalize, no audit row and no compensation on any duplicate.
 *
 * That holds for a RECEIVING duplicate too, however old it looks. There is no
 * age at which this request may close one out, because the browser tab
 * creates proposals through the same query and its staging capabilities stay
 * valid for an hour (`PROPOSAL_UPLOAD_SIGNING_WINDOW_MS`) — a person still
 * uploading in the tab would have their live row rejected by a CLI push of
 * the same content. The only window every surface honours is the reaper's
 * own, and the reaper is what applies it.
 *
 * ## Authorization
 *
 * Two separate questions, both answered server-side and neither taken from the
 * caller:
 *
 *  - WHICH organization: `requireHostingOrganizationId` resolves the project's
 *    own host org. No caller-supplied `organizationId` is accepted at all —
 *    there is no parameter for one.
 *  - WHAT the caller may do: `assertInstructionDeriveAccess`, the same dynamic
 *    check `derive` runs, asked with the caller's `mode`. `INSTRUCTION_READ`
 *    for a proposal, because proposing is what a reader does in the tab;
 *    `INSTRUCTION_CREATE` for a publish, because that is what the tab demands
 *    of the same person to put a version in front of everyone.
 *
 * ## Two modes, and each one has its own scope in front of it
 *
 * `mode` is REQUIRED and has no default. The two authorities are separate all
 * the way out to the credential, which is the whole point:
 *
 *  - `mode: "proposal"` opens a proposal an editor reviews. Its scope is
 *    `instructions:write`, which the Connect dialog mints for read-only roles
 *    and describes as review-gated.
 *  - `mode: "publish"` publishes directly, with no review. Its scope is
 *    `instructions:publish`, which the Connect dialog never mints, no MCP tool
 *    asks for, and `READ_ONLY_ORG_API_KEY_SCOPES` refuses a viewer.
 *
 * One scope carrying both would mean a key described as review-gated published
 * directly whenever its creator happened to hold `INSTRUCTION_CREATE` — the
 * scope would no longer describe what the key can do, which is the objection
 * that kept publishing out of this file until the second scope existed.
 *
 * The runtime is fail-CLOSED on the mode: anything that is not exactly
 * `"publish"` proposes. A JavaScript caller that forgets the field, or sends a
 * mode this file does not know, gets the reviewed path rather than the
 * unreviewed one.
 *
 * A key-backed caller has already had its declared scope checked by
 * `requireScope` at the route; this is the live per-call permission check that
 * must happen in addition to it, never instead of it. It runs for every key
 * type, wildcard ones included.
 */
import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	claimInstructionFileStagingKey,
	createDerivedInstructionSnapshot,
	type DuplicateInstructionProposal,
	getInstructionSnapshot,
	getInstructionSnapshotWithPublishedPointer,
	getProjectInstructionSettings,
	getPublishedInstructionSnapshot,
	type InstructionProposalStatus,
	listInstructionFiles,
	rejectAbandonedInstructionSnapshot,
} from "@repo/database";
import {
	isStagingKey,
	SNAPSHOT_LIMITS,
	snapshotPrefix,
	stagingKey,
} from "@repo/instructions";
import { getStorageProvider } from "@repo/storage";
import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../../lib/audit";
import {
	derivedSnapshotRefusal,
	MAX_CHANGES,
	type RawInstructionChange,
	validateInstructionChanges,
} from "./change-set";
import { finalizeInstructionSnapshot } from "./finalize";
import { requireHostingOrganizationId } from "./hosting-organization";
import {
	isInstructionWorkflowNotStarted,
	unwrapInstructionWorkflowError,
} from "./instruction-workflow-start";
import { assertInstructionDeriveAccess } from "./proposal-authorization";

// Same source `SKILLS_BUCKET_NAME` feeds (config/index.ts), imported the way
// `create-upload-urls.ts` does.
const SKILLS_BUCKET = config.storage.bucketNames.skills;

/**
 * The most decoded bytes one inline change set may carry.
 *
 * Two megabytes, against a 4.5 MB serverless request-body ceiling. The margin
 * is not slack: base64 content inflates by a third on the wire and JSON string
 * escaping adds more on top, so 2 MiB of file content is already close to 3 MiB
 * of request. A change set bigger than this is a folder upload wearing a diff,
 * and the tab is where a folder upload belongs — it is also the only path that
 * re-resolves the project's live ignore settings.
 *
 * `SNAPSHOT_LIMITS.maxFileBytes` still bounds each individual file; this bounds
 * the request.
 */
const MAX_INLINE_CHANGE_BYTES = 2 * 1024 * 1024;

/**
 * The most ENCODED characters one inline change set may carry, checked before
 * anything is decoded.
 *
 * Decoding is what allocates, so the cheap bound has to come first: a caller
 * sending 40 MB of base64 must be refused by a length comparison rather than
 * by a `Buffer` that was allocated to measure it. Four MiB of characters is
 * comfortably more than `MAX_INLINE_CHANGE_BYTES` can decode to under either
 * encoding, so this never refuses a payload the byte cap would have accepted.
 */
const MAX_INLINE_ENCODED_CHARS = 4 * 1024 * 1024;

/** How a `put`'s `content` string is to be read back into bytes. */
type InlineContentEncoding = "utf8" | "base64";

/**
 * Which of the two authorities a change set is exercising.
 *
 * Spelled out as a type rather than a boolean so a call site reads as what it
 * does — `mode: "publish"` at a route gated on `instructions:publish` — and so
 * a third mode, if one is ever needed, is an addition rather than a rewrite.
 */
export type InstructionChangeMode = "proposal" | "publish";

export type InlineInstructionChange =
	| {
			op: "put";
			path: string;
			content: string;
			encoding?: InlineContentEncoding;
	  }
	| { op: "delete"; path: string };

export type SubmitInstructionChangeInput = {
	/** The human the request acts as. Never a client-supplied field. */
	userId: string;
	projectId: string;
	/**
	 * The snapshot the change set is stated against. REQUIRED, and it is the
	 * stale-base protection in its entirety.
	 *
	 * It used to be optional, defaulting to whatever was published now — which
	 * quietly turned the check off for every caller that left it out. An agent
	 * that read v7, spent a minute composing an edit and sent it while a
	 * teammate published v8 would have its change rebased onto v8 without a
	 * word, silently reverting whatever v8 changed in the files it touched.
	 * There is no safe default: only the caller knows which version it read.
	 */
	baseSnapshotId: string;
	changes: readonly InlineInstructionChange[];
	/**
	 * What the change set is FOR: a proposal held for review, or a new
	 * published version.
	 *
	 * No default, so every caller states which authority it is exercising —
	 * the two have separate API-key scopes in front of them and the choice is
	 * never the server's to guess. `"publish"` is checked for exactly;
	 * anything else proposes (see the header).
	 */
	mode: InstructionChangeMode;
	/**
	 * Context for the audit row. A shape-compatible synthetic context is fine
	 * (`recordAuditFromRequest` documents that and swallows its own failures);
	 * the MCP gateway builds one from its session the way `announceStoryCreated`
	 * does, and the REST route passes the API key's resolved user.
	 */
	audit: AuditRequestContext;
	/** Which surface filed the change, for the audit row. */
	via: string;
};

export type SubmitInstructionChangeResult = {
	/**
	 * Which mode actually ran, as the server resolved it.
	 *
	 * Echoed rather than left implicit so a surface can describe the outcome
	 * without re-deriving it from what it asked for — and so a `"proposal"`
	 * here on a call that meant to publish is visible in the response rather
	 * than only in the absence of a review state.
	 */
	mode: InstructionChangeMode;
	snapshotId: string;
	version: number;
	baseSnapshotId: string;
	baseVersion: number;
	fileCount: number;
	inheritedCount: number;
	putCount: number;
	deleteCount: number;
	/** `PENDING` for a proposal; always null in publish mode. */
	proposalStatus: InstructionProposalStatus | null;
	/** The snapshot's status after its validation workflow was started. */
	status: string;
	/**
	 * True when this snapshot has been published AT LEAST ONCE by the time of
	 * this response. A publish normally lands AFTER the response returns — the
	 * workflow that promotes and publishes a snapshot keeps running past this
	 * call — so `false` means "not yet confirmed", never "refused" and never
	 * "will not happen": the same request can still go on to publish a moment
	 * later, and this field will not update to say so.
	 *
	 * Deliberately NOT a live "does this snapshot own the pointer right now"
	 * check: the pointer can move again after a genuine publish (a later
	 * edit's own fast-forward, or a deliberate History rollback), and calling
	 * that "was not published" would be false — it WAS. `current.publishedAt`
	 * is the durable record of that (`publishInstructionSnapshot`, the
	 * `@repo/database` query, sets it exactly once, on the write that moves
	 * the pointer to this snapshot, and nothing ever clears it), which is why
	 * it is the primary signal here; `publishedPointer?.id === current.id` is
	 * only the FRESHER one, for a publish that committed in the gap between
	 * this function's own two reads (see
	 * `getInstructionSnapshotWithPublishedPointer`'s doc comment — the two are
	 * not one database snapshot).
	 *
	 * Always `false` for a proposal, regardless of what either signal shows —
	 * nothing here ever asks the workflow to publish one, so a coincidental
	 * pointer match or a stray `publishedAt` is not this request's doing.
	 */
	published: boolean;
};

/**
 * Read the inline change set into bytes, hashing each `put` server-side.
 *
 * `size` and `sha256` are NEVER taken from the caller on this path. The tab's
 * `derive` accepts both because the browser then PUTs the bytes itself and the
 * gate re-hashes whatever landed; here the server holds the bytes, so a
 * caller-supplied hash could only ever be a way to make the registered row
 * disagree with the object.
 *
 * The bytes come back keyed by POSITION, not by path: the caller's spelling is
 * not the stored one (`validateRelativePath` normalises separators, `./`
 * prefixes and repeated slashes), and pairing them up by the raw string would
 * lose a file whenever the two differed. `validateInstructionChanges` preserves
 * input order, so the index is the reliable join.
 */
function decodeChanges(changes: readonly InlineInstructionChange[]): {
	raw: RawInstructionChange[];
	bytesByIndex: Map<number, Buffer>;
} {
	if (changes.length === 0) {
		throw new ORPCError("BAD_REQUEST", {
			message: "No changes were sent.",
		});
	}
	if (changes.length > MAX_CHANGES) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Too many changes (${changes.length} > ${MAX_CHANGES}). Upload the folder from the Coding Instructions tab instead.`,
		});
	}

	let encodedChars = 0;
	for (const change of changes) {
		if (change.op === "put") {
			encodedChars += change.content.length;
		}
	}
	if (encodedChars > MAX_INLINE_ENCODED_CHARS) {
		throw new ORPCError("BAD_REQUEST", {
			message: `The change set is too large to send inline (over ${MAX_INLINE_CHANGE_BYTES} bytes of file content). Upload the folder from the Coding Instructions tab instead.`,
		});
	}

	const raw: RawInstructionChange[] = [];
	const bytesByIndex = new Map<number, Buffer>();
	let totalBytes = 0;
	for (const [index, change] of changes.entries()) {
		if (change.op === "delete") {
			raw.push({ op: "delete", path: change.path });
			continue;
		}
		const encoding = change.encoding ?? "utf8";
		// `Buffer.from(_, "base64")` is permissive and silently drops
		// non-alphabet characters, so a round-trip comparison is what turns a
		// mangled payload into a refusal rather than a file whose bytes are
		// not the ones the caller meant.
		const bytes = Buffer.from(change.content, encoding);
		if (
			encoding === "base64" &&
			bytes.toString("base64").replace(/=+$/, "") !==
				change.content.replace(/[\s=]+/g, "")
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Content for ${change.path} is not valid base64.`,
			});
		}
		totalBytes += bytes.byteLength;
		if (totalBytes > MAX_INLINE_CHANGE_BYTES) {
			throw new ORPCError("BAD_REQUEST", {
				message: `The change set is too large to send inline (over ${MAX_INLINE_CHANGE_BYTES} bytes of file content). Upload the folder from the Coding Instructions tab instead.`,
			});
		}
		raw.push({
			op: "put",
			path: change.path,
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
		bytesByIndex.set(index, bytes);
	}
	return { raw, bytesByIndex };
}

export async function submitInstructionChange(
	input: SubmitInstructionChangeInput,
): Promise<SubmitInstructionChangeResult> {
	// Compared against the publish literal, never against the proposal one:
	// an absent or unrecognised mode has to land on the REVIEWED path, and a
	// truthiness test or a `!== "proposal"` would land it on the other one.
	const proposal = input.mode !== "publish";
	const mode: InstructionChangeMode = proposal ? "proposal" : "publish";

	// Live permission FIRST, before any tenant data is read: proposing needs
	// INSTRUCTION_READ, publishing needs INSTRUCTION_CREATE. This is the check
	// an API key never exceeds, and it runs for every key type including a
	// wildcard one — the scope at the route is a ceiling, and this is the
	// floor underneath it.
	await assertInstructionDeriveAccess({
		projectId: input.projectId,
		userId: input.userId,
		proposal,
	});
	const organizationId = await requireHostingOrganizationId(
		input.projectId,
		input.userId,
	);

	// Spec §6.12: one source of truth per project. A repository-backed
	// project's instructions are changed in git and refreshed by sync;
	// accepting an edit here would fork Fabric away from the repository with
	// no way to reconcile. Same refusal the tab gets.
	const settings = await getProjectInstructionSettings(
		input.projectId,
		organizationId,
	);
	if (settings.sourceOfTruth === "REPOSITORY") {
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"This project's coding instructions come from its repository. Change the files there and sync the project.",
			data: { reason: "REPOSITORY_SOURCE_OF_TRUTH" },
		});
	}

	// The base is ALWAYS the currently published snapshot: a proposal is a
	// fast-forward claim on the published pointer (§6.12), so any other base
	// would be refused a moment later by `derive`'s own rule. Resolving it
	// here rather than trusting `baseSnapshotId` is what makes that field
	// what it should be — the caller's STATEMENT about what it last read,
	// checked against reality below.
	const publishedPointer = await getPublishedInstructionSnapshot(
		input.projectId,
	);
	// `getPublishedInstructionSnapshot` is UNSCOPED (it follows the pointer on
	// the Project row), so the tenant-scoped read is what proves the row
	// belongs to the organization resolved above.
	const base = publishedPointer
		? await getInstructionSnapshot(
				publishedPointer.id,
				input.projectId,
				organizationId,
			)
		: null;
	if (!base) {
		throw new ORPCError("NOT_FOUND", {
			message:
				"This project has no published coding instructions to change yet. Upload a first version from the Coding Instructions tab.",
			data: { reason: "NOTHING_PUBLISHED" },
		});
	}
	if (input.baseSnapshotId !== base.id) {
		// The spec's `PULL_FIRST`, in the same shape the tab receives it. The
		// message is direction-neutral on purpose: a rollback makes "someone
		// published a newer version" a plain falsehood.
		throw new ORPCError("CONFLICT", {
			message:
				"The published version changed since your copy was taken. Sync the project's coding instructions and make the change again.",
			data: { reason: "BASE_NOT_PUBLISHED" },
		});
	}

	const { raw, bytesByIndex } = decodeChanges(input.changes);
	const { changes, putCount, deleteCount } = validateInstructionChanges({
		projectId: input.projectId,
		changes: raw,
		settingsFrozen: base.settingsFrozen,
	});
	// Re-keyed on the STORED spelling now that validation has normalised it,
	// which is what the file rows below carry.
	const contentByPath = new Map<string, Buffer>();
	for (const [index, bytes] of bytesByIndex) {
		const validated = changes[index];
		if (validated?.op === "put") {
			contentByPath.set(validated.path, bytes);
		}
	}

	const storage = getStorageProvider();

	/**
	 * The duplicate's own state, in the ordinary success shape. From the
	 * caller's side this IS its earlier attempt's answer, delivered late.
	 *
	 * `putCount` / `deleteCount` come from THIS request's validated change
	 * set, which is identical to the one that opened the proposal — that is
	 * what the digest the query matched on means.
	 */
	const duplicateResult = (
		existing: DuplicateInstructionProposal,
	): SubmitInstructionChangeResult => ({
		mode,
		snapshotId: existing.id,
		version: existing.version,
		baseSnapshotId: base.id,
		baseVersion: base.version,
		fileCount: existing.fileCount,
		inheritedCount: existing.inheritedCount,
		putCount,
		deleteCount,
		proposalStatus: existing.proposalStatus,
		status: existing.status,
		// The dedup match is scoped to `proposalStatus: "PENDING"`
		// (`createDerivedInstructionSnapshot`), so `duplicateResult` is only
		// ever reached for a proposal — a publish never sets that column and
		// so never matches it. Nothing here has asked the workflow to publish
		// this row.
		published: false,
	});

	const created = await createDerivedInstructionSnapshot({
		projectId: input.projectId,
		organizationId,
		userId: input.userId,
		baseSnapshotId: base.id,
		// A publish is a snapshot that publishes ITSELF when its validation
		// run passes, which is exactly what the tab's direct save does
		// (`derive-snapshot.ts` with `proposal: false`). Nothing here reaches
		// past the gate: the same verify → scan → publish workflow decides,
		// and a change set that fails it publishes nothing.
		publishOnReady: !proposal,
		proposal,
		changes,
		limits: {
			maxFiles: SNAPSHOT_LIMITS.maxFiles,
			maxTotalBytes: SNAPSHOT_LIMITS.maxTotalBytes,
		},
		baseKeyPrefix: snapshotPrefix(input.projectId, base.id),
	});

	if (!created.ok) {
		// Reported, never taken over: no upload, no finalize, no audit row. The
		// proposer is told what their proposal is actually doing, and the
		// surfaces turn that into advice that the dedup will not swallow.
		if (created.reason === "duplicate_proposal") {
			return duplicateResult(created.existing);
		}
		throw derivedSnapshotRefusal(created.reason, created.detail);
	}

	// Everything from here to the workflow start is COMPENSATED on failure.
	//
	// The snapshot row exists now, RECEIVING and — for a proposal — PENDING,
	// and a proposal in that state counts against both admission caps (five
	// per proposer, twenty-five per project). The tab's flow can leave such a
	// row behind harmlessly: the browser owns the next step, the person can
	// retry or cancel, and the six-hour reaper is the backstop for the ones
	// nobody comes back to. Inline submission has no next step and no person
	// at the keyboard — a storage outage in the loop below would leave an
	// agent's failed push holding one of five slots for six hours, and five
	// failed pushes would lock the proposer out of the feature entirely with
	// nothing to cancel in the tab.
	//
	// So a failure BEFORE the workflow start is closed out here, through the
	// same conditional write the reaper uses: REJECTED, carrying the
	// "staging pending" mark so the reaper's second phase still sweeps
	// whatever bytes did land. The compare-and-set on `status: "RECEIVING"`
	// is what makes it safe to do from here, and the row is always one THIS
	// request created: a duplicate returned above never reaches this section.
	// Flipped immediately before the finalizer is called. Everything up to
	// that line is this request's own work — an audit row, a staging claim, an
	// object write — and none of it can have handed the snapshot to a
	// workflow. `startWasNeverAttempted` covers the one failure INSIDE the
	// finalizer that is still on this side of the line; the flag covers
	// everything before it, without depending on any error's shape.
	let finalizerWasEntered = false;
	let finalized: Awaited<ReturnType<typeof finalizeInstructionSnapshot>>;
	try {
		// The audit row goes out BEFORE the bytes are written and the workflow
		// is started, exactly as `derive` records it before the browser
		// uploads anything: what is being recorded is that this caller started
		// an upload, and a later failure to store the bytes does not un-start
		// it.
		//
		// One row per snapshot CREATED, which is what this request has just
		// done: a duplicate returned above records nothing, because the
		// request that wrote that row already recorded it.
		recordAuditFromRequest(input.audit, {
			action: "project.instructions.upload_started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_snapshot",
				id: created.id,
				name: `v${created.version}`,
			},
			metadata: {
				// The TAB's vocabulary, not this file's. `derive-snapshot.ts`
				// records `"proposal"` or `"derived"` for the same two
				// outcomes, and an audit reader looking for direct versions
				// has to find the ones made from here as well; `via` is what
				// says which surface each one came through. The publish
				// itself is audited separately, as
				// `project.instructions.published`, by the workflow activity
				// that moves the pointer — the same row the tab produces,
				// because it IS the same activity.
				mode: proposal ? "proposal" : "derived",
				via: input.via,
				baseSnapshotId: base.id,
				baseVersion: base.version,
				putCount,
				deleteCount,
				inheritedCount: created.inheritedCount,
				keptCount: created.fileCount,
			},
		});

		// The same rewrite `createUploadUrls` performs before it signs: the row's
		// provisional `stagingKey(projectId, "pending", <index>)` becomes the real
		// `(projectId, snapshotId, fileId)` key, under a compare-and-set that also
		// checks the parent is still RECEIVING. Doing it the same way is what keeps
		// the bytes where the verify activity looks for them.
		const staged = new Set(created.staged.map((f) => f.id));
		const rows = (
			await listInstructionFiles(created.id, organizationId)
		).filter((f) => staged.has(f.id));
		for (const row of rows) {
			const bytes = contentByPath.get(row.path);
			if (!bytes) {
				// Unreachable: every staged row came from a `put` in this
				// request.
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `No content was staged for ${row.path}`,
				});
			}
			const key = stagingKey(input.projectId, created.id, row.id);
			if (row.storageKey !== key) {
				// A key outside staging is an IMMUTABLE snapshot key that promotion
				// wrote, and nothing may point such a row back at writable storage.
				// Not reachable for a row this call just created; checked because
				// the invariant is what makes the write below safe.
				if (!isStagingKey(row.storageKey)) {
					throw new ORPCError("CONFLICT", {
						message: "Upload not found or no longer receiving",
					});
				}
				const { moved } = await claimInstructionFileStagingKey({
					fileId: row.id,
					snapshotId: created.id,
					projectId: input.projectId,
					organizationId,
					from: row.storageKey,
					to: key,
				});
				if (!moved) {
					throw new ORPCError("CONFLICT", {
						message: "Upload not found or no longer receiving",
					});
				}
			}
			await storage.uploadFile(key, bytes, {
				bucket: SKILLS_BUCKET,
				contentType: row.mimeType,
			});
		}
		finalizerWasEntered = true;
		// The finalizer is INSIDE the compensated section, and the boundary
		// is drawn inside it rather than around it.
		//
		// `finalizeInstructionSnapshot` reaches Temporal before it starts
		// anything, and reaching Temporal is the failure most likely to
		// happen at all — a misconfigured deployment, an unreachable
		// cluster. Nothing owns the row when that fails, so closing it out is
		// safe; leaving the finalizer wholly outside the section would strand
		// the row on exactly the common case.
		//
		// Once `workflow.start` has been CALLED, the outcome is ambiguous by
		// construction: a start can succeed and its acknowledgement be lost,
		// which is why the finalizer tolerates
		// `WorkflowExecutionAlreadyStartedError` at all. Rejecting the row
		// then would race a validation run that is already reading it, so
		// that half is left to the reaper's stale-VALIDATING sweep, which
		// asks Temporal about the workflow before deciding — the question
		// this code cannot answer.
		//
		// The finalizer says which side it failed on by throwing
		// `InstructionWorkflowNotStartedError`, and `startWasNeverAttempted`
		// below is what reads it.
		finalized = await finalizeInstructionSnapshot({
			snapshot: { id: created.id, status: "RECEIVING" },
			projectId: input.projectId,
			organizationId,
			userId: input.userId,
		});
	} catch (error) {
		// Compensate unless the workflow start was actually reached: either
		// this failed before the finalizer was entered at all, or the
		// finalizer says it never got as far as calling `workflow.start`.
		//
		// Always a row THIS request created — a duplicate returned above
		// never reaches here — so the RECEIVING compare-and-set inside it is
		// the only fence it needs.
		if (!finalizerWasEntered || isInstructionWorkflowNotStarted(error)) {
			await releaseUnstartedSnapshot({
				snapshotId: created.id,
				projectId: input.projectId,
				organizationId,
			});
		}
		// The marker is transport for that verdict, not the failure itself:
		// the caller sees the error that actually happened.
		throw unwrapInstructionWorkflowError(error);
	}

	// What the ROW says, not what this request assumed when it wrote it.
	//
	// `finalizeInstructionSnapshot` already re-reads the status for its own
	// answer, because a small change set can reach a terminal verdict before
	// the finalizer's conditional write lands. `proposalStatus` moves with
	// that verdict — the gate's rejection closes the proposal's review state
	// in the same transaction — so pairing the finalizer's real status with a
	// hard-coded PENDING produced a result saying "rejected, but awaiting
	// review", which the surfaces turned into "cancel it in the tab" for a
	// row nobody can cancel and that a new push would sail straight past.
	//
	// The snapshot's status and the project's published pointer, read via
	// `getInstructionSnapshotWithPublishedPointer` — a round-trip saving over
	// two separate calls, NOT a single consistent instant; see that
	// function's own doc comment for why no caller here may treat it as one.
	//
	// The response returns while the workflow this request started is still
	// running: `finalizeInstructionSnapshot` (the promotion activity) writes
	// `status: READY`, and `publishInstructionSnapshotActivity` — a LATER,
	// separate activity — moves the pointer afterward, normally after this
	// function has already returned. So "classify this response as pending or
	// superseded" is not a question this read can answer correctly no matter
	// how it is taken: the true outcome has usually not happened yet. What
	// `published` reports instead is the observed fact as of THIS moment —
	// see its own doc comment on `SubmitInstructionChangeResult` — not a
	// verdict on what will eventually be true.
	const { snapshot: current, publishedPointer: publishedNow } =
		await getInstructionSnapshotWithPublishedPointer(
			created.id,
			input.projectId,
			organizationId,
		);
	// `current.publishedAt` is the durable signal: `publishInstructionSnapshot`
	// (`@repo/database`) sets it, once, on the exact write that moves the
	// pointer to this snapshot, and nothing in the lifecycle ever clears it —
	// so a non-null value means this snapshot WAS published, and stays true
	// even if a later edit's fast-forward or a deliberate History rollback
	// moves the pointer on again. `publishedNow?.id === current.id` is checked
	// too, only because it is the FRESHER of the two reads above: a publish
	// that committed in the gap between them can move the pointer before
	// `publishedAt` was read, and would otherwise be missed for one response.
	// Gated on `!proposal` as a CONTRACT: this field answers "did the publish
	// THIS REQUEST asked for land", and a proposal never asks the workflow to
	// publish at all (`publishOnReady: false` above) — a coincidental pointer
	// match or a stray `publishedAt` on a proposal row is not this request's
	// doing, whatever either signal happens to show.
	const published = Boolean(
		!proposal &&
			current &&
			(current.publishedAt != null || publishedNow?.id === current.id),
	);
	return {
		mode,
		snapshotId: created.id,
		version: created.version,
		baseSnapshotId: base.id,
		baseVersion: base.version,
		fileCount: created.fileCount,
		inheritedCount: created.inheritedCount,
		putCount,
		deleteCount,
		// A row that vanished between the finalizer and here — a retention
		// prune, a project delete — has no review state left to report.
		proposalStatus: current?.proposalStatus ?? null,
		status: current?.status ?? finalized.status,
		published,
	};
}
/**
 * Close out a snapshot row that no workflow ever took ownership of, through
 * the same conditional write the reaper uses: REJECTED, carrying the
 * "staging pending" mark so the reaper's sweep phase still removes whatever
 * bytes did land.
 *
 * What this buys is TIME, not an instant free slot. The row stays inside
 * `activeProposalFilter` until that sweep clears the marker, which is the
 * existing invariant and the thing that keeps a half-swept prefix
 * discoverable. Without this, the row would sit RECEIVING for the six-hour
 * abandonment window before the reaper would even consider it.
 *
 * Best effort, and deliberately unable to mask the real failure: the caller
 * must see WHY the push failed, not a secondary error from the cleanup. A
 * compensation that itself fails leaves exactly the row the reaper already
 * exists to close out.
 */
async function releaseUnstartedSnapshot(input: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<void> {
	try {
		await rejectAbandonedInstructionSnapshot({
			...input,
			source: "inline_submit_compensation",
		});
	} catch (error) {
		console.error(
			"[instructions] failed to close out an unstarted snapshot after an inline submit error",
			error,
		);
	}
}
