"use client";

import { useAnalytics } from "@analytics";
import {
	AI_CHAT_DOCUMENT_FORMAT_LABELS,
	buildAiChatAcceptAttribute,
} from "@repo/utils/ai-chat-attachment";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { MicIcon, Paperclip, SendHorizonal, Square } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type KeyboardEvent,
	type ClipboardEvent as ReactClipboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CopilotSidebarAttachments } from "./CopilotSidebarAttachments";
import {
	type AttachedFile,
	type AttachmentSource,
	useCopilotDocumentUpload,
} from "./use-copilot-document-upload";
import { useDropZoneOverlay } from "./use-drop-zone-overlay";
import {
	formatRecordingDuration,
	useVoiceDictation,
} from "./use-voice-dictation";

/**
 * CopilotKit InputProps interface (from @copilotkit/react-ui props.d.ts)
 * We redeclare here to avoid importing internal types.
 */
interface CopilotInputProps {
	inProgress: boolean;
	onSend: (text: string) => Promise<unknown>;
	isVisible?: boolean;
	onStop?: () => void;
	onUpload?: () => void;
	hideStopButton?: boolean;
}

/**
 * Telemetry-only surface identifier. Per spec §14, this is the SOLE purpose of
 * the `surface` field — it does not gate any runtime behavior. Adding the
 * field here lets every caller (DocumentEditor, DocumentGeneratorEditor, and
 * the new AI Feature Assistant wiring on StoryWorkspace) tag their events
 * without forking the factory. Per spec §10 step 1.
 */
type CopilotSidebarSurface =
	| "feature-assistant"
	| "document"
	| "document-generator"
	| "nexus"
	| "loom";

