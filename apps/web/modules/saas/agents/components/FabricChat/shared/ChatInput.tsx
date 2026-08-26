"use client";

/**
 * ChatInput - Shared input component for chat interfaces
 *
 * Features:
 * - Auto-resizing textarea
 * - Send button with loading state
 * - Optional attachment button
 * - Keyboard handling (Enter to send, Shift+Enter for newline)
 * - Slots for additional content (context indicator, artifacts trigger)
 * - @template, @file, @story/@issue, @user mention support with autocomplete
 *
 * Used by both Direct and Orchestrator chat modes.
 */

import { DEFAULT_AI_CHAT_MAX_FILE_BYTES } from "@repo/utils/ai-chat-attachment";
import {
	formatRecordingDuration,
	useVoiceDictation,
} from "@saas/shared/components/copilot/use-voice-dictation";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { Loader2, MicIcon, Paperclip, Send, StopCircle } from "lucide-react";
import { useTranslations } from "next-intl";

// User-facing strings audited against fabric/standards/ai/ai-copy-tone.md — task 4.1.
// None use forbidden vocabulary ("best" / "optimal" / "required" /
// "should" / "recommended" / "must" / "kill" / "abort" / "terminate" /
// "sorry"). Same strings as FabricInput.tsx and the Nexus ComposeInput
// so the four AI surfaces stay symmetric.
const STOP_BUTTON_LABEL = "Stop generating";
const STOP_BUTTON_TOOLTIP = "Stop this response · Esc";

import { useClipboardImagePaste } from "@saas/projects/lib/use-clipboard-image-paste";
import {
	type ChangeEvent,
	forwardRef,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	type MentionableFile,
	useFileMention,
} from "../../../hooks/useFileMention";
import {
	type MentionableStory,
	useStoryMention,
} from "../../../hooks/useStoryMention";
import {
	type MentionableTemplate,
	useTemplateMention,
} from "../../../hooks/useTemplateMention";
import {
	type MentionableUser,
	useUserMention,
} from "../../../hooks/useUserMention";
import { ActiveTemplateIndicator } from "./ActiveTemplateIndicator";
import { FileAutocomplete } from "./FileAutocomplete";
import { StoryAutocomplete } from "./StoryAutocomplete";
import { TemplateAutocomplete } from "./TemplateAutocomplete";
import { UserAutocomplete } from "./UserAutocomplete";

export type MentionType = "template" | "file" | "story" | "user" | null;

/**
 * Loom paste/drop image MIME allowlist — matches Nexus per spec §4.4.
 * Frozen at module scope so the `Set` identity is stable across renders
 * (the shared hook keys configuration off `optionsRef`, but a fresh Set
 * each render would still cause unnecessary churn in the option object).
 */
const LOOM_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/tiff",
]);

/**
 * Chat-surface cap from spec §7, now read from the shared attachment
 * vocabulary rather than restated.
 *
 * It has to be the same number the paperclip enforces: a separate constant
 * meant that raising the document cap left paste refusing at the old limit, so
 * the identical image was accepted through one entry point and rejected
 * through the other on the same surface.
 */
const LOOM_IMAGE_MAX_BYTES = DEFAULT_AI_CHAT_MAX_FILE_BYTES;

/** Hard cap on parallel pasted images per spec §7 / decisions.md. */
const LOOM_IMAGE_MAX_PER_PASTE = 5 as const;

/** No-op uploader used when image-paste is disabled — keeps the hook call
 *  unconditional to satisfy the Rules of Hooks. */
const NOOP_UPLOADER = async (
	_file: File,
	_signal: AbortSignal,
): Promise<void> => {
	/* image paste disabled — no-op */
};

export interface ChatInputProps {
	/** Current input value */
	value: string;
	/** Callback when input changes */
	onChange: (value: string) => void;
	/** Callback when user submits message */
	onSend: () => void;
	/** Whether currently loading/sending */
	isLoading?: boolean;
	/** Whether input is disabled */
	disabled?: boolean;
	/** Placeholder text */
	placeholder?: string;
	/** Custom class name for the container */
	className?: string;

