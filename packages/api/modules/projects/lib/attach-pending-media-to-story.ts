/**
 * Apply-time orchestrator for attaching chat-thread images to backlog stories.
 *
 * Runs in the oRPC request handler (Slack/Teams `approve-pending-proposal.ts`),
 * NOT inside a Temporal workflow. `fetch`, `crypto.randomUUID`, `Date.now`,
 * and `uploadFile` are all confined here. Per spec § 6.4 the existing
 * `temporal-replay-validation.yml` is sufficient — no additional replay
 * test is required for this feature. See `fabric/standards/backend/temporal.md`
 * § Determinism.
 *
 * Pipeline (spec § 4.6, FR-11..FR-18, FR-21..FR-23):
 *
 *   1. Parse `proposal.sourceMetadata.attachments` (typed
 *      `PendingAttachmentRef[]`). Empty / undefined → short-circuit return,
 *      no DB / network / R2 IO (FR-23 / AC15).
 *   2. Apply caps in fixed order (FR-12):
 *        a. Count cap        — slice to `MAX_IMAGES_PER_THREAD`.
 *        b. Slack pre-check  — when `file.size > MAX_BYTES_PER_IMAGE`, skip
 *                              without downloading.
 *        c. Download         — with shared `AbortController`, concurrency
 *                              `DOWNLOAD_CONCURRENCY`, hard byte cap
 *                              `MAX_BYTES_PER_IMAGE` per request.
 *        d. Post-download    — defense-in-depth size + MIME check.
 *        e. Running total    — `MAX_TOTAL_BYTES_PER_THREAD`.
 *   3. Upload each surviving buffer to R2 under
 *      `story-media/{projectId}/{storyId}/{randomUuid}.{ext}` via `uploadFile`.
 *   4. Patch `story.description` via `appendAttachmentsSection`; append a
 *      warning line per source inside the same `## Attachments` block when
 *      warnings exist.
 *   5. Persist the new description via `updateStory(storyId, projectId, …)`
 *      directly (NOT via the oRPC `updateStoryProcedure`).
 *
 * Tenant isolation:
 *   - The orchestrator does not re-validate `(organizationId, userId)` itself.
 *     The caller (the approve procedure in Group 5) is responsible for
 *     resolving the correct `projectId` from a `tenantProtectedProcedure`.
 *   - All R2 keys carry `{projectId}/{storyId}/` so the keyspace inherits the
 *     tenant gate from the parent project.
 *   - `updateStory` filters by `where: { id, projectId }` so an attacker who
 *     spoofs a foreign `storyId` resolves to null and the write fails — the
 *     orchestrator catches that failure and emits a warning rather than
 *     throwing out.
 *
 * Security:
 *   - The bot / Graph access token is never logged. The orchestrator extracts
 *     only the named structured-log fields (`refId`, `mime`, `size`,
 *     `durationMs`, `proposalId`, `projectId`, `storyId`, `channelId`,
 *     `threadTs`/`messageId`).
 *   - Signed URLs (Slack `url_private`, Graph `hostedContents/{id}/$value`)
 *     are never logged — the underlying download helpers enforce this; the
 *     orchestrator only logs `refId`.
 *   - The raw `sourceMetadata` JSON is never logged — only the typed fields
 *     extracted from it are.
 *
 * Observability:
 *   - Structured-log span name: `chat-thread-attachments`.
 *   - Steps: `download`, `upload`, `patch_description`. (`persist_warnings`
 *     fires from the caller in Group 5 after `setPendingProposalAttachmentResult`.)
 *   - Outcomes: `success | skipped | failed`.
 *   - Failures at WARN; the circuit-breaker-open path is signalled by the
 *     underlying `withProviderBreaker("aws_s3", …)` in `uploadFile` and
 *     surfaces here as an upload exception we map to `upload_failed`.
 */