interface CopilotSidebarInputConfig {
	organizationId?: string | null;
	/**
	 * Called when extracted content becomes available for a file, with the
	 * finished, filename-neutralized rag-context entry built by
	 * `useCopilotDocumentUpload`. Hosts push it into their rag-context state;
	 * they never see the raw filename, so they cannot build an envelope.
	 */
	onContentExtracted?: (entry: string) => void;
	/**
	 * Report the rag context this host is already carrying, so an attachment is
	 * judged against the request it will actually ride in. Forwarded verbatim to
	 * `useCopilotDocumentUpload` — see its doc for why per-file checks alone
	 * cannot keep a request under the body cap (Fizzy #2167).
	 */
	getResidentContext?: () => { bytes: number; imageCount: number };
	/**
	 * Fires synchronously immediately before the typed text is handed to
	 * CopilotKit's `onSend` (after the upload pipeline, after the "can we even
	 * send?" guards). The document editor surfaces use this to `flushSync` the
	 * live editor markdown into the `useCoAgent` `document` state field so the
	 * outgoing turn's state snapshot always carries the current document.
	 *
	 * Why this is needed: `useCoAgent` is bidirectional, so an agent response
	 * that omits `document` (every plain Q&A turn, every tool-call round) syncs
	 * an empty `document` back onto the frontend state. Without re-asserting the
	 * editor content right before each send, the next turn ships an empty
	 * `state.document` and the agent answers as if it cannot see the open page.
	 *
	 * Optional and additive — callers that omit it are unaffected (no-op).
	 */
	onBeforeSend?: () => void;
	/**
	 * Fires synchronously immediately after `onBeforeSend` and immediately
	 * before the typed text is handed to CopilotKit's `onSend` — i.e. only
	 * for sends that actually start a run (all send guards, including
	 * `onBeforeSend`, have already passed). Hosts use it to mark the
	 * upcoming run as user-initiated so the "AI is generating" pill can
	 * distinguish real generations from the AG-UI connect handshake.
	 */
	onUserSend?: () => void;
	/**
	 * Fires when a send that already called `onUserSend` fails before or
	 * without completing a run — i.e. `onSend` itself rejects. Hosts use
	 * this to clear the mark `onUserSend` set, so a failed send can't leave
	 * a stale "run initiated" flag for a later, unrelated handshake to
	 * surface as a false pill. Not called when `onSend` succeeds (the
	 * mark's own true→false-transition clear handles that case).
	 */
	onUserSendFailed?: () => void;
	/**
	 * Telemetry-only surface identifier. MUST NOT gate any runtime
	 * behavior. Defaults to "feature-assistant" so callers can adopt the new
	 * config field incrementally.
	 */
	surface?: CopilotSidebarSurface;
	/**
	 * Restrict the image MIME allowlist for this surface (e.g., the AI Feature
	 * Assistant limits to PNG/JPEG). Non-image types are unaffected. When
	 * omitted, falls back to the hook's default IMAGE_TYPES (PNG/JPEG/GIF/WEBP).
	 */
	allowedImageTypes?: readonly string[];
	/**
	 * Maximum number of image chips this surface allows per session. When the
	 * cap is reached, additional image attachments are rejected with an inline
	 * toast. Non-image files are unaffected. Omit for no cap.
	 */
	maxImageCount?: number;
	/**
	 * When true, the attachment paperclip is rendered in a disabled state and
	 * paste/drop are not wired. Used by surfaces that need to gate the
	 * attachment surface on edit permissions (AC-10 for the AI Feature
	 * Assistant — read-only viewers can chat but cannot attach files).
	 */
	attachmentDisabled?: boolean;
	/**
	 * Tooltip text shown when the user hovers the disabled paperclip. Defaults
	 * to a generic message when omitted. Only used when `attachmentDisabled` is
	 * true.
	 */
	attachmentDisabledReason?: string;
	/**
	 * Override the max longest-side dimension when compressing image uploads on
	 * this surface. Defaults to the module-level `MAX_IMAGE_DIMENSION` (2000)
	 * when undefined. The AI Feature Assistant passes 1024 px (spec
	 * 2026-05-19-feature-assistant-images §5.1); document editor surfaces omit
	 * it and inherit the existing 2000 px default.
	 */
	compressionMaxDimension?: number;
	/**
	 * Override the JPEG canvas quality when compressing image uploads on this
	 * surface. Defaults to 0.85 when undefined. The AI Feature Assistant passes
	 * 0.80 (spec 2026-05-19-feature-assistant-images §5.1); document editor
	 * surfaces omit it and inherit the existing 0.85 default.
	 */
	compressionQuality?: number;
	/**
	 * Side-channel for the chat-history persistence pipeline. Fires once
	 * after `uploadAttachments()` resolves with one or more successful
	 * uploads and BEFORE the typed text is handed to CopilotKit's onSend.
	 * Receives the persistable shape (S3 key + mime + name + size) for
	 * every successful upload so the parent can stash them in a ref keyed
	 * to the next user-role terminal message — `CopilotPersistenceHook`
	 * then reads the ref and attaches the metadata to its
	 * `appendTurnForDocument` call.
	 *
	 * Optional — callers who haven't adopted the document-assistant
	 * history feature flag (or who don't need per-message attachment
	 * persistence at all, like the standalone Fabric AI page) simply omit
	 * the field and the factory no-ops this slot.
	 */
	onAttachmentsForNextMessage?: (
		attachments: Array<{
			id: string;
			s3Path: string;
			name: string;
			mimeType: string;
			sizeBytes?: number;
			kind: "image" | "file";
			/**
			 * Optional in-session preview URL. The input pipeline passes a
			 * base64 data URL for image attachments (already computed by
			 * the upload hook for the chip-thumbnail path) so the live
			 * bubble can render the preview INSTANTLY, before the read-side
			 * procedure has a chance to sign an S3 GET URL. After a page
			 * reload the registry is repopulated from the SSR-loaded
			 * `previewUrl` (which IS signed), so the same image keeps
			 * rendering — the in-session data URL is purely a latency
			 * optimization, never persisted.
			 */
			previewUrl?: string;
		}>,
	) => void;
}

/**
 * The accept string is composed from the shared vocabulary rather than restated
 * here, so this picker cannot drift from what the hook validates and the server
 * admits. `allowedImageTypes` still narrows the image segment per surface — the
 * Feature Assistant passes jpeg/png — and an absent or empty list falls back to
 * the full default image set, exactly as before.
 */
