/**
 * Shared attachment types for the chat-thread image-attachments feature.
 *
 * These types are the single carrier shape used by both the Slack and Teams
 * fetch activities (which write into `PendingBacklogProposal.sourceMetadata.attachments`)
 * AND the central apply-time orchestrator `attachPendingMediaToStory` (which
 * downloads → uploads → patches the story description).
 *
 * Pure TypeScript — no runtime. Located in `@repo/integrations/shared` so
 * both `@repo/temporal` (activity layer) and `@repo/api` (procedure layer)
 * can depend on a single source of truth without creating a backward edge in
 * the workspace DAG.
 */

/**
 * Slack file metadata captured at `conversations.replies` time.
 * Mirrors Slack's wire shape minus fields we don't need.
 */
export interface SlackThreadFile {
	/** Slack `file.id` — primary dedup key. */
	id: string;
	/** `file.name` — sanitized at apply-time before use as alt text. */
	name: string;
	/** `file.mimetype` — verified against `SUPPORTED_ATTACHMENT_MIMES`. */
	mimetype: string;
	/** `file.url_private` — requires the bot token (`files:read` scope) to GET. */
	urlPrivate: string;
	/** `file.size` (bytes) — checked against `MAX_BYTES_PER_IMAGE`. */
	size: number;
	/** `file.title` — first-choice alt-text source. */
	title?: string;
}

/**
 * Teams hosted-content reference captured at `list_channel_threads` time.
 *
 * Resolution at apply time prefers `srcUrl` (verbatim Graph URL Teams emitted
 * in the `<img src>` attribute). When `srcUrl` is absent — older refs from
 * proposals stored before this field existed — the downloader falls back to
 * reconstructing the URL from `messageId` (+ `parentMessageId` for replies).
 *
 * Reconstruction is fragile: Teams uses different parent-path shapes for root
 * messages vs. replies, and the canonical form is what Teams writes into the
 * src — not what the docs imply. Preserving `srcUrl` removes the guessing.
 */
export interface TeamsHostedContentRef {
	/** Graph `hostedContent.id` — primary dedup key. */
	id: string;
	/**
	 * Graph message id where this hostedContent lives. For a root-message
	 * image, this is the thread root. For a reply image, this is the reply
	 * id (and `parentMessageId` is the thread root).
	 */
	messageId: string;
	/**
	 * Set ONLY for refs extracted from a reply. Equals the thread root id;
	 * used by the legacy reconstruction path to build
	 * `/messages/{parentMessageId}/replies/{messageId}/hostedContents/...`.
	 * Undefined when the ref came from the root message. New code prefers
	 * `srcUrl` and only consults this field for backward-compat with
	 * already-stored refs.
	 */
	parentMessageId?: string;
	/**
	 * Verbatim Graph URL captured from the `<img src>` attribute Teams
	 * embedded in the message body — used as the download URL when present.
	 * Always `https://graph.microsoft.com/...`; non-Graph srcs are dropped at
	 * the parser to keep this field a safe absolute Graph URL.
	 *
	 * Treated as a sensitive signed URL: NEVER logged. Only `id` is.
	 */
	srcUrl?: string;
	/** Graph content type (e.g., `image/png`). Surfaced when available. */
	contentType: string;
	/** Text from `<img alt="…">` in the message HTML, if present. */
	altText?: string;
	/** Filename hint from `Content-Disposition` or `<img>` extraction, if present. */
	fileName?: string;
}

/**
 * Unified sidecar entry carried on
 * `PendingBacklogProposal.sourceMetadata.attachments`.
 *
 * The discriminator `source` lets each apply-time helper read only the
 * shape relevant to its integration.
 */
export type PendingAttachmentRef =
	| { source: "slack"; file: SlackThreadFile; messageTs: string }
	| { source: "teams"; ref: TeamsHostedContentRef };

/**
 * Reason a single attachment was skipped (at fetch time or apply time) or
 * failed (during download / upload). Persisted in the proposal's
 * `sourceMetadata.attachmentWarnings` for the proposal-inbox UI to render
 * the `⚠ M` chip and for the markdown warning line on the resulting story.
 */
export type AttachmentWarningReason =
	| "unsupported_mime"
	| "image_too_large"
	| "thread_total_exceeded"
	| "count_cap_exceeded"
	| "scope_missing"
	| "auth_failed"
	| "external_workspace"
	| "download_failed"
	| "upload_failed"
	| "patch_failed"
	| "budget_exceeded";

/**
 * One skip / failure surfaced to the reviewer. Carries a sanitized `detail`
 * safe to render in HTML — NEVER tokens, signed URLs, or thread author PII
 * (see the security rules above).
 */
export interface AttachmentWarning {
	source: "slack" | "teams";
	/** `file.id` for Slack or `hostedContent.id` for Teams. */
	refId: string;
	reason: AttachmentWarningReason;
	/** Sanitized — no PII / tokens / URLs. MIME strings + byte counts only. */
	detail?: string;
}

/**
 * Output of a successful download + upload. Passed to
 * `appendAttachmentsSection` to extend the story description with
 * `![sanitizedName](s3Key)` lines inside the `## Attachments` block.
 *
 * NOTE: This shape is the union of the FE helper's `UploadedAttachment`
 * (which only knows `s3Key` + `name`) PLUS the additional `mimeType` carried
 * through by the server-side orchestrator for log redaction and downstream
 * multimodal context.
 */
export interface UploadedAttachment {
	/** R2 key: `story-media/{projectId}/{storyId}/{uuid}.{ext}`. */
	s3Key: string;
	/** Sanitized alt-text for the markdown image entry. */
	name: string;
	/** MIME type used for `Content-Type` at upload and logged at INFO. */
	mimeType: string;
}