import { randomUUID } from "node:crypto";
import { config } from "@repo/config";
import { updateStory } from "@repo/database";
import {
	APPROVAL_BUDGET_MS,
	type AttachmentWarning,
	DOWNLOAD_CONCURRENCY,
	DOWNLOAD_TIMEOUT_MS,
	MAX_BYTES_PER_IMAGE,
	MAX_IMAGES_PER_THREAD,
	MAX_TOTAL_BYTES_PER_THREAD,
	type PendingAttachmentRef,
	type SlackThreadFile,
	SUPPORTED_ATTACHMENT_MIMES,
	type SupportedAttachmentMime,
	type TeamsHostedContentRef,
	type UploadedAttachment,
} from "@repo/integrations";
import {
	downloadTeamsHostedContent,
	DownloadFailedError as TeamsDownloadFailedError,
} from "@repo/integrations/microsoft";
import {
	AuthFailedError,
	downloadSlackFile,
	ExternalWorkspaceError,
	ScopeMissingError,
	DownloadFailedError as SlackDownloadFailedError,
} from "@repo/integrations/slack";
import { logger as defaultLogger } from "@repo/logs";
import { uploadFile } from "@repo/storage";
import {
	ATTACHMENTS_HEADING,
	appendAttachmentsSection,
	hasAttachmentsHeading,
} from "./append-attachments-section";

// =============================================================================
// Public types
// =============================================================================

/**
 * Minimal logger surface we depend on. Lifting this into an interface keeps
 * the orchestrator testable (the test passes a mock that captures every call)
 * AND signals that we never call `logger.fatal` or `logger.trace` here — only
 * the four levels listed below.
 */