const buildAcceptAttribute = buildAiChatAcceptAttribute;

/** Debounce window for SR announcements so rapid status flips do not spam the queue. */
const ANNOUNCEMENT_DEBOUNCE_MS = 50;

/** Status values worth announcing to assistive tech. Other states (`pending`, `processing`) are intermediate and would just spam the SR queue. */
type AnnounceableStatus = "uploading" | "ready" | "error";

/**
 * Factory that returns a custom CopilotSidebar Input component with
 * document upload support baked in via closure.
 *
 * Usage:
 * ```tsx
 * const CustomInput = useMemo(
 *   () => createCopilotSidebarInput({ organizationId }),
 *   [organizationId]
 * );
 * <CopilotSidebar Input={CustomInput} imageUploadsEnabled={true} ... />
 * ```
 */
export function createCopilotSidebarInput(config: CopilotSidebarInputConfig) {
	// Default the telemetry surface so callers that adopted the factory before
	// this field existed continue to compile without a code change. Per spec
	// §10 step 1 + §15 ("rollback: createCopilotSidebarInput continues to work
	// for the existing callers because all changes are additive"). The value
	// is read only by the (forthcoming) telemetry emitter — it never branches
	// runtime behavior.
	const surface: CopilotSidebarSurface =
		config.surface ?? "feature-assistant";

	return function CopilotSidebarInput(props: CopilotInputProps) {
		const { inProgress, onSend, onStop, onUpload, hideStopButton } = props;
		const [text, setText] = useState("");
		const textareaRef = useRef<HTMLTextAreaElement>(null);

		// Voice dictation lifecycle lives in the shared hook so this surface,
		// Loom, and the Fabric Agent shared ChatInput all share one
		// implementation — change once, propagate everywhere.
		const {
			isRecording,
			hasSpeechSupport,
			recordingSeconds,
			toggle: handleMicClick,
		} = useVoiceDictation({
			onTranscript: (transcript) =>
				setText((prev) => prev + (prev ? " " : "") + transcript),
			disabled: inProgress,
		});

		const tTooltips = useTranslations("tooltips.copilot");
		const tAnnounce = useTranslations("tooltips.copilot.announce");

		// Format the image-format list shown in the attach tooltip/aria-label
		// from the surface's actual `allowedImageTypes`. Surfaces that restrict
		// to PNG/JPG (e.g. AI Feature Assistant) must not advertise GIF/WebP.
		const imageFormatsLabel = useMemo(() => {
			const allowed = config.allowedImageTypes ?? [
				"image/jpeg",
				"image/png",
				"image/gif",
				"image/webp",
			];
			const mimeToShortName: Record<string, string> = {
				"image/jpeg": "JPG",
				"image/png": "PNG",
				"image/gif": "GIF",
				"image/webp": "WebP",
			};
			const labels = allowed
				.map((mime) => mimeToShortName[mime])
				.filter((value): value is string => Boolean(value));
			// Stable order: PNG, JPG, GIF, WebP
			const order = ["PNG", "JPG", "GIF", "WebP"];
			labels.sort((a, b) => order.indexOf(a) - order.indexOf(b));
			return labels.join(", ");
		}, [config.allowedImageTypes]);
		// Document formats come from the shared vocabulary, not from the
		// translation string. Hand-keeping them there is what let this label
		// drift: it advertised "PDF, DOCX, TXT, MD" while HTML and JSON were
		// already accepted, and it is an `aria-label`, so the drift told screen
		// readers a supported format was unsupported. Images stay separate —
		// they narrow per surface (see `imageFormatsLabel` above).
		const attachTooltip = tTooltips("attachDocument", {
			documentFormats: AI_CHAT_DOCUMENT_FORMAT_LABELS.join(", "),
			imageFormats: imageFormatsLabel,
		});

		// Telemetry emitter. `useAnalytics` is the established hook
		// pattern in the SaaS app (`@analytics`); the active provider is wired
		// at app boot. Per `fabric/standards/global/error-handling.md` §"Logging
		// sensitive data": payload contains ONLY `{ surface, kind, mime,
		// sizeBytes }` — never `filename`, file content, `userId`, or
		// `organizationId`.
		const { trackEvent } = useAnalytics();

		// Emit `copilot_attachment_added` synchronously the moment the upload
		// pipeline flips a chip to `ready`. We use the hook's
		// `onAttachmentReady` callback (rather than a `useEffect` over
		// `attachedFiles`) because Send commonly calls `clearAttachments()`
		// in the same React batch — an effect would observe `processing → []`
		// and miss the terminal state. The hook fires this exactly once per
		// chip, so no dedupe set is needed here.
		const handleAttachmentReady = useCallback(
			(info: {
				id: string;
				mime: string;
				sizeBytes: number;
				source: AttachmentSource;
			}) => {
				trackEvent("copilot_attachment_added", {
					surface,
					kind: info.source,
					mime: info.mime || "application/octet-stream",
					sizeBytes: info.sizeBytes,
				});
			},
			[trackEvent],
		);

		const {
			attachedFiles,
			handleFileSelect,
			addFiles,
			removeAttachment,
			uploadAttachments,
			clearAttachments,
			isUploading,
			isPreparing,
			fileInputRef,
		} = useCopilotDocumentUpload({
			organizationId: config.organizationId,
			onContentExtracted: config.onContentExtracted,
			onAttachmentReady: handleAttachmentReady,
			allowedImageTypes: config.allowedImageTypes,
			maxImageCount: config.maxImageCount,
			compressionMaxDimension: config.compressionMaxDimension,
			compressionQuality: config.compressionQuality,
			getResidentContext: config.getResidentContext,
		});

		// Wire drop-zone overlay. The hook owns drag-counter state
		// and the dragenter/dragleave/drop handlers; we only render the overlay
		// element and forward the dropped files into the same `addFiles` path
		// the paperclip uses. The `"drop"` source tag is telemetry-only — see
		// the `copilot_attachment_added` emitter below.
		const handleDropFiles = useCallback(
			(files: readonly File[]) => {
				if (config.attachmentDisabled) {
					return;
				}
				void addFiles(files, "drop");
			},
			[addFiles],
		);
		const { isDraggingFile, dropZoneProps } = useDropZoneOverlay({
			onDrop: handleDropFiles,
			disabled: inProgress || !!config.attachmentDisabled,
		});

		// Polite live-region announcer state for paste/drop status transitions
		// (Task 4.1). The map keyed by file id remembers what we last announced
		// per chip so we do not re-announce on unrelated re-renders, and the
		// debounce coalesces rapid `pending → uploading → processing → ready`
		// flips into a single announcement per terminal state.
		const [announcement, setAnnouncement] = useState("");
		const lastAnnouncedRef = useRef<Map<string, AnnounceableStatus>>(
			new Map(),
		);
		const pendingAnnouncementRef = useRef<string | null>(null);
		const announceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
			null,
		);

		useEffect(() => {
			let nextStatusToAnnounce: AnnounceableStatus | null = null;

			for (const file of attachedFiles) {
				const previous = lastAnnouncedRef.current.get(file.id);
				const announceable = pickAnnounceable(file);
				if (announceable && announceable !== previous) {
					lastAnnouncedRef.current.set(file.id, announceable);
					// Last-write-wins inside a single tick: a chip that lands
					// on `ready` after `uploading` in the same render should
					// get the terminal "uploaded" announcement.
					nextStatusToAnnounce = announceable;
				}
			}

			// Drop entries for chips that have been removed entirely so the
			// map does not grow unbounded across long sessions.
			const currentIdSet = new Set(attachedFiles.map((f) => f.id));
			for (const id of Array.from(lastAnnouncedRef.current.keys())) {
				if (!currentIdSet.has(id)) {
					lastAnnouncedRef.current.delete(id);
				}
			}

			if (!nextStatusToAnnounce) {
				return;
			}

			const message =
				nextStatusToAnnounce === "uploading"
					? tAnnounce("uploading")
					: nextStatusToAnnounce === "ready"
						? tAnnounce("uploaded")
						: tAnnounce("failed");

			pendingAnnouncementRef.current = message;
			if (announceTimerRef.current) {
				clearTimeout(announceTimerRef.current);
			}
			announceTimerRef.current = setTimeout(() => {
				const next = pendingAnnouncementRef.current;
				if (next !== null) {
					setAnnouncement(next);
					pendingAnnouncementRef.current = null;
				}
			}, ANNOUNCEMENT_DEBOUNCE_MS);
		}, [attachedFiles, tAnnounce]);

		// Cleanup the debounce timer on unmount so a late-firing setTimeout
		// cannot setState on a torn-down component (matches the abort-controller
		// pattern fixed in commit 0c04d8abd).
		useEffect(() => {
			return () => {
				if (announceTimerRef.current) {
					clearTimeout(announceTimerRef.current);
					announceTimerRef.current = null;
				}
			};
		}, []);

		// Paste handler: route file payloads to `addFiles`; non-file pastes
		// fall through to the textarea's native paste so plain-text pastes
		// remain unaffected. The `"paste"` source tag is
		// telemetry-only — see the `copilot_attachment_added` emitter below.
		const handlePaste = useCallback(
			(event: ReactClipboardEvent<HTMLTextAreaElement>) => {
				const files = event.clipboardData?.files;
				if (!files || files.length === 0) {
					return;
				}
				if (config.attachmentDisabled) {
					return;
				}
				event.preventDefault();
				void addFiles(files, "paste");
			},
			[addFiles],
		);

		const hasText = text.trim().length > 0;
		const hasAttachments = attachedFiles.length > 0;
		const canSend =
			(hasText || hasAttachments) &&
			!inProgress &&
			!isUploading &&
			!isPreparing;

		const handleSend = useCallback(async () => {
			if (!canSend) {
				return;
			}

			// Mirrors the FabricChat (Loom/Nexus) pattern: the typed text is
			// the user's message, and attachment metadata travels on a separate
			// channel. Here that channel is `onContentExtracted` →
			// page-level `useCopilotReadable("rag context")` /
			// `useCoAgent` state — never inlined in the message body. No
			// hardcoded primer prompt is injected into the conversation.
			//
			// Snapshot the file names BEFORE `clearAttachments()` runs so the
			// `[Attached: …]` hint can be appended to the message. The hint is
			// stripped from the visible bubble by `CopilotUserMessage` (which
			// renders the names as paperclip chips instead) and exists ONLY
			// so the bubble has *something* visible when the user sends a
			// file with no typed text, and so the agent has a one-line cue
			// that files are staged for this turn.
			const typedText = text.trim();
			const stagedCount = hasAttachments ? attachedFiles.length : 0;

			// Run the upload pipeline first. The hook surfaces per-file errors
			// (chip→error + toast) inside its own catch block; the return value
			// only enumerates files that ACTUALLY reached the agent. We use
			// that to drive both the visible `[Attached: …]` hint and the
			// "should we even send?" decision below — without this the user
			// sees a "Failed to upload sample.pdf" toast AND the agent
			// receives `[Attached: sample.pdf]` and replies "please paste the
			// content" at the same time.
			let successfulNames: string[] = [];
			if (hasAttachments) {
				const { uploadedFiles } = await uploadAttachments();
				successfulNames = uploadedFiles.map((f) => f.name);
				// Side-channel for the document-assistant chat-history
				// persistence pipeline. Only fires when the parent supplied
				// the callback (i.e. the document/feature editor surfaces
				// with the chat-history feature flag on). Filters out any
				// upload that didn't produce an `s3Path` — without the key
				// there's nothing to re-sign on read, so persisting the
				// envelope would be a dead row.
				if (config.onAttachmentsForNextMessage) {
					const persistable = uploadedFiles
						.filter((f) => Boolean(f.s3Path))
						.map((f) => {
							const isImage = (f.type ?? "").startsWith("image/");
							// For images, the upload hook already
							// produced a base64 data URL via
							// `readFileAsDataURL` (used by the chip
							// thumbnail + rag-context channel). Pass it
							// through as the in-session preview so the
							// live bubble renders instantly, without
							// waiting for an S3 sign round-trip. Non-image
							// MIMEs don't get a data URL — the link chip
							// is filename-only until the next reload, at
							// which point the read procedure mints a
							// fresh signed download URL.
							const inlinePreview =
								isImage &&
								typeof f.extractedContent === "string" &&
								f.extractedContent.startsWith("data:")
									? f.extractedContent
									: undefined;
							return {
								id: f.documentId,
								s3Path: f.s3Path as string,
								name: f.name,
								mimeType: f.type || "application/octet-stream",
								sizeBytes: f.size,
								kind: isImage
									? ("image" as const)
									: ("file" as const),
								...(inlinePreview
									? { previewUrl: inlinePreview }
									: {}),
							};
						});
					if (persistable.length > 0) {
						config.onAttachmentsForNextMessage(persistable);
					}
				}
			}

			const failedCount = stagedCount - successfulNames.length;

			let messageText = typedText;
			if (successfulNames.length > 0) {
				const hint = `[Attached: ${successfulNames.join(", ")}]`;
				messageText = messageText ? `${messageText}\n\n${hint}` : hint;
			}

			// If the user is sending file-only and ALL files failed, do not
			// fire onSend — the per-file toast already explained what went
			// wrong. Sending an empty message would just hand the agent
			// nothing to respond to.
			if (!messageText) {
				return;
			}
			if (failedCount > 0 && successfulNames.length === 0) {
				return;
			}

			// Clear input UI state BEFORE awaiting onSend. CopilotKit's onSend
			// resolves when the agent stream completes, not when the message is
			// queued — without this, the chip and the typed text linger above
			// the input for the entire agent response. Matches the FabricChat
			// (Loom/Nexus) pattern of clearing on click.
			setText("");
			clearAttachments();

			// Synchronous hook for the host surface to flush editor→agent state
			// right before CopilotKit captures the outgoing state snapshot. The
			// document editor surfaces `flushSync` the live editor markdown into
			// `useCoAgent`'s `document` field here so the agent always receives
			// the current document — without this, a prior bidirectional state
			// sync can leave `state.document` empty and the agent answers as if
			// it cannot see the open page. No-op for callers that omit it.
			config.onBeforeSend?.();
			// Marked AFTER onBeforeSend so a throw there (never reaches
			// onSend, no run starts) does not mark a run that never
			// happens — onUserSendFailed exists for failures AFTER this
			// point (i.e. inside onSend itself).
			config.onUserSend?.();

			try {
				await onSend(messageText);
			} catch (error) {
				config.onUserSendFailed?.();
				throw error;
			}

			// Refocus textarea
			setTimeout(() => textareaRef.current?.focus(), 0);
		}, [
			canSend,
			text,
			hasAttachments,
			attachedFiles,
			uploadAttachments,
			onSend,
			clearAttachments,
		]);

		const handleKeyDown = useCallback(
			(e: KeyboardEvent<HTMLTextAreaElement>) => {
				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					handleSend();
				}
			},
			[handleSend],
		);

		const openDocumentDialog = useCallback(() => {
			fileInputRef.current?.click();
		}, [fileInputRef]);

		// Auto-resize textarea
		const handleTextChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				setText(e.target.value);
				const el = e.target;
				el.style.height = "auto";
				el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
			},
			[],
		);

		return (
			<div
				className="copilot-sidebar-input-wrapper relative"
				data-copilot-surface={surface}
				{...dropZoneProps}
			>
				{/* Attachment chips */}
				<CopilotSidebarAttachments
					files={attachedFiles}
					onRemove={removeAttachment}
					textareaRef={textareaRef}
				/>

				{/* Bordered input container — FabricDirectChat visual style */}
				<div className="copilot-sidebar-input-container">
					{/* Textarea — top area */}
					<textarea
						ref={textareaRef}
						value={text}
						onChange={handleTextChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						placeholder={
							isRecording ? "Listening…" : "Type a message..."
						}
						disabled={inProgress}
						rows={2}
						className="copilot-sidebar-textarea"
					/>

					{/* Bottom row: attachment icons (left) + send button (right) */}
					<div className="copilot-sidebar-input-bottom">
						<div className="flex items-center gap-0.5">
							{/*
							 * Document attachment button — icon-only control,
							 * therefore both `aria-label` AND `<Tooltip>` per
							 * `fabric/standards/frontend/tooltips.md` (Task 4.4).
							 */}
							{/*
							 * When the surface gates attachments (AC-10: read-only
							 * viewers on the AI Feature Assistant), render the
							 * button disabled inside a span wrapper so the tooltip
							 * remains reachable — Radix Tooltip skips pointer events
							 * on disabled children. The button keeps `aria-disabled`
							 * for assistive-tech announcement. Pattern proven by
							 * `ContextUploaderDialog.tsx`.
							 */}
							{config.attachmentDisabled ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<span
											className="inline-flex"
											// biome-ignore lint/a11y/noNoninteractiveTabindex: Radix Tooltip skips pointer events on disabled children — span wrapper must be focusable for keyboard tooltip discovery. Pattern mirrors ContextUploaderDialog.tsx.
											tabIndex={0}
										>
											<button
												type="button"
												disabled
												aria-disabled
												className={cn(
													"copilot-sidebar-action-btn",
													"opacity-50 cursor-not-allowed",
												)}
												aria-label={
													config.attachmentDisabledReason ??
													attachTooltip
												}
											>
												<Paperclip className="size-4" />
											</button>
										</span>
									</TooltipTrigger>
									<TooltipContent side="top">
										{config.attachmentDisabledReason ??
											"Attachments are disabled."}
									</TooltipContent>
								</Tooltip>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={openDocumentDialog}
											disabled={inProgress || isUploading}
											className={cn(
												"copilot-sidebar-action-btn",
												hasAttachments &&
													"text-primary",
											)}
											aria-label={attachTooltip}
										>
											<Paperclip className="size-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{attachTooltip}
									</TooltipContent>
								</Tooltip>
							)}

							{/* Single paperclip handles both files and images.
							    The CopilotKit `imageUploadsEnabled` channel is no
							    longer wired — images flow through the same upload
							    pipeline as documents and reach the agent via the
							    page's `useCopilotReadable` context (mirrors Nexus). */}
						</div>

						{/* Right cluster: mic + send/stop */}
						<div className="flex items-center gap-1.5">
							{isRecording && (
								<span
									className="text-[11px] font-medium tabular-nums text-destructive"
									aria-live="polite"
								>
									{formatRecordingDuration(recordingSeconds)}
								</span>
							)}
							<Tooltip>
								<TooltipTrigger asChild>
									<button
										type="button"
										onClick={handleMicClick}
										disabled={
											inProgress || !hasSpeechSupport
										}
										aria-label={tTooltips(
											"voiceInput.label",
										)}
										aria-pressed={isRecording}
										className={cn(
											"flex size-7 items-center justify-center rounded-lg transition-colors",
											!hasSpeechSupport &&
												"text-muted-foreground opacity-40 cursor-not-allowed",
											hasSpeechSupport &&
												!isRecording &&
												"text-muted-foreground hover:text-foreground hover:bg-muted/60",
											hasSpeechSupport &&
												isRecording &&
												"text-destructive bg-destructive/10 motion-safe:animate-pulse",
										)}
									>
										<MicIcon className="size-3.5" />
									</button>
								</TooltipTrigger>
								<TooltipContent side="top">
									{!hasSpeechSupport
										? tTooltips("voiceInput.unsupported")
										: inProgress
											? tTooltips("voiceInput.busy")
											: isRecording
												? tTooltips(
														"voiceInput.recording",
													)
												: tTooltips("voiceInput.idle")}
								</TooltipContent>
							</Tooltip>

							{/* Send / Stop button */}
							{inProgress && !hideStopButton ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={onStop}
											className="copilot-sidebar-stop-btn"
											aria-label={tTooltips(
												"stopGeneration",
											)}
										>
											<Square className="size-3.5" />
										</button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{tTooltips("stopGeneration")}
									</TooltipContent>
								</Tooltip>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<button
											type="button"
											onClick={handleSend}
											disabled={!canSend}
											className={cn(
												"copilot-sidebar-send-btn",
												canSend &&
													"copilot-sidebar-send-btn-active",
											)}
											aria-label={tTooltips(
												"sendMessage",
											)}
										>
											<SendHorizonal className="size-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent side="top">
										{tTooltips("sendMessage")}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					</div>
				</div>

				{/*
				 * Off-screen (NOT display:none) file input for documents.
				 *
				 * We deliberately use `sr-only` instead of `hidden` (=
				 * `display:none`). Chromium 124+ (April 2024) tightened the
				 * file-picker user-activation rules: a programmatic
				 * `fileInputRef.current.click()` on a `display:none` input
				 * silently does nothing — the click event propagates to the
				 * input, but the OS file picker never opens. Users saw the
				 * paperclip button click without any visible reaction. The
				 * input must be technically rendered (any layout-present
				 * style) for the picker to surface, which `sr-only` provides
				 * (position:absolute, 1×1 clipped, off-screen) while keeping
				 * the control invisible to sighted users. The same pattern is
				 * already used in `WizardFileUploader` and
				 * `ContextUploaderDialog` for the same reason.
				 *
				 * See https://chromestatus.com/feature/5079176222605312
				 * (Restrict programmatic click() on hidden file inputs).
				 */}
				<input
					ref={fileInputRef}
					type="file"
					multiple
					accept={buildAcceptAttribute(config.allowedImageTypes)}
					onChange={handleFileSelect}
					className="sr-only"
					// The control is operated via the visible Paperclip button
					// above; keep this off-screen input out of the tab order
					// AND out of the a11y tree so screen-reader users don't
					// hear a second, unlabeled "file input" announcement.
					aria-hidden="true"
					tabIndex={-1}
				/>

				{/*
				 * Drop-zone overlay. Editorial label, design tokens
				 * only (no hex). `pointer-events-none` keeps drag events flowing
				 * through to the wrapper handlers; `aria-hidden` keeps it out of
				 * the accessibility tree (the polite live-region announcement
				 * for the drop event lands in Group 4 / Task 4.1). Fade is
				 * `motion-safe:` so reduced-motion users get an instant toggle
				 * (Task 4.3).
				 */}
				<div
					aria-hidden="true"
					className={cn(
						"pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg",
						"bg-primary/5 border border-dashed border-primary/30",
						"motion-safe:transition-opacity motion-safe:duration-150",
						isDraggingFile ? "opacity-100" : "opacity-0",
					)}
				>
					<span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
						Drop to attach
					</span>
				</div>

				{/*
				 * Polite live region for paste/drop status announcements
				 * (Task 4.1, spec §4.3). `sr-only` hides visually; `aria-live`
				 * + `aria-atomic` announce the entire content on each change.
				 * Driven by chip-status transitions; `lastAnnouncedRef` and a
				 * 50ms debounce coalesce rapid `pending → uploading → ready`
				 * flips into a single announcement.
				 */}
				<span className="sr-only" aria-live="polite" aria-atomic="true">
					{announcement}
				</span>
			</div>
		);
	};
}

/**
 * Maps an attached file's lifecycle status to the announcement we should make.
 * Returns `null` for transient states the SR user does not need to hear about.
 */
function pickAnnounceable(file: AttachedFile): AnnounceableStatus | null {
	switch (file.status) {
		case "uploading":
			return "uploading";
		case "ready":
			return "ready";
		case "error":
			return "error";
		default:
			return null;
	}
}