	// Stop / cancel — see `specs/2026-05-09-stop-ai-generation/spec.md` § 8.5–8.6.
	/**
	 * Invoked when the user clicks the morphed Stop button while a
	 * generation is in-flight. The consumer wires this to the streaming
	 * hook's `stop()` (Direct chat / Loom Direct page / Loom Orchestrator).
	 * When omitted, the morph button is not rendered and the existing
	 * spinner-only treatment is preserved (back-compat).
	 */
	onStop?: () => void;
	/**
	 * Orchestrator-only: render the Stop morph while the workflow is
	 * paused on `pendingApproval` (AC-9 / decision 20). Direct-chat
	 * surfaces leave this `false`.
	 */
	pendingApproval?: boolean;

	// Attachment handling
	/** Callback when attachment button is clicked */
	onAttachClick?: () => void;
	/** Tooltip text for attachment button */
	attachTooltip?: string;
	/** Whether attachment is disabled */
	attachDisabled?: boolean;
	/** Whether to show attachment button */
	showAttachButton?: boolean;

	// Slots for additional content
	/** Content to render above the input (e.g., attached files, tool suggestions) */
	topSlot?: React.ReactNode;
	/** Content to render in the header area (e.g., context indicator, artifacts trigger) */
	headerSlot?: React.ReactNode;

	// Template mention support
	/** Organization ID for tenant-aware template search */
	organizationId?: string | null;
	/** Enable @template mentions */
	enableTemplateMentions?: boolean;
	/** Callback when merged template instructions change */
	onMergedInstructionsChange?: (instructions: string | null) => void;
	/** Callback when selected templates change */
	onSelectedTemplatesChange?: (templates: MentionableTemplate[]) => void;
	/** Callback when merged integration IDs change */
	onMergedIntegrationIdsChange?: (ids: string[]) => void;
	/** Callback when merged MCP config IDs change */
	onMergedMcpConfigIdsChange?: (ids: string[]) => void;
	/** Callback when merged Fabric AI tool IDs change */
	onMergedFabricToolIdsChange?: (ids: string[]) => void;
	/** Initial selected templates (for restoring session-level selections across remounts) */
	initialSelectedTemplates?: MentionableTemplate[];

	// File mention support
	/** Project ID for file/story mention search */
	projectId?: string;
	/** Enable @file mentions */
	enableFileMentions?: boolean;

	// Story mention support
	/** Enable @story / @issue mentions */
	enableStoryMentions?: boolean;

	// User mention support
	/** Enable @user mentions */
	enableUserMentions?: boolean;

	// Image paste / drag-drop support
	/**
	 * Enable clipboard-paste and drag-drop of images directly into the chat
	 * input. When `true`, the host MUST also supply `imageUploader`; otherwise
	 * the handlers are still attached but every paste is a no-op.
	 */
	enableImagePaste?: boolean;
	/**
	 * Surface-owned uploader invoked for each pasted/dropped image. The host
	 * decides which oRPC pipeline to call (Direct/Nexus → `ai.documents.*`,
	 * Orchestrator → its existing image route). The hook supplies an
	 * `AbortSignal` that fires on `ChatInput` unmount so long-running uploads
	 * can short-circuit.
	 */
	imageUploader?: (file: File, signal: AbortSignal) => Promise<void>;
	/**
	 * Mixed paste/drop — non-image files are forwarded here so the host can
	 * route them to the existing file-picker pipeline (spec §7 mixed-files
	 * split). If omitted, non-image files are dropped silently.
	 */
	onPasteNonImageFiles?: (files: File[]) => void;
}