export interface OrchestratorLogger {
	debug(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

export interface AttachPendingMediaInput {
	/** Proposal row to read `sourceMetadata.attachments` from. */
	proposal: {
		id: string;
		/**
		 * `Prisma.JsonValue` — read defensively. We expect a
		 * `{ attachments?: PendingAttachmentRef[]; … }` shape but never trust
		 * it; downstream defensively narrows.
		 */
		sourceMetadata: unknown;
	};
	/** Target story to patch the description on. */
	story: {
		id: string;
		description: string | null;
	};
	/** Per-source dispatch token. */
	source: "slack" | "teams";
	/**
	 * Bot / Graph access token. Caller resolves it from the integration's
	 * credentials. Never logged.
	 */
	accessToken: string;
	/** For tenant scoping. Used in R2 key and the `updateStory` call. */
	projectId: string;
	/** Org context (tenant). May be null in personal mode. Stamped on the version row. */
	organizationId: string | null;
	/** The approving user. Stamped on the version row as `changedBy`. */
	userId: string;
	/** Snapshotted reviewer name for semantic last-edit attribution. */
	userName?: string | null;
	/** Optional caller-supplied logger. Defaults to the package logger. */
	logger?: OrchestratorLogger;
	/** Optional override for the global budget; defaults to `APPROVAL_BUDGET_MS`. */
	budgetMs?: number;
	/**
	 * Optional override for the Teams Graph message URL builder. When the
	 * orchestrator processes a Teams ref it needs the parent message URL to
	 * construct the hostedContents download URL. The caller (channel monitor
	 * approve procedure) knows whether the message lives under
	 * `/teams/{teamId}/channels/{channelId}/messages/{messageId}` or
	 * `/chats/{chatId}/messages/{messageId}` and supplies the builder.
	 *
	 * When omitted, the orchestrator falls back to the channel-monitor URL
	 * shape with the channel/team ids pulled from `sourceMetadata`.
	 */
	teamsMessageUrlBuilder?: (ref: TeamsHostedContentRef) => string;
}

export interface AttachPendingMediaResult {
	uploaded: UploadedAttachment[];
	warnings: AttachmentWarning[];
}

// =============================================================================
// Internal helpers
// =============================================================================

interface ExtractedMetadata {
	attachments: PendingAttachmentRef[];
	channelId?: string;
	threadTs?: string;
	messageId?: string;
	teamId?: string;
	channelOrChatPrefix?: string;
}

/**
 * Defensively narrow `proposal.sourceMetadata` to the shape we need. The
 * `sourceMetadata` column is `Json?` in Prisma — runtime callers may have
 * written anything. We accept only the fields we recognize and ignore the
 * rest, returning safe empty defaults when missing.
 */
function extractFromSourceMetadata(sourceMetadata: unknown): ExtractedMetadata {
	if (!sourceMetadata || typeof sourceMetadata !== "object") {
		return { attachments: [] };
	}
	const meta = sourceMetadata as Record<string, unknown>;
	const rawAttachments = meta.attachments;
	const attachments = Array.isArray(rawAttachments)
		? (rawAttachments as PendingAttachmentRef[])
		: [];

	const stringOrUndefined = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;

	return {
		attachments,
		channelId: stringOrUndefined(meta.channelId),
		threadTs: stringOrUndefined(meta.threadTs),
		messageId: stringOrUndefined(meta.messageId),
		teamId: stringOrUndefined(meta.teamId ?? meta.slackTeamId),
		channelOrChatPrefix: stringOrUndefined(meta.channelOrChatPrefix),
	};
}

/** Stable per-ref identifier for warnings + log lines. */
function refIdOf(ref: PendingAttachmentRef): string {
	return ref.source === "slack" ? ref.file.id : ref.ref.id;
}

/** Best-effort filename derivation for the markdown alt text. */
function altTextForSlack(file: SlackThreadFile, fallbackIndex: number): string {
	if (file.title && file.title.trim().length > 0) {
		return file.title;
	}
	if (file.name && file.name.trim().length > 0) {
		return file.name;
	}
	const ext = extensionForMime(file.mimetype) ?? "bin";
	return `image-${fallbackIndex + 1}.${ext}`;
}

/** Best-effort filename derivation for Teams hosted-content alt text. */
function altTextForTeams(
	ref: TeamsHostedContentRef,
	contentDisposition: string | undefined,
	mime: string,
	fallbackIndex: number,
): string {
	const fromDisposition =
		parseFilenameFromContentDisposition(contentDisposition);
	if (fromDisposition) {
		return fromDisposition;
	}
	if (ref.altText && ref.altText.trim().length > 0) {
		return ref.altText;
	}
	if (ref.fileName && ref.fileName.trim().length > 0) {
		return ref.fileName;
	}
	const ext = extensionForMime(mime) ?? "bin";
	return `image-${fallbackIndex + 1}.${ext}`;
}

/**
 * Parse `filename="…"` (RFC 6266) from a `Content-Disposition` header. We
 * support the simple quoted form; unquoted and `filename*=UTF-8''…` are
 * tolerated by returning undefined and letting the caller fall back.
 */
function parseFilenameFromContentDisposition(
	value: string | undefined,
): string | undefined {
	if (!value) {
		return undefined;
	}
	const m = value.match(/filename\s*=\s*"([^"]+)"/i);
	if (m?.[1]) {
		return m[1];
	}
	const unq = value.match(/filename\s*=\s*([^;\s]+)/i);
	if (unq?.[1]) {
		return unq[1];
	}
	return undefined;
}

/** Map MIME to file extension for R2 keys + filename fallbacks. */
function extensionForMime(mime: string): string | undefined {
	const lower = mime.toLowerCase();
	if (lower.startsWith("image/png")) {
		return "png";
	}
	if (lower.startsWith("image/jpeg")) {
		return "jpg";
	}
	if (lower.startsWith("image/gif")) {
		return "gif";
	}
	if (lower.startsWith("image/webp")) {
		return "webp";
	}
	return undefined;
}

/** Defense-in-depth MIME check at post-download time. */
function isSupportedMime(mime: string): mime is SupportedAttachmentMime {
	const baseMime = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	return (SUPPORTED_ATTACHMENT_MIMES as readonly string[]).includes(baseMime);
}

/**
 * Build a warning entry. The detail field is restricted to MIME strings,
 * byte counts, and error class names — never URLs, tokens, or PII.
 */
function warning(
	source: "slack" | "teams",
	refId: string,
	reason: AttachmentWarning["reason"],
	detail?: string,
): AttachmentWarning {
	return detail !== undefined
		? { source, refId, reason, detail }
		: { source, refId, reason };
}

/**
 * Format the warning lines that go INSIDE the `## Attachments` block.
 * One line per source (decisions § 10). In v1 a single proposal is
 * single-source so we typically emit one line; the multi-source branch is
 * defensive.
 */
function formatAttachmentWarningLines(
	warnings: readonly AttachmentWarning[],
): string[] {
	const bySource = new Map<"slack" | "teams", number>();
	for (const w of warnings) {
		bySource.set(w.source, (bySource.get(w.source) ?? 0) + 1);
	}
	const lines: string[] = [];
	const order: ("slack" | "teams")[] = ["slack", "teams"];
	for (const source of order) {
		const count = bySource.get(source);
		if (count && count > 0) {
			const label = source === "slack" ? "Slack" : "Teams";
			const noun = count === 1 ? "image" : "images";
			lines.push(
				`_⚠ ${count} ${noun} couldn't be attached from ${label} — open the thread to view._`,
			);
		}
	}
	return lines;
}

/**
 * Append warning lines into an existing or newly-created `## Attachments`
 * block. The `appendAttachmentsSection` helper covers the upload-line
 * insertion; this fills the warning-line slot inside the same block.
 *
 * Idempotent: every line we emit is matched against `description.includes`
 * so a rerun doesn't double-stamp the same warning.
 *
 * The "does the block already exist" test is `hasAttachmentsHeading` from
 * `append-attachments-section` — this used to be a third, independently
 * inlined `description.includes("## Attachments")`, which meant a decorated
 * heading made THIS function create a second block right after
 * `appendAttachmentsSection` had merged into the first.
 */
function appendWarningLinesToAttachmentsBlock(
	description: string,
	warningLines: readonly string[],
): string {
	if (warningLines.length === 0) {
		return description;
	}
	// De-dupe against existing identical warning lines (idempotency).
	const fresh = warningLines.filter((line) => !description.includes(line));
	if (fresh.length === 0) {
		return description;
	}

	const joined = fresh.join("\n");
	if (hasAttachmentsHeading(description)) {
		const trailing = description.endsWith("\n") ? "" : "\n";
		return `${description}${trailing}${joined}\n`;
	}
	const separator =
		description.length === 0
			? ""
			: description.endsWith("\n")
				? "\n"
				: "\n\n";
	return `${description}${separator}${ATTACHMENTS_HEADING}\n\n${joined}\n`;
}

/**
 * Bounded concurrency runner. Schedules items in `inputs` through a queue with
 * at most `concurrency` in-flight at any time. The callback receives the input
 * AND its original index so the caller can map results back to refs.
 *
 * Aborts cleanly when `signal` fires — already-running tasks finish, but no
 * new tasks are started; their `signal.aborted` is observed by the caller.
 */
async function runWithConcurrency<TIn, TOut>(
	inputs: readonly TIn[],
	concurrency: number,
	signal: AbortSignal,
	run: (input: TIn, index: number) => Promise<TOut>,
): Promise<
	Array<{ index: number; result: TOut } | { index: number; error: unknown }>
> {
	const results: Array<
		{ index: number; result: TOut } | { index: number; error: unknown }
	> = new Array(inputs.length);
	let next = 0;

	async function worker(): Promise<void> {
		while (true) {
			const i = next++;
			if (i >= inputs.length) {
				return;
			}
			if (signal.aborted) {
				results[i] = { index: i, error: new BudgetExceededError() };
				continue;
			}
			try {
				const out = await run(inputs[i] as TIn, i);
				results[i] = { index: i, result: out };
			} catch (err) {
				results[i] = { index: i, error: err };
			}
		}
	}

	const workerCount = Math.min(concurrency, inputs.length);
	const workers: Promise<void>[] = [];
	for (let w = 0; w < workerCount; w++) {
		workers.push(worker());
	}
	await Promise.all(workers);
	return results;
}

/**
 * Distinct sentinel for budget-exceeded so the warning mapper can distinguish
 * a generic download failure from the budget-timeout case.
 */
class BudgetExceededError extends Error {
	constructor() {
		super("approval_budget_exceeded");
		this.name = "BudgetExceededError";
	}
}

// =============================================================================
// The orchestrator
// =============================================================================

const SPAN = "chat-thread-attachments";

/**
 * Apply-time orchestrator. See file header for the full contract.
 *
 * Returns `{ uploaded, warnings }`. NEVER throws — every internal error path
 * is caught and converted to an `AttachmentWarning`. The caller (approve
 * procedure) is free to `await` without try/catch, though a defense-in-depth
 * try/catch at the call site is still recommended.
 */
export async function attachPendingMediaToStory(
	input: AttachPendingMediaInput,
): Promise<AttachPendingMediaResult> {
	const logger: OrchestratorLogger = input.logger ?? defaultLogger;
	const budgetMs = input.budgetMs ?? APPROVAL_BUDGET_MS;

	// Top-level guard: every uncaught throw inside the orchestrator gets
	// converted into a warning so the approval handler can never crash on
	// an attachment error (FR-23).
	try {
		const meta = extractFromSourceMetadata(input.proposal.sourceMetadata);
		const refs = meta.attachments;

		// Empty-input short-circuit (FR-23 / AC15).
		if (refs.length === 0) {
			logger.debug(
				"[chat-thread-attachments] empty input, short-circuit",
				{
					span: SPAN,
					step: "download",
					outcome: "skipped",
					proposalId: input.proposal.id,
					projectId: input.projectId,
					storyId: input.story.id,
				},
			);
			return { uploaded: [], warnings: [] };
		}

		const warnings: AttachmentWarning[] = [];

		// Cap (a): COUNT — slice & emit `count_cap_exceeded` for overflow.
		const accepted = refs.slice(0, MAX_IMAGES_PER_THREAD);
		const overflow = refs.slice(MAX_IMAGES_PER_THREAD);
		for (const ref of overflow) {
			warnings.push(
				warning(ref.source, refIdOf(ref), "count_cap_exceeded"),
			);
		}

		// Cap (b): SLACK PRE-CHECK — if `file.size` exceeds the per-image cap,
		// drop without downloading. Teams refs do not carry a reliable size
		// pre-flight so they advance to the download stage.
		const passedPreCheck: Array<{
			ref: PendingAttachmentRef;
			index: number;
		}> = [];
		for (let i = 0; i < accepted.length; i++) {
			const ref = accepted[i] as PendingAttachmentRef;
			if (ref.source === "slack" && ref.file.size > MAX_BYTES_PER_IMAGE) {
				warnings.push(
					warning(
						"slack",
						ref.file.id,
						"image_too_large",
						`${ref.file.size}`,
					),
				);
				continue;
			}
			passedPreCheck.push({ ref, index: i });
		}

		// Cap (e) precursor: prepare the running-total tracker. The
		// post-download branch consults this; subsequent refs are skipped with
		// `thread_total_exceeded` once the total exceeds the limit.
		let runningBytes = 0;
		let totalCapHit = false;

		// Single shared AbortController wired to the global budget (FR-13, FR-14).
		const budgetController = new AbortController();
		const budgetTimer = setTimeout(() => {
			budgetController.abort();
		}, budgetMs);

		const uploaded: UploadedAttachment[] = [];

		try {
			// Cap (c): DOWNLOAD — bounded concurrency. We dispatch each ref to
			// its source-specific helper, with a per-request abort signal
			// derived from the shared budget signal.
			const downloads = await runWithConcurrency(
				passedPreCheck,
				DOWNLOAD_CONCURRENCY,
				budgetController.signal,
				async (item, _i) => {
					const downloadStart = Date.now();
					const { ref } = item;
					const refId = refIdOf(ref);
					// Per-request timeout controller chained to the global
					// budget signal: aborts at min(DOWNLOAD_TIMEOUT_MS, budget
					// remaining). When the budget aborts, this signal aborts
					// too (the budget signal listener triggers).
					const perRequestController = new AbortController();
					const onBudgetAbort = () => perRequestController.abort();
					budgetController.signal.addEventListener(
						"abort",
						onBudgetAbort,
						{ once: true },
					);
					if (budgetController.signal.aborted) {
						perRequestController.abort();
					}
					const perRequestTimer = setTimeout(() => {
						perRequestController.abort();
					}, DOWNLOAD_TIMEOUT_MS);
					try {
						if (ref.source === "slack") {
							const result = await downloadSlackFile(
								ref.file.urlPrivate,
								input.accessToken,
								{
									signal: perRequestController.signal,
									maxBytes: MAX_BYTES_PER_IMAGE,
								},
							);
							logger.info("[chat-thread-attachments] download", {
								span: SPAN,
								step: "download",
								source: ref.source,
								outcome: "success",
								refId,
								mime: result.mime,
								size: result.size,
								durationMs: Date.now() - downloadStart,
								proposalId: input.proposal.id,
								projectId: input.projectId,
								storyId: input.story.id,
								...(meta.channelId !== undefined
									? { channelId: meta.channelId }
									: {}),
								...(meta.threadTs !== undefined
									? { threadTs: meta.threadTs }
									: {}),
							});
							return {
								ref,
								mime: result.mime,
								size: result.size,
								buffer: result.buffer,
								contentDisposition: undefined as
									| string
									| undefined,
							};
						}
						// Teams
						const teamsRef = ref.ref;
						const messageUrl = resolveTeamsMessageUrl({
							ref: teamsRef,
							meta,
							builder: input.teamsMessageUrlBuilder,
						});
						const result = await downloadTeamsHostedContent(
							teamsRef,
							input.accessToken,
							{
								signal: perRequestController.signal,
								maxBytes: MAX_BYTES_PER_IMAGE,
								messageUrl,
							},
						);
						logger.info("[chat-thread-attachments] download", {
							span: SPAN,
							step: "download",
							source: ref.source,
							outcome: "success",
							refId,
							mime: result.mime,
							size: result.size,
							durationMs: Date.now() - downloadStart,
							proposalId: input.proposal.id,
							projectId: input.projectId,
							storyId: input.story.id,
							...(meta.messageId !== undefined
								? { messageId: meta.messageId }
								: {}),
						});
						return {
							ref,
							mime: result.mime,
							size: result.size,
							buffer: result.buffer,
							contentDisposition: result.contentDisposition,
						};
					} catch (err) {
						logger.warn("[chat-thread-attachments] download", {
							span: SPAN,
							step: "download",
							source: ref.source,
							outcome: "failed",
							refId,
							durationMs: Date.now() - downloadStart,
							proposalId: input.proposal.id,
							projectId: input.projectId,
							storyId: input.story.id,
							errorName:
								err instanceof Error ? err.name : "unknown",
						});
						throw err;
					} finally {
						clearTimeout(perRequestTimer);
						budgetController.signal.removeEventListener(
							"abort",
							onBudgetAbort,
						);
					}
				},
			);

			// Post-process the download outcomes (FR-12 d & e): the upload step
			// runs only on successful, in-budget downloads that satisfy the
			// post-download size + MIME + running-total checks.
			for (const outcome of downloads) {
				if ("error" in outcome) {
					const ref = passedPreCheck[outcome.index]?.ref;
					if (!ref) {
						continue;
					}
					const refId = refIdOf(ref);
					warnings.push(
						mapDownloadErrorToWarning(
							ref.source,
							refId,
							outcome.error,
						),
					);
					continue;
				}

				const { ref, mime, size, buffer, contentDisposition } =
					outcome.result;
				const refId = refIdOf(ref);

				// Cap (d) defense-in-depth: even though the download helper
				// enforces the per-image byte cap, re-check on the buffer in
				// case the helper changes shape later.
				if (size > MAX_BYTES_PER_IMAGE) {
					warnings.push(
						warning(
							ref.source,
							refId,
							"image_too_large",
							`${size}`,
						),
					);
					continue;
				}

				// MIME post-check (FR-12 e' — defensive). Fetch-time filter
				// already enforced this; this is the AC4 / case 7 branch.
				if (!isSupportedMime(mime)) {
					warnings.push(
						warning(
							ref.source,
							refId,
							"unsupported_mime",
							mime.split(";")[0],
						),
					);
					continue;
				}

				// Cap (e): RUNNING TOTAL — once the next image would exceed
				// the total cap, skip it and every subsequent one.
				if (
					totalCapHit ||
					runningBytes + size > MAX_TOTAL_BYTES_PER_THREAD
				) {
					totalCapHit = true;
					warnings.push(
						warning(
							ref.source,
							refId,
							"thread_total_exceeded",
							`${size}`,
						),
					);
					continue;
				}

				// Upload to R2 (FR-16).
				const ext = extensionForMime(mime) ?? "bin";
				const s3Key = `story-media/${input.projectId}/${input.story.id}/${randomUUID()}.${ext}`;
				const uploadStart = Date.now();
				try {
					await uploadFile(s3Key, buffer, {
						bucket: config.storage.bucketNames.projectContexts,
						contentType: mime,
					});
					logger.info("[chat-thread-attachments] upload", {
						span: SPAN,
						step: "upload",
						source: ref.source,
						outcome: "success",
						refId,
						mime,
						size,
						durationMs: Date.now() - uploadStart,
						proposalId: input.proposal.id,
						projectId: input.projectId,
						storyId: input.story.id,
					});
				} catch (err) {
					logger.warn("[chat-thread-attachments] upload", {
						span: SPAN,
						step: "upload",
						source: ref.source,
						outcome: "failed",
						refId,
						mime,
						size,
						durationMs: Date.now() - uploadStart,
						proposalId: input.proposal.id,
						projectId: input.projectId,
						storyId: input.story.id,
						errorName: err instanceof Error ? err.name : "unknown",
					});
					warnings.push(
						warning(
							ref.source,
							refId,
							"upload_failed",
							err instanceof Error ? err.name : "unknown",
						),
					);
					continue;
				}

				runningBytes += size;

				// Build the alt-text + UploadedAttachment shape (decisions § 11).
				const name =
					ref.source === "slack"
						? altTextForSlack(ref.file, uploaded.length)
						: altTextForTeams(
								ref.ref,
								contentDisposition,
								mime,
								uploaded.length,
							);
				uploaded.push({ s3Key, name, mimeType: mime });
			}
		} finally {
			// Always tear down the budget timer to avoid keeping the process
			// alive after the orchestrator returns (FR-13).
			clearTimeout(budgetTimer);
		}

		// FR-17: patch description if anything to write.
		if (uploaded.length === 0 && warnings.length === 0) {
			// Nothing happened. Don't touch the story.
			return { uploaded, warnings };
		}

		const baseDescription = input.story.description ?? "";
		const afterUploads = appendAttachmentsSection(
			baseDescription,
			uploaded.map(({ s3Key, name }) => ({ s3Key, name })),
		);
		const warningLines = formatAttachmentWarningLines(warnings);
		const finalDescription = appendWarningLinesToAttachmentsBlock(
			afterUploads,
			warningLines,
		);

		const descriptionChanged = finalDescription !== baseDescription;
		if (descriptionChanged) {
			const patchStart = Date.now();
			try {
				await updateStory(
					input.story.id,
					input.projectId,
					{ description: finalDescription },
					{
						userId: input.userId,
						organizationId: input.organizationId ?? undefined,
						changedBy: input.userId,
						changeDescription: "Attach chat-thread images",
						lastEditedByName: input.userName ?? null,
						lastEditedSource: "AI_BACKLOG_UPDATE",
					},
				);
				logger.info("[chat-thread-attachments] patch_description", {
					span: SPAN,
					step: "patch_description",
					outcome: "success",
					uploadedCount: uploaded.length,
					warningCount: warnings.length,
					durationMs: Date.now() - patchStart,
					proposalId: input.proposal.id,
					projectId: input.projectId,
					storyId: input.story.id,
				});
			} catch (err) {
				logger.warn("[chat-thread-attachments] patch_description", {
					span: SPAN,
					step: "patch_description",
					outcome: "failed",
					durationMs: Date.now() - patchStart,
					proposalId: input.proposal.id,
					projectId: input.projectId,
					storyId: input.story.id,
					errorName: err instanceof Error ? err.name : "unknown",
				});
				// Defense in depth: a story-not-found / version-conflict here
				// should not propagate. The R2 uploads already succeeded —
				// this is a DB-patch failure, not an upload failure. Record
				// as `patch_failed` so the inbox tooltip points at the right
				// subsystem (decisions log: bug_008). FR-23: approval still
				// succeeds; the warning surfaces via the `⚠ M` chip.
				warnings.push({
					source: input.source,
					refId: input.story.id,
					reason: "patch_failed",
					detail: err instanceof Error ? err.name : "unknown",
				});
			}
		} else {
			logger.debug("[chat-thread-attachments] patch_description", {
				span: SPAN,
				step: "patch_description",
				outcome: "skipped",
				proposalId: input.proposal.id,
				projectId: input.projectId,
				storyId: input.story.id,
			});
		}

		return { uploaded, warnings };
	} catch (err) {
		// Final top-level defense — should be unreachable because every inner
		// branch already catches. Convert to a single opaque warning.
		const fallback: AttachmentWarning = {
			source: input.source,
			refId: "unknown",
			reason: "download_failed",
			detail: "unexpected_error",
		};
		try {
			logger.error("[chat-thread-attachments] unexpected", {
				span: SPAN,
				outcome: "failed",
				proposalId: input.proposal.id,
				projectId: input.projectId,
				storyId: input.story.id,
				errorName: err instanceof Error ? err.name : "unknown",
			});
		} catch {
			// Logger itself failed — swallow; FR-23 forbids us from propagating.
		}
		return { uploaded: [], warnings: [fallback] };
	}
}

// =============================================================================
// Source-specific helpers
// =============================================================================

/**
 * Resolve the Graph URL prefix for a Teams ref. Precedence:
 *   1. `ref.srcUrl` — verbatim from the `<img src>` Teams emitted. The
 *      downloader uses this directly; this function returns it just to
 *      satisfy the required-`messageUrl` type contract for the downloader
 *      options. Set on every ref captured after the srcUrl-preservation
 *      change shipped — see `extractHostedContentRefsFromHtml`.
 *   2. Caller-supplied `builder` — the channel-monitor approve procedure
 *      knows whether the message lives under
 *      `/teams/.../channels/.../messages/...` or `/chats/.../messages/...`.
 *   3. Reconstruction from `meta.teamId` + `meta.channelId` —
 *      backward-compat for refs persisted before `srcUrl` existed. This
 *      branch has historically gotten the reply URL shape wrong
 *      (bug_002 and its follow-up); new refs avoid it entirely via (1).
 *
 * Throws `TeamsDownloadFailedError` only when no path can produce a URL —
 * the surrounding try/catch maps it to a `download_failed` warning.
 */
function resolveTeamsMessageUrl({
	ref,
	meta,
	builder,
}: {
	ref: TeamsHostedContentRef;
	meta: ExtractedMetadata;
	builder?: (ref: TeamsHostedContentRef) => string;
}): string {
	if (ref.srcUrl !== undefined) {
		// The downloader prefers ref.srcUrl and ignores messageUrl when it's
		// set — but we still need to return a valid string here to satisfy
		// the required-`messageUrl` shape. Returning srcUrl itself is harmless
		// (it's the same URL the downloader will use) and avoids the
		// teamId/channelId missing-metadata throw for refs that don't need
		// either field to function.
		return ref.srcUrl;
	}
	if (builder) {
		return builder(ref);
	}
	if (meta.teamId && meta.channelId) {
		// Legacy reconstruction path for refs persisted before `srcUrl`
		// existed. Uses the nested `/messages/{rootId}/replies/{replyId}/...`
		// shape for replies (bug_002 fix from PR #1166) and the flat
		// `/messages/{messageId}/...` shape for roots. This branch is now
		// largely diagnostic — fresh ingestion always populates `srcUrl`.
		const base = `https://graph.microsoft.com/v1.0/teams/${meta.teamId}/channels/${meta.channelId}/messages`;
		return ref.parentMessageId !== undefined
			? `${base}/${ref.parentMessageId}/replies/${ref.messageId}`
			: `${base}/${ref.messageId}`;
	}
	throw new TeamsDownloadFailedError(
		"Cannot resolve Teams message URL — missing teamId/channelId in sourceMetadata",
	);
}

/**
 * Translate a download-stage exception into the right `AttachmentWarning`
 * shape (FR-19, FR-20, FR-21).
 */
function mapDownloadErrorToWarning(
	source: "slack" | "teams",
	refId: string,
	err: unknown,
): AttachmentWarning {
	if (err instanceof ScopeMissingError) {
		return { source, refId, reason: "scope_missing" };
	}
	if (err instanceof AuthFailedError) {
		return { source, refId, reason: "auth_failed" };
	}
	if (err instanceof ExternalWorkspaceError) {
		return { source, refId, reason: "external_workspace" };
	}
	if (err instanceof BudgetExceededError) {
		return {
			source,
			refId,
			reason: "budget_exceeded",
			detail: "approval_budget_exceeded",
		};
	}
	if (err instanceof SlackDownloadFailedError) {
		// `image_too_large` from the streaming-cap branch is a per-image cap
		// hit, not a generic failure (decisions § 7 / spec § 4.8).
		if (err.message === "image_too_large") {
			return {
				source,
				refId,
				reason: "image_too_large",
				detail: err.status !== undefined ? `${err.status}` : undefined,
			};
		}
		return {
			source,
			refId,
			reason: "download_failed",
			detail: err.status !== undefined ? `${err.status}` : err.name,
		};
	}
	if (err instanceof TeamsDownloadFailedError) {
		if (err.message === "image_too_large") {
			return {
				source,
				refId,
				reason: "image_too_large",
				detail: err.status !== undefined ? `${err.status}` : undefined,
			};
		}
		return {
			source,
			refId,
			reason: "download_failed",
			detail: err.status !== undefined ? `${err.status}` : err.name,
		};
	}
	// AbortError or anything else — treat as download failure. The cause is
	// recorded as the error class name, NEVER the message (the message may
	// contain a URL fragment from libraries we don't control).
	if (err instanceof Error) {
		// Native AbortError fires when the budget controller aborts an
		// in-flight fetch — surface that as the budget reason.
		if (err.name === "AbortError") {
			return {
				source,
				refId,
				reason: "budget_exceeded",
				detail: "approval_budget_exceeded",
			};
		}
		return { source, refId, reason: "download_failed", detail: err.name };
	}
	return { source, refId, reason: "download_failed", detail: "unknown" };
}

// Re-export the helpers used by tests / Group 5 callers.
export { formatAttachmentWarningLines, appendWarningLinesToAttachmentsBlock };