export const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(
	function ChatInput(
		{
			value,
			onChange,
			onSend,
			isLoading = false,
			disabled = false,
			placeholder = "Type a message...",
			className,
			onAttachClick,
			attachTooltip = "Attach files",
			attachDisabled = false,
			showAttachButton = true,
			topSlot,
			headerSlot,
			organizationId,
			enableTemplateMentions = false,
			onMergedInstructionsChange,
			onSelectedTemplatesChange,
			onMergedIntegrationIdsChange,
			onMergedMcpConfigIdsChange,
			onMergedFabricToolIdsChange,
			initialSelectedTemplates,
			projectId,
			enableFileMentions = false,
			enableStoryMentions = false,
			enableUserMentions = false,
			enableImagePaste = false,
			imageUploader,
			onPasteNonImageFiles,
			onStop,
			pendingApproval = false,
		},
		ref,
	) {
		const internalRef = useRef<HTMLTextAreaElement>(null);
		const textareaRef =
			(ref as React.RefObject<HTMLTextAreaElement>) || internalRef;
		const containerRef = useRef<HTMLDivElement>(null);

		// Track cursor position for @ detection
		const [cursorPosition, setCursorPosition] = useState(0);
		// Track which mention type is currently active
		const [activeMentionType, setActiveMentionType] =
			useState<MentionType>(null);

		// Use template mention hook (only if enabled)
		const {
			setSearchQuery: setTemplateSearchQuery,
			isOpen: isTemplateMentionOpen,
			setIsOpen: setIsTemplateMentionOpen,
			selectedIndex: templateSelectedIndex,
			setSelectedIndex: setTemplateSelectedIndex,
			results: templateMentionResults,
			isLoading: isTemplateMentionLoading,
			selectedTemplates,
			mergedInstructions,
			mergedIntegrationIds,
			mergedMcpConfigIds,
			mergedFabricToolIds,
			selectTemplate,
			removeTemplate,
			handleKeyDown: handleTemplateMentionKeyDown,
		} = useTemplateMention({
			organizationId,
			enabled: enableTemplateMentions,
			initialSelectedTemplates,
		});

		// Use file mention hook (only if enabled)
		const {
			setSearchQuery: setFileSearchQuery,
			isOpen: isFileMentionOpen,
			setIsOpen: setIsFileMentionOpen,
			selectedIndex: fileSelectedIndex,
			setSelectedIndex: setFileSelectedIndex,
			results: fileMentionResults,
			isLoading: isFileMentionLoading,
			selectItem: selectFile,
			handleKeyDown: handleFileMentionKeyDown,
		} = useFileMention({
			projectId,
			organizationId,
			enabled: enableFileMentions,
		});

		// Use story mention hook (only if enabled)
		const {
			setSearchQuery: setStorySearchQuery,
			isOpen: isStoryMentionOpen,
			setIsOpen: setIsStoryMentionOpen,
			selectedIndex: storySelectedIndex,
			setSelectedIndex: setStorySelectedIndex,
			results: storyMentionResults,
			isLoading: isStoryMentionLoading,
			selectItem: selectStory,
			handleKeyDown: handleStoryMentionKeyDown,
		} = useStoryMention({
			projectId,
			organizationId,
			enabled: enableStoryMentions,
		});

		// Use user mention hook (only if enabled)
		const {
			setSearchQuery: setUserSearchQuery,
			isOpen: isUserMentionOpen,
			setIsOpen: setIsUserMentionOpen,
			selectedIndex: userSelectedIndex,
			setSelectedIndex: setUserSelectedIndex,
			results: userMentionResults,
			isLoading: isUserMentionLoading,
			selectItem: selectUser,
			handleKeyDown: handleUserMentionKeyDown,
		} = useUserMention({
			organizationId,
			enabled: enableUserMentions,
		});

		// Image paste / drag-drop.
		// The hook is called unconditionally (Rules of Hooks) but is wired
		// into the textarea only when `enableImagePaste === true`. When
		// disabled the no-op uploader is used so the hook does no work.
		const {
			handlePaste: handleImagePaste,
			handleDrop: handleImageDrop,
			handleDragOver: handleImageDragOver,
		} = useClipboardImagePaste({
			surface: "loom",
			maxSizeBytes: LOOM_IMAGE_MAX_BYTES,
			allowedMimeTypes: LOOM_IMAGE_MIME_TYPES,
			maxFilesPerPaste: LOOM_IMAGE_MAX_PER_PASTE,
			uploader: imageUploader ?? NOOP_UPLOADER,
			onNonImageFiles: onPasteNonImageFiles,
		});

		// Voice dictation — shared with CopilotSidebarInput so the four AI
		// surfaces (feature/document copilot, Loom, Fabric Agent) all run
		// the same SpeechRecognition state machine. See
		// `apps/web/modules/saas/shared/components/copilot/use-voice-dictation.ts`.
		const tTooltips = useTranslations("tooltips.copilot");
		const {
			isRecording,
			hasSpeechSupport,
			recordingSeconds,
			toggle: handleMicClick,
		} = useVoiceDictation({
			onTranscript: (transcript) => {
				onChange(value + (value ? " " : "") + transcript);
			},
			disabled: isLoading || disabled,
		});

		// Helper: close all mention dropdowns
		const closeAllMentions = useCallback(() => {
			setIsTemplateMentionOpen(false);
			setIsFileMentionOpen(false);
			setIsStoryMentionOpen(false);
			setIsUserMentionOpen(false);
			setActiveMentionType(null);
		}, [
			setIsTemplateMentionOpen,
			setIsFileMentionOpen,
			setIsStoryMentionOpen,
			setIsUserMentionOpen,
		]);

		// Extract @ mention from input at cursor position
		const extractMentionQuery = useCallback(
			(
				text: string,
				cursor: number,
			): { query: string; start: number; type: MentionType } | null => {
				// Look backwards from cursor for @
				let start = cursor - 1;
				while (start >= 0) {
					const char = text[start];
					// Stop if we hit whitespace or another @
					if (char === " " || char === "\n" || char === "\t") {
						start++;
						break;
					}
					if (char === "@") {
						// Extract the full mention text including prefix
						const mentionText = text.slice(start + 1, cursor);
						// Determine mention type from prefix
						let type: MentionType = null;
						let query = mentionText;

						if (mentionText.startsWith("file:")) {
							if (!enableFileMentions) {
								return null;
							}
							type = "file";
							query = mentionText.slice(5);
						} else if (mentionText.startsWith("story:")) {
							if (!enableStoryMentions) {
								return null;
							}
							type = "story";
							query = mentionText.slice(6);
						} else if (mentionText.startsWith("issue:")) {
							if (!enableStoryMentions) {
								return null;
							}
							type = "story";
							query = mentionText.slice(6);
						} else if (mentionText.startsWith("user:")) {
							if (!enableUserMentions) {
								return null;
							}
							type = "user";
							query = mentionText.slice(5);
						} else if (mentionText.startsWith("template:")) {
							if (!enableTemplateMentions) {
								return null;
							}
							type = "template";
							query = mentionText.slice(9);
						} else if (
							// Bare @ without prefix - treat as template for backwards compat
							enableTemplateMentions &&
							!mentionText.includes(":")
						) {
							type = "template";
							query = mentionText;
						}

						// Only valid if @ is at start or after whitespace
						if (
							type &&
							(start === 0 || /\s/.test(text[start - 1]))
						) {
							return { query, start, type };
						}
						return null;
					}
					start--;
				}
				return null;
			},
			[
				enableTemplateMentions,
				enableFileMentions,
				enableStoryMentions,
				enableUserMentions,
			],
		);

		// Handle template selection
		const handleSelectTemplate = useCallback(
			(template: MentionableTemplate) => {
				// Remove @query from input
				const mention = extractMentionQuery(value, cursorPosition);
				if (mention) {
					const before = value.slice(0, mention.start);
					const after = value.slice(cursorPosition);
					onChange(before + after);
				}
				selectTemplate(template);
				setActiveMentionType(null);
			},
			[
				value,
				cursorPosition,
				extractMentionQuery,
				onChange,
				selectTemplate,
			],
		);

		// Handle file selection
		const handleSelectFile = useCallback(
			(file: MentionableFile) => {
				const mention = extractMentionQuery(value, cursorPosition);
				if (mention) {
					const before = value.slice(0, mention.start);
					const after = value.slice(cursorPosition);
					const contextBlock = `\n\n[File: ${file.path}]\n\`\`\`${file.language || "text"}\n/* File reference: ${file.path} */\n\`\`\`\n\n`;
					onChange(before + contextBlock + after);
				}
				selectFile(file);
				setActiveMentionType(null);
			},
			[value, cursorPosition, extractMentionQuery, onChange, selectFile],
		);

		// Handle story selection
		const handleSelectStory = useCallback(
			(story: MentionableStory) => {
				const mention = extractMentionQuery(value, cursorPosition);
				if (mention) {
					const before = value.slice(0, mention.start);
					const after = value.slice(cursorPosition);
					const contextBlock = `\n\n[Story ${story.identifier}: ${story.title}]\nStatus: ${story.status}\n\n`;
					onChange(before + contextBlock + after);
				}
				selectStory(story);
				setActiveMentionType(null);
			},
			[value, cursorPosition, extractMentionQuery, onChange, selectStory],
		);

		// Handle user selection
		const handleSelectUser = useCallback(
			(user: MentionableUser) => {
				const mention = extractMentionQuery(value, cursorPosition);
				if (mention) {
					const before = value.slice(0, mention.start);
					const after = value.slice(cursorPosition);
					const contextBlock = `\n\n[@${user.name || user.email || "User"}]\n\n`;
					onChange(before + contextBlock + after);
				}
				selectUser(user);
				setActiveMentionType(null);
			},
			[value, cursorPosition, extractMentionQuery, onChange, selectUser],
		);

		const handleKeyDown = useCallback(
			(e: KeyboardEvent<HTMLTextAreaElement>) => {
				// Handle mention selection with Enter/Tab - intercept to remove @query text
				if (
					activeMentionType === "template" &&
					isTemplateMentionOpen &&
					templateMentionResults.length > 0 &&
					(e.key === "Enter" || e.key === "Tab")
				) {
					const selectedTemplate =
						templateMentionResults[templateSelectedIndex];
					if (selectedTemplate) {
						e.preventDefault();
						handleSelectTemplate(selectedTemplate);
						return;
					}
				}

				if (
					activeMentionType === "file" &&
					isFileMentionOpen &&
					fileMentionResults.length > 0 &&
					(e.key === "Enter" || e.key === "Tab")
				) {
					const selectedFile = fileMentionResults[fileSelectedIndex];
					if (selectedFile) {
						e.preventDefault();
						handleSelectFile(selectedFile);
						return;
					}
				}

				if (
					activeMentionType === "story" &&
					isStoryMentionOpen &&
					storyMentionResults.length > 0 &&
					(e.key === "Enter" || e.key === "Tab")
				) {
					const selectedStory =
						storyMentionResults[storySelectedIndex];
					if (selectedStory) {
						e.preventDefault();
						handleSelectStory(selectedStory);
						return;
					}
				}

				if (
					activeMentionType === "user" &&
					isUserMentionOpen &&
					userMentionResults.length > 0 &&
					(e.key === "Enter" || e.key === "Tab")
				) {
					const selectedUser = userMentionResults[userSelectedIndex];
					if (selectedUser) {
						e.preventDefault();
						handleSelectUser(selectedUser);
						return;
					}
				}

				// Let mention handlers process arrow keys and escape
				if (
					activeMentionType === "template" &&
					handleTemplateMentionKeyDown(e)
				) {
					return;
				}
				if (
					activeMentionType === "file" &&
					handleFileMentionKeyDown(e)
				) {
					return;
				}
				if (
					activeMentionType === "story" &&
					handleStoryMentionKeyDown(e)
				) {
					return;
				}
				if (
					activeMentionType === "user" &&
					handleUserMentionKeyDown(e)
				) {
					return;
				}

				if (e.key === "Enter" && !e.shiftKey) {
					e.preventDefault();
					if (value.trim() && !isLoading && !disabled) {
						onSend();
					}
				}
			},
			[
				value,
				isLoading,
				disabled,
				onSend,
				activeMentionType,
				isTemplateMentionOpen,
				templateMentionResults,
				templateSelectedIndex,
				handleSelectTemplate,
				isFileMentionOpen,
				fileMentionResults,
				fileSelectedIndex,
				handleSelectFile,
				isStoryMentionOpen,
				storyMentionResults,
				storySelectedIndex,
				handleSelectStory,
				isUserMentionOpen,
				userMentionResults,
				userSelectedIndex,
				handleSelectUser,
				handleTemplateMentionKeyDown,
				handleFileMentionKeyDown,
				handleStoryMentionKeyDown,
				handleUserMentionKeyDown,
			],
		);

		const handleChange = useCallback(
			(e: ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value;
				const cursor = e.target.selectionStart ?? newValue.length;
				setCursorPosition(cursor);
				onChange(newValue);

				// Check for @ mention
				const mention = extractMentionQuery(newValue, cursor);
				if (mention) {
					// Close all other mention dropdowns (mutual exclusion)
					closeAllMentions();
					setActiveMentionType(mention.type);

					switch (mention.type) {
						case "template":
							setTemplateSearchQuery(mention.query);
							setIsTemplateMentionOpen(true);
							break;
						case "file":
							setFileSearchQuery(mention.query);
							setIsFileMentionOpen(true);
							break;
						case "story":
							setStorySearchQuery(mention.query);
							setIsStoryMentionOpen(true);
							break;
						case "user":
							setUserSearchQuery(mention.query);
							setIsUserMentionOpen(true);
							break;
					}
				} else {
					closeAllMentions();
				}
			},
			[
				onChange,
				extractMentionQuery,
				closeAllMentions,
				setTemplateSearchQuery,
				setIsTemplateMentionOpen,
				setFileSearchQuery,
				setIsFileMentionOpen,
				setStorySearchQuery,
				setIsStoryMentionOpen,
				setUserSearchQuery,
				setIsUserMentionOpen,
			],
		);

		// Track cursor position on click/selection
		const handleSelect = useCallback(
			(e: React.SyntheticEvent<HTMLTextAreaElement>) => {
				const target = e.target as HTMLTextAreaElement;
				setCursorPosition(target.selectionStart ?? 0);
			},
			[],
		);

		// React-event-shape adapters around the hook handlers. Discard the
		// hook's boolean return so they fit React's `void`-returning event
		// signature, and short-circuit when image paste is disabled so we do
		// not interfere with the textarea's default paste behavior.
		const onTextareaPaste = useCallback(
			(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
				if (!enableImagePaste) {
					return;
				}
				handleImagePaste(e);
			},
			[enableImagePaste, handleImagePaste],
		);
		const onTextareaDrop = useCallback(
			(e: React.DragEvent<HTMLTextAreaElement>) => {
				if (!enableImagePaste) {
					return;
				}
				handleImageDrop(e);
			},
			[enableImagePaste, handleImageDrop],
		);
		const onTextareaDragOver = useCallback(
			(e: React.DragEvent<HTMLTextAreaElement>) => {
				if (!enableImagePaste) {
					return;
				}
				handleImageDragOver(e);
			},
			[enableImagePaste, handleImageDragOver],
		);

		// Notify parent of template changes
		useEffect(() => {
			if (enableTemplateMentions) {
				onSelectedTemplatesChange?.(selectedTemplates);
			}
		}, [
			selectedTemplates,
			enableTemplateMentions,
			onSelectedTemplatesChange,
		]);

		// Notify parent of merged instructions changes
		useEffect(() => {
			if (enableTemplateMentions) {
				onMergedInstructionsChange?.(mergedInstructions);
			}
		}, [
			mergedInstructions,
			enableTemplateMentions,
			onMergedInstructionsChange,
		]);

		// Notify parent of merged integration IDs changes
		useEffect(() => {
			if (enableTemplateMentions) {
				onMergedIntegrationIdsChange?.(mergedIntegrationIds);
			}
		}, [
			mergedIntegrationIds,
			enableTemplateMentions,
			onMergedIntegrationIdsChange,
		]);

		// Notify parent of merged MCP config IDs changes
		useEffect(() => {
			if (enableTemplateMentions) {
				onMergedMcpConfigIdsChange?.(mergedMcpConfigIds);
			}
		}, [
			mergedMcpConfigIds,
			enableTemplateMentions,
			onMergedMcpConfigIdsChange,
		]);

		// Notify parent of merged Fabric AI tool IDs changes
		useEffect(() => {
			if (enableTemplateMentions) {
				onMergedFabricToolIdsChange?.(mergedFabricToolIds);
			}
		}, [
			mergedFabricToolIds,
			enableTemplateMentions,
			onMergedFabricToolIdsChange,
		]);

		// Close dropdown when clicking outside
		useEffect(() => {
			if (
				!enableTemplateMentions &&
				!enableFileMentions &&
				!enableStoryMentions &&
				!enableUserMentions
			) {
				return;
			}
			const handleClickOutside = (e: MouseEvent) => {
				if (
					containerRef.current &&
					!containerRef.current.contains(e.target as Node)
				) {
					closeAllMentions();
				}
			};

			document.addEventListener("mousedown", handleClickOutside);
			return () =>
				document.removeEventListener("mousedown", handleClickOutside);
		}, [
			enableTemplateMentions,
			enableFileMentions,
			enableStoryMentions,
			enableUserMentions,
			closeAllMentions,
		]);

		const canSend = value.trim() && !isLoading && !disabled;

		return (
			<div className={cn("space-y-2", className)}>
				{/* Header slot - context indicator, artifacts trigger, etc. */}
				{headerSlot && (
					<div className="px-1 min-w-0 overflow-x-hidden">
						{headerSlot}
					</div>
				)}

				{/* Active template indicator */}
				{enableTemplateMentions && selectedTemplates.length > 0 && (
					<ActiveTemplateIndicator
						templates={selectedTemplates}
						onRemove={removeTemplate}
					/>
				)}

				{/* Top slot - attached files, tool suggestions, etc. */}
				{topSlot}

				{/* Main Input Container */}
				<div
					ref={containerRef}
					className="relative rounded-2xl border bg-card shadow-md transition-all focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20 focus-within:shadow-lg"
				>
					{/* Template autocomplete dropdown */}
					{enableTemplateMentions &&
						isTemplateMentionOpen &&
						activeMentionType === "template" && (
							<TemplateAutocomplete
								results={templateMentionResults}
								isLoading={isTemplateMentionLoading}
								selectedIndex={templateSelectedIndex}
								onSelect={handleSelectTemplate}
								onHover={setTemplateSelectedIndex}
							/>
						)}

					{/* File autocomplete dropdown */}
					{enableFileMentions &&
						isFileMentionOpen &&
						activeMentionType === "file" && (
							<FileAutocomplete
								results={fileMentionResults}
								isLoading={isFileMentionLoading}
								selectedIndex={fileSelectedIndex}
								onSelect={handleSelectFile}
								onHover={setFileSelectedIndex}
							/>
						)}

					{/* Story autocomplete dropdown */}
					{enableStoryMentions &&
						isStoryMentionOpen &&
						activeMentionType === "story" && (
							<StoryAutocomplete
								results={storyMentionResults}
								isLoading={isStoryMentionLoading}
								selectedIndex={storySelectedIndex}
								onSelect={handleSelectStory}
								onHover={setStorySelectedIndex}
							/>
						)}

					{/* User autocomplete dropdown */}
					{enableUserMentions &&
						isUserMentionOpen &&
						activeMentionType === "user" && (
							<UserAutocomplete
								results={userMentionResults}
								isLoading={isUserMentionLoading}
								selectedIndex={userSelectedIndex}
								onSelect={handleSelectUser}
								onHover={setUserSelectedIndex}
							/>
						)}

					<div className="flex items-end gap-2 p-3">
						{/* Attachment button */}
						{showAttachButton && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
										onClick={onAttachClick}
										disabled={isLoading || attachDisabled}
									>
										<Paperclip className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">
									<p>{attachTooltip}</p>
								</TooltipContent>
							</Tooltip>
						)}

						{/* Textarea */}
						<Textarea
							ref={textareaRef}
							value={value}
							onChange={handleChange}
							onKeyDown={handleKeyDown}
							onSelect={handleSelect}
							onClick={handleSelect}
							onPaste={onTextareaPaste}
							onDrop={onTextareaDrop}
							onDragOver={onTextareaDragOver}
							placeholder={
								isRecording ? "Listening…" : placeholder
							}
							className="flex-1 min-h-[44px] max-h-[200px] resize-none border-0 bg-transparent px-2 py-2 focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/50 text-[15px]"
							disabled={isLoading || disabled}
						/>

						{/* Right cluster — timer + mic + send/stop share the
						 * same baseline. The outer row uses `items-end` so
						 * the textarea's bottom anchors the layout; this
						 * inner `items-center` cluster keeps the small
						 * recording chip vertically aligned with the mic
						 * icon (matches the copilot sidebar pattern).
						 * `self-end` pins the whole cluster to the bottom
						 * of the row alongside the paperclip on the left.
						 */}
						<div className="flex items-center gap-1.5 self-end">
							{/* Mic — voice dictation. Disabled while a turn is in
							 * flight (`isLoading`), parent forced `disabled`, or
							 * the browser does not expose SpeechRecognition.
							 * Shared `useVoiceDictation` keeps state machine,
							 * retries, cleanup, and error toasts symmetric with
							 * the copilot sidebar.
							 */}
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
									<Button
										type="button"
										variant="ghost"
										size="icon"
										onClick={handleMicClick}
										disabled={
											isLoading ||
											disabled ||
											!hasSpeechSupport
										}
										aria-label={tTooltips(
											"voiceInput.label",
										)}
										aria-pressed={isRecording}
										className={cn(
											"h-9 w-9 shrink-0 rounded-xl transition-colors",
											!hasSpeechSupport &&
												"text-muted-foreground opacity-40",
											hasSpeechSupport &&
												!isRecording &&
												"text-muted-foreground hover:text-foreground hover:bg-muted",
											hasSpeechSupport &&
												isRecording &&
												"text-destructive bg-destructive/10 motion-safe:animate-pulse",
										)}
									>
										<MicIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="top">
									<p>
										{!hasSpeechSupport
											? tTooltips(
													"voiceInput.unsupported",
												)
											: isLoading
												? tTooltips("voiceInput.busy")
												: isRecording
													? tTooltips(
															"voiceInput.recording",
														)
													: tTooltips(
															"voiceInput.idle",
														)}
									</p>
								</TooltipContent>
							</Tooltip>

							{/* Send → Stop morph.
							 *
							 * While a generation is in-flight (`isLoading` for
							 * direct chat, `isLoading || pendingApproval` for
							 * orchestrator) and an `onStop` handler is provided,
							 * the trailing button morphs into a neutral muted
							 * Stop control per spec § 8.5–8.6 / decision 8. No
							 * destructive red, no `transition-all`, no
							 * `hover:scale-*` (CLAUDE.md anti-patterns).
							 *
							 * If the consumer hasn't wired `onStop`, we fall
							 * back to the previous spinner-only treatment so
							 * the legacy callers keep working.
							 */}
							{onStop && (isLoading || pendingApproval) ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											onClick={onStop}
											aria-label={STOP_BUTTON_LABEL}
											className="h-9 w-9 shrink-0 rounded-xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
										>
											<StopCircle className="h-5 w-5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="top">
										<p>{STOP_BUTTON_TOOLTIP}</p>
									</TooltipContent>
								</Tooltip>
							) : (
								<Button
									onClick={onSend}
									disabled={!canSend}
									size="icon"
									autoLoading={false}
									className="h-9 w-9 shrink-0 rounded-xl transition-colors"
								>
									{isLoading && (
										<Loader2 className="h-4 w-4 animate-spin" />
									)}
									{!isLoading && <Send className="h-4 w-4" />}
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		);
	},
);
