"use client";

import {
	useCoAgent,
	useCopilotAction,
	useCopilotChat,
	useCopilotChatInternal,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { normalizeDocumentType, type ProjectContext } from "@repo/agent-types";
import { normalizeForComparison } from "@repo/utils/normalize-for-comparison";
import { AttachmentRegistryProvider } from "@saas/shared/components/copilot/AttachmentRegistry";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { createCopilotSidebarInput } from "@saas/shared/components/copilot/CopilotSidebarInput";
import { CopilotUserMessage } from "@saas/shared/components/copilot/CopilotUserMessage";
import type { MessageAttachmentListItem } from "@saas/shared/components/copilot/MessageAttachmentList";
import {
	makeAssistantMessageWithRunMark,
	makeSuggestionsListWithRunMark,
} from "@saas/shared/components/copilot/run-mark-wrappers";
import { useUserRunSignal } from "@saas/shared/components/copilot/use-user-run-signal";
import {
	type ClarifyingQuestionFrequency,
	useClarifyingQuestions,
} from "@saas/shared/components/copilot/useClarifyingQuestions";
import { CustomMessages } from "./copilot/CustomMessages";
import { DocumentAssistantOutcomesProvider } from "./copilot/DocumentAssistantOutcomesProvider";
import { HydratedMessagesProvider } from "./copilot/HydratedMessagesContext";
import "@copilotkit/react-ui/styles.css";
import "./DocumentEditor.css";
import { useRegisterFabricAgentContext } from "@saas/agents/components/FabricAgentLauncher";
import { useConfirmChangesOperationResult } from "@saas/agents/copilot/useConfirmChangesOperationResult";
import { useCodeContextLauncher } from "@saas/agents/hooks/useCodeContextLauncher";
import { useDefaultMcpInlineRender } from "@saas/agents/hooks/useDefaultMcpInlineRender";
import { useFabricMention } from "@saas/agents/hooks/useFabricMention";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useRegisterTiptapEditor } from "@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry";
import { usePickerIntentConsumer } from "@saas/projects/components/excalidraw-auto-insert/usePickerIntentConsumer";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	AlertTriangle,
	CheckIcon,
	ChevronDown,
	Code2Icon,
	EyeIcon,
	HistoryIcon,
	ImageIcon,
	Loader2,
	MoreHorizontal as MoreHorizontalIcon,
	RefreshCcwDotIcon,
	RefreshCw,
	SaveIcon,
	SparklesIcon,
	X as XIcon,
} from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { toast } from "sonner";
import { PromptSelector } from "../../prompts/components/PromptSelector";
import { useDiffPreview } from "../hooks/use-diff-view-mode";
import { useCollaborativeEditor } from "../hooks/useCollaborativeEditor";
import { useDocumentAssistantHistoryRealtimeSync } from "../hooks/useDocumentAssistantHistory";
import { useDocumentAssistantHistoryEnabled } from "../hooks/useDocumentAssistantHistoryEnabled";
import {
	isEmptyExtractionAgainstBaseline,
	isNoOpProposedContent,
} from "../lib/confirm-noop-guards";
import {
	diffPartialText,
	focusOnAnchor,
	focusOnLastDiff,
	fromMarkdown,
	repairMarkdownDocument,
	resetScrollTracking,
} from "../lib/diff-utils";
import {
	isDocumentGenerationStale,
	resolveGenerationTimestamp,
} from "../lib/document-generation-timestamp";
import { getEditorMarkdownForSave } from "../lib/editor-markdown-save";
import { extractMentionIdsFromHtml } from "../lib/extract-mention-ids";
import { uploadImage } from "../lib/image-upload-utils";
import {
	type MentionActiveIds,
	MentionStatusContext,
} from "../lib/mention-status-context";
import { createCollaborativeExtensions } from "../lib/tiptap-extensions";
import { createAdvancedExtensions } from "../lib/tiptap-extensions-advanced";
import { CollaborationStatus } from "./CollaborationStatus";
import { CopilotHistoryDrawer } from "./copilot/CopilotHistoryDrawer";
import { CopilotPersistenceHook } from "./copilot/CopilotPersistenceHook";
import { createCopilotSidebarHeader } from "./copilot/CopilotSidebarHeader";
import { createCopilotSidebarLauncher } from "./copilot/CopilotSidebarLauncher";
import { DiffPreviewPanes } from "./DiffPreviewPanes";
import { DiffReviewBar } from "./DiffReviewBar";
import { DiffViewModeToggle } from "./DiffViewModeToggle";
import { DocumentAssetsPanel } from "./DocumentAssetFrame";
import { DocumentDecisionPrecheckBanner } from "./DocumentDecisionPrecheckBanner";
import { DocumentGenerationFailedNotice } from "./DocumentGenerationFailedNotice";
import { DocumentGenerationProgress } from "./DocumentGenerationProgress";
import { DocumentTocRail } from "./DocumentTocRail";
import { DocumentVersionHistory } from "./DocumentVersionHistory";
import { useUpdateDocumentWithContext } from "./documents/useUpdateDocumentWithContext";
import { EditorToolbar } from "./EditorToolbar";
import { ImageLightbox } from "./ImageLightbox";
import { ImageSelectionToolbar } from "./ImageSelectionToolbar";
import {
	SlashCommandsExtension,
	setSlashCommandImageUploadHandler,
} from "./SlashCommands";
import { MeetingSelector } from "./stories/MeetingSelector";

// Non-collaborative extensions (matches document-generator pattern)
// Uses advanced extensions for proper diff highlighting support (<em> and <s> tags).
// The @-mention suggestion popover needs the active project + document ids,
// so this is built per-instance via
// `buildNonCollaborativeExtensions(projectId, documentId)` rather than as a
// module-level constant.
function buildNonCollaborativeExtensions(
	projectId: string | null,
	documentId: string | null,
) {
	return [
		...createAdvancedExtensions({ projectId, documentId }),
		SlashCommandsExtension,
	];
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
	GENERAL: "General",
	PRD: "PRD",
	PROPOSAL: "Proposal",
	BUSINESS_CASE: "Business Case",
	DESIGN_SYSTEM: "Design System",
	ARCHITECTURE: "Architecture",
	TECHNICAL_SPEC: "Technical Spec",
	USER_STORY: "Feature",
	API_SPEC: "API Spec",
};

export function getDocumentTypeLabel(type: string): string {
	return DOCUMENT_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

type Props = {
	projectId: string;
	documentId: string;
	/**
	 * When true, the action bar collapses its inline buttons into the
	 * overflow menu regardless of viewport width. The page-level wrapper
	 * (DocumentEditorPage) sets this when the AI sidebar is expanded — at
	 * that point the page is shifted but the lg: media query (viewport-based)
	 * doesn't know that the *available* width has shrunk, so without this
	 * flag the wide-tier inline buttons would overlap each other.
	 */
	isAiSidebarExpanded?: boolean;
	/**
	 * DOM mount points for the page-chrome action bar (Line 3). DocumentEditor
	 * portals its state-coupled chrome controls (Raw toggle + Version history
	 * into actionSlot, Save split-button into saveSlot) so the masthead stays
	 * consistent with the feature editor's layout while the state for those
	 * controls (viewMode, isSaving, hasUnsavedChanges) keeps living here where
	 * it belongs.
	 */
	actionSlot?: HTMLElement | null;
	saveSlot?: HTMLElement | null;
	/** Mount for the Yjs sync-status pill — lives on the breadcrumb row. */
	syncSlot?: HTMLElement | null;
	/**
	 * Group D — SSR-hydrated document-assistant context. The RSC page
	 * (`app/(saas)/app/.../documents/[documentId]/page.tsx`) fetches the
	 * caller's most recent ACTIVE document-assistant conversation and
	 * the client wrapper (`DocumentEditorPage`) passes the payload
	 * through. Messages themselves render via `<HydratedMessagesProvider>` +
	 * `<CustomMessages>` (see `HydratedMessagesContext.tsx`). The two
	 * props below let this component:
	 *
	 * - Stamp `documentRefKind` on every persistence write (Group H wires
	 *   `appendTurnForDocument`).
	 * - Track the current `conversationId` in local state so subsequent
	 *   turns append to the right conversation row (and so the "New
	 *   conversation" affordance in Group E can null it out).
	 *
	 * Defaults keep this component backwards-compatible with any callers
	 * that haven't been migrated yet (e.g. tests, storybook).
	 *
	 * Spec §6.2.
	 */
	documentRefKind?: "PROJECT_DOCUMENT" | "USER_STORY";
	initialAssistantConversationId?: string | null;
	/**
	 * Group E — visibility metadata from the same SSR fetch that produced
	 * `initialAssistantConversationId`. Drives the visibility chip in the
	 * `<CopilotSidebarHeader>` (FR-17 / FR-18, AC-8). Both default to a
	 * brand-new SHARED + unlocked thread so callers that haven't been
	 * migrated (e.g. tests) keep working.
	 */
	initialAssistantVisibility?: "SHARED" | "PRIVATE";
	initialAssistantVisibilityLockedAt?: string | null;
	/**
	 * Message ids from the SSR-hydrated conversation, threaded through to
	 * `CopilotPersistenceHook` so its walker doesn't re-fire
	 * `appendTurnForDocument` for already-persisted messages on every
	 * page reload. Derived in `DocumentEditorPage` from the same SSR
	 * payload that feeds `<HydratedMessagesProvider>`.
	 */
	initialPersistedMessageIds?: ReadonlyArray<string>;
	/**
	 * SSR-hydration seed for the live `<AttachmentRegistryProvider>`
	 * map. Derived at the page level from the same `initialAssistantMessages`
	 * payload. Pre-populating the registry on first render is what lets
	 * hydrated user bubbles render
	 * the rich `<MessageAttachmentList>` (inline image previews + file
	 * chips) on page reload instead of falling back to the legacy
	 * `[Attached: …]` filename caption.
	 */
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	/**
	 * Raw persisted-conversation blob from the SSR loader. Consumed by
	 * `<HydratedMessagesProvider>` (mounted around `<CopilotSidebar>`)
	 * so `<CustomMessages>` can render historical turns directly from
	 * React state instead of pushing them through `agent.messages`. This
	 * is the fix for the hydration flake — see HydratedMessagesContext
	 * docblock for the full Part-2 rationale.
	 */
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
};

interface AgentState {
	document: string;
	streamingContent?: string;
	documentType?: string;
	error?: string;
	retryCount?: number;
	focusAnchor?: string;
	// RAG contexts from uploaded documents, Notion pages, etc.
	ragContexts?: string[];
	// Project context (name, techStack, features, etc.)
	projectContext?: ProjectContext;
	// Integration status flags
	hasTeamsIntegration?: boolean;
	hasSlackIntegration?: boolean;
	hasGitHubIntegration?: boolean;
	hasRepoIntegration?: boolean;
	// Tenant context for tool execution
	projectId?: string;
	userId?: string;
	organizationId?: string;
	// Per-turn reasoning trace surfaced via ReasoningCollapsible (PR #1023).
	reasoningByTurn?: Record<
		number,
		{
			text: string;
			durationMs: number;
			startedAt: number;
			completedAt: number;
		}
	>;
	// Per-turn tool-call trace surfaced via ReasoningCollapsible (PR #1024).
	toolCallsByTurn?: Record<
		number,
		Array<{
			id: string;
			name: string;
			status: "pending" | "success" | "error";
			startedAt: number;
			durationMs?: number;
			errorMessage?: string;
		}>
	>;
}

export function DocumentEditor({
	projectId,
	documentId,
	isAiSidebarExpanded = false,
	actionSlot,
	saveSlot,
	syncSlot,
	documentRefKind = "PROJECT_DOCUMENT",
	initialAssistantConversationId = null,
	initialAssistantVisibility = "SHARED",
	initialAssistantVisibilityLockedAt = null,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
}: Props) {
	const [isRegenerating, setIsRegenerating] = useState(false);
	const { organizationId } = useOrganizationContext();
	// Group D — Local state holding the active document-assistant
	// `conversationId`. Seeded from the SSR payload, this is the id that
	// Group H's `appendTurnForDocument` mutation will pass on each
	// stream-completion event. It is held as state (not a derived value)
	// because Group E's "New conversation" affordance resets it to `null`
	// and the next persisted turn will lazy-create a fresh row.
	//
	// `documentRefKind` is read-only — it is fully determined by which RSC
	// route mounted this component (PROJECT_DOCUMENT for the document editor,
	// USER_STORY for the feature editor's reuse of this component) and never
	// changes mid-session.
	const [activeAssistantConversationId, setActiveAssistantConversationId] =
		useState<string | null>(initialAssistantConversationId);
	// Group E — local visibility state seeded from the SSR snapshot. Bumped
	// to the outer component so a child re-render of `DocumentEditorInner`
	// does NOT throw away the user's pending "Private to me" toggle (the
	// inner component re-mounts on prompt changes / yjs sync events). The
	// header (rendered inside the inner component) reads + mutates this.
	const [activeAssistantVisibility, setActiveAssistantVisibility] = useState<
		"SHARED" | "PRIVATE"
	>(initialAssistantVisibility);
	const [
		activeAssistantVisibilityLockedAt,
		setActiveAssistantVisibilityLockedAt,
	] = useState<string | null>(initialAssistantVisibilityLockedAt);
	// Surface the seeded id once so Group H wiring has an obvious console
	// breadcrumb during development. Removed when Group H lands the
	// persistence mutation (which will replace this with real telemetry).
	useEffect(() => {
		if (process.env.NODE_ENV !== "production") {
			console.warn("[DocumentEditor] document-assistant hydrated", {
				documentRefKind,
				documentRefId: documentId,
				activeAssistantConversationId,
				activeAssistantVisibility,
				activeAssistantVisibilityLockedAt,
			});
		}
		// Run once per mount; subsequent updates to
		// `activeAssistantConversationId` are intentionally not logged
		// (Group H will replace this with telemetry anyway).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const params = useParams();
	const searchParams = useSearchParams();

	// Check if we should auto-generate on mount (from Create Document with AI)
	const shouldGenerateOnMount = searchParams.get("generate") === "true";

	// Detect if we're on an org route by checking for organizationSlug in params
	const paramOrgSlug = params?.organizationSlug as string | undefined;
	const isOrgRoute = !!paramOrgSlug;
	const orgContextReady = !isOrgRoute || organizationId !== undefined;

	// Check if collaboration is enabled via environment variable
	const enableCollaboration =
		process.env.NEXT_PUBLIC_ENABLE_COLLABORATION === "true";

	// Fetch document with polling when regenerating.
	// refetchOnWindowFocus is gated on isRegenerating: it lets users who
	// switch tabs during a long generation see the completed document
	// when they return. While simply reading, refetching on focus would
	// re-seed the editor and reset the scroll position.
	const {
		data: documentData,
		isLoading,
		// Passed down to DocumentEditorInner so its FAILED watcher can tell a
		// freshly-polled snapshot apart from one already in flight when a
		// regenerate mutation resolved (see regenerationAckAtRef).
		dataUpdatedAt: documentDataUpdatedAt,
	} = useQuery({
		...orpc.projects.documents.get.queryOptions({
			// `organizationId` is part of the query key. Omitting it here
			// while DocumentEditorPage passes it cached the same document
			// under two keys, so opening one document cost two identical
			// round-trips. It is also required for correctness: without it
			// the fetch falls back to the viewer's session active-org, which
			// 404s for a mentioned user whose active org differs from the
			// route (Fizzy #1187, fixed in DocumentEditorPage but not here).
			input: { id: documentId, projectId, organizationId },
		}),
		enabled: orgContextReady,
		// Poll when actively regenerating OR when document status is GENERATING.
		// Floor cap: stop polling if generation runs longer than 10 minutes without completion.
		refetchInterval: (query) => {
			const doc = query.state.data?.document;
			if (!isRegenerating && doc?.status !== "GENERATING") {
				return false;
			}
			const startedAt = resolveGenerationTimestamp(
				doc?.generationStartedAt,
				doc?.updatedAt,
			);
			if (Date.now() - startedAt > 10 * 60 * 1000) {
				return false;
			}
			return 3000;
		},
		// "always" bypasses the 60s default staleTime so a user who tabs
		// away mid-generation always sees the completed document on return.
		refetchOnWindowFocus: (query) => {
			const doc = query.state.data?.document;
			if (!isRegenerating && doc?.status !== "GENERATING") {
				return false;
			}
			const startedAt = resolveGenerationTimestamp(
				doc?.generationStartedAt,
				doc?.updatedAt,
			);
			if (Date.now() - startedAt > 10 * 60 * 1000) {
				return false;
			}
			return "always";
		},
	});

	const document = documentData?.document;

	// Fetch project for context - wait for org context on org routes
	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const { data: projectData } = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	const project = projectData?.project;

	// `!orgContextReady` belongs in the loading test, not beside it: the two
	// queries above are disabled until the org resolves, and a disabled query
	// does not report `isLoading`, so without this the render falls straight
	// through to "Document not found" on every org-route load. Mirrors the
	// combined flag in DocumentEditorPage.
	if (isLoading || !orgContextReady) {
		return (
			<div className="flex items-center justify-center h-96">
				<div className="text-muted-foreground">Loading document...</div>
			</div>
		);
	}

	if (!document) {
		return (
			<div className="flex items-center justify-center h-96">
				<div className="text-muted-foreground">Document not found</div>
			</div>
		);
	}

	// If collaboration is enabled, use the collaborative wrapper
	// Otherwise, render the editor directly without collaboration
	if (enableCollaboration) {
		return (
			<CollaborativeDocumentEditor
				projectId={projectId}
				documentId={documentId}
				organizationId={organizationId ?? null}
				document={document}
				project={project ?? null}
				isRegenerating={isRegenerating}
				setIsRegenerating={setIsRegenerating}
				shouldGenerateOnMount={shouldGenerateOnMount}
				isAiSidebarExpanded={isAiSidebarExpanded}
				actionSlot={actionSlot}
				saveSlot={saveSlot}
				syncSlot={syncSlot}
				documentRefKind={documentRefKind}
				activeAssistantConversationId={activeAssistantConversationId}
				setActiveAssistantConversationId={
					setActiveAssistantConversationId
				}
				ssrConversationId={initialAssistantConversationId}
				activeAssistantVisibility={activeAssistantVisibility}
				setActiveAssistantVisibility={setActiveAssistantVisibility}
				activeAssistantVisibilityLockedAt={
					activeAssistantVisibilityLockedAt
				}
				setActiveAssistantVisibilityLockedAt={
					setActiveAssistantVisibilityLockedAt
				}
				initialPersistedMessageIds={initialPersistedMessageIds}
				initialAttachmentsByMessageId={initialAttachmentsByMessageId}
				initialAssistantMessages={initialAssistantMessages}
				documentDataUpdatedAt={documentDataUpdatedAt}
			/>
		);
	}

	// Non-collaborative mode - render directly
	return (
		<DocumentEditorInner
			projectId={projectId}
			documentId={documentId}
			organizationId={organizationId ?? null}
			document={document}
			project={project ?? null}
			isRegenerating={isRegenerating}
			setIsRegenerating={setIsRegenerating}
			enableCollaboration={false}
			ydoc={null}
			provider={null}
			isCollabConnected={false}
			isCollabSynced={false}
			collaborators={[]}
			userColor="#4ECDC4"
			shouldGenerateOnMount={shouldGenerateOnMount}
			isAiSidebarExpanded={isAiSidebarExpanded}
			actionSlot={actionSlot}
			saveSlot={saveSlot}
			syncSlot={syncSlot}
			documentRefKind={documentRefKind}
			activeAssistantConversationId={activeAssistantConversationId}
			setActiveAssistantConversationId={setActiveAssistantConversationId}
			activeAssistantVisibility={activeAssistantVisibility}
			setActiveAssistantVisibility={setActiveAssistantVisibility}
			activeAssistantVisibilityLockedAt={
				activeAssistantVisibilityLockedAt
			}
			setActiveAssistantVisibilityLockedAt={
				setActiveAssistantVisibilityLockedAt
			}
			initialPersistedMessageIds={initialPersistedMessageIds}
			initialAttachmentsByMessageId={initialAttachmentsByMessageId}
			initialAssistantMessages={initialAssistantMessages}
			ssrConversationId={initialAssistantConversationId}
			documentDataUpdatedAt={documentDataUpdatedAt}
		/>
	);
}

// Wrapper component that handles collaborative editing setup
// Has a timeout mechanism - if collaboration doesn't connect within 5 seconds,
// falls back to non-collaborative mode so users aren't blocked
function CollaborativeDocumentEditor({
	projectId,
	documentId,
	organizationId,
	document,
	project,
	isRegenerating,
	setIsRegenerating,
	shouldGenerateOnMount = false,
	isAiSidebarExpanded = false,
	actionSlot,
	saveSlot,
	syncSlot,
	documentRefKind,
	activeAssistantConversationId,
	setActiveAssistantConversationId,
	activeAssistantVisibility,
	setActiveAssistantVisibility,
	activeAssistantVisibilityLockedAt,
	setActiveAssistantVisibilityLockedAt,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
	ssrConversationId,
	documentDataUpdatedAt,
}: {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	document: {
		id: string;
		title: string;
		type: string;
		content: string | null;
		status?: string;
		generationError?: string | null;
		// Async decision pre-check result + the content hash it was judged
		// against, forwarded to the editor's inline contradiction banner.
		decisionPrecheck?: unknown;
		contentHash?: string | null;
		// Hash freshly computed from the live content by the read path, compared
		// against the pre-check's `checkedContentHash` for the banner's freshness
		// gate (decoupled from the embed-owned `contentHash`).
		currentContentHash?: string | null;
	};
	project: {
		name: string;
		description?: string | null;
		goals?: string | null;
		techStack: string[];
		features: string[];
		projectTypes?: string[];
		organizationId?: string | null;
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		defaultBranch?: string | null;
	} | null;
	isRegenerating: boolean;
	setIsRegenerating: (value: boolean) => void;
	shouldGenerateOnMount?: boolean;
	isAiSidebarExpanded?: boolean;
	actionSlot?: HTMLElement | null;
	saveSlot?: HTMLElement | null;
	syncSlot?: HTMLElement | null;
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	activeAssistantConversationId: string | null;
	setActiveAssistantConversationId: (value: string | null) => void;
	activeAssistantVisibility: "SHARED" | "PRIVATE";
	setActiveAssistantVisibility: (value: "SHARED" | "PRIVATE") => void;
	activeAssistantVisibilityLockedAt: string | null;
	setActiveAssistantVisibilityLockedAt: (value: string | null) => void;
	initialPersistedMessageIds?: ReadonlyArray<string>;
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
	ssrConversationId: string | null;
	documentDataUpdatedAt: number;
}) {
	const [isClient, setIsClient] = useState(false);
	const [connectionTimedOut, setConnectionTimedOut] = useState(false);

	// Ensure we're on the client before initializing Yjs
	useEffect(() => {
		setIsClient(true);
	}, []);

	// Initialize collaboration (only on client)
	const {
		ydoc,
		provider,
		isConnected: isCollabConnected,
		isSynced: isCollabSynced,
		collaborators,
		userColor,
	} = useCollaborativeEditor({
		documentId,
		projectId,
		enabled: isClient && !connectionTimedOut, // Disable if timed out
	});

	// Connection timeout - fall back to non-collaborative mode if the
	// PartyKit provider hasn't both connected and synced within the grace
	// window. 12s covers slow initial sync on prod (observed persistent
	// "connecting to collaboration server" spinner) without leaving users
	// waiting indefinitely.
	useEffect(() => {
		if (!isClient || connectionTimedOut) {
			return;
		}

		const timeout = setTimeout(() => {
			if (!isCollabConnected || !isCollabSynced) {
				console.warn(
					"[CollaborativeDocumentEditor] Connection timeout - falling back to non-collaborative mode",
				);
				setConnectionTimedOut(true);
			}
		}, 12000); // 12 second timeout

		// Clear timeout if we successfully connect
		if (isCollabConnected && isCollabSynced) {
			clearTimeout(timeout);
		}

		return () => clearTimeout(timeout);
	}, [isClient, isCollabConnected, isCollabSynced, connectionTimedOut]);

	// If connection timed out, render in non-collaborative mode.
	// MUST thread `actionSlot` / `saveSlot` / `syncSlot` through — they're
	// the portal targets for the Save split-button + Version history +
	// collab status pill. The original PR #802 (action-bar redesign)
	// added these to the success path but forgot the fallback, so a
	// collab timeout silently hid the Save / Version-history buttons.
	if (connectionTimedOut) {
		return (
			<DocumentEditorInner
				projectId={projectId}
				documentId={documentId}
				organizationId={organizationId}
				document={document}
				project={project}
				isRegenerating={isRegenerating}
				setIsRegenerating={setIsRegenerating}
				enableCollaboration={false}
				ydoc={null}
				provider={null}
				isCollabConnected={false}
				isCollabSynced={false}
				collaborators={[]}
				userColor="#4ECDC4"
				shouldGenerateOnMount={shouldGenerateOnMount}
				isAiSidebarExpanded={isAiSidebarExpanded}
				actionSlot={actionSlot}
				saveSlot={saveSlot}
				syncSlot={syncSlot}
				documentRefKind={documentRefKind}
				activeAssistantConversationId={activeAssistantConversationId}
				setActiveAssistantConversationId={
					setActiveAssistantConversationId
				}
				ssrConversationId={ssrConversationId}
				activeAssistantVisibility={activeAssistantVisibility}
				setActiveAssistantVisibility={setActiveAssistantVisibility}
				activeAssistantVisibilityLockedAt={
					activeAssistantVisibilityLockedAt
				}
				setActiveAssistantVisibilityLockedAt={
					setActiveAssistantVisibilityLockedAt
				}
				initialPersistedMessageIds={initialPersistedMessageIds}
				initialAttachmentsByMessageId={initialAttachmentsByMessageId}
				initialAssistantMessages={initialAssistantMessages}
				documentDataUpdatedAt={documentDataUpdatedAt}
			/>
		);
	}

	// Show loading while waiting for client-side hydration, ydoc, provider, connection, AND sync
	// The CollaborationCursor extension requires the provider's awareness to be fully ready,
	// which only happens after the initial sync is complete
	// Also verify provider.awareness exists - this can be undefined during initialization
	const isProviderReady =
		provider?.awareness &&
		typeof provider.awareness.getStates === "function";

	if (
		!isClient ||
		!ydoc ||
		!isProviderReady ||
		!isCollabConnected ||
		!isCollabSynced
	) {
		return (
			<div className="flex items-center justify-center h-96">
				<div className="flex flex-col items-center gap-3 text-muted-foreground">
					<Loader2 className="h-8 w-8 animate-spin" />
					<span>
						{isCollabConnected
							? "Syncing document..."
							: "Connecting to collaboration server..."}
					</span>
					<span className="text-xs text-muted-foreground/70">
						Will continue without collaboration if connection fails
					</span>
				</div>
			</div>
		);
	}

	// Additional safety check - verify ydoc is truly a Y.Doc with required methods
	if (typeof ydoc.getXmlFragment !== "function") {
		console.error(
			"[CollaborativeDocumentEditor] ydoc passed guard but doesn't have getXmlFragment!",
		);
		return (
			<div className="flex items-center justify-center h-96">
				<div className="flex flex-col items-center gap-3 text-muted-foreground">
					<Loader2 className="h-8 w-8 animate-spin" />
					<span>Initializing document structure...</span>
				</div>
			</div>
		);
	}

	return (
		<DocumentEditorInner
			projectId={projectId}
			documentId={documentId}
			organizationId={organizationId}
			document={document}
			project={project}
			isRegenerating={isRegenerating}
			setIsRegenerating={setIsRegenerating}
			enableCollaboration={true}
			ydoc={ydoc}
			provider={provider}
			isCollabConnected={isCollabConnected}
			isCollabSynced={isCollabSynced}
			collaborators={collaborators ?? []}
			userColor={userColor}
			shouldGenerateOnMount={shouldGenerateOnMount}
			isAiSidebarExpanded={isAiSidebarExpanded}
			actionSlot={actionSlot}
			saveSlot={saveSlot}
			syncSlot={syncSlot}
			documentRefKind={documentRefKind}
			activeAssistantConversationId={activeAssistantConversationId}
			setActiveAssistantConversationId={setActiveAssistantConversationId}
			activeAssistantVisibility={activeAssistantVisibility}
			setActiveAssistantVisibility={setActiveAssistantVisibility}
			activeAssistantVisibilityLockedAt={
				activeAssistantVisibilityLockedAt
			}
			setActiveAssistantVisibilityLockedAt={
				setActiveAssistantVisibilityLockedAt
			}
			initialPersistedMessageIds={initialPersistedMessageIds}
			initialAttachmentsByMessageId={initialAttachmentsByMessageId}
			initialAssistantMessages={initialAssistantMessages}
			ssrConversationId={ssrConversationId}
			documentDataUpdatedAt={documentDataUpdatedAt}
		/>
	);
}

// Inner component with CopilotKit hooks
interface CollaboratorInfo {
	name: string;
	color: string;
	image?: string;
}

interface DocumentEditorInnerProps {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	isRegenerating: boolean;
	setIsRegenerating: (value: boolean) => void;
	/** See note on the public DocumentEditor `isAiSidebarExpanded` prop. */
	isAiSidebarExpanded?: boolean;
	document: {
		id: string;
		title: string;
		type: string;
		content: string | null;
		version?: number;
		status?: string;
		generationError?: string | null;
		generationProgress?: number;
		generationStartedAt?: Date | string | null;
		updatedAt?: Date | string | null;
		// Async decision pre-check result + the content hash it was judged
		// against, surfaced by the editor's inline contradiction banner.
		decisionPrecheck?: unknown;
		contentHash?: string | null;
		// Hash freshly computed from the live content by the read path, compared
		// against the pre-check's `checkedContentHash` for the banner's freshness
		// gate (decoupled from the embed-owned `contentHash`).
		currentContentHash?: string | null;
	};
	project: {
		name: string;
		description?: string | null;
		goals?: string | null;
		techStack: string[];
		features: string[];
		projectTypes?: string[];
		organizationId?: string | null;
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		defaultBranch?: string | null;
	} | null;
	// Collaboration props (passed from outer component)
	enableCollaboration: boolean;
	ydoc: import("yjs").Doc | null;
	provider: import("y-partykit/provider").default | null;
	isCollabConnected: boolean;
	isCollabSynced: boolean;
	collaborators: CollaboratorInfo[];
	userColor: string;
	// Auto-generation on mount (from Create Document with AI)
	shouldGenerateOnMount?: boolean;
	/** See note on the public DocumentEditor `actionSlot` / `saveSlot` props. */
	actionSlot?: HTMLElement | null;
	saveSlot?: HTMLElement | null;
	syncSlot?: HTMLElement | null;
	// Group D / E — document-assistant context lifted to the outer
	// `DocumentEditor` so it survives inner re-mounts (yjs ticks, prompt
	// refetches). The inner component reads + mutates them via the setters
	// below. See `DocumentEditor` for the live state owners.
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	activeAssistantConversationId: string | null;
	setActiveAssistantConversationId: (value: string | null) => void;
	activeAssistantVisibility: "SHARED" | "PRIVATE";
	setActiveAssistantVisibility: (value: "SHARED" | "PRIVATE") => void;
	activeAssistantVisibilityLockedAt: string | null;
	setActiveAssistantVisibilityLockedAt: (value: string | null) => void;
	/** Threaded from the public `DocumentEditor` prop so the inner
	 * `<CopilotPersistenceHook>` mount can pre-seed its dedupe set. */
	initialPersistedMessageIds?: ReadonlyArray<string>;
	/** Threaded from the public `DocumentEditor` prop so the inner
	 * `<AttachmentRegistryProvider>` mount can pre-populate its map. */
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	/** Raw persisted-conversation blob from the SSR loader, threaded
	 * through to `<HydratedMessagesProvider>` which sits inside the
	 * inner component around `<CopilotSidebar>`. */
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
	/**
	 * The conversation id the SSR `initialAssistantMessages` blob belongs
	 * to. Distinct from `activeAssistantConversationId` (which is the
	 * LIVE, mutable id that flips when the user clicks "Start a new
	 * conversation"). `<HydratedMessagesProvider>` compares the two to
	 * decide whether the SSR-loaded history is still relevant — when
	 * they diverge (active points at a different / null conversation),
	 * the provider clears the historical set so the user doesn't see
	 * the archived thread's turns inside the brand-new one.
	 */
	ssrConversationId: string | null;
	/**
	 * `dataUpdatedAt` from the outer `documents.get` query that produces
	 * `document` (react-query's fetch-completion timestamp for that query's
	 * current data). Consumed by the FAILED watcher effect below via
	 * `regenerationAckAtRef` to distinguish a genuinely fresh failure from a
	 * stale pre-retry snapshot still in flight when a regenerate mutation
	 * resolved.
	 */
	documentDataUpdatedAt: number;
}

function formatTranscriptContexts(
	transcripts: Array<{
		meetingSubject: string;
		meetingDate: string | null;
		speakerNames: string[];
		content: string;
	}>,
): string[] {
	return transcripts.map((t) => {
		const date = t.meetingDate
			? new Date(t.meetingDate).toLocaleDateString()
			: "";
		const speakers =
			t.speakerNames.length > 0
				? `Speakers: ${t.speakerNames.join(", ")}\n`
				: "";
		return `[Meeting Transcript - ${t.meetingSubject}${date ? ` (${date})` : ""}]\n${speakers}${t.content}`;
	});
}

function DocumentEditorInner({
	projectId,
	documentId,
	organizationId,
	document,
	project,
	isRegenerating,
	setIsRegenerating,
	// Collaboration props from parent
	enableCollaboration,
	ydoc,
	provider,
	isCollabConnected,
	isCollabSynced,
	collaborators,
	userColor,
	// Auto-generation on mount (from Create Document with AI)
	shouldGenerateOnMount = false,
	isAiSidebarExpanded = false,
	actionSlot,
	saveSlot,
	syncSlot,
	// Document-assistant context (Group D/E) — read-only here; setters
	// are wired into the CopilotSidebar header's "New conversation"
	// handler and (in Group H) the post-stream `appendTurnForDocument`
	// success callback.
	documentRefKind,
	activeAssistantConversationId,
	setActiveAssistantConversationId,
	activeAssistantVisibility,
	setActiveAssistantVisibility,
	activeAssistantVisibilityLockedAt,
	setActiveAssistantVisibilityLockedAt,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
	ssrConversationId,
	documentDataUpdatedAt,
}: DocumentEditorInnerProps) {
	// Group E — feature flag (FR-27) for the chat-history header. Returns
	// true for personal context and for orgs with the flag ON. When
	// false, the `Header` prop on `<CopilotSidebar>` is left at its
	// CopilotKit default (no plus/history/visibility chip).
	const documentAssistantHistoryEnabled =
		useDocumentAssistantHistoryEnabled();

	// Fork-aware hydration state. Seeded from the SSR-init props, replaced
	// by `handleForked` below when the user forks a historical conversation
	// from the drawer. The three values move together:
	//   - `effectiveAssistantMessages` — what `<HydratedMessagesProvider>`
	//     and `CustomMessages` render as the historical-half of the sidebar.
	//   - `effectiveSsrConversationId` — keyed against `activeAssistant
	//     ConversationId` by the provider: when they match, the messages
	//     render; when they diverge (e.g. "Start new conversation"), the
	//     historical half goes empty. Replacing this with the forked id
	//     keeps the post-fork sidebar populated.
	//   - `effectivePersistedMessageIds` — pre-seeds the persistence walker
	//     so it does NOT re-persist any of the copied messages on the next
	//     fingerprint tick (they already exist in the new conversation
	//     row server-side from the fork transaction).
	//
	// Why local state (not derived): the SSR props are frozen at mount.
	// Fork happens mid-session and needs to replace them without a page
	// reload — otherwise the chat would flicker out before the new conv
	// renders.
	const [effectiveAssistantMessages, setEffectiveAssistantMessages] =
		useState<ReadonlyArray<Record<string, unknown>> | undefined>(
			initialAssistantMessages,
		);
	const [effectiveSsrConversationId, setEffectiveSsrConversationId] =
		useState<string | null>(ssrConversationId);
	const [effectivePersistedMessageIds, setEffectivePersistedMessageIds] =
		useState<ReadonlyArray<string> | undefined>(initialPersistedMessageIds);
	// Group E — CopilotKit's live message-store setter (FR-10). The
	// plus-icon affordance calls `setCopilotMessages([])` to clear the
	// transcript so the next user input lazy-creates a fresh row.
	//
	// `useCopilotChatInternal().setMessages` (NOT
	// `useCopilotMessagesContext().setMessages`) is the supported primitive
	// in CopilotKit 1.52: the context's setMessages writes into a separate
	// `useState([])` that the sidebar does not render from, so clearing it
	// has no visible effect. The internal hook routes through
	// `agent.setMessages(...)` which is the array `<CopilotSidebar>`'s
	// custom <CustomMessages> mounts read for the LIVE half of its
	// output (the historical half comes from <HydratedMessagesProvider>).
	const { setMessages: setCopilotMessages } = useCopilotChatInternal();
	// Cross-tab BroadcastChannel listener: when this user has the same
	// document open in another tab and renames / deletes / appends there,
	// the local drawer's list + viewer pane refetches without waiting for
	// a focus tick. Mount unconditionally — the hook no-ops when the
	// feature flag is off, when BroadcastChannel is unavailable (older
	// browsers / privacy mode), or when the scope doesn't match.
	useDocumentAssistantHistoryRealtimeSync({
		documentRefKind: "PROJECT_DOCUMENT",
		documentRefId: documentId,
		projectId,
		organizationId: organizationId ?? null,
	});
	// Group E — local drawer state. Group F's `<CopilotHistoryDrawer>`
	// reads it; the header flips it open.
	const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
	const [isProgressDismissed, setIsProgressDismissed] = useState(false);

	useEffect(() => {
		setIsProgressDismissed(false);
	}, [documentId]);
	// `documentRefKind` is read by `<CopilotSidebarHeader>` (Group E),
	// `<CopilotHistoryDrawer>` (Group F), and will be consumed by
	// `appendTurnForDocument` in Group H.
	// Router for URL manipulation (used by auto-generation and save redirect)
	const router = useRouter();
	// Used to build the Manage Prompts link when the page chrome owns the
	// gear (mirrors PromptSelector's own basePath/documentType-aware URL).
	const { basePath } = useOrganizationContext();
	const params = useParams();

	// Fetch document assets (architecture diagrams etc. produced by Agent Skills).
	// Polls while regenerating so a newly-saved diagram shows up automatically.
	const { data: assetsData } = useQuery({
		...orpc.projects.documents.listAssets.queryOptions({
			input: { projectId, documentId, organizationId },
		}),
		refetchInterval: isRegenerating ? 3000 : false,
	});
	const documentAssets = assetsData?.assets ?? [];

	// Resolve which @mention user IDs in the initial content are still active
	// members of this project/org. The result feeds MentionStatusContext so that
	// MentionNodeView can grey-out chips for removed users.
	const initialMentionIds = useMemo(
		() => extractMentionIdsFromHtml(document.content),
		// document.content is the initial snapshot — intentionally not reactive to
		// live editor changes (which would trigger a fetch on every keystroke).
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[document.id],
	);

	const { data: activeMentionsData } = useQuery({
		...orpc.projects.documents.resolveActiveMentions.queryOptions({
			input: { userIds: initialMentionIds, organizationId, projectId },
		}),
		enabled: initialMentionIds.length > 0,
		staleTime: 60_000,
	});

	const activeIdsSet: MentionActiveIds = useMemo(
		() =>
			activeMentionsData ? new Set(activeMentionsData.activeIds) : null,
		[activeMentionsData],
	);

	const fabricAgentContext = useMemo(
		() => ({
			projectId,
			projectName: project?.name,
			documentId,
			repositoryUrl: project?.repositoryUrl ?? null,
			repositoryOwner: project?.repositoryOwner ?? null,
			repositoryName: project?.repositoryName ?? null,
			prompt: `Help me with document ${document.title}. Use the current project and attached workspace context.`,
		}),
		[
			projectId,
			project?.name,
			documentId,
			project?.repositoryUrl,
			project?.repositoryOwner,
			project?.repositoryName,
			document.title,
		],
	);
	useRegisterFabricAgentContext(fabricAgentContext);

	// RAG contexts are no longer pre-fetched and injected into the system prompt.
	// The agent uses search_project_knowledge tool for on-demand retrieval,
	// which returns only relevant contexts per query instead of all 20+ contexts.
	// This reduces the system prompt from ~250K tokens to ~50K tokens.
	const documentContextData = { ragContexts: [] as string[] };
	const isLoadingContexts = false;

	// Check if code search is enabled for this project (controls hasRepoIntegration)
	const { data: ragSettingsData } = useQuery({
		...orpc.projects.ragSettings.get.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
		enabled: !!projectId,
		staleTime: 60000,
	});
	const codeSearchEnabled =
		ragSettingsData?.settings?.codeSearchEnabled ?? false;

	// Fetch recent Teams messages for chat editing
	// This provides the last 10 messages from linked Teams chats
	// staleTime: 30s — fresh enough for AI context; explicit refetch on AI-start handles updates
	const {
		data: teamsMessagesData,
		isLoading: isLoadingTeams,
		refetch: refetchTeamsMessages,
	} = useQuery({
		...orpc.integrations.teams.getRecentMessages.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId,
		staleTime: 30_000,
	});

	// Fetch recent Slack messages for chat editing
	// Mirrors the Teams pattern above for Slack parity
	const {
		data: slackMessagesData,
		isLoading: isLoadingSlack,
		refetch: refetchSlackMessages,
	} = useQuery({
		...orpc.integrations.slack.getRecentMessages.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId,
		staleTime: 30_000,
	});

	// Fetch meeting transcript context for chat editing
	// Provides recent meeting transcript summaries/content for AI context
	const { data: transcriptContextData, isLoading: isLoadingTranscripts } =
		useQuery({
			...orpc.projects.meetingTranscriptSync.getContext.queryOptions({
				input: {
					projectId,
					limit: 10,
					organizationId: organizationId ?? null,
				},
			}),
			enabled: !!projectId,
			staleTime: 300000, // Cache for 5 minutes (transcripts sync infrequently)
		});

	// Track if auto-generation has been triggered (prevents duplicates)
	const hasTriggeredAutoGeneration = useRef(false);

	// Safety check: validate collaboration prerequisites
	// We compute this early but handle it after hooks to maintain consistent hook order
	const isCollabPrerequisitesReady =
		!enableCollaboration ||
		(ydoc !== null &&
			typeof ydoc?.getXmlFragment === "function" &&
			provider !== null &&
			provider?.awareness !== null &&
			typeof provider?.awareness?.getStates === "function");

	const queryClient = useQueryClient();
	const { user } = useSession();
	// Simple state following the working CopilotKit pattern
	const [currentDocument, setCurrentDocument] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [showConfirmDialog, setShowConfirmDialog] = useState(false);
	const [previousContent, setPreviousContent] = useState<string>("");
	const [newContent, setNewContent] = useState<string>("");
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const [showImportedRegenWarning, setShowImportedRegenWarning] =
		useState(false);
	const [showVersionHistory, setShowVersionHistory] = useState(false);
	const [selectedPromptId, setSelectedPromptId] = useState<
		string | undefined
	>(undefined);
	const [selectedPromptVersionId, setSelectedPromptVersionId] = useState<
		string | undefined
	>(undefined);

	// Refs to access values without adding them as effect/action dependencies
	// (prevents CopilotKit setAction → context update → re-render loops)
	const selectedPromptIdRef = useRef(selectedPromptId);
	selectedPromptIdRef.current = selectedPromptId;
	const selectedPromptVersionIdRef = useRef(selectedPromptVersionId);
	selectedPromptVersionIdRef.current = selectedPromptVersionId;
	const currentDocumentRef = useRef(currentDocument);
	currentDocumentRef.current = currentDocument;

	// Lightbox state for read-only image viewing
	const [lightboxImage, setLightboxImage] = useState<{
		src: string;
		alt: string;
	} | null>(null);

	// Repository metadata from project settings (for GitHub CopilotKit actions)
	const repoOwner = (project as Record<string, unknown>)?.repositoryOwner as
		| string
		| undefined;
	const repoName = (project as Record<string, unknown>)?.repositoryName as
		| string
		| undefined;
	const repoBranch =
		((project as Record<string, unknown>)?.defaultBranch as
			| string
			| undefined) || "main";
	const repoProvider = project?.repositoryUrl?.includes("gitlab.com")
		? "gitlab"
		: "github";
	const hasGitHub = !!repoOwner && !!repoName && repoProvider === "github";
	const hasGitLab = repoProvider === "gitlab" && !!repoOwner && !!repoName;
	const gitlabProjectId = hasGitLab
		? encodeURIComponent(`${repoOwner}/${repoName}`)
		: "";
	const lastSavedContentRef = useRef<string>("");
	// Plain-text snapshot of the editor at the last persisted baseline.
	// Used as a fast pre-check in recomputeDirtyState — comparing
	// `editor.state.doc.textContent` to this string is an O(N) walk over the
	// doc's text nodes, with no HTML serialization or Turndown roundtrip.
	// On long documents this is dramatically cheaper than the full markdown
	// comparison and short-circuits the common typing case.
	const lastSavedTextRef = useRef<string>("");
	const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Debounce running getEditorMarkdownForSave (Turndown) on every keystroke.
	const dirtyCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Forward reference: the recomputeDirtyState helper is declared before
	// triggerAutoSave so it can be used inside onUpdate. We assign the latest
	// triggerAutoSave to this ref each render.
	const triggerAutoSaveRef = useRef<(() => void) | null>(null);
	const isManualSaveRef = useRef(false);
	const shouldRedirectAfterSaveRef = useRef(false);
	// True only while we are programmatically replacing editor content via
	// editor.commands.setContent (initial Yjs sync, content repair, view-mode
	// toggle, regen accept/reject, version restore, streaming diff render).
	// TipTap's onUpdate fires for these too, but they should NOT mark the
	// document as having unsaved user edits — that flag belongs to real input.
	const isProgrammaticUpdateRef = useRef(false);
	const editorRef = useRef<ReturnType<typeof useEditor>>(null);
	const { isLoading, visibleMessages } = useCopilotChat();
	// `useCopilotChat().visibleMessages` is empty on staging — proven via
	// [DIFF-AUDIT-TRACE] from the diag PR (#1148 + #1150): `len: 0` at
	// the moment a diff is sitting in the editor waiting for accept. The
	// stream that DOES carry the live messages (including the AGUI
	// tool-call entries) is `useCopilotChatInternal().messages` — the
	// same source the persistence walker reads. Wiring the diff-outcome
	// matcher to it lets the chip-stamping flow finally see the data.
	//
	// `internalMessagesForToolCallMatcher` is named verbosely so the
	// useCallback dep / linter rule doesn't pull in the OTHER
	// `useCopilotChatInternal().setMessages` already bound above for the
	// "+ New conversation" flow.
	const { messages: internalMessagesForToolCallMatcher } =
		useCopilotChatInternal();
	// `isLoading` flips true during CopilotKit AG-UI handshakes (info /
	// agent/connect) on mount and re-mount, even when no user-initiated
	// generation is happening. We keep `isLoading` for editor read-only
	// gating (which must be defensive), but the "Generating" pill needs a
	// signal that doesn't flash during background handshakes — it gates on
	// the explicit user-send signal from `useUserRunSignal`, marked by the
	// chat input's `onUserSend`. See the hook's doc-comment for the
	// transition-clear and reload-mid-run semantics.
	const { isUserGenerationActive, markUserRunInitiated, clearUserRunMark } =
		useUserRunSignal(isLoading);

	// Spec §3.8 FR-23 (Group G) — locate the most recent diff-producing
	// tool call in the live chat history so the DiffReviewBar can stamp
	// accept/reject outcomes on the correct entry inside the persisted
	// conversation messages JSON.
	//
	// Supported tool names (must match what the LangGraph agent actually
	// emits — confirmed on staging via API inspection of persisted blobs):
	//   - `write_document_local` — legacy GQL-format inline write
	//   - `confirm_changes`      — current AGUI-format diff confirmation
	//
	// Handles BOTH live message shapes CopilotKit 1.52 surfaces:
	//
	//   (a) GQL-format ActionExecutionMessage — has the `isActionExecutionMessage()`
	//       discriminator method, `name`, and `parentMessageId`. We map
	//       `messageId ← parentMessageId` (the assistant text turn that
	//       authored the call) and `toolCallId ← action.id`.
	//
	//   (b) AGUI-format assistant tool-call message — `{role:"assistant",
	//       toolCalls:[{id, type:"function", function:{name, arguments}}]}`
	//       with NO methods. We support both the top-level `tc.name`
	//       (older shape) and the nested `tc.function.name` (current
	//       OpenAI shape staging actually emits). The "parent" text
	//       message is the immediately-prior assistant text turn
	//       (CopilotKit splits a single turn into text + tool-calls);
	//       we walk backwards to find it, mirroring the persistence
	//       walker's behaviour in `CopilotPersistenceHook`.
	//
	// `messageId` MUST line up with the parent text message's id because
	// the server-side persistence merge (PR #1143) puts toolCalls on the
	// text message, so DiffOutcomeChip can find them.
	const DIFF_TOOL_NAMES: ReadonlyArray<string> = [
		"write_document_local",
		"confirm_changes",
	];
	const lastWriteDocumentLocalToolCall = useMemo(() => {
		// Walk the INTERNAL message store (visibleMessages is empty on
		// staging — see comment at the hook call site for evidence link).
		// Fall back to visibleMessages only as a last resort for any
		// legacy GQL surfaces that route through the public hook.
		const messagesToWalk =
			internalMessagesForToolCallMatcher &&
			internalMessagesForToolCallMatcher.length > 0
				? internalMessagesForToolCallMatcher
				: visibleMessages;
		if (!messagesToWalk || messagesToWalk.length === 0) {
			return null;
		}
		for (let i = messagesToWalk.length - 1; i >= 0; i--) {
			const m = messagesToWalk[i];
			if (!m) {
				continue;
			}
			const asMaybeAction = m as {
				isActionExecutionMessage?: () => boolean;
				id?: string;
				name?: string;
				parentMessageId?: string | null;
				role?: string;
				toolCalls?: unknown;
			};
			// Path (a): GQL-format ActionExecutionMessage.
			if (
				typeof asMaybeAction.isActionExecutionMessage === "function" &&
				asMaybeAction.isActionExecutionMessage()
			) {
				if (
					typeof asMaybeAction.id === "string" &&
					typeof asMaybeAction.name === "string" &&
					DIFF_TOOL_NAMES.includes(asMaybeAction.name)
				) {
					return {
						messageId:
							asMaybeAction.parentMessageId ?? asMaybeAction.id,
						toolCallId: asMaybeAction.id,
					};
				}
				continue;
			}
			// Path (b): AGUI-format tool-call-only assistant message.
			if (
				asMaybeAction.role === "assistant" &&
				Array.isArray(asMaybeAction.toolCalls) &&
				asMaybeAction.toolCalls.length > 0
			) {
				for (const rawTc of asMaybeAction.toolCalls as unknown[]) {
					if (!rawTc || typeof rawTc !== "object") {
						continue;
					}
					const tc = rawTc as {
						id?: unknown;
						name?: unknown;
						function?: { name?: unknown };
					};
					const tcId = typeof tc.id === "string" ? tc.id : null;
					const tcName =
						typeof tc.name === "string"
							? tc.name
							: typeof tc.function?.name === "string"
								? tc.function.name
								: null;
					if (!tcId || !tcName) {
						continue;
					}
					if (!DIFF_TOOL_NAMES.includes(tcName)) {
						continue;
					}
					// Find the parent text message (immediately-prior
					// assistant text turn). Walk backwards from i-1,
					// stopping at the first user message (turn boundary).
					let parentTextId: string | null = null;
					for (let p = i - 1; p >= 0; p--) {
						const prev = messagesToWalk[p] as {
							id?: string;
							role?: string;
							content?: unknown;
						};
						if (!prev?.id) {
							continue;
						}
						if (prev.role === "user") {
							break;
						}
						if (
							prev.role === "assistant" &&
							typeof prev.content === "string" &&
							prev.content.length > 0
						) {
							parentTextId = prev.id;
							break;
						}
					}
					return {
						messageId: parentTextId ?? asMaybeAction.id ?? tcId,
						toolCallId: tcId,
					};
				}
			}
		}
		return null;
	}, [internalMessagesForToolCallMatcher, visibleMessages]);

	// Chat-session attachment contexts. Kept separate from `localRagContexts`
	// (which holds project-level vector-searched docs + Teams/Slack and is
	// intentionally NOT published via `useCopilotReadable` — see comment at
	// the readable site below) so we can publish *just* the freshly-uploaded
	// files via the rag-context channel the agent actually reads. Without
	// this separate channel, paperclip uploads on this surface vanish into
	// `localRagContexts` and never reach the agent — which is why the user
	// saw "I cannot access the attached screenshot" replies even though the
	// chip showed in the bubble.
	const [chatAttachmentContexts, setChatAttachmentContexts] = useState<
		string[]
	>([]);

	// Callback to add uploaded document content to RAG contexts for follow-up
	// questions. `flushSync` forces the state commit synchronously so the
	// `useCopilotReadable` value is updated before the in-flight Send picks
	// up CopilotKit's context snapshot — without it the first turn after
	// upload races the React batch and ships an empty context.
	//
	// The entry arrives finished from `useCopilotDocumentUpload` — including
	// the image envelope, which differs from text/PDF: the upload pipeline
	// produces a `data:image/...;base64,…` URL for image files and
	// `buildAttachmentContextEntry` surfaces it as a markdown image link so
	// the agent's chat-node can peel the data URL out (`splitRagContextImages`)
	// and re-attach it as an `image_url` content part on the user message —
	// that's the only way vision-capable models actually consume the picture.
	// Without that branch images were sent as base64 text under a "Document"
	// label and the model answered "I can't view the attached image".
	const handleContentExtracted = useCallback((contextEntry: string) => {
		flushSync(() => {
			setChatAttachmentContexts((prev) => [...prev, contextEntry]);
		});
	}, []);

	// FIFO queue of per-message attachment batches, keyed positionally.
	// `CopilotSidebarInput` pushes the latest batch the moment a Send
	// resolves the upload pipeline; `CopilotPersistenceHook` shifts the
	// oldest batch when a user-role message reaches terminal state and
	// attaches the metadata to the `appendTurnForDocument` payload. See
	// `CopilotPersistenceHook.tsx` for the failure-mode analysis.
	const pendingAttachmentsRef = useRef<
		Array<
			Array<{
				id: string;
				s3Path: string;
				name: string;
				mimeType: string;
				sizeBytes?: number;
				kind: "image" | "file";
			}>
		>
	>([]);
	const handleAttachmentsForNextMessage = useCallback(
		(
			attachments: Array<{
				id: string;
				s3Path: string;
				name: string;
				mimeType: string;
				sizeBytes?: number;
				kind: "image" | "file";
			}>,
		) => {
			pendingAttachmentsRef.current.push(attachments);
		},
		[],
	);

	// Stable hook handed to the input factory below. It flushes the live editor
	// content into the agent's `document` state field right before every chat
	// send — the real closure is assigned to `syncDocumentBeforeSendRef.current`
	// once `editor`/`setAgentStateRef` are declared (further down). `useCoAgent`
	// is bidirectional, so an agent reply that omits `document` syncs an empty
	// value back onto the frontend state (see unified-server.ts:888-891);
	// re-asserting it before each send keeps the agent able to see the open
	// document's sections. Defined here so the factory memo can reference a
	// stable identity without re-registering.
	const syncDocumentBeforeSendRef = useRef<() => void>(() => {});
	const handleBeforeSend = useCallback(() => {
		syncDocumentBeforeSendRef.current();
	}, []);

	// Custom CopilotSidebar Input with document upload support
	const CustomSidebarInput = useMemo(
		() =>
			createCopilotSidebarInput({
				organizationId: organizationId ?? null,
				onContentExtracted: handleContentExtracted,
				surface: "document",
				compressionMaxDimension: 1024,
				compressionQuality: 0.8,
				onAttachmentsForNextMessage: handleAttachmentsForNextMessage,
				onBeforeSend: handleBeforeSend,
				onUserSend: markUserRunInitiated,
				onUserSendFailed: clearUserRunMark,
			}),
		[
			organizationId,
			handleContentExtracted,
			handleAttachmentsForNextMessage,
			handleBeforeSend,
			markUserRunInitiated,
			clearUserRunMark,
		],
	);

	// Suggestion chips and the assistant bubble's "Regenerate" button both
	// start a run through CopilotKit internals, bypassing the custom
	// `Input`'s `onUserSend` — see `run-mark-wrappers.tsx`. Memoized on
	// `markUserRunInitiated` (a stable identity from `useUserRunSignal`) so
	// `<CopilotSidebar>`'s `AssistantMessage` / `RenderSuggestionsList`
	// props keep a stable component identity across renders.
	const AssistantMessageWithMark = useMemo(
		() =>
			makeAssistantMessageWithRunMark(
				CopilotAssistantMessage,
				markUserRunInitiated,
			),
		[markUserRunInitiated],
	);
	const SuggestionsListWithMark = useMemo(
		() => makeSuggestionsListWithRunMark(markUserRunInitiated),
		[markUserRunInitiated],
	);

	// Group E — handles the plus-icon "New conversation" affordance in
	// the sidebar header (FR-10). Order matters:
	//   1. Archive the live thread server-side (if one exists).
	//   2. Null out the local conversationId AND reset visibility back to
	//      the SHARED + unlocked defaults so the next user input
	//      lazy-creates a brand-new row.
	//   3. Clear CopilotKit's in-memory transcript so the user sees a
	//      fresh greeting (same path the empty-thread first-load takes).
	//   4. Toast a polite confirmation so the user knows their click took
	//      effect — important because the visual change is subtle when
	//      the previous thread had only one or two turns.
	//
	// Failure handling: if the archive call fails (network blip,
	// FORBIDDEN, feature-flag), we still reset local state. The server
	// row stays ACTIVE and the next persisted turn appends to it — the
	// worst case is "the old thread reappears on next reload", which is
	// safer than silently leaving the user staring at the previous
	// transcript. The toast tells them what happened.
	const handleNewConversation = useCallback(async () => {
		const archivingId = activeAssistantConversationId;
		try {
			if (archivingId) {
				await orpcClient.agents.conversations.archiveForDocument({
					conversationId: archivingId,
					organizationId: organizationId ?? null,
				});
			}
			setActiveAssistantConversationId(null);
			setActiveAssistantVisibility("SHARED");
			setActiveAssistantVisibilityLockedAt(null);
			setCopilotMessages([]);
			toast.success("Started a new conversation");
		} catch (err) {
			// Local state still resets so the UI isn't stuck — the message
			// just acknowledges the partial-success path.
			setActiveAssistantConversationId(null);
			setActiveAssistantVisibility("SHARED");
			setActiveAssistantVisibilityLockedAt(null);
			setCopilotMessages([]);
			const message =
				err instanceof Error
					? err.message
					: "Could not archive the previous conversation.";
			toast.error(message);
		}
	}, [activeAssistantConversationId, organizationId, setCopilotMessages]);

	const handleOpenHistory = useCallback(() => {
		setHistoryDrawerOpen(true);
	}, []);

	// Custom CopilotSidebar Header — only assembled when the org has the
	// chat-history feature flag ON. When OFF, the `Header` prop on
	// `<CopilotSidebar>` is left at its CopilotKit default so existing
	// behaviour is unchanged for orgs that have disabled the feature
	// (FR-27).
	const CustomSidebarHeader = useMemo(() => {
		if (!documentAssistantHistoryEnabled) {
			return undefined;
		}
		return createCopilotSidebarHeader({
			title: "AI Assistant",
			documentRefKind,
			documentRefId: documentId,
			projectId,
			organizationId: organizationId ?? null,
			conversationId: activeAssistantConversationId,
			visibility: activeAssistantVisibility,
			visibilityLockedAt: activeAssistantVisibilityLockedAt,
			onNewConversation: handleNewConversation,
			onOpenHistory: handleOpenHistory,
			// Lifts the chip's pre-first-send toggle into the parent
			// state so `requestedVisibility` on the persistence hook
			// matches what the user picked. Without this, toggling to
			// PRIVATE before send would silently lazy-create the
			// conversation as SHARED (the SSR-initial value).
			onVisibilityChange: setActiveAssistantVisibility,
		});
	}, [
		documentAssistantHistoryEnabled,
		documentRefKind,
		documentId,
		projectId,
		organizationId,
		activeAssistantConversationId,
		activeAssistantVisibility,
		activeAssistantVisibilityLockedAt,
		handleNewConversation,
		handleOpenHistory,
	]);

	// Branded reopen launcher for the AI Assistant. Gated on the same
	// chat-history flag as the header: when OFF, leaving `Button` undefined
	// keeps CopilotKit's default round launcher; when ON, the header owns
	// closing (its X button) and this pill owns reopening (it renders only
	// while the panel is closed).
	const CustomSidebarLauncher = useMemo(() => {
		if (!documentAssistantHistoryEnabled) {
			return undefined;
		}
		return createCopilotSidebarLauncher();
	}, [documentAssistantHistoryEnabled]);

	// isConfirming is used for the regeneration confirmation dialog (different from streaming)
	const [isConfirming, setIsConfirming] = useState(false);
	// hasPendingConfirm: generation is done, Confirm Changes dialog is showing
	const [hasPendingConfirm, setHasPendingConfirm] = useState(false);
	// Callbacks for the DiffReviewBar to trigger accept/reject
	const confirmCallbacksRef = useRef<{
		accept: () => void;
		reject: () => void;
	} | null>(null);
	// Whether the current executing confirm has already been processed (armed a
	// card OR resolved as a no-op). Gates the one-time arm side effects so they
	// don't re-run on every render while the tool call is executing, and signals
	// Effect 4 to hold its write-back during the confirm window.
	const confirmArmedRef = useRef(false);
	// Whether the current confirm resolved as a no-op (normalized-identical
	// payload). While set, the confirm action renders nothing actionable.
	const confirmNoOpRef = useRef(false);
	// Marks a save as confirm-initiated so its outcome (version bump / no-op /
	// error) is surfaced to the user instead of being silent.
	const isConfirmSaveRef = useRef(false);
	// Guard to suppress auto-save during per-change diff review edits
	const isDiffReviewEditRef = useRef(false);
	// Guard to suppress auto-save while the Update-using-context diff is on screen
	const isContextUpdateActiveRef = useRef(false);

	// Ref to preserve the baseline content when regeneration starts
	// This prevents the CopilotKit streaming effect from corrupting the baseline
	// needed for the side-by-side comparison dialog
	const regenerationBaselineRef = useRef<string | null>(null);

	// Tracks the safety-timer handle so we can cancel it once regeneration
	// actually completes. Without this, the timer's closure holds a stale
	// `isRegenerating` value and fires a misleading "timeout" toast even
	// after the document has already been delivered successfully.
	const regenerationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	// Ref to store the respond function from regenerate_document action
	// This is called when user accepts/rejects in RegenerationConfirmDialog
	const regenerationRespondRef = useRef<
		((result: { accepted: boolean }) => void) | null
	>(null);

	// Ref for image upload handler — allows editorProps (created before handler) to access it
	const imageUploadRef = useRef<((files: FileList) => Promise<void>) | null>(
		null,
	);

	// Track if regeneration was triggered to prevent duplicate triggers
	const regenerationTriggeredRef = useRef(false);

	// Timestamp (Date.now()) captured the instant the generate mutation
	// resolves. The server (generate-document procedure) writes GENERATING +
	// clears generationError BEFORE it starts the Temporal workflow, so any
	// polled document snapshot fetched AFTER this instant that still shows
	// FAILED reflects a genuine failure during THIS run — not stale data left
	// over from the run we're retrying. Null whenever no mutation-backed
	// regeneration is in flight, which keeps the FAILED watcher below unarmed
	// for paths that don't go through the mutation.
	const regenerationAckAtRef = useRef<number | null>(null);

	// Track if this is a direct regeneration (button click) vs agent-based regeneration
	// Direct regeneration should NOT sync agent state back to editor (prevents AI response overwriting)
	const isDirectRegenerationRef = useRef(false);

	// LOCAL STATE for RAG contexts and project context
	// These are stored locally and sent via useCopilotReadable (one-way to agent)
	// This prevents them from being overwritten when useCoAgent syncs back from agent response
	const [localRagContexts, setLocalRagContexts] = useState<string[]>([]);
	const [localProjectContext, setLocalProjectContext] =
		useState<ProjectContext | null>(null);

	// Announcement text for the scroll-to-mention live region (screen reader)
	const [scrollAnnouncement, setScrollAnnouncement] = useState("");
	// Store document contexts separately so Teams messages can be updated independently
	const documentContextsRef = useRef<string[]>([]);

	// === STREAMING BASELINE REFS (fixes race condition with async state) ===
	// The baseline must be captured synchronously when loading starts.
	// Using state alone causes race conditions because setCurrentDocument is async
	// but Effect 3 needs the baseline immediately when agentState changes.
	const baselineRef = useRef<string>("");
	const wasLoadingRef = useRef(false);

	// View mode state for raw/rich toggle
	const [viewMode, setViewMode] = useState<"rich" | "raw">("rich");
	const [rawContent, setRawContent] = useState(
		repairMarkdownDocument(document?.content || ""),
	);

	// Create collaborative extensions when provider and ydoc are available
	// Additional guards ensure provider.awareness is ready before creating extensions
	const collaborativeExtensions = useMemo(() => {
		if (!enableCollaboration || !provider || !ydoc) {
			return null;
		}
		// Verify provider.awareness is ready
		if (
			!provider.awareness ||
			typeof provider.awareness.getStates !== "function"
		) {
			console.warn(
				"[DocumentEditor] Provider awareness not ready, skipping collaborative extensions",
			);
			return null;
		}
		// Verify ydoc has required methods
		if (typeof ydoc.getXmlFragment !== "function") {
			console.error(
				"[DocumentEditor] ydoc is not valid, skipping collaborative extensions",
			);
			return null;
		}
		return createCollaborativeExtensions({
			ydoc,
			provider,
			user: {
				name: user?.name || "Anonymous",
				color: userColor,
			},
			projectId,
			documentId,
		});
	}, [
		enableCollaboration,
		ydoc,
		provider,
		user?.name,
		userColor,
		projectId,
		documentId,
	]);

	// Non-collaborative extensions, rebuilt when the active document changes
	// so the @-mention suggestion popover queries the correct document scope.
	const nonCollaborativeExtensions = useMemo(
		() => buildNonCollaborativeExtensions(projectId, documentId),
		[projectId, documentId],
	);

	// Determine which extensions to use
	// If collaboration is enabled AND provider is ready, use collaborative extensions
	// Otherwise, use standard extensions
	const editorExtensions = useMemo(() => {
		if (enableCollaboration && collaborativeExtensions) {
			return collaborativeExtensions;
		}
		return nonCollaborativeExtensions;
	}, [
		enableCollaboration,
		collaborativeExtensions,
		nonCollaborativeExtensions,
	]);

	// Initialize TipTap editor
	// Parent component ensures provider is ready before this component mounts (when collaboration is enabled)
	const editor = useEditor(
		{
			extensions: editorExtensions,
			immediatelyRender: false,
			editorProps: {
				attributes: { class: "p-10 tiptap" },
				// Intercept paste to route image files through S3 upload (not base64)
				handlePaste: (_view, event) => {
					const files = event.clipboardData?.files;
					if (!files?.length) {
						return false;
					}
					const imageFiles = Array.from(files).filter(
						(f) =>
							f.type.startsWith("image/") &&
							f.size <= 5 * 1024 * 1024,
					);
					if (!imageFiles.length) {
						return false;
					}
					// Create a FileList-like object and route through S3 pipeline
					const dt = new DataTransfer();
					for (const f of imageFiles) {
						dt.items.add(f);
					}
					imageUploadRef.current?.(dt.files);
					return true; // Prevent TipTap's default base64 paste
				},
				// Intercept drop to route image files through S3 upload
				handleDrop: (_view, event) => {
					const files = event.dataTransfer?.files;
					if (!files?.length) {
						return false;
					}
					const imageFiles = Array.from(files).filter(
						(f) =>
							f.type.startsWith("image/") &&
							f.size <= 5 * 1024 * 1024,
					);
					if (!imageFiles.length) {
						return false;
					}
					event.preventDefault();
					const dt = new DataTransfer();
					for (const f of imageFiles) {
						dt.items.add(f);
					}
					imageUploadRef.current?.(dt.files);
					return true; // Prevent TipTap's default handling
				},
			},
			// Only set initial content in non-collaborative mode
			// In collaborative mode, content is loaded from Yjs
			content: enableCollaboration
				? undefined
				: document?.content
					? (() => {
							try {
								return fromMarkdown(document.content);
							} catch (e) {
								console.error(
									"[DocumentEditor] fromMarkdown failed on initial content:",
									e,
								);
								return "";
							}
						})()
					: "",
			onUpdate: ({ editor: ed }) => {
				// Only react to user input — skip during AI updates, diff review,
				// programmatic content replacement, or while the confirmation dialog
				// is showing diff marks.
				if (
					!ed.isEditable ||
					isLoading ||
					isRegenerating ||
					isDiffReviewEditRef.current ||
					isProgrammaticUpdateRef.current ||
					hasPendingConfirm ||
					isContextUpdateActiveRef.current
				) {
					return;
				}
				// Derive hasUnsavedChanges from a content equality check rather
				// than flipping it true on every keystroke. This makes the
				// "Saved" state self-correcting: typing then deleting back to
				// the original content snaps the button back to disabled, and
				// any spurious onUpdate that slips past the guards (e.g. an
				// async Y.js sync transaction) cannot leave the flag stuck on
				// dirty when the document actually matches what's persisted.
				scheduleDirtyCheck();
			},
		},
		[editorExtensions],
	);

	// Keep editor ref in sync so stale closures (e.g. useCopilotAction with [] deps) can access it
	editorRef.current = editor;

	// Register this editor with the Excalidraw auto-insert resolver
	// registry so the chat button can target it when it produces an
	// `<excalidraw-embed>` insert request. See spec §9 (active-editor
	// resolution algorithm). `useRegisterTiptapEditor` is no-op while
	// `editor` is null (still booting).
	useRegisterTiptapEditor({
		projectId,
		kind: "document",
		documentId,
		editor,
	});

	// Consume any pending picker intent the chat may have stashed in
	// sessionStorage before navigating to this document. Defers to the
	// next animation frame so the registration above is committed first.
	// `kind: "document"` is HARDCODED here -- making it configurable
	// would let an intent leak across page navigations.
	usePickerIntentConsumer({
		editor,
		projectId,
		kind: "document",
		documentId,
		documentLabel: document?.title ?? undefined,
	});

	// Wrapper for editor.commands.setContent that flips a ref so the editor's
	// onUpdate callback can distinguish programmatic content replacement from
	// real user input. Without this, every Yjs init / content repair / view
	// toggle / regen / version restore would mark the document as dirty and
	// the Save button would be permanently stuck on "Save" instead of "Saved".
	const applyProgrammaticContent = useCallback(
		(
			ed: ReturnType<typeof useEditor> | null | undefined,
			content: Parameters<
				NonNullable<typeof ed>["commands"]["setContent"]
			>[0],
		) => {
			if (!ed) {
				return;
			}
			isProgrammaticUpdateRef.current = true;
			ed.commands.setContent(content);
			queueMicrotask(() => {
				isProgrammaticUpdateRef.current = false;
			});
		},
		[],
	);

	// Single point that updates the persisted-content baseline. Capturing the
	// editor's textContent alongside the markdown lets recomputeDirtyState do
	// a cheap text-only pre-check before falling back to Turndown for the
	// rare formatting-only diff. Critical for long documents where Turndown
	// is the dominant cost.
	//
	// IMPORTANT: prefer the editor's *roundtripped* markdown over the raw
	// input. recomputeDirtyState compares against `getEditorMarkdownForSave`
	// output; if we baseline the raw markdown and the editor parses + Turndown
	// roundtrips it into a slightly different form (whitespace, list marker
	// normalisation, etc.), the very first onUpdate after mount sees
	// "currentMarkdown !== baseline" and marks the doc dirty even though the
	// user hasn't touched anything.
	const updateSavedBaseline = useCallback((markdown: string) => {
		const ed = editorRef.current;
		const normalised =
			ed && markdown.trim().length > 0
				? getEditorMarkdownForSave(ed) || markdown
				: markdown;
		lastSavedContentRef.current = normalised;
		lastSavedTextRef.current = ed?.state.doc.textContent ?? "";
	}, []);

	// Source of truth for the Save button: compare what the editor currently
	// holds against what we last persisted to the server. This makes the
	// "Saved" state self-correcting — typing then deleting back to the original
	// snaps the button back to "Saved", and any onUpdate that slips past the
	// programmatic guard (e.g. an out-of-band Y.js sync transaction) cannot
	// leave the flag stuck on dirty when the content actually matches.
	//
	// Performance contract for long documents:
	//   1. Fast path — compare editor.state.doc.textContent against the cached
	//      baseline text. This is an O(N) walk over text nodes with no HTML
	//      serialization or Turndown work. The vast majority of dirty
	//      keystrokes change the text content, so this short-circuits without
	//      ever invoking Turndown.
	//   2. Slow path — text matches the baseline, so the only way the doc
	//      can still be dirty is a formatting-only edit (bold toggle, etc.).
	//      Only then do we run getEditorMarkdownForSave (Turndown) for an
	//      authoritative comparison.
	const recomputeDirtyState = useCallback(() => {
		const ed = editorRef.current;

		const scheduleAutoSave = (isDirty: boolean) => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			if (isDirty) {
				autoSaveTimeoutRef.current = setTimeout(() => {
					triggerAutoSaveRef.current?.();
				}, 10000);
			}
		};

		if (viewMode === "raw") {
			const isDirty =
				rawContent.trim() !== lastSavedContentRef.current.trim();
			setHasUnsavedChanges(isDirty);
			scheduleAutoSave(isDirty);
			return;
		}

		if (!ed) {
			return;
		}

		// Fast path: text-only equality. Cheap on long docs.
		const currentText = ed.state.doc.textContent;
		if (currentText !== lastSavedTextRef.current) {
			setHasUnsavedChanges(true);
			scheduleAutoSave(true);
			return;
		}

		// Slow path: text matches; check for formatting-only differences.
		const currentMarkdown = getEditorMarkdownForSave(ed) || "";
		const isDirty =
			currentMarkdown.trim() !== lastSavedContentRef.current.trim();
		setHasUnsavedChanges(isDirty);
		scheduleAutoSave(isDirty);
	}, [viewMode, rawContent]);

	// Debounced wrapper — keeps the per-keystroke cost negligible since
	// getEditorMarkdownForSave runs Turndown across the whole document.
	const scheduleDirtyCheck = useCallback(() => {
		if (dirtyCheckTimeoutRef.current) {
			clearTimeout(dirtyCheckTimeoutRef.current);
		}
		dirtyCheckTimeoutRef.current = setTimeout(() => {
			dirtyCheckTimeoutRef.current = null;
			recomputeDirtyState();
		}, 150);
	}, [recomputeDirtyState]);

	// useCoAgent for streaming updates from LangGraph
	// NOTE: ragContexts and projectContext are NOT stored here because useCoAgent
	// syncs bidirectionally - when the agent responds, it replaces the state.
	// Since the agent doesn't return these fields, they would get lost.
	// Instead, they're stored in local state and sent via useCopilotReadable.
	//
	// `initialState` MUST be memoized: a fresh object on every render causes
	// CopilotKit / AG-UI to re-emit `agent/connect` handshakes, which on top of
	// presence-tick re-renders sends dozens of redundant /api/copilotkit POSTs
	// per document load and burns the per-user 500/min rate-limit budget.
	const repositoryUrl = (project as Record<string, unknown>)?.repositoryUrl;
	const initialAgentState = useMemo<AgentState>(
		() => ({
			document: "",
			streamingContent: "",
			documentType: document?.type
				? normalizeDocumentType(document.type)
				: "general",
			error: undefined,
			retryCount: 0,
			hasTeamsIntegration: false,
			hasSlackIntegration: false,
			hasGitHubIntegration: !!repositoryUrl,
			hasRepoIntegration: codeSearchEnabled && !!repositoryUrl,
			projectId,
			userId: user?.id ?? "",
			organizationId: organizationId ?? undefined,
			// Declare reasoningByTurn / toolCallsByTurn in initialState so
			// CopilotKit's useCoAgent doesn't filter them out of the React
			// state updates. Without these keys, STATE_SNAPSHOT events that
			// carry per-turn reasoning/tool-call traces (PR #976/#1023/#1024)
			// arrive on the SSE wire but are dropped before reaching
			// CopilotAssistantMessage's useCoAgent subscription.
			reasoningByTurn: {},
			toolCallsByTurn: {},
		}),
		[
			document?.type,
			repositoryUrl,
			codeSearchEnabled,
			projectId,
			user?.id,
			organizationId,
		],
	);

	const {
		state: agentState,
		setState: setAgentState,
		nodeName,
	} = useCoAgent<AgentState>({
		name: "project_document_generator",
		initialState: initialAgentState,
	});

	// `useCoAgent` returns a new `setState` function every render, so listing it in
	// a useEffect dep array causes an infinite render loop. Stash the latest
	// reference in a ref and read through it from effects that only need to fire
	// when their *data* dependencies change.
	const setAgentStateRef = useRef(setAgentState);
	setAgentStateRef.current = setAgentState;

	// Mirror the agent's proposed document into a ref so the confirm action —
	// whose render closure is stale under empty deps — can read the freshest
	// proposed content deterministically when the confirm arms (RC2 fix).
	const agentDocumentRef = useRef<string>("");
	agentDocumentRef.current = agentState?.document ?? "";

	// Keep the before-send sync closure (handed to the input factory above as
	// `handleBeforeSend`) pointing at the latest `editor` + `setAgentStateRef`.
	// Flushes the current editor markdown into `state.document` synchronously
	// right before each send so the outgoing turn always carries the open
	// document — guards against the bidirectional `useCoAgent` sync having
	// clobbered it to empty. Partial-update form only (never spread a stale
	// `agentState` snapshot).
	syncDocumentBeforeSendRef.current = () => {
		if (!editor) {
			return;
		}
		// This only mirrors editor content into the agent's
		// context state (not a save) — `?? ""` is fine; a failed read just
		// means the agent temporarily sees an empty document.
		const markdown = getEditorMarkdownForSave(editor) ?? "";
		flushSync(() => {
			setAgentStateRef.current({
				document: markdown,
			} as Partial<AgentState> as AgentState);
		});
	};

	// Track whether we've initialized the agent state
	const agentStateInitializedRef = useRef(false);
	const yjsInitializedRef = useRef(false);
	const ragContextsInitializedRef = useRef(false);
	const contentRepairAppliedRef = useRef(false);

	// Populate agent state with RAG contexts, Teams messages, and project context when data loads
	// This enables the chat sidebar to reference uploaded documents, Notion pages, and Teams discussions
	// IMPORTANT: Wait for BOTH queries to complete to avoid race condition where Teams messages
	// arrive after initial state is set (ragContextsInitializedRef would block the update)
	useEffect(() => {
		// Wait for all queries to finish loading before initializing
		// This prevents the race condition where contexts arrive before Teams/Slack/transcript data
		const bothQueriesComplete =
			!isLoadingContexts &&
			!isLoadingTeams &&
			!isLoadingSlack &&
			!isLoadingTranscripts;

		if (
			bothQueriesComplete &&
			documentContextData &&
			project &&
			!ragContextsInitializedRef.current
		) {
			// Vector-searched RAG contexts (already filtered and ranked by Qdrant)
			const documentContexts = documentContextData.ragContexts || [];

			// Format Teams messages as context strings
			// Format: [Teams - ChatName] Author (Date): Message
			const teamsContexts: string[] = [];
			if (
				teamsMessagesData?.messages &&
				teamsMessagesData.messages.length > 0
			) {
				for (const msg of teamsMessagesData.messages) {
					const date = msg.createdAt
						? new Date(msg.createdAt).toLocaleDateString()
						: "";
					const formattedMsg = `[Teams - ${msg.chatName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
					teamsContexts.push(formattedMsg);
				}
			}

			// Format Slack messages as context strings
			// Format: [Slack - #channelName] Author (Date): Message
			const slackContexts: string[] = [];
			if (
				slackMessagesData?.messages &&
				slackMessagesData.messages.length > 0
			) {
				for (const msg of slackMessagesData.messages) {
					const date = msg.createdAt
						? new Date(msg.createdAt).toLocaleDateString()
						: "";
					const formattedMsg = `[Slack - #${msg.channelName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
					slackContexts.push(formattedMsg);
				}
			}

			const transcriptContexts = formatTranscriptContexts(
				transcriptContextData?.transcripts ?? [],
			);

			// Combine all contexts: vector-searched documents first, then transcripts, then Teams/Slack messages
			const ragContexts = [
				...documentContexts,
				...transcriptContexts,
				...teamsContexts,
				...slackContexts,
			];

			// Clear features when DOCUMENT RAG exists (features vs RAG fix)
			// This prevents wizard-generated features from overriding actual uploaded content
			// Note: We only check documentContexts, not teamsContexts, because Teams messages
			// are discussion context, not document specifications that would replace features
			const hasDocumentRag = documentContexts.length > 0;

			ragContextsInitializedRef.current = true;
			// Store document contexts in ref for later Teams updates
			documentContextsRef.current = documentContexts;

			// Sync integration flags into agent state so the agent can bind the right search tools.
			// hasTeamsIntegration / hasSlackIntegration default to false in useCoAgent's initial state
			// and are never updated otherwise, so Teams/Slack search tools are never bound.
			// Recompute repo-related flags unconditionally — `prev?.hasRepoIntegration`
			// can be `false` (not undefined) from useCoAgent's initialState when this
			// component renders before the `ragSettings` query resolves, and `??`
			// would strand that stale `false` even after the toggle/URL are known.
			const repoUrlPresent = !!(project as Record<string, unknown>)
				?.repositoryUrl;
			setAgentState((prev) => ({
				document: prev?.document ?? "",
				streamingContent: prev?.streamingContent ?? "",
				documentType: prev?.documentType ?? document?.type ?? "general",
				error: prev?.error,
				retryCount: prev?.retryCount ?? 0,
				focusAnchor: prev?.focusAnchor,
				projectId: prev?.projectId ?? projectId,
				userId: prev?.userId ?? user?.id ?? "",
				organizationId:
					prev?.organizationId ?? organizationId ?? undefined,
				hasGitHubIntegration: repoUrlPresent,
				hasRepoIntegration: codeSearchEnabled && repoUrlPresent,
				hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
				hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			}));

			// Store in LOCAL state (not agent state) so it doesn't get overwritten
			// when useCoAgent syncs back from agent response
			setLocalRagContexts(ragContexts);
			setLocalProjectContext({
				name: project.name,
				description: project.description ?? undefined,
				goals: project.goals ?? undefined,
				techStack: project.techStack ?? [],
				features: hasDocumentRag ? [] : (project.features ?? []),
				projectTypes: project.projectTypes ?? [],
				repositoryUrl: (project as Record<string, unknown>)
					.repositoryUrl as string | undefined,
				repositoryOwner: (project as Record<string, unknown>)
					.repositoryOwner as string | undefined,
				repositoryName: (project as Record<string, unknown>)
					.repositoryName as string | undefined,
				defaultBranch: (project as Record<string, unknown>)
					.defaultBranch as string | undefined,
			});
		}
	}, [
		documentContextData,
		teamsMessagesData?.messages,
		slackMessagesData?.messages,
		transcriptContextData?.transcripts,
		project,
		isLoadingContexts,
		isLoadingTeams,
		isLoadingSlack,
		isLoadingTranscripts,
	]);

	// Sync integration flags into agent state whenever their source queries change.
	// The main initialization effect above is guarded by a one-shot ref, so toggling
	// "Enable code search for AI agents" (or connecting Teams/Slack) while the editor
	// is open wouldn't otherwise propagate to the agent state — leaving code-search
	// tools unbound until a hard reload.
	// Partial update form — matches the pattern already used elsewhere (e.g. the
	// document/focusAnchor updates). We read `setAgentState` through a ref because
	// `useCoAgent` returns a new function reference every render; listing it in deps
	// would cause an infinite update loop.
	const repoUrlForSync = (project as Record<string, unknown>)
		?.repositoryUrl as string | undefined;
	useEffect(() => {
		const repoUrlPresent = !!repoUrlForSync;
		setAgentStateRef.current({
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: repoUrlPresent,
			hasRepoIntegration: codeSearchEnabled && repoUrlPresent,
		} as AgentState);
	}, [
		teamsMessagesData?.hasTeamsIntegration,
		slackMessagesData?.hasSlackIntegration,
		repoUrlForSync,
		codeSearchEnabled,
	]);

	// Update localRagContexts when Teams/Slack/transcript data changes AFTER initialization
	// This allows fresh messages to be included in subsequent AI requests
	useEffect(() => {
		// Only run after initialization and when messages change
		if (
			!ragContextsInitializedRef.current ||
			isLoadingTeams ||
			isLoadingSlack
		) {
			return;
		}

		const transcriptContexts = formatTranscriptContexts(
			transcriptContextData?.transcripts ?? [],
		);

		// Format Teams messages
		const teamsContexts: string[] = [];
		if (
			teamsMessagesData?.messages &&
			teamsMessagesData.messages.length > 0
		) {
			for (const msg of teamsMessagesData.messages) {
				const date = msg.createdAt
					? new Date(msg.createdAt).toLocaleDateString()
					: "";
				const formattedMsg = `[Teams - ${msg.chatName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
				teamsContexts.push(formattedMsg);
			}
		}

		// Format Slack messages
		const slackContexts: string[] = [];
		if (
			slackMessagesData?.messages &&
			slackMessagesData.messages.length > 0
		) {
			for (const msg of slackMessagesData.messages) {
				const date = msg.createdAt
					? new Date(msg.createdAt).toLocaleDateString()
					: "";
				const formattedMsg = `[Slack - #${msg.channelName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
				slackContexts.push(formattedMsg);
			}
		}

		// Combine document contexts (from ref) with fresh transcripts/Teams/Slack messages
		const updatedRagContexts = [
			...documentContextsRef.current,
			...transcriptContexts,
			...teamsContexts,
			...slackContexts,
		];

		setLocalRagContexts(updatedRagContexts);
	}, [
		teamsMessagesData?.messages,
		slackMessagesData?.messages,
		transcriptContextData?.transcripts,
		isLoadingTeams,
		isLoadingSlack,
	]);

	// Initialize Yjs document with content when first synced (only in collaborative mode)
	useEffect(() => {
		if (
			enableCollaboration &&
			isCollabSynced &&
			ydoc &&
			!yjsInitializedRef.current &&
			document?.content &&
			editor
		) {
			// Check if Yjs doc is empty (first load)
			const xmlFragment = ydoc.getXmlFragment("prosemirror");
			if (xmlFragment.length === 0) {
				// Set content through the editor which will sync to Yjs
				applyProgrammaticContent(
					editor,
					fromMarkdown(document.content),
				);
			}
			yjsInitializedRef.current = true;
		}
	}, [enableCollaboration, isCollabSynced, document?.content, editor, ydoc]);

	// Scroll to a mentioned anchor when the URL hash matches `#m-<anchor>`.
	// Mentions are stored as `data-mention-id="m_<rand>"` (underscore form);
	// the URL fragment uses `#m-<rand>` (hyphen form) for cleaner URLs.
	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!editor) {
			return;
		}
		const hash = window.location.hash;
		if (!hash.startsWith("#m-")) {
			return;
		}
		// Anchors are generated from `Math.random().toString(36)` + a base-36
		// timestamp, so legitimate ids only contain `[0-9a-z_]`. Reject
		// anything else so a crafted hash can't break querySelector.
		const fragment = hash.slice(3);
		if (!/^[0-9a-z_]+$/.test(fragment)) {
			return;
		}
		const dataValue = `m_${fragment}`;
		let cancelled = false;
		let retries = 0;
		const MAX_RETRIES = 10; // ~2 s of hydration window
		let flashTimer: ReturnType<typeof setTimeout> | undefined;
		let announcementTimer: ReturnType<typeof setTimeout> | undefined;
		const tryScroll = () => {
			if (cancelled) {
				return;
			}
			const el = window.document.querySelector<HTMLElement>(
				`span[data-mention-id="${dataValue}"]`,
			);
			if (!el) {
				if (retries >= MAX_RETRIES) {
					return;
				}
				retries += 1;
				setTimeout(tryScroll, 200);
				return;
			}
			el.scrollIntoView({ block: "center" });
			el.classList.add("mention-flash");
			flashTimer = setTimeout(
				() => el.classList.remove("mention-flash"),
				1500,
			);
			// Announce the navigation to screen readers via the polite live region.
			setScrollAnnouncement("Jumped to mention in document.");
			announcementTimer = setTimeout(
				() => setScrollAnnouncement(""),
				3000,
			);
		};
		tryScroll();
		return () => {
			cancelled = true;
			if (flashTimer !== undefined) {
				clearTimeout(flashTimer);
			}
			if (announcementTimer !== undefined) {
				clearTimeout(announcementTimer);
			}
		};
	}, [editor]);

	// Show toast notification when agent error occurs
	useEffect(() => {
		if (agentState?.error) {
			toast.error(agentState.error);
		}
	}, [agentState?.error]);

	// Initialize agent state with document content on mount
	// Use ref to ensure this only runs once even if dependencies change
	// IMPORTANT: Use getEditorMarkdownForSave to ensure proper markdown conversion
	// This handles cases where document.content might have raw HTML (e.g., TipTap tables)
	useEffect(() => {
		if (document?.content && editor && !agentStateInitializedRef.current) {
			// Get properly converted markdown from the editor
			// This uses Turndown with custom rules for TipTap tables
			const editorMarkdown = getEditorMarkdownForSave(editor);
			// Use editor markdown if available, otherwise fall back to document
			// content. Fizzy #1987: `editorMarkdown` is null on serialization
			// failure (was "" before) — that already routes into this same
			// document.content fallback below.
			const markdownContent =
				editorMarkdown && editorMarkdown.trim().length > 0
					? editorMarkdown
					: document.content;

			agentStateInitializedRef.current = true;
			// Use properly converted markdown for agent state
			// This ensures the AI sees markdown, not raw HTML
			setCurrentDocument(markdownContent);
			// IMPORTANT: Preserve ragContexts and projectContext (may be set before or after)
			setAgentState((prev) => ({
				...prev,
				document: markdownContent,
				streamingContent: markdownContent,
			}));
			updateSavedBaseline(markdownContent);
			// CRITICAL: Also set baselineRef so diff highlighting works correctly
			// Without this, the first streaming would see an empty baseline and show all content as additions
			baselineRef.current = markdownContent;

			// If TipTap editor was initialized empty (because document was generating),
			// populate the editor canvas immediately once generated content arrives.
			if (
				editorMarkdown !== null &&
				editorMarkdown.trim().length === 0 &&
				!enableCollaboration
			) {
				try {
					applyProgrammaticContent(
						editor,
						fromMarkdown(markdownContent),
					);
				} catch {
					/* leave canvas as-is on programmatic update error */
				}
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, document?.content]);

	// Repair malformed loaded content once after the editor has hydrated.
	// This catches previously saved/collaborative documents that already contain
	// broken code blocks and would otherwise bypass the markdown import cleanup.
	useEffect(() => {
		if (
			!editor ||
			isLoading ||
			isRegenerating ||
			contentRepairAppliedRef.current
		) {
			return;
		}

		if (enableCollaboration && !isCollabSynced) {
			return;
		}

		const currentMarkdown = getEditorMarkdownForSave(editor);
		const fallbackMarkdown = repairMarkdownDocument(
			document?.content || "",
		);
		// `currentMarkdown` is null on serialization failure (was
		// "" before) — that already routes into the fallbackMarkdown branch.
		const sourceMarkdown =
			currentMarkdown && currentMarkdown.trim().length > 0
				? currentMarkdown
				: fallbackMarkdown;
		const repairedMarkdown = repairMarkdownDocument(sourceMarkdown);

		contentRepairAppliedRef.current = true;

		if (
			repairedMarkdown.trim().length > 0 &&
			repairedMarkdown !== sourceMarkdown
		) {
			applyProgrammaticContent(editor, fromMarkdown(repairedMarkdown));
			setCurrentDocument(repairedMarkdown);
			setRawContent(repairedMarkdown);
			// applyProgrammaticContent dispatches synchronously, so the editor
			// already holds the repaired content by the time we capture the
			// text snapshot here.
			updateSavedBaseline(repairedMarkdown);
			baselineRef.current = repairedMarkdown;
		}
	}, [
		document?.content,
		editor,
		enableCollaboration,
		isCollabSynced,
		isLoading,
		isRegenerating,
	]);

	// NOTE: Streaming effects are defined below in the "STREAMING PATTERN" section.
	// This section follows the exact ag-ui-demo pattern for reliable diff highlighting.

	// Auto-save pending changes before AI updates begin
	useEffect(() => {
		if (isLoading && hasUnsavedChanges) {
			// Cancel the debounce timer and save immediately
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			handleSave();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isLoading]);

	// Refetch Teams/Slack messages when AI request starts (rising edge only)
	// This ensures the next request has the latest context
	const prevIsLoadingRef = useRef(false);
	useEffect(() => {
		if (isLoading && !prevIsLoadingRef.current) {
			// Refetch messages in the background
			// The updated messages will be available for the NEXT AI request
			refetchTeamsMessages();
			refetchSlackMessages();
		}
		prevIsLoadingRef.current = isLoading;
	}, [isLoading, refetchTeamsMessages, refetchSlackMessages]);

	// Cleanup auto-save timeout on unmount
	useEffect(() => {
		return () => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
			}
		};
	}, []);

	// Detect when document content changes during regeneration
	// For regeneration: Load new content directly into editor (no diff highlighting)
	// and show a simple Accept/Reject confirmation
	useEffect(() => {
		if (!isRegenerating || isConfirming) {
			return;
		}

		const baseline = regenerationBaselineRef.current;
		const polledContent = document?.content;

		// Content must exist and differ from baseline.
		// baseline can be null/empty for first-generation — any non-empty content triggers.
		const hasNewContent =
			polledContent != null &&
			polledContent.length > 0 &&
			polledContent !== (baseline || "");

		if (!hasNewContent) {
			return;
		}

		// Cancel the safety timer — regeneration succeeded, so the
		// "taking longer than expected" notice must not fire afterwards.
		if (regenerationTimeoutRef.current) {
			clearTimeout(regenerationTimeoutRef.current);
			regenerationTimeoutRef.current = null;
		}

		// Batch all state updates to prevent flicker
		startTransition(() => {
			// Stop polling and set confirming flag
			setIsRegenerating(false);
			setIsConfirming(true);
			// Store previous and new content using the preserved baseline
			setPreviousContent(baseline || "");
			setNewContent(polledContent);

			// For regeneration: Load new content directly into editor (no diff)
			// The user can then Accept (keep) or Reject (revert)
			const markdown = fromMarkdown(polledContent);
			requestAnimationFrame(() => {
				applyProgrammaticContent(editor, markdown);
			});
			setCurrentDocument(polledContent);
			// NOTE: Don't call setAgentState here - it can trigger CopilotKit to respond
			// The agent state will be updated when user accepts/rejects

			// Show confirmation dialog
			setShowConfirmDialog(true);
			// Clear the baseline ref after use
			regenerationBaselineRef.current = null;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [document?.content, isRegenerating, isConfirming]);

	// FAILED watcher (issue #720): the effect above only ever looks for NEW
	// content — a workflow that fails mid-run never writes content, so it had
	// nothing to react to, and the "Regenerating Document…" spinner sat there
	// until the 5-minute safety timer finally gave up. This effect watches
	// the polled `document.status` for a genuine FAILED and stops the
	// spinner the moment one shows up.
	//
	// The tricky part is telling a FRESH failure apart from a STALE one. The
	// generate-document procedure writes GENERATING + clears
	// `generationError` BEFORE it starts the Temporal workflow (see
	// `markDocumentGenerationStarted`), so:
	//   - `regenerationAckAtRef.current` is the instant the mutation that
	//     kicked off THIS run resolved.
	//   - Any polled snapshot whose `dataUpdatedAt` is AFTER that instant was
	//     fetched no earlier than the server's GENERATING write, so a FAILED
	//     status in it can only be a real failure from THIS run — never a
	//     leftover FAILED row from the run being retried.
	//   - A snapshot fetched BEFORE that instant (a poll that was already in
	//     flight when the mutation resolved) is ignored: it can still carry
	//     the PREVIOUS run's FAILED status even though this run is already
	//     underway.
	useEffect(() => {
		if (!isRegenerating) {
			return;
		}
		const ackAt = regenerationAckAtRef.current;
		// Null means either the mutation hasn't resolved yet, or this
		// regeneration didn't go through the mutation at all (see the
		// CopilotKit / agent auto-regen paths) — stay unarmed rather than
		// react to a status we can't date.
		if (ackAt == null) {
			return;
		}
		if (document?.status !== "FAILED") {
			return;
		}
		if (documentDataUpdatedAt <= ackAt) {
			// Stale pre-retry snapshot — ignore it.
			return;
		}

		// Genuine mid-workflow failure: stop the regenerating state so the
		// existing DocumentGenerationFailedNotice overlay takes over.
		if (regenerationTimeoutRef.current) {
			clearTimeout(regenerationTimeoutRef.current);
			regenerationTimeoutRef.current = null;
		}
		setIsRegenerating(false);
		toast.error(
			document.generationError
				? `Document generation failed: ${document.generationError}`
				: "Document generation failed. Please try again.",
		);
		if (regenerationRespondRef.current) {
			regenerationRespondRef.current({ accepted: false });
			regenerationRespondRef.current = null;
		}
		regenerationTriggeredRef.current = false;
		regenerationBaselineRef.current = null;
		regenerationAckAtRef.current = null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		document?.status,
		document?.generationError,
		documentDataUpdatedAt,
		isRegenerating,
	]);

	// === STREAMING PATTERN - REF-BASED TO FIX RACE CONDITIONS ===
	// The key insight: React state updates are async, but we need the baseline
	// IMMEDIATELY when streaming starts. Using refs ensures synchronous access.

	// Effect 1: Capture baseline when loading STARTS (transition from false to true)
	// Uses ref to detect the transition and capture baseline synchronously
	useEffect(() => {
		// Do not advance the loading-edge ref until the editor exists.
		// `useEditor` runs with `immediatelyRender: false`, so `editor` is
		// null on the first commit, while `isLoading` tracks the assistant's
		// connect handshake rather than a user request and can already be
		// true. Serializing a null editor returns null, which the branch
		// below would report as a failed AI review; consuming the transition
		// would also lose the baseline for the run that follows. `editor` is
		// a dependency, so this re-runs once the instance exists.
		if (!editor) {
			return;
		}
		// Only capture baseline on transition: wasLoading=false → isLoading=true
		if (isLoading && !wasLoadingRef.current && !isRegenerating) {
			// Reset scroll tracking for new streaming session
			// This clears the "user scrolled away" flag so auto-scroll works
			resetScrollTracking();

			const baseline = getEditorMarkdownForSave(editor);
			// Null means serialization failed. Do NOT overwrite the
			// baseline/currentDocument with "" — Effect 3 treats an empty
			// baseline as "no prior content" and replaces the editor with the
			// AI's raw output unfiltered, and a later Reject would then restore
			// that empty string, wiping real content. Keep the last-known-good
			// baseline instead.
			if (baseline !== null) {
				baselineRef.current = baseline;
				setCurrentDocument(baseline); // Keep state in sync for other uses
			} else {
				toast.error(
					"Couldn't read the document content to start this AI review — please retry.",
				);
			}
		}
		wasLoadingRef.current = isLoading;
		editor.setEditable(!isLoading && !isRegenerating);
	}, [isLoading, isRegenerating, editor]);

	// Effect 2: Final diff when nodeName becomes "end"
	// Uses baselineRef instead of currentDocument state to avoid stale closure
	useEffect(() => {
		if (nodeName === "end" && !isRegenerating) {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			// Only show diff if we have BOTH baseline AND new content
			if (
				baseline.trim().length > 0 &&
				newDocument.trim().length > 0 &&
				baseline !== newDocument
			) {
				const diff = diffPartialText(baseline, newDocument, true);
				const markdown = fromMarkdown(diff);
				// TipTap's setContent calls flushSync internally; deferring to a
				// microtask moves it out of the useEffect's render phase, where
				// React would otherwise throw "flushSync was called from inside
				// a lifecycle method".
				queueMicrotask(() => {
					isDiffReviewEditRef.current = true;
					applyProgrammaticContent(editor, markdown);
					isDiffReviewEditRef.current = false;
				});
			}

			// Focus on the changed section using focusAnchor from agent state
			const anchor = agentState?.focusAnchor;
			if (anchor && anchor.trim().length > 0) {
				setTimeout(() => {
					focusOnAnchor(editor, anchor);
				}, 100);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeName, isRegenerating, agentState?.document]);

	// Effect 3: Streaming diff updates
	// CRITICAL: Uses baselineRef.current instead of currentDocument state
	// This fixes the race condition where state hasn't updated yet
	useEffect(() => {
		if (isLoading && !isRegenerating) {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			// Skip if baseline is empty (shouldn't happen, but safety check)
			if (baseline.trim().length === 0) {
				// No baseline - just show the new content without diff
				if (newDocument.trim().length > 0) {
					const markdown = fromMarkdown(newDocument);
					applyProgrammaticContent(editor, markdown);
				}
				return;
			}

			// Skip if new document is empty or same as baseline
			if (newDocument.trim().length === 0 || newDocument === baseline) {
				return;
			}

			const diff = diffPartialText(baseline, newDocument);
			const markdown = fromMarkdown(diff);
			applyProgrammaticContent(editor, markdown);
			// Follow the last diff element during streaming
			focusOnLastDiff(editor);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentState?.document, isRegenerating, isLoading]);

	// Effect 4: Sync editor to state when not loading
	// Also updates baselineRef so it's ready for the next streaming session
	const editorDocRef = editor?.state?.doc;
	useEffect(() => {
		// Do NOT write the editor's (still-baseline) markdown back into agent
		// state while a confirm is arming or pending. At end-of-run all events
		// land in one commit with `isLoading` already false, so this effect
		// would otherwise clobber the freshly-delivered proposed document with
		// the stale baseline — the write-back half of the RC2 race. The confirm
		// handler owns delivery of the proposed content in that window.
		if (
			!isLoading &&
			!isRegenerating &&
			editor &&
			!hasPendingConfirm &&
			!confirmArmedRef.current
		) {
			const editorMarkdown = getEditorMarkdownForSave(editor);
			// Null means serialization failed on this edit — skip
			// the sync rather than overwriting currentDocument/baselineRef with
			// "". Those values feed straight into save (handleSave/rawContent)
			// and AI diffing, so silently corrupting them to empty would just
			// relocate the original data-loss bug one hop over.
			if (editorMarkdown !== null) {
				setCurrentDocument(editorMarkdown);
				baselineRef.current = editorMarkdown; // Keep ref in sync
				// IMPORTANT: Use functional update to preserve ragContexts and projectContext
				setAgentState((prev) => ({
					...prev,
					document: editorMarkdown,
				}));
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editorDocRef, isLoading, isRegenerating, hasPendingConfirm]);

	// Sync raw content when currentContent changes (from editor updates)
	useEffect(() => {
		if (viewMode === "rich" && editor) {
			const markdown = getEditorMarkdownForSave(editor);
			// Null means serialization failed — skip the sync
			// rather than corrupting the raw-mode mirror (which handleSave
			// writes directly to the DB) to "".
			if (markdown !== null) {
				setRawContent(markdown);
			}
		}
	}, [editor?.state?.doc, viewMode, editor]);

	// Handle switching between raw and rich view
	const handleViewModeToggle = () => {
		if (viewMode === "raw") {
			// Switching from raw to rich - update editor with raw content
			const normalized = repairMarkdownDocument(rawContent);
			setRawContent(normalized);
			setCurrentDocument(normalized);
			if (editor) {
				applyProgrammaticContent(editor, fromMarkdown(normalized));
			}
			setViewMode("rich");
		} else {
			// Switching from rich to raw - already synced
			setViewMode("raw");
		}
	};

	// @fabric mention support for raw markdown editor
	const { handleInputChange: handleRawEditorFabricMention } =
		useFabricMention({
			projectId,
			projectName: project?.name,
			onMentionTrigger: () => {
				toast.info("Opening Fabric Agent...");
			},
		});

	// Code context launcher for "Ask About This" functionality
	const { openWithSelectedCode, getSelectedText, isLikelyCode } =
		useCodeContextLauncher({
			projectId,
			projectName: project?.name,
			repositoryUrl: project?.repositoryUrl ?? null,
			repositoryOwner: project?.repositoryOwner ?? null,
			repositoryName: project?.repositoryName ?? null,
			defaultBranch: project?.defaultBranch ?? null,
		});

	// Handle "Ask About This" from text selection
	const handleAskAboutSelection = () => {
		const selected = getSelectedText();
		if (!selected) {
			toast.info("Select some text first to ask about it");
			return;
		}
		if (!isLikelyCode(selected)) {
			// Still allow but maybe warn
			openWithSelectedCode(selected, undefined, "Explain this:");
		} else {
			openWithSelectedCode(selected, undefined, "Explain this code:");
		}
	};

	// Broken images render a readable message instead of the browser's native
	// broken-image icon (Fizzy #2027) — e.g. a signed URL that expired before
	// the refresher below could re-resolve it. That lives in the
	// ImageLoadFallback extension, as a decoration, so the message can never
	// reach the saved document.

	// Re-resolve expired S3 signed URLs when the editor loads content.
	// Signed URLs expire after 1 hour — this refreshes them on every page load.
	useEffect(() => {
		if (!editor) {
			return;
		}
		const resolveUrls = async () => {
			const editorDom = editor.view.dom;
			const images = editorDom.querySelectorAll("img[src]");
			// Collect S3 keys from src URLs containing document-media/
			const keyMap = new Map<string, HTMLImageElement[]>();
			for (const img of images) {
				const src = img.getAttribute("src") || "";
				const match = src.match(/\/(document-media\/[^?"]+)/);
				if (match) {
					const key = match[1];
					if (!keyMap.has(key)) {
						keyMap.set(key, []);
					}
					keyMap.get(key)?.push(img as HTMLImageElement);
				}
			}
			if (keyMap.size === 0) {
				return;
			}
			try {
				const { urls } =
					await orpcClient.projects.documents.resolveMediaUrls({
						projectId,
						documentId,
						s3Keys: [...keyMap.keys()],
					});
				for (const [key, imgEls] of keyMap) {
					const freshUrl = urls[key];
					if (!freshUrl) {
						continue;
					}
					for (const img of imgEls) {
						img.setAttribute("src", freshUrl);
					}
				}
			} catch (e) {
				console.error("[DocumentEditor] Failed to resolve S3 URLs:", e);
			}
		};
		// Delay slightly to ensure editor content is rendered
		const timer = setTimeout(resolveUrls, 500);
		return () => clearTimeout(timer);
	}, [editor, projectId, documentId]);

	// Handle image upload from toolbar or drag-drop
	const handleImageUpload = async (files: FileList) => {
		if (!editor) {
			return;
		}

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) {
				continue;
			}

			const uploadId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

			// Insert upload placeholder
			editor.commands.insertImageUpload({
				uploadId,
				filename: file.name,
				progress: 0,
				error: null,
			});

			try {
				const s3Key = await uploadImage({
					file,
					projectId,
					documentId,
					organizationId,
					onProgress: (percent) => {
						editor.commands.updateImageUpload(uploadId, {
							progress: percent,
						});
					},
				});

				// Resolve the S3 key to a signed URL for display
				const urls =
					await orpcClient.projects.documents.resolveMediaUrls({
						projectId,
						documentId,
						organizationId,
						s3Keys: [s3Key],
					});
				const signedUrl = urls.urls[s3Key];

				// Remove placeholder and insert actual image with all attrs at once.
				// Using insertContent (not setImage + updateAttributes) because
				// setImage moves the cursor past the image, so updateAttributes
				// wouldn't target the newly inserted image.
				editor.commands.removeImageUpload(uploadId);
				if (signedUrl) {
					editor
						.chain()
						.focus()
						.insertContent({
							type: "image",
							attrs: {
								src: signedUrl,
								alt: file.name,
								width: "50%",
								"data-s3-key": s3Key,
							},
						})
						.run();
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Upload failed";
				editor.commands.updateImageUpload(uploadId, {
					error: message,
					progress: 0,
				});
				toast.error(`Failed to upload ${file.name}: ${message}`);
			}
		}
	};

	// Keep the ref in sync so editorProps handlers can access the latest function
	imageUploadRef.current = handleImageUpload;

	// Register the S3 upload handler for slash commands
	useEffect(() => {
		setSlashCommandImageUploadHandler(handleImageUpload);
		return () => setSlashCommandImageUploadHandler(null);
	}, [editor, projectId, documentId]);

	// Handle raw content changes
	const handleRawContentChange = (value: string) => {
		// Check for @fabric mention
		const result = handleRawEditorFabricMention(value);
		if (result.consumed) {
			// Mention was consumed, don't update content
			return;
		}
		setRawContent(result.value);
		setCurrentDocument(result.value);
		// Same content-equality model as the rich editor: dirty iff the new
		// raw value differs from what we last persisted. Compare directly
		// without debouncing because we already have the new value here.
		const isDirty =
			result.value.trim() !== lastSavedContentRef.current.trim();
		setHasUnsavedChanges(isDirty);
		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
			autoSaveTimeoutRef.current = null;
		}
		if (isDirty) {
			autoSaveTimeoutRef.current = setTimeout(() => {
				triggerAutoSave();
			}, 10000);
		}
	};

	// Keyboard shortcut for toggling view mode (Ctrl+Shift+V or Cmd+Shift+V)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "V") {
				e.preventDefault();
				handleViewModeToggle();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewMode, rawContent]);

	// Save mutation with optimistic update to avoid flicker between confirm and server write
	// Must carry `organizationId` because the `documents.get` query itself
	// now does. `setQueryData` / `getQueryData` match the key EXACTLY (unlike
	// invalidate/cancel, which match by prefix), so a key missing this field
	// would write the optimistic save into a phantom cache entry and make the
	// error rollback a silent no-op.
	const documentGetQueryKey = orpc.projects.documents.get.queryKey({
		input: { id: documentId, projectId, organizationId },
	});
	const saveMutation = useMutation(
		orpc.projects.documents.update.mutationOptions({
			onMutate: async (variables) => {
				// Cancel outgoing refetches so they don't overwrite our optimistic update
				await queryClient.cancelQueries({
					queryKey: documentGetQueryKey,
				});
				// Snapshot previous value
				const previous = queryClient.getQueryData(documentGetQueryKey);
				// Optimistically update cache
				queryClient.setQueryData(documentGetQueryKey, (old: any) => {
					if (!old?.document) {
						return old;
					}
					return {
						...old,
						document: {
							...old.document,
							content: variables.content,
						},
					};
				});
				return { previous };
			},
			onError: (error, _variables, context) => {
				// Rollback cache
				if (context?.previous) {
					queryClient.setQueryData(
						documentGetQueryKey,
						context.previous,
					);
				}
				toast.error(`Failed to save document: ${error.message}`);
				setIsSaving(false);
			},
			onSuccess: (data, variables) => {
				if (isManualSaveRef.current) {
					toast.success("Document saved successfully");
				} else if (isConfirmSaveRef.current) {
					// Confirm-initiated saves must never be silent (I3/AC3/AC5):
					// a version-bearing success, an informational no-op, or the
					// error toast in onError — exactly one, always.
					if (data?.contentUnchanged) {
						toast.info(
							"No changes were applied — the document already matches the saved version.",
						);
					} else {
						const version = data?.document?.version;
						toast.success(
							version != null
								? `Changes applied — saved as v${version}`
								: "Changes applied.",
						);
					}
				}
				// Update the persisted-content baseline, then re-derive the
				// dirty flag from it. recomputeDirtyState handles the
				// typing-during-save case naturally — if the live editor moved
				// past `variables.content`, the comparison will leave the
				// flag at true; otherwise it flips to false.
				updateSavedBaseline(variables.content || "");
				recomputeDirtyState();
				// Ensure cache reflects saved content and version without triggering refetch flicker
				queryClient.setQueryData(documentGetQueryKey, (old: any) => {
					if (!old?.document) {
						return old;
					}
					return {
						...old,
						document: {
							...old.document,
							content: variables.content,
							...(data?.document?.version != null
								? { version: data.document.version }
								: {}),
						},
					};
				});
				// Invalidate version history so new version appears in the list
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.versions.list.queryKey({
						input: {
							projectId,
							documentId,
							organizationId,
						},
					}),
				});
				// Only redirect when the user explicitly chose "Save & Close".
				// "Save" (primary), auto-save, and confirm/reject saves all keep
				// the user on the document.
				if (shouldRedirectAfterSaveRef.current) {
					const orgSlug = params?.organizationSlug as
						| string
						| undefined;
					const projectUrl = orgSlug
						? `/app/${orgSlug}/projects/${projectId}`
						: `/app/projects/${projectId}`;
					router.push(projectUrl);
				}
			},
			onSettled: () => {
				setIsSaving(false);
				// Reset the intent refs whether the save succeeded or failed so a
				// later auto-save (or unrelated save) doesn't inherit stale
				// "manual" / "confirm" / "redirect" intent from a previous click.
				isManualSaveRef.current = false;
				isConfirmSaveRef.current = false;
				shouldRedirectAfterSaveRef.current = false;
			},
		}),
	);

	// Update using context — reviews meeting transcripts + Teams/Slack chatter
	// since the doc was created and proposes in-editor diff edits.
	const contextUpdate = useUpdateDocumentWithContext({
		projectId,
		documentId,
		organizationId: organizationId ?? null,
		editor,
		getEditorMarkdownForSave,
		fromMarkdown,
		diffPartialText,
		onSaved: () => {
			queryClient.invalidateQueries({ queryKey: documentGetQueryKey });
			queryClient.invalidateQueries({
				queryKey: orpc.projects.documents.versions.list.queryKey({
					input: { projectId, documentId, organizationId },
				}),
			});
		},
	});
	// Keep the ref in sync so the onUpdate + triggerAutoSave guards can read it.
	isContextUpdateActiveRef.current = contextUpdate.isActive;

	// Diff review-mode toggle (inline / side-by-side / full preview). Pure view
	// state — switching never mutates the editor doc or the pending diff. One
	// shared preference across both review flows (and the Feature editor).
	const isDiffReviewActive = hasPendingConfirm || contextUpdate.showingDiff;
	const {
		diffViewMode,
		setDiffViewMode,
		diffViews,
		effectiveDiffViewMode,
		showDiffPreviewPanes,
	} = useDiffPreview(editor, isDiffReviewActive);

	// Auto-save function - skip save if content hasn't actually changed
	const triggerAutoSave = () => {
		if (!hasUnsavedChanges || !document) {
			return;
		}
		// Never auto-save while the context-update diff is on screen — the
		// editor contains diff markers, not the user's chosen content.
		if (isContextUpdateActiveRef.current) {
			return;
		}
		// Never auto-save while a regeneration is in flight or its
		// accept/reject dialog is open. The editor is showing programmatically
		// streamed content (or the result of one), and an autosave here would
		// bump projectDocument.version without creating a matching
		// DocumentVersion row — leaving Reject unable to do a clean
		// rollback (see Fizzy #1155).
		if (isRegenerating || showConfirmDialog) {
			return;
		}
		// Only require editor for rich mode — raw mode uses rawContent directly
		if (viewMode !== "raw" && !editor) {
			return;
		}
		// Compare current editor content against the baseline to avoid
		// creating versions from HTML→Markdown roundtrip differences
		if (viewMode !== "raw") {
			// Null means the serializer failed on this tick. Bail
			// silently — coercing to "" would make `currentMarkdown` never equal
			// `lastSavedContentRef`, so this would re-fire `handleSave()` (and
			// its stale-content fallback) every 10s for as long as the
			// serializer stays broken. `handleSave` already reports failures
			// when the user saves manually, so no toast here.
			const editorMarkdown = getEditorMarkdownForSave(editor);
			if (editorMarkdown === null) {
				return;
			}
			if (editorMarkdown.trim() === lastSavedContentRef.current.trim()) {
				setHasUnsavedChanges(false);
				return;
			}
			handleSave();
			return;
		}
		const currentMarkdown = rawContent;
		if (currentMarkdown.trim() === lastSavedContentRef.current.trim()) {
			setHasUnsavedChanges(false);
			return;
		}
		handleSave();
	};
	// Expose the latest triggerAutoSave to recomputeDirtyState via a ref so
	// the dirty-check helper (declared earlier) can schedule it without a
	// circular forward reference.
	triggerAutoSaveRef.current = triggerAutoSave;

	const handleSave = () => {
		if (!document) {
			return;
		}
		// Clear auto-save timeout when manually saving
		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
			autoSaveTimeoutRef.current = null;
		}
		// Use raw content if in raw mode, otherwise get from editor.
		// `editorMarkdown` is null on serialization failure (was
		// "" before). Falling through to the agentState.document /
		// currentDocument fallback chain on a `null` read would silently
		// persist a stale, older revision over the user's current text — so
		// bail before building `content` at all.
		const editorMarkdown =
			viewMode === "raw" ? null : getEditorMarkdownForSave(editor);
		if (viewMode !== "raw" && editorMarkdown === null) {
			setIsSaving(false);
			toast.error(
				"Couldn't save your changes — the editor content could not be read. Your text is still here; please copy it somewhere safe and reload the page.",
			);
			return;
		}
		const content =
			viewMode === "raw"
				? rawContent
				: (editorMarkdown && editorMarkdown.trim().length > 0
						? editorMarkdown
						: agentState?.document) ||
					currentDocument ||
					"";
		setIsSaving(true);
		// Update local state immediately so future streaming diffs compare against saved text
		setCurrentDocument(content);
		// IMPORTANT: Preserve ragContexts and projectContext when updating document
		setAgentState((prev) => ({
			...prev,
			document: content,
			streamingContent: content,
		}));
		saveMutation.mutate({
			projectId,
			id: documentId,
			content,
		});
	};

	// Expose document state to CopilotKit (memoized to avoid re-registrations on every render)
	const documentReadableValue = useMemo(
		() => ({
			documentId,
			documentType: document?.type,
			title: document?.title,
			// NOTE: document content is intentionally omitted here — it is already
			// included in the agent's system prompt via state.document (useCoAgent).
			// Sending it again as JSON doubles the token count and can overflow the
			// model's effective reasoning space, causing it to answer questions
			// conversationally instead of calling write_document_local.
			projectName: project?.name,
			projectDescription: project?.description,
			techStack: project?.techStack,
			features: project?.features,
		}),
		[
			documentId,
			document?.type,
			document?.title,
			project?.name,
			project?.description,
			project?.techStack,
			project?.features,
		],
	);
	useCopilotReadable({
		description: "The current document being edited",
		value: documentReadableValue,
	});

	// Project-level RAG contexts (`localRagContexts`) are intentionally NOT
	// sent via `useCopilotReadable` — the agent uses the
	// `search_project_knowledge` tool for on-demand retrieval against the
	// Qdrant index instead.
	//
	// CHAT-SESSION attachments (`chatAttachmentContexts`) are different:
	// they are uploaded via the paperclip in this turn, are not in Qdrant,
	// and the agent has no way to retrieve them without our help. We
	// publish them via the same "rag context" description the
	// `project_document_generator` chat-node already reads
	// (`findReadableValue("rag context")` →
	// `unified-server.ts:447-450`). The value shape mirrors what
	// StoryWorkspace and DocumentGeneratorEditor publish, so the agent
	// extracts `value.ragContexts` uniformly across all three surfaces.
	useCopilotReadable({
		description:
			"RAG context — content extracted from files the user has attached in this chat session. Each entry is prefixed with the filename and contains either the raw text (documents) or a markdown image link with a base64 data URL (images, for vision-capable models).",
		value: {
			ragContexts: chatAttachmentContexts,
			ragContextsCount: chatAttachmentContexts.length,
		},
	});

	// Mirror chat-attachment contexts onto `useCoAgent` state as a
	// belt-and-suspenders fallback. The agent reads `useCopilotReadable`
	// first and falls back to `state.ragContexts` if the readable arrives
	// stale on a turn that races with the file-upload state commit. Same
	// pattern as DocumentGeneratorEditor and StoryWorkspace.
	useEffect(() => {
		setAgentStateRef.current({
			ragContexts: chatAttachmentContexts,
		} as Partial<AgentState> as AgentState);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatAttachmentContexts]);

	const hasRepoUrl = !!(project as Record<string, unknown>)?.repositoryUrl;
	const projectContextReadableValue = useMemo(
		() => ({
			projectContext: localProjectContext,
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: hasRepoUrl,
			hasRepoIntegration: codeSearchEnabled && hasRepoUrl,
			projectId,
		}),
		[
			localProjectContext,
			teamsMessagesData?.hasTeamsIntegration,
			slackMessagesData?.hasSlackIntegration,
			hasRepoUrl,
			codeSearchEnabled,
			projectId,
		],
	);
	useCopilotReadable({
		description:
			"Project context including name, description, tech stack, and features",
		value: projectContextReadableValue,
	});

	// Embed contexts mutation - ensures contexts are in Qdrant before regeneration
	// Same pattern as wizard's DocumentGenerationStep.tsx
	const embedContextsMutation = useMutation(
		orpc.projects.contexts.embed.mutationOptions({}),
	);

	// Regenerate document action - triggers Temporal workflow for major rewrites
	const regenerateMutation = useMutation(
		orpc.projects.documents.generate.mutationOptions({
			onSuccess: () => {
				// Record the instant the server confirmed this run started.
				// generate-document writes GENERATING + clears generationError
				// BEFORE it starts the workflow, so any polled snapshot fetched
				// after this instant that still shows FAILED is a genuine
				// failure from THIS run, not a stale one left over from the run
				// being retried — see the FAILED-watcher effect above.
				regenerationAckAtRef.current = Date.now();

				const documentQueryKey = orpc.projects.documents.get.queryKey({
					input: { id: documentId, projectId, organizationId },
				});
				// Force a refetch now so it supersedes any poll that was
				// already in flight when the mutation resolved — an in-flight
				// poll can carry a pre-GENERATING (possibly still-FAILED)
				// snapshot yet complete after ackAt, which would otherwise
				// slip past the watcher's dataUpdatedAt guard.
				void queryClient.invalidateQueries({
					queryKey: documentQueryKey,
				});

				// Clear any timer from a previous regeneration attempt before
				// scheduling a new one — prevents overlapping safety timers.
				if (regenerationTimeoutRef.current) {
					clearTimeout(regenerationTimeoutRef.current);
				}

				// Safety net for the rare case where polling never observes a
				// content change (e.g. workflow stalled, or regeneration produced
				// byte-identical output). On fire we refetch once from the server
				// — if new content has in fact arrived, the detection effect above
				// will process it and cancel this path; only if content still
				// hasn't changed do we surface a soft notice to the user.
				regenerationTimeoutRef.current = setTimeout(() => {
					regenerationTimeoutRef.current = null;
					void queryClient
						.invalidateQueries({ queryKey: documentQueryKey })
						.finally(() => {
							// Read the freshest cached content directly — this
							// avoids stale closures and races with the detection
							// effect. If content has actually arrived, the
							// detection effect will (or already did) open the
							// confirm dialog; we must stay silent to avoid a
							// duplicate "timed out" toast on top of it.
							const latest = queryClient.getQueryData(
								documentQueryKey,
							) as
								| { document?: { content?: string | null } }
								| undefined;
							const latestContent =
								latest?.document?.content ?? null;
							const baseline = regenerationBaselineRef.current;
							const contentArrived =
								latestContent != null &&
								latestContent.length > 0 &&
								latestContent !== (baseline ?? "");
							if (contentArrived) {
								return;
							}
							// Genuinely no new content after one last server
							// check — surface a soft, actionable notice.
							setIsRegenerating(false);
							toast.info(
								"Document generation is taking longer than expected. Refresh the page to check for the latest version.",
							);
							if (regenerationRespondRef.current) {
								regenerationRespondRef.current({
									accepted: false,
								});
								regenerationRespondRef.current = null;
							}
							regenerationTriggeredRef.current = false;
						});
				}, 300000); // 5 minutes
			},
			onError: (error) => {
				console.error(
					"[DocumentEditor] Regeneration mutation failed:",
					error,
				);
				toast.error(`Failed to regenerate document: ${error.message}`);
				setIsRegenerating(false);
				// Cancel the safety timer — we already know the outcome.
				if (regenerationTimeoutRef.current) {
					clearTimeout(regenerationTimeoutRef.current);
					regenerationTimeoutRef.current = null;
				}
				// Unblock the CopilotKit action so UI recovers
				if (regenerationRespondRef.current) {
					regenerationRespondRef.current({ accepted: false });
					regenerationRespondRef.current = null;
				}
				// Reset triggered ref so user can retry
				regenerationTriggeredRef.current = false;
				// Clear the baseline ref
				regenerationBaselineRef.current = null;
				// Clear the ack timestamp — this run never got a GENERATING
				// write to ack, so the FAILED watcher must stay unarmed.
				regenerationAckAtRef.current = null;
				// The server may have gone GENERATING → FAILED as part of
				// this failed start (generate-document marks GENERATING
				// before starting the workflow, then FAILED if the start
				// itself throws). A poll in flight when the mutation
				// rejected can have cached that intermediate GENERATING
				// snapshot, and since we just stopped polling above (by
				// setting isRegenerating false), that stale cache would
				// otherwise never refresh. Refetch once so the persisted
				// FAILED status reaches the cache — with the spinner
				// already stopped, DocumentGenerationFailedNotice can now
				// render instead of leaving the user with only this toast.
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.get.queryKey({
						input: { id: documentId, projectId, organizationId },
					}),
				});
			},
		}),
	);

	// Reject-regeneration mutation: atomically deletes the freshly-created
	// DocumentVersion row and rewinds projectDocument.{content, version} so
	// version history stays consistent with the live document. Used in the
	// Reject handler below; falls back to the old skipVersionBump path on
	// CONFLICT (e.g. first-ever generation has no prior version to revert to).
	const rejectRegenerationMutation = useMutation(
		orpc.projects.documents.rejectRegeneration.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: documentGetQueryKey,
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.versions.list.queryKey({
						input: { projectId, documentId, organizationId },
					}),
				});
			},
		}),
	);

	// Cancel any in-flight safety timer on unmount so it can't fire against
	// an unmounted component.
	useEffect(() => {
		return () => {
			if (regenerationTimeoutRef.current) {
				clearTimeout(regenerationTimeoutRef.current);
				regenerationTimeoutRef.current = null;
			}
		};
	}, []);

	// Direct regeneration handler - called by the Regenerate button (bypasses agent)
	const handleDirectRegenerate = async () => {
		if (isRegenerating || isLoading) {
			return;
		}

		// Always confirm before regenerating: regen replaces the live content
		// with a fresh AI generation. The current content is preserved in
		// version history, but the user should know that's what's about to
		// happen so they can cancel if they meant to edit instead.
		if (!showImportedRegenWarning) {
			setShowImportedRegenWarning(true);
			return;
		}
		setShowImportedRegenWarning(false);

		// Capture baseline BEFORE regeneration starts
		const baselineContent = document?.content || currentDocument;
		regenerationBaselineRef.current = baselineContent;

		// Mark as direct regeneration (not agent-based)
		// This prevents Effect 4 from syncing agent state back to editor
		isDirectRegenerationRef.current = true;
		regenerationTriggeredRef.current = true;
		// Clear any ackAt left over from a previous run before this run's
		// mutation resolves and (re)arms it — otherwise the FAILED watcher
		// could momentarily see a stale ackAt from before this retry began.
		regenerationAckAtRef.current = null;
		setIsProgressDismissed(false);
		setIsRegenerating(true);

		try {
			// Step 1: Embed contexts first (same pattern as wizard's DocumentGenerationStep)
			// This ensures project contexts are in Qdrant before RAG retrieval
			await embedContextsMutation.mutateAsync({ projectId });
		} catch {
			// Continue anyway - some contexts might already be embedded
		}

		// Step 2: Use empty prompt to trigger document-type-specific default prompt in Temporal workflow
		// e.g., "Create a comprehensive PRD that outlines the product vision..." for PRD
		// The system prompt (from Prompt Library) + project context provide all necessary context
		regenerateMutation.mutate({
			id: documentId,
			prompt: "", // Empty = use default document-type prompt (matches Step 5 behavior)
			promptId: selectedPromptId,
			promptVersionId: selectedPromptVersionId,
		});
	};

	// Auto-generate on mount when coming from "Create Document with AI"
	// The document content contains the AI prompt from the create dialog
	useEffect(() => {
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let isCancelled = false;

		// Also check regenerationTriggeredRef to prevent double-triggering if previous attempt already started
		if (
			shouldGenerateOnMount &&
			!hasTriggeredAutoGeneration.current &&
			!regenerationTriggeredRef.current &&
			document &&
			!isLoading &&
			!isRegenerating
		) {
			// The document content is the AI prompt from CreateDocumentDialog
			const aiPrompt = document.content || "";

			// Start generation after a short delay to let the UI settle
			timeoutId = setTimeout(async () => {
				// Check if component was unmounted or effect re-ran during the delay
				if (isCancelled) {
					return;
				}

				// CRITICAL: Only mark as triggered AFTER we confirm the timeout callback is executing
				// If we set this before the timeout, and the effect re-runs before timeout fires,
				// the flag will be true but the mutation was never called.
				hasTriggeredAutoGeneration.current = true;

				// Mark as regenerating FIRST (before any async operations)
				regenerationTriggeredRef.current = true;
				isDirectRegenerationRef.current = true;
				// Clear any ackAt left over from a previous run — see the
				// comment on the same line in handleDirectRegenerate.
				regenerationAckAtRef.current = null;
				setIsRegenerating(true);

				// Capture baseline (the AI prompt, which will be replaced)
				regenerationBaselineRef.current = aiPrompt;

				// Clear URL parameter to prevent re-renders from retriggering
				const newUrl = window.location.pathname;
				router.replace(newUrl);

				try {
					// Step 1: Embed contexts first
					await embedContextsMutation.mutateAsync({ projectId });
				} catch (_error) {
					// Continue anyway - some contexts might already be embedded
				}

				// Step 2: Trigger generation with the AI prompt
				// Read prompt IDs from refs to avoid stale closures without adding them as deps
				regenerateMutation.mutate({
					id: documentId,
					prompt: aiPrompt, // Use the AI prompt from the create dialog
					promptId: selectedPromptIdRef.current,
					promptVersionId: selectedPromptVersionIdRef.current,
				});
			}, 500);
		}

		// Cleanup: clear timeout and mark as cancelled on unmount
		return () => {
			isCancelled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		shouldGenerateOnMount,
		document,
		isLoading,
		isRegenerating,
		documentId,
		projectId,
		router,
	]);

	// Render default-MCP tool results (e.g. Excalidraw `create_view`)
	// inline in the AI Document Assistant sidebar. The hook hooks the
	// CopilotKit wildcard action; for tool calls without our render
	// envelope it returns `null` (default rendering). Without this the
	// model's Excalidraw result shows up as raw JSON in the chat.
	useDefaultMcpInlineRender({ organizationId });

	// Clarifying-question card + frequency policy. Lets the agent ask the user a
	// question with up to 3 clickable options (instead of a free-text inline
	// question) and continue with the answer; the project's frequency tier
	// controls how often it asks.
	useClarifyingQuestions({
		frequency:
			(
				project as {
					clarifyingQuestionFrequency?: ClarifyingQuestionFrequency | null;
				} | null
			)?.clarifyingQuestionFrequency ?? "BALANCED",
		organizationId: organizationId ?? null,
	});

	// Meeting selection action - shows MeetingSelector inline in chat
	// Mirrors the pattern from BacklogChat.tsx
	useCopilotAction({
		name: "select_meetings",
		description:
			"Show a meeting selector UI for the user to pick meetings. The user selects meetings and confirms. The tool response will contain a 'selectedMeetings' array with objects containing joinUrl and optional startTime. IMPORTANT: When this tool returns selectedMeetings (non-empty array), you MUST immediately call fetchMeetingNotes with those meetings to fetch the transcripts. Do NOT ask the user to choose again — they already chose.",
		parameters: [],
		renderAndWaitForResponse: ({ respond }) => (
			<MeetingSelector
				projectId={projectId}
				organizationId={organizationId ?? null}
				onConfirm={(selectedMeetings) =>
					respond?.({ selectedMeetings })
				}
				onCancel={() => respond?.({ selectedMeetings: [] })}
			/>
		),
	});

	// Fetch meeting notes action - calls API to get meeting transcripts
	useCopilotAction({
		name: "fetchMeetingNotes",
		description:
			"Fetch meeting transcripts from Microsoft Teams for selected meetings. You MUST call this immediately after select_meetings returns selectedMeetings. Pass the exact selectedMeetings array from the select_meetings result. Returns transcript content. Then call write_document_local to APPEND a few bullet points to 1-3 existing sections. The document type, title, structure, and all existing text MUST stay exactly the same.",
		parameters: [
			{
				name: "selectedMeetings",
				type: "object[]",
				description:
					"The selectedMeetings array returned by select_meetings. Pass it directly.",
				required: true,
			},
		],
		handler: async (args) => {
			const selectedMeetings =
				(args.selectedMeetings as Array<{
					joinUrl: string;
					startTime?: string;
				}>) ?? [];
			const result =
				await orpcClient.projects.documents.fetchMeetingNotes({
					projectId,
					organizationId: organizationId ?? null,
					selectedMeetings,
				});
			const formattedNotes = result.notes
				.filter((n) => n.content)
				.map((n) => `## Meeting: ${n.subject}\n\n${n.content}`)
				.join("\n\n---\n\n");
			// Keep the instruction short and specific — the system prompt already
			// has comprehensive editing rules via buildCurrentDocumentSection.
			// Verbose competing rules confuse the model and cause full rewrites.
			return [
				"MEETING TRANSCRIPTS (reference material — extract relevant points only):",
				"",
				formattedNotes,
				"",
				"REMINDER: Append a few bullet points to 1-3 existing sections. Do NOT change the document title, type, structure, or rewrite existing text.",
			].join("\n");
		},
		render: ({ status }) => {
			if (status === "complete") {
				return (
					<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
						Meeting notes fetched successfully.
					</div>
				);
			}
			return (
				<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					Fetching meeting notes...
				</div>
			);
		},
	});

	// === GitHub Repository Tools ===
	// These actions let the AI assistant read code, PRs, and issues from the
	// project's connected GitHub repository. Follows the fetchMeetingNotes pattern.
	// Auto-fills owner/repo from project settings so the user only needs to specify paths.

	useCopilotAction(
		{
			name: "github_get_file_contents",
			description: hasGitHub
				? `Read a file or list a directory from the project's GitHub repository (${repoOwner}/${repoName}). Use this to look at source code, configs, READMEs, etc. when editing documents. The owner and repo are auto-filled. Just provide the file path.`
				: "GitHub not connected.",
			parameters: [
				{
					name: "path",
					type: "string",
					description:
						"File or directory path in the repo (e.g. 'src/auth/middleware.ts' or 'src/')",
					required: true,
				},
				{
					name: "ref",
					type: "string",
					description:
						"Branch or commit SHA. Defaults to the project's default branch.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_file_contents",
							args: {
								owner: repoOwner,
								repo: repoName,
								path: args.path,
								ref: (args.ref as string) || repoBranch,
							},
						});
					const data = result.result as Record<string, unknown>;
					if (Array.isArray(data)) {
						const listing = (data as Array<Record<string, unknown>>)
							.map(
								(f) =>
									`${f.type === "dir" ? "dir" : "file"}  ${f.path}`,
							)
							.join("\n");
						return `DIRECTORY LISTING: ${args.path}\n\n${listing}`;
					}
					const content = (data.content as string) || "";
					const filePath = (data.path as string) || args.path;
					return `FILE: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
				} catch (error) {
					return `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							File contents fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Reading from GitHub repository...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName, repoBranch],
	);

	useCopilotAction(
		{
			name: "github_get_repository",
			description: hasGitHub
				? `Get repository metadata for ${repoOwner}/${repoName}. Returns description, language, topics, default branch, and last updated date.`
				: "GitHub not connected.",
			parameters: [],
			handler: async () => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_repository",
							args: { owner: repoOwner, repo: repoName },
						});
					const repo = result.result as Record<string, unknown>;
					return [
						`REPOSITORY: ${repo.full_name || `${repoOwner}/${repoName}`}`,
						`Description: ${repo.description || "N/A"}`,
						`Language: ${repo.language || "N/A"}`,
						`Default branch: ${repo.default_branch || repoBranch}`,
						`Topics: ${(repo.topics as string[])?.join(", ") || "none"}`,
						`Last updated: ${repo.updated_at || "N/A"}`,
					].join("\n");
				} catch (error) {
					return `Error fetching repository info: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Repository info fetched.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching repository info...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	useCopilotAction(
		{
			name: "github_list_pull_requests",
			description: hasGitHub
				? `List recent pull requests from ${repoOwner}/${repoName}. Useful for understanding recent changes and what's in progress.`
				: "GitHub not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_pull_requests",
							args: {
								owner: repoOwner,
								repo: repoName,
								state: (args.state as string) || "open",
								per_page: 15,
							},
						});
					const prs = result.result as Array<Record<string, unknown>>;
					if (!Array.isArray(prs) || prs.length === 0) {
						return "No pull requests found.";
					}
					const formatted = prs
						.map(
							(pr) =>
								`- #${pr.number} ${pr.title} (${pr.state}${pr.draft ? ", draft" : ""}) by ${pr.author || "unknown"} — ${pr.head} → ${pr.base}`,
						)
						.join("\n");
					return `PULL REQUESTS (${(args.state as string) || "open"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching pull requests: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Pull requests fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching pull requests...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	useCopilotAction(
		{
			name: "github_list_issues",
			description: hasGitHub
				? `List recent issues from ${repoOwner}/${repoName}. Useful for understanding bugs, feature requests, and open work items.`
				: "GitHub not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_issues",
							args: {
								owner: repoOwner,
								repo: repoName,
								state: (args.state as string) || "open",
								per_page: 15,
							},
						});
					const issues = result.result as Array<
						Record<string, unknown>
					>;
					if (!Array.isArray(issues) || issues.length === 0) {
						return "No issues found.";
					}
					const formatted = issues
						.map(
							(i) =>
								`- #${i.number} ${i.title} (${i.state}) [${(i.labels as string[])?.join(", ") || "no labels"}]`,
						)
						.join("\n");
					return `ISSUES (${(args.state as string) || "open"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching issues: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Issues fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching issues...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	// ── GitLab CopilotKit actions ───────────────────────────────────
	// Mirror the GitHub actions above but target GitLab API via executeGitLabTool

	useCopilotAction(
		{
			name: "gitlab_get_file_contents",
			description: hasGitLab
				? `Read a file or list a directory from the project's GitLab repository (${repoOwner}/${repoName}). Use this to look at source code, configs, READMEs, etc. when editing documents. Just provide the file path.`
				: "GitLab not connected.",
			parameters: [
				{
					name: "path",
					type: "string",
					description:
						"File or directory path in the repo (e.g. 'src/auth/middleware.ts' or 'src/')",
					required: true,
				},
				{
					name: "ref",
					type: "string",
					description:
						"Branch or commit SHA. Defaults to the project's default branch.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_file_contents",
							args: {
								project_id: gitlabProjectId,
								path: args.path,
								ref: (args.ref as string) || repoBranch,
							},
						});
					const data = result.result as Record<string, unknown>;
					if (Array.isArray(data)) {
						const listing = (data as Array<Record<string, unknown>>)
							.map(
								(f) =>
									`${f.type === "tree" ? "dir" : "file"}  ${f.path}`,
							)
							.join("\n");
						return `DIRECTORY LISTING: ${args.path}\n\n${listing}`;
					}
					const content = (data.content as string) || "";
					const filePath = (data.path as string) || args.path;
					return `FILE: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
				} catch (error) {
					return `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							File contents fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Reading from GitLab repository...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, repoBranch, gitlabProjectId],
	);

	useCopilotAction(
		{
			name: "gitlab_get_project",
			description: hasGitLab
				? `Get project metadata for ${repoOwner}/${repoName} on GitLab. Returns description, default branch, topics, and last activity date.`
				: "GitLab not connected.",
			parameters: [],
			handler: async () => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_project",
							args: { project_id: gitlabProjectId },
						});
					const proj = result.result as Record<string, unknown>;
					return [
						`PROJECT: ${proj.name_with_namespace || `${repoOwner}/${repoName}`}`,
						`Description: ${proj.description || "N/A"}`,
						`Default branch: ${proj.default_branch || repoBranch}`,
						`Topics: ${(proj.topics as string[])?.join(", ") || "none"}`,
						`Last activity: ${proj.last_activity_at || "N/A"}`,
					].join("\n");
				} catch (error) {
					return `Error fetching project info: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Project info fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching project info...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	useCopilotAction(
		{
			name: "gitlab_list_merge_requests",
			description: hasGitLab
				? `List recent merge requests from ${repoOwner}/${repoName} on GitLab. Useful for understanding recent changes and what's in progress.`
				: "GitLab not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'opened', 'closed', 'merged', or 'all'. Defaults to 'opened'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_merge_requests",
							args: {
								project_id: gitlabProjectId,
								state: (args.state as string) || "opened",
								per_page: 15,
							},
						});
					const mrs = result.result as Array<Record<string, unknown>>;
					if (!Array.isArray(mrs) || mrs.length === 0) {
						return "No merge requests found.";
					}
					const formatted = mrs
						.map(
							(mr) =>
								`- !${mr.iid} ${mr.title} (${mr.state}${mr.draft ? ", draft" : ""}) by ${mr.author || "unknown"} -- ${mr.source_branch} -> ${mr.target_branch}`,
						)
						.join("\n");
					return `MERGE REQUESTS (${(args.state as string) || "opened"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching merge requests: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Merge requests fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching merge requests...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	useCopilotAction(
		{
			name: "gitlab_list_issues",
			description: hasGitLab
				? `List recent issues from ${repoOwner}/${repoName} on GitLab. Useful for understanding bugs, feature requests, and open work items.`
				: "GitLab not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'opened', 'closed', or 'all'. Defaults to 'opened'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_issues",
							args: {
								project_id: gitlabProjectId,
								state: (args.state as string) || "opened",
								per_page: 15,
							},
						});
					const issues = result.result as Array<
						Record<string, unknown>
					>;
					if (!Array.isArray(issues) || issues.length === 0) {
						return "No issues found.";
					}
					const formatted = issues
						.map(
							(i) =>
								`- #${i.iid} ${i.title} (${i.state}) [${(i.labels as string[])?.join(", ") || "no labels"}]`,
						)
						.join("\n");
					return `ISSUES (${(args.state as string) || "opened"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching issues: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Issues fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching issues...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	// Regenerate document action - uses renderAndWaitForResponse to block the agent
	// until user accepts/rejects in RegenerationConfirmDialog
	useCopilotAction(
		{
			name: "regenerate_document",
			description:
				"Fully regenerate document content from scratch using AI with project context and RAG. Use this for major rewrites, not iterative edits.",
			parameters: [
				{
					name: "prompt",
					type: "string",
					description:
						"Instructions for what to generate (e.g., 'Regenerate the entire PRD with more technical details')",
					required: true,
				},
			],
			renderAndWaitForResponse: ({ args, respond, status }) => {
				// Always update respond ref to latest (it may change between renders)
				if (respond) {
					regenerationRespondRef.current = respond;
				}

				// Trigger regeneration only once when status is "executing"
				// Check both the ref AND state to prevent duplicate triggers
				if (
					status === "executing" &&
					!regenerationTriggeredRef.current &&
					!isRegenerating
				) {
					// Mark as triggered immediately to prevent race conditions
					regenerationTriggeredRef.current = true;
					// Clear any ackAt left over from a previous run — see the
					// comment on the same line in handleDirectRegenerate.
					regenerationAckAtRef.current = null;

					const prompt = args.prompt as string;

					// Capture baseline BEFORE regeneration starts
					const baselineContent =
						document?.content || currentDocumentRef.current;
					regenerationBaselineRef.current = baselineContent;

					// Start regeneration - use setTimeout to avoid state update during render
					setTimeout(async () => {
						setIsRegenerating(true);

						// Step 1: Embed contexts first (same pattern as wizard's DocumentGenerationStep)
						try {
							await embedContextsMutation.mutateAsync({
								projectId,
							});
						} catch (_error) {
							// Continue anyway - some contexts might already be embedded
						}

						// Step 2: Trigger regeneration workflow
						// Read prompt IDs from refs to avoid adding them as deps
						regenerateMutation.mutate({
							id: documentId,
							prompt,
							promptId: selectedPromptIdRef.current,
							promptVersionId: selectedPromptVersionIdRef.current,
						});
					}, 0);
				}

				// If status is "complete", don't show anything (action is done)
				if (status === "complete") {
					return (
						<div className="p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
							Document regeneration completed.
						</div>
					);
				}

				// Show waiting UI - agent is blocked until respond() is called
				return (
					<div className="p-4 bg-muted rounded-lg">
						<div className="flex items-center gap-2">
							<div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
							<span className="text-muted-foreground">
								{isRegenerating
									? "Regenerating document... This may take a few minutes."
									: "Starting document regeneration..."}
							</span>
						</div>
						<p className="text-sm text-muted-foreground mt-2">
							A confirmation dialog will appear when the document
							is ready.
						</p>
					</div>
				);
			},
		},
		[isRegenerating, document?.content, documentId],
	);

	// Fizzy #1412 CopilotKit Option A — Tier 3 wire-up (extends PR #1240
	// StoryWorkspace integration to DocumentEditor). Persists a
	// `role: "system"` operation-result message into the underlying
	// AgentConversation when the user accepts or rejects the
	// `confirm_changes` dialog below.
	//
	// **Latest-ref pattern is REQUIRED here** (more so than in
	// StoryWorkspace) because this `useCopilotAction` registers with
	// an EMPTY dependency array `[]` (see the closing `[]` at the end
	// of the action options object below). Based on observed behavior
	// in CopilotKit 1.52.0 (not a documented API guarantee), an empty
	// deps array causes the library to cache the
	// `renderAndWaitForResponse` callback ONCE at first render — when
	// `activeAssistantConversationId` is still `null` (PersistenceHook
	// hasn't lazy-created yet) — and never refresh it. Without the
	// ref, every click would fire the helper's null-info-log path
	// forever; the operation-result would never persist. The ref
	// always points at the freshest closure with the resolved
	// conversationId. This is the same regression Copilot caught on
	// PR #1240; here it would manifest 100% of the time because the
	// deps array is empty.
	//
	// Two refs cover the two staleness vectors Codex round-2 flagged:
	//   - `recordOutcomeRef`: freshest helper callback so the
	//     conversationId flip is observed at click time.
	//   - `documentRef`: freshest document so a parent renaming the
	//     document mid-flow produces an accurate persisted summary.
	//
	// Both refs are updated via `useLayoutEffect` (not `useEffect`)
	// because passive effects run AFTER paint, leaving a narrow
	// window where a click event could fire with a stale ref payload
	// (Codex round-2 Important #1). `useLayoutEffect` runs
	// synchronously during the commit phase BEFORE paint, eliminating
	// that race. The fire-and-forget persistence here doesn't strictly
	// need that guarantee, but it costs nothing and keeps the wire-up
	// consistent with how other latest-ref patterns in this codebase
	// would behave if they ever became durable.
	const recordConfirmChangesOutcome = useConfirmChangesOperationResult({
		conversationId: activeAssistantConversationId,
		projectId,
		organizationId: organizationId ?? null,
		operationLabel: "Confirm AI document changes",
	});
	const recordOutcomeRef = useRef(recordConfirmChangesOutcome);
	const documentRef = useRef(document);
	useLayoutEffect(() => {
		recordOutcomeRef.current = recordConfirmChangesOutcome;
	}, [recordConfirmChangesOutcome]);
	useLayoutEffect(() => {
		documentRef.current = document;
	}, [document]);

	// Confirmation action for agent changes
	// CRITICAL FIX: Use editor content with diff tags stripped, NOT agentState.document
	// The AI may return only partial content, but the editor has the full merged view
	// with diff highlighting. getEditorMarkdownForSave() strips diff tags and gives us
	// the final content (original - deletions + additions).
	useCopilotAction(
		{
			name: "confirm_changes",
			renderAndWaitForResponse: ({ args, respond, status }) => {
				const handleReject = () => {
					setHasPendingConfirm(false);
					confirmCallbacksRef.current = null;
					// Reject: Restore the baseline content
					const fallback =
						baselineRef.current || currentDocumentRef.current;
					applyProgrammaticContent(
						editorRef.current,
						fromMarkdown(fallback),
					);
					setAgentState((prev) => ({
						...prev,
						document: fallback,
					}));
					// Fire-and-forget operation-result persistence (Tier 3).
					// Read via `recordOutcomeRef.current` (latest-ref pattern)
					// so the helper sees the freshest `conversationId` even
					// when the captured closure dates back to a pre-lazy-
					// create render.
					void recordOutcomeRef.current({ accepted: false });
					respond?.({ accepted: false });
				};

				const handleAccept = () => {
					// Confirm: Get the merged content from editor (strips diff tags)
					const currentEditor = editorRef.current;
					const finalContent =
						getEditorMarkdownForSave(currentEditor);

					// Null means serialization failed outright
					// (distinct from a genuinely empty document, which is ""
					// and a legitimate save). Persisting null would write an
					// empty document. Surface an actionable error and resolve
					// the tool call cleanly (as a non-apply) so it never
					// dangles in "executing" — the editor is left untouched
					// for the user to copy from before reloading.
					if (finalContent === null) {
						toast.error(
							"Couldn't read the document content from the editor — nothing was saved. Copy any unsaved work and reload the page.",
						);
						setHasPendingConfirm(false);
						confirmCallbacksRef.current = null;
						void recordOutcomeRef.current({ accepted: false });
						respond?.({ accepted: false });
						return;
					}

					// Never persist an extraction that came back empty against a
					// non-empty baseline (I4/RC3): even a legitimate "" read here
					// would silently wipe the document. Surface an actionable
					// error and resolve the tool call cleanly (as a non-apply) so
					// it never dangles in "executing" — the editor is left
					// untouched for the user to copy from before reloading.
					if (
						isEmptyExtractionAgainstBaseline(
							finalContent,
							baselineRef.current,
						)
					) {
						toast.error(
							"Couldn't read the document content from the editor — nothing was saved. Copy any unsaved work and reload the page.",
						);
						setHasPendingConfirm(false);
						confirmCallbacksRef.current = null;
						void recordOutcomeRef.current({ accepted: false });
						respond?.({ accepted: false });
						return;
					}

					setHasPendingConfirm(false);
					confirmCallbacksRef.current = null;

					applyProgrammaticContent(
						currentEditor,
						fromMarkdown(finalContent),
					);
					setCurrentDocument(finalContent);
					baselineRef.current = finalContent;
					setAgentState((prev) => ({
						...prev,
						document: finalContent,
					}));

					// Mark this as a confirm-initiated save so its outcome is
					// surfaced (version bump / no-op / error) instead of silent.
					isConfirmSaveRef.current = true;
					startTransition(() => {
						setIsSaving(true);
						saveMutation.mutate({
							projectId,
							id: documentId,
							content: finalContent,
						});
					});
					// Fire-and-forget operation-result persistence (Tier 3).
					// Both reads go through refs (latest-ref pattern):
					//   - `recordOutcomeRef.current`: freshest helper
					//     closure with the resolved `conversationId`.
					//   - `documentRef.current.title`: freshest document
					//     title so a mid-flow rename produces an accurate
					//     summary instead of a stale-closure title from
					//     when the action was registered.
					// See the hook-call doc comment above for the empty-
					// deps caching rationale.
					void recordOutcomeRef.current({
						accepted: true,
						summary: "Changes applied.",
					});
					respond?.({ accepted: true });
				};

				// Deterministic confirm delivery (RC2). The action render closure
				// is stale under empty deps, so read the freshest proposed document
				// from `agentDocumentRef` and process each executing confirm once.
				if (status === "executing") {
					if (!confirmArmedRef.current) {
						confirmArmedRef.current = true;
						const proposedDoc = agentDocumentRef.current ?? "";
						const baseline = baselineRef.current;
						const noOp = isNoOpProposedContent(
							proposedDoc,
							baseline,
						);
						confirmNoOpRef.current = noOp;
						if (noOp) {
							// No-op gate (I1): never present an actionable card for an
							// unchanged document (a bare model-initiated confirm, or an
							// edit that collapsed to baseline). Resolve the tool call
							// like a reject and inform the user — once.
							confirmCallbacksRef.current = null;
							queueMicrotask(() => {
								toast.info(
									"No updates found — the document is unchanged.",
								);
								void recordOutcomeRef.current({
									accepted: false,
								});
								respond?.({ accepted: false });
							});
						} else {
							confirmCallbacksRef.current = {
								accept: handleAccept,
								reject: handleReject,
							};
							queueMicrotask(() => {
								// Apply the reviewed diff from the arming path (I2/RC2)
								// so delivery no longer hinges on Effect 2's microtask
								// beating Effect 4's write-back. Idempotent with Effect
								// 2 — skip when the editor already shows the merge.
								const currentEditor = editorRef.current;
								if (currentEditor) {
									const editorMarkdown =
										getEditorMarkdownForSave(currentEditor);
									// Null means serialization
									// failed — treat like "not already merged"
									// so the diff overlay below still applies
									// rather than comparing against a failed read.
									const editorAlreadyMerged =
										editorMarkdown !== null &&
										editorMarkdown !== "" &&
										normalizeForComparison(
											editorMarkdown,
										) ===
											normalizeForComparison(proposedDoc);
									if (!editorAlreadyMerged) {
										const diff = diffPartialText(
											baseline,
											proposedDoc,
											true,
										);
										isDiffReviewEditRef.current = true;
										applyProgrammaticContent(
											currentEditor,
											fromMarkdown(diff),
										);
										isDiffReviewEditRef.current = false;
									}
								}
								setHasPendingConfirm(true);
							});
						}
					}
				} else {
					// Tool call resolved — allow the next confirm cycle to re-arm.
					confirmArmedRef.current = false;
					confirmNoOpRef.current = false;
				}

				// A no-op confirm renders nothing actionable — it is resolved above.
				if (confirmNoOpRef.current) {
					return <>{null}</>;
				}

				return (
					<ConfirmChanges
						args={args}
						respond={respond}
						status={status}
						onMount={() => setHasPendingConfirm(true)}
						onDone={() => {
							setHasPendingConfirm(false);
							confirmCallbacksRef.current = null;
						}}
						onReject={handleReject}
						onConfirm={handleAccept}
					/>
				);
			},
		},
		[],
	);

	// AI Diagram Suggestion action - analyzes content and suggests Mermaid diagrams
	useCopilotAction(
		{
			name: "suggest_diagram",
			description:
				"Suggest a Mermaid diagram that could help illustrate part of the document. " +
				"Analyze the document content for architecture descriptions, workflows, data flows, " +
				"entity relationships, or process steps that would benefit from a visual diagram. " +
				"Generate the Mermaid code and insert it at the cursor position. " +
				"Use calm, advisory language -- never claim the diagram is optimal or required.",
			parameters: [
				{
					name: "diagramType",
					type: "string",
					description:
						"The type of Mermaid diagram to generate (flowchart, sequence, classDiagram, erDiagram, mindmap, C4Context, C4Container, stateDiagram, gantt)",
					required: true,
				},
				{
					name: "mermaidCode",
					type: "string",
					description:
						"The complete Mermaid diagram code to insert. Must be valid Mermaid syntax.",
					required: true,
				},
				{
					name: "rationale",
					type: "string",
					description:
						"A brief, advisory explanation of why this diagram might be helpful for the document. Use neutral language.",
					required: true,
				},
			],
			handler: async (args) => {
				const mermaidCode = args.mermaidCode as string;

				if (!editor) {
					return "Editor is not available. The diagram was not inserted.";
				}

				// Insert Mermaid code block at cursor via the editor
				// The MermaidBlock extension will render it as a diagram
				editor
					.chain()
					.focus()
					.insertContent({
						type: "mermaidBlock",
						attrs: { content: mermaidCode },
					})
					.run();

				return `Diagram inserted. ${args.rationale}`;
			},
			render: ({ args, status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
							<span className="font-medium text-foreground">
								Diagram added
							</span>{" "}
							&mdash;{" "}
							{(args.rationale as string) ||
								"A diagram has been placed in the document."}
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Preparing diagram...
					</div>
				);
			},
		},
		[editor],
	);

	// Safety check: if collaboration prerequisites aren't ready, show loading
	// This handles edge cases with React concurrent rendering where guards may pass
	// but props become stale during render
	if (!isCollabPrerequisitesReady) {
		console.warn(
			"[DocumentEditorInner] Collaboration prerequisites not ready",
		);
		return (
			<div className="flex items-center justify-center h-96">
				<div className="flex flex-col items-center gap-3 text-muted-foreground">
					<Loader2 className="h-8 w-8 animate-spin" />
					<span>Initializing collaboration...</span>
				</div>
			</div>
		);
	}

	// Suggestion chips shown in the chat sidebar
	const suggestions = [
		{
			title: "Update from meeting notes",
			message:
				"Update this document with insights from my recent meetings. Show me the meeting selector so I can choose which meetings to include.",
		},
		{
			title: "Expand technical details",
			message: "Add more technical details to the architecture section",
		},
		{
			title: "Add implementation details",
			message:
				"Add implementation details, constraints, and assumptions to the relevant sections without regenerating the whole document.",
		},
		{
			title: "Fill missing sections",
			message:
				"Identify thin or missing sections and expand them in place with concrete details, examples, and edge cases.",
		},
		{
			title: "Suggest a diagram",
			message:
				"Analyze this document and suggest a Mermaid diagram that could help illustrate the architecture, workflow, or relationships described in the content.",
		},
	];

	return (
		<MentionStatusContext.Provider value={activeIdsSet}>
			<AttachmentRegistryProvider
				pendingAttachmentsRef={pendingAttachmentsRef}
				initialAttachmentsByMessageId={initialAttachmentsByMessageId}
			>
				<DocumentAssistantOutcomesProvider
					documentRefKind={documentRefKind}
					documentRefId={documentId}
					projectId={projectId}
					organizationId={organizationId ?? null}
				>
					<HydratedMessagesProvider
						initialMessages={effectiveAssistantMessages ?? []}
						ssrConversationId={effectiveSsrConversationId}
						activeConversationId={activeAssistantConversationId}
						documentRefKind={documentRefKind}
						documentRefId={documentId}
						projectId={projectId}
						organizationId={organizationId ?? null}
					>
						<CopilotSidebar
							AssistantMessage={AssistantMessageWithMark}
							UserMessage={CopilotUserMessage}
							Messages={CustomMessages}
							defaultOpen={false}
							clickOutsideToClose={false}
							Input={CustomSidebarInput}
							RenderSuggestionsList={SuggestionsListWithMark}
							// Group E. `CustomSidebarHeader` is `undefined` when the
							// org has the chat-history feature flag OFF — CopilotKit's
							// default header renders instead.
							Header={CustomSidebarHeader}
							// Group E (cont). When the chat-history flag is OFF,
							// `CustomSidebarLauncher` is undefined and CopilotKit's default
							// round launcher renders. When ON, the header owns closing and
							// this branded pill owns reopening.
							Button={CustomSidebarLauncher}
							labels={{
								title: "AI Assistant",
								initial:
									"Hi! I can help you edit this document in place. Try asking me to:\n\n• Expand a specific section\n• Add technical details, examples, or edge cases\n• Fill in missing sections or clarify requirements\n• Draw an Excalidraw diagram (architecture, flow, etc.)\n\nUse the 'Regenerate' button above the editor only for full document regeneration.",
							}}
							suggestions={suggestions}
						>
							{/* Group H — persists each terminal-state CopilotKit
				    message via `appendTurnForDocument` (FR-2,
				    AC-5/AC-6/AC-7). Side-effect-only component (renders
				    `null`). Mounted inside <CopilotSidebar> so the
				    `useCopilotChatInternal` hook resolves against the
				    same provider the sidebar consumes. Gated on the
				    feature flag to mirror the sidebar header + history
				    drawer mounts. */}
							{documentAssistantHistoryEnabled ? (
								<CopilotPersistenceHook
									documentRefKind={documentRefKind}
									documentRefId={documentId}
									projectId={projectId}
									organizationId={organizationId ?? null}
									conversationId={
										activeAssistantConversationId
									}
									onConversationIdResolved={
										setActiveAssistantConversationId
									}
									onSpilled={setActiveAssistantConversationId}
									requestedVisibility={
										activeAssistantVisibility
									}
									agentId="project_document_generator"
									pendingAttachmentsRef={
										pendingAttachmentsRef
									}
									initialPersistedMessageIds={
										effectivePersistedMessageIds
									}
								/>
							) : null}
							<div className="flex flex-col h-full">
								{/* Header */}
								<div className="relative flex items-center justify-between px-6 py-2 border-b bg-background gap-4">
									{/* AI Generating Indicator - Centered when active */}
									{isUserGenerationActive &&
									!hasPendingConfirm ? (
										<>
											{/* Shimmer progress line at bottom of header */}
											<div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden">
												<div className="generating-shimmer-line" />
											</div>
											<div className="flex-1 flex justify-center">
												<div className="flex items-center gap-2.5 px-5 py-2 rounded-full bg-foreground shadow-md">
													<FabricLogo
														className="size-3.5 opacity-80"
														size={14}
														variant="inverse"
													/>
													<span className="text-sm font-medium text-background">
														Generating
													</span>
													<span className="flex items-center gap-1">
														<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:0ms]" />
														<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:150ms]" />
														<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:300ms]" />
													</span>
												</div>
											</div>
										</>
									) : (
										<>
											{/* The page-level header (lines 1 & 2) already carries the
								  document title and document-type chip, so this row carries
								  prompt-related controls (selector + Manage Prompts gear +
								  Regenerate + Update using context) flush-LEFT, sitting
								  underneath the document type on Line 3. */}
											<div className="flex items-center gap-2 min-w-0 flex-1 justify-start">
												<div className="flex min-w-0 lg:flex-initial">
													<PromptSelector
														agentName="project_document_generator"
														documentType={
															document.type
														}
														value={selectedPromptId}
														onValueChange={
															setSelectedPromptId
														}
														onPromptVersionChange={
															setSelectedPromptVersionId
														}
														disabled={
															isSaving ||
															isRegenerating
														}
														placeholder="Use default prompt"
														// Always show the "Update Binding" action so
														// users can re-bind their prompt selection as
														// the default for this document type. The
														// action bar is lean enough now that there's
														// always room for it.
														showBindAction={true}
														// PromptSelector renders its own Manage
														// Prompts gear inline. Action slot on Line 3
														// no longer mirrors this control — it lives
														// here next to the selector where prompt-
														// management actions belong.
														hideManagePromptsAction={
															false
														}
														// Compact sizing matches the 32-px buttons in
														// the prompt row (Line 4) — non-doc-editor
														// usages (form contexts in ExistingProjectFlow
														// etc.) keep the default Radix h-9/text-base.
														compact={true}
													/>
												</div>

												{/* Spacer pushes Regenerate + Update using
									  context to the right edge of the row so the
									  prompt-related cluster (selector + Manage
									  Prompts gear + Update Binding) stays
									  flush-left underneath the document type. */}
												<div className="flex-1" />

												{/* Wide tier: inline action buttons.
									  Normally shown at lg+ (1024). When the AI sidebar
									  is expanded the *available* width shrinks by 28rem
									  (448px) on top of the 72px nav rail, so even at
									  the xl breakpoint (1280) only ~760px is left —
									  not enough for the full inline tier. We bump to
									  2xl (1536) for the wide tier in that case so the
									  overflow menu kicks in earlier. */}
												<div
													className={`items-center gap-2 ${
														isAiSidebarExpanded
															? "hidden 2xl:flex"
															: "hidden lg:flex"
													}`}
												>
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	type="button"
																	variant="outline"
																	size="sm"
																	onClick={
																		handleDirectRegenerate
																	}
																	disabled={
																		isSaving ||
																		isRegenerating
																	}
																	className="h-8 gap-1.5 text-xs"
																>
																	<RefreshCw
																		className={`size-3 ${isRegenerating ? "animate-spin" : ""}`}
																	/>
																	<span className="hidden xl:inline">
																		Regenerate
																	</span>
																</Button>
															</TooltipTrigger>
															<TooltipContent>
																<p>
																	Regenerate
																	the entire
																	document
																	using AI
																</p>
																<p className="text-xs text-muted-foreground">
																	Uses
																	Temporal
																	workflow for
																	reliable
																	processing
																</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	type="button"
																	variant="outline"
																	size="sm"
																	onClick={() =>
																		void contextUpdate.start()
																	}
																	disabled={
																		isSaving ||
																		isRegenerating ||
																		contextUpdate.isActive ||
																		viewMode ===
																			"raw"
																	}
																	className="h-8 gap-1.5 text-xs"
																>
																	{contextUpdate.isLoading ? (
																		<Loader2 className="size-3 animate-spin" />
																	) : (
																		<RefreshCcwDotIcon className="size-3" />
																	)}
																	<span className="hidden xl:inline">
																		Update
																		using
																		context
																	</span>
																</Button>
															</TooltipTrigger>
															<TooltipContent>
																<p>
																	Update this
																	document
																	with the
																	latest
																	context
																</p>
																<p className="text-xs text-muted-foreground">
																	{viewMode ===
																	"raw"
																		? "Switch to Rich mode to review proposed changes"
																		: "Reviews recent meeting transcripts and team messages"}
																</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
													{enableCollaboration &&
														!actionSlot && (
															<CollaborationStatus
																isConnected={
																	isCollabConnected
																}
																isSynced={
																	isCollabSynced
																}
																collaborators={
																	collaborators ??
																	[]
																}
															/>
														)}
												</div>

												{/* Narrow tier: overflow menu — visible at the
									  same widths the wide tier hides. */}
												<div
													className={`flex ${
														isAiSidebarExpanded
															? "2xl:hidden"
															: "lg:hidden"
													}`}
												>
													{enableCollaboration &&
														!actionSlot && (
															<CollaborationStatus
																isConnected={
																	isCollabConnected
																}
																isSynced={
																	isCollabSynced
																}
																collaborators={
																	collaborators ??
																	[]
																}
															/>
														)}
													<DropdownMenu>
														<TooltipProvider>
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<DropdownMenuTrigger
																		asChild
																	>
																		<Button
																			type="button"
																			variant="outline"
																			size="sm"
																			aria-label="More document actions"
																			disabled={
																				isSaving
																			}
																		>
																			<MoreHorizontalIcon className="h-4 w-4" />
																		</Button>
																	</DropdownMenuTrigger>
																</TooltipTrigger>
																<TooltipContent>
																	<p>
																		More
																		document
																		actions
																	</p>
																</TooltipContent>
															</Tooltip>
														</TooltipProvider>
														<DropdownMenuContent
															align="end"
															className="w-56"
														>
															<DropdownMenuItem
																onSelect={() =>
																	handleDirectRegenerate()
																}
																disabled={
																	isSaving ||
																	isRegenerating
																}
															>
																<RefreshCw
																	className={`mr-2 h-4 w-4 ${isRegenerating ? "animate-spin" : ""}`}
																/>
																Regenerate
															</DropdownMenuItem>
															<DropdownMenuItem
																onSelect={() =>
																	void contextUpdate.start()
																}
																disabled={
																	isSaving ||
																	isRegenerating ||
																	contextUpdate.isActive ||
																	viewMode ===
																		"raw"
																}
															>
																{contextUpdate.isLoading ? (
																	<Loader2 className="mr-2 h-4 w-4 animate-spin" />
																) : (
																	<RefreshCcwDotIcon className="mr-2 h-4 w-4" />
																)}
																Update using
																context
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</div>
											</div>
										</>
									)}
								</div>

								{/* Toolbar - Only show in rich mode */}
								{viewMode === "rich" && (
									<EditorToolbar
										editor={editor}
										onImageUpload={handleImageUpload}
									/>
								)}

								{/* Non-blocking banner when generation progress overlay is dismissed */}
								{isProgressDismissed &&
									document?.status === "GENERATING" &&
									(!document.content ||
										document.content.trim().length ===
											0) && (
										<div className="mx-6 mt-4 flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-xs text-primary">
											<div className="flex items-center gap-2">
												<Loader2 className="h-3.5 w-3.5 animate-spin" />
												<span>
													Document generation in
													progress...
												</span>
											</div>
											<div className="flex items-center gap-2">
												<Button
													size="sm"
													variant="ghost"
													className="h-6 px-2 text-xs text-primary hover:text-primary"
													onClick={() =>
														setIsProgressDismissed(
															false,
														)
													}
												>
													Show Progress
												</Button>
												{(() => {
													const isStale =
														isDocumentGenerationStale(
															document?.generationStartedAt,
															document?.updatedAt,
														);
													if (!isStale) {
														return null;
													}
													return (
														<Button
															size="sm"
															variant="outline"
															className="h-6 px-2 text-xs border-primary/30"
															disabled={
																isRegenerating
															}
															onClick={
																handleDirectRegenerate
															}
														>
															Retry
														</Button>
													);
												})()}
											</div>
										</div>
									)}

								{/* Generation & Regeneration Progress Overlay */}
								{!isProgressDismissed &&
									!showImportedRegenWarning &&
									((isRegenerating && !showConfirmDialog) ||
										(document?.status === "GENERATING" &&
											(!document.content ||
												document.content.trim()
													.length === 0))) && (
										<div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 flex items-center justify-center p-4">
											<DocumentGenerationProgress
												status={
													document?.status ||
													"GENERATING"
												}
												progress={
													document?.generationProgress ??
													0
												}
												title={document?.title}
												error={
													document?.generationError
												}
												generationStartedAt={
													document?.generationStartedAt
												}
												updatedAt={document?.updatedAt}
												onRetry={handleDirectRegenerate}
												onDismiss={() =>
													setIsProgressDismissed(true)
												}
												isRetrying={isRegenerating}
												isRegenerating={isRegenerating}
											/>
										</div>
									)}

								{/* Failed-generation notice — surfaces a persisted FAILED
					    status so a failed generation isn't shown as an empty
					    "saved" document with no error (Business Case QA, AC-7). */}
								{document?.status === "FAILED" &&
									!isRegenerating &&
									!showConfirmDialog &&
									!showImportedRegenWarning && (
										<DocumentGenerationFailedNotice
											error={document.generationError}
											onRetry={handleDirectRegenerate}
											isRetrying={isRegenerating}
										/>
									)}

								{/* Warning dialog before regeneration */}
								{showImportedRegenWarning &&
									(() => {
										const docSource = (document as any)
											?.source as string | undefined;
										const isImported =
											docSource === "IMPORTED" ||
											docSource === "EXTERNAL";
										return (
											<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
												<div className="bg-card border border-border rounded-lg p-6 shadow-2xl max-w-md mx-4">
													<div className="flex items-center gap-2 mb-3">
														<AlertTriangle className="h-5 w-5 text-highlight" />
														<h3 className="text-lg font-semibold">
															{isImported
																? "Regenerate Imported Document?"
																: "Regenerate this document?"}
														</h3>
													</div>
													{isImported && (
														<p className="text-sm text-muted-foreground mb-3">
															{docSource ===
															"EXTERNAL"
																? "This document was imported from an external source."
																: "This document was imported from an uploaded file."}
														</p>
													)}
													<p className="text-sm mb-3">
														Regenerating will
														replace the current
														content with a new
														AI-generated version
														using all your project
														context. You'll be able
														to accept or reject the
														result after generation.
													</p>
													<div className="p-3 bg-muted rounded-lg mb-4">
														<p className="text-sm text-muted-foreground">
															{isImported
																? "Your imported version will be preserved in version history."
																: "Your current content will be saved to version history before being replaced."}
														</p>
													</div>
													<div className="flex justify-end gap-2">
														<Button
															variant="outline"
															size="sm"
															onClick={() =>
																setShowImportedRegenWarning(
																	false,
																)
															}
														>
															Cancel
														</Button>
														<Button
															size="sm"
															onClick={
																handleDirectRegenerate
															}
														>
															<RefreshCw className="mr-2 h-4 w-4" />
															Regenerate
														</Button>
													</div>
												</div>
											</div>
										);
									})()}

								{/* Confirmation Dialog for Regenerated Content */}
								{showConfirmDialog && (
									<RegenerationConfirmDialog
										previousContent={previousContent}
										newContent={newContent}
										onAccept={() => {
											// Accept new content
											startTransition(() => {
												const html =
													fromMarkdown(newContent);

												// Use requestAnimationFrame to defer editor update
												requestAnimationFrame(() => {
													applyProgrammaticContent(
														editor,
														html,
													);
												});

												// Update local state only - DO NOT call setAgentState for direct regeneration
												// Calling setAgentState triggers CopilotKit which causes the AI response to appear
												setCurrentDocument(newContent);

												// Only update agent state for agent-based regeneration (has respond ref)
												if (
													regenerationRespondRef.current
												) {
													// IMPORTANT: Preserve ragContexts and projectContext
													setAgentState((prev) => ({
														...prev,
														document: newContent,
														streamingContent:
															newContent,
													}));
													regenerationRespondRef.current(
														{
															accepted: true,
														},
													);
													regenerationRespondRef.current =
														null;
												}

												setShowConfirmDialog(false);
												regenerationTriggeredRef.current = false;
												// Keep isDirectRegenerationRef true a bit longer to prevent any async effects
												setTimeout(() => {
													isDirectRegenerationRef.current = false;
												}, 500);

												// Reset confirming flag after a delay
												setTimeout(() => {
													setIsConfirming(false);
												}, 1000);

												toast.success(
													"Document regeneration accepted!",
												);
											});
										}}
										onReject={() => {
											// Revert to previous content
											startTransition(() => {
												const markdown =
													fromMarkdown(
														previousContent,
													);

												// Use requestAnimationFrame to defer editor update
												requestAnimationFrame(() => {
													applyProgrammaticContent(
														editor,
														markdown,
													);
												});

												// Update local state only - DO NOT call setAgentState for direct regeneration
												setCurrentDocument(
													previousContent,
												);

												// True rollback: delete the regen's DocumentVersion row and
												// rewind projectDocument.{version, content} to the prior
												// snapshot, so version history stays consistent. Falls back
												// to the old skipVersionBump save when there is no prior
												// version to revert to (e.g. first-ever generation) or
												// the live state has drifted from the latest snapshot.
												// Passing `organizationId` explicitly anchors the side
												// effects (RAG re-embed, realtime) to the current route's
												// tenant rather than the session's active org, which can
												// be stale.
												rejectRegenerationMutation.mutate(
													{
														projectId,
														id: documentId,
														organizationId:
															organizationId ??
															null,
													},
													{
														onError: (error) => {
															const isNoPrior =
																(
																	error as {
																		code?: string;
																	}
																)?.code ===
																"CONFLICT";
															if (!isNoPrior) {
																toast.error(
																	`Failed to reject regeneration: ${error.message}`,
																);
																return;
															}
															// First-ever generation — no prior version
															// to revert to. Best we can do is overwrite
															// the live content back to the captured
															// previousContent without touching versions.
															saveMutation.mutate(
																{
																	projectId,
																	id: documentId,
																	content:
																		previousContent,
																	skipVersionBump: true,
																	organizationId:
																		organizationId ??
																		null,
																},
															);
														},
													},
												);

												// Only update agent state for agent-based regeneration (has respond ref)
												if (
													regenerationRespondRef.current
												) {
													// IMPORTANT: Preserve ragContexts and projectContext
													setAgentState((prev) => ({
														...prev,
														document:
															previousContent,
														streamingContent:
															previousContent,
													}));
													regenerationRespondRef.current(
														{
															accepted: false,
														},
													);
													regenerationRespondRef.current =
														null;
												}

												setShowConfirmDialog(false);
												regenerationTriggeredRef.current = false;
												// Keep isDirectRegenerationRef true a bit longer to prevent any async effects
												setTimeout(() => {
													isDirectRegenerationRef.current = false;
												}, 500);

												// Reset confirming flag after a delay
												setTimeout(() => {
													setIsConfirming(false);
												}, 1000);

												toast.info(
													"Document regeneration rejected. Reverted to previous version.",
												);
											});
										}}
									/>
								)}

								{/* Editor */}
								<div className="relative flex min-h-0 flex-1 overflow-hidden">
									{viewMode === "rich" &&
										!showDiffPreviewPanes && (
											<DocumentTocRail
												editor={editor}
												onAnnounce={
													setScrollAnnouncement
												}
											/>
										)}
									{viewMode === "rich" ? (
										// biome-ignore lint/a11y/useKeyWithClickEvents: click delegates to image lightbox, keyboard handled via Escape in lightbox
										// biome-ignore lint/a11y/noStaticElementInteractions: editor container delegates image clicks, not interactive itself
										<div
											className={`flex-1 overflow-auto bg-background ${isLoading || hasPendingConfirm || contextUpdate.showingDiff ? "streaming-diff-active" : ""} ${!editor?.isEditable ? "tiptap-readonly" : ""}`}
											onClick={(e) => {
												// Open lightbox when clicking images in read-only mode
												if (!editor?.isEditable) {
													const target =
														e.target as HTMLElement;
													const imgEl =
														target.tagName === "IMG"
															? (target as HTMLImageElement)
															: target
																	.closest(
																		"figure",
																	)
																	?.querySelector(
																		"img",
																	);
													if (
														imgEl &&
														imgEl instanceof
															HTMLImageElement
													) {
														setLightboxImage({
															src: imgEl.src,
															alt:
																imgEl.alt || "",
														});
													}
												}
											}}
										>
											{editor && (
												<ImageSelectionToolbar
													editor={editor}
												/>
											)}
											{/* Sticky diff-review header — the mode toggle and
							    accept/reject bar stay pinned to the top of the
							    scroll area while a long document is reviewed. */}
											<div className="sticky top-0 z-20 bg-background">
												{isDiffReviewActive && (
													<div className="flex items-center justify-end border-b border-border bg-muted/30 px-4 py-2">
														<DiffViewModeToggle
															value={diffViewMode}
															onChange={
																setDiffViewMode
															}
														/>
													</div>
												)}
												{hasPendingConfirm && (
													<DiffReviewBar
														editor={editor}
														mode={
															effectiveDiffViewMode
														}
														onAcceptAll={() =>
															confirmCallbacksRef.current?.accept()
														}
														onRejectAll={() =>
															confirmCallbacksRef.current?.reject()
														}
														onBeforeChange={() => {
															isDiffReviewEditRef.current = true;
														}}
														onAfterChange={() => {
															isDiffReviewEditRef.current = false;
														}}
														outcomeAudit={{
															conversationId:
																activeAssistantConversationId,
															projectId,
															organizationId,
															messageId:
																lastWriteDocumentLocalToolCall?.messageId ??
																null,
															toolCallId:
																lastWriteDocumentLocalToolCall?.toolCallId ??
																null,
														}}
													/>
												)}
												{contextUpdate.isLoading && (
													<div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 bg-muted/50 border-b border-border text-sm backdrop-blur-sm">
														<Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
														<span className="font-medium text-foreground">
															{
																contextUpdate.loadingStage
															}
														</span>
														<span className="text-xs text-muted-foreground tabular-nums">
															·{" "}
															{
																contextUpdate.elapsedSeconds
															}
															s elapsed
														</span>
														<span className="ml-auto text-xs text-muted-foreground">
															This usually takes
															30–120 s
														</span>
													</div>
												)}
												{contextUpdate.showingDiff && (
													<DiffReviewBar
														editor={editor}
														mode={
															effectiveDiffViewMode
														}
														onAcceptAll={() => {
															void contextUpdate.confirm();
														}}
														onRejectAll={() => {
															contextUpdate.reject();
														}}
														onBeforeChange={() => {
															isDiffReviewEditRef.current = true;
														}}
														onAfterChange={() => {
															isDiffReviewEditRef.current = false;
														}}
													/>
												)}
											</div>
											{document && (
												<DocumentDecisionPrecheckBanner
													projectId={projectId}
													documentId={documentId}
													organizationId={
														organizationId ?? null
													}
													decisionPrecheck={
														document.decisionPrecheck
													}
													currentContentHash={
														document.currentContentHash ??
														null
													}
													onAcknowledged={() => {
														queryClient.invalidateQueries(
															{
																queryKey:
																	documentGetQueryKey,
															},
														);
													}}
												/>
											)}
											{contextUpdate.showingDiff &&
												contextUpdate.preview
													?.summary && (
													<div className="mx-4 mt-2 rounded-md border border-border bg-card px-3 py-2">
														<p className="text-xs font-medium text-muted-foreground uppercase tracking-[0.2em]">
															AI Summary
														</p>
														<p className="mt-1 text-sm text-foreground/80">
															{
																contextUpdate
																	.preview
																	.summary
															}
														</p>
													</div>
												)}
											<div
												className={
													showDiffPreviewPanes
														? "hidden"
														: undefined
												}
											>
												<EditorContent
													editor={editor}
													className="prose prose-sm max-w-none dark:prose-invert"
												/>
											</div>
											{showDiffPreviewPanes &&
												diffViews && (
													<DiffPreviewPanes
														mode={
															effectiveDiffViewMode ===
															"fullPreview"
																? "fullPreview"
																: "sideBySide"
														}
														derived={diffViews}
													/>
												)}
											<DocumentAssetsPanel
												assets={documentAssets}
											/>
										</div>
									) : (
										<div className="flex-1 overflow-auto bg-background p-10">
											{rawContent.includes(
												"data:image/",
											) && (
												<div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
													<ImageIcon className="size-3.5 shrink-0" />
													<span>
														This document contains
														embedded images. Use the
														rich editor to view
														them.
													</span>
												</div>
											)}
											<div className="mb-2 flex items-center justify-between">
												<span className="text-xs text-muted-foreground font-mono">
													Raw Markdown
												</span>
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={
														handleAskAboutSelection
													}
													disabled={isLoading}
													className="gap-1.5"
												>
													<SparklesIcon className="size-3.5" />
													Ask About Selection
												</Button>
											</div>
											<Textarea
												value={rawContent}
												onChange={(e) =>
													handleRawContentChange(
														e.target.value,
													)
												}
												placeholder="Enter your document content in markdown format... Type @fabric followed by your question to ask the AI agent."
												className="font-mono text-sm resize-none min-h-[calc(100vh-300px)] w-full"
												disabled={isLoading}
											/>
											<div className="mt-4 space-y-2">
												<p className="text-xs text-muted-foreground">
													Raw markdown view. Edit the
													document directly in
													markdown format.
												</p>
											</div>
											<DocumentAssetsPanel
												assets={documentAssets}
											/>
										</div>
									)}
								</div>
							</div>

							{/* Version History Panel */}
							<DocumentVersionHistory
								open={showVersionHistory}
								onOpenChange={setShowVersionHistory}
								projectId={projectId}
								documentId={documentId}
								currentVersion={document?.version || 1}
								currentContent={
									document?.content || currentDocument || ""
								}
								onVersionRestored={(
									restoredContent: string,
								) => {
									// Programmatically update editor - no page reload
									applyProgrammaticContent(
										editor,
										fromMarkdown(restoredContent),
									);
									setCurrentDocument(restoredContent);
									baselineRef.current = restoredContent;
									updateSavedBaseline(restoredContent);
									setAgentState((prev) => ({
										...prev,
										document: restoredContent,
										streamingContent: restoredContent,
									}));
									setHasUnsavedChanges(false);
									// Invalidate queries to refresh version list and document metadata
									queryClient.invalidateQueries({
										queryKey:
											orpc.projects.documents.get.queryKey(
												{
													input: {
														id: documentId,
														projectId,
														organizationId,
													},
												},
											),
									});
									queryClient.invalidateQueries({
										queryKey:
											orpc.projects.documents.versions.list.queryKey(
												{
													input: {
														projectId,
														documentId,
														organizationId,
													},
												},
											),
									});
									setShowVersionHistory(false);
								}}
							/>
						</CopilotSidebar>

						{/* Group F — persistent chat-history drawer. The drawer is
			    the secondary surface for browsing prior conversations;
			    only mounted when the org has the feature flag ON,
			    mirroring `CustomSidebarHeader`. */}
						{documentAssistantHistoryEnabled && user ? (
							<CopilotHistoryDrawer
								open={historyDrawerOpen}
								onOpenChange={setHistoryDrawerOpen}
								documentRefKind={documentRefKind}
								documentRefId={documentId}
								projectId={projectId}
								organizationId={organizationId ?? null}
								currentUserId={user.id}
								activeConversationId={
									activeAssistantConversationId
								}
								onForked={({
									forkedConversationId,
									copiedMessages,
								}) => {
									// Swap the live chat to the new (forked)
									// conversation without crashing CopilotKit.
									//
									// Order:
									//   1. Clear CopilotKit's runtime so the live
									//      half of the sidebar shows nothing — only
									//      the historical (forked) messages render.
									//   2. Update the hydrated trio (messages + ssr
									//      id + persisted ids) so HydratedMessagesProvider
									//      re-renders with the forked messages and
									//      CopilotPersistenceHook does NOT re-persist
									//      any of them (ids pre-seeded into the
									//      walker's "already persisted" set).
									//   3. Flip the active conversation id last so
									//      the provider's `sameThread` check passes
									//      and the historical half lights up.
									//
									// What we DON'T do: push the copied messages
									// into CopilotKit's runtime via a second
									// setMessages call. That triggers an internal
									// "Remember to wrap your app in <CopilotKit>"
									// error mid-render which the error boundary
									// then catches and unmounts the whole editor.
									// Reproduced on staging dpl_2RyCKvUFvsaMv2CojKQ7BEu8qo3q.
									//
									// Agent context for the next user send is
									// recovered server-side: the LangGraph agent
									// reads the persisted messages[] for the
									// active conversationId, so the user's next
									// turn carries the full forked history without
									// the client having to seed the runtime.
									// Verified on staging: "How many D7 markers did
									// we add?" answered "There are 2 — D7 marker 1
									// and D7 marker 2" — backend pulled context.
									setCopilotMessages([]);
									setEffectiveAssistantMessages(
										copiedMessages as unknown as ReadonlyArray<
											Record<string, unknown>
										>,
									);
									setEffectiveSsrConversationId(
										forkedConversationId,
									);
									setEffectivePersistedMessageIds(
										copiedMessages
											.map((m) => m.id)
											.filter(
												(id): id is string =>
													typeof id === "string",
											),
									);
									setActiveAssistantConversationId(
										forkedConversationId,
									);
								}}
							/>
						) : null}

						{/* Image Lightbox for read-only viewing */}
						{lightboxImage && (
							<ImageLightbox
								src={lightboxImage.src}
								alt={lightboxImage.alt}
								onClose={() => setLightboxImage(null)}
							/>
						)}

						{/* Page-chrome sync slot — Yjs sync status pill. Lives on the
			  breadcrumb row alongside the project-presence indicators. */}
						{syncSlot &&
							enableCollaboration &&
							createPortal(
								<CollaborationStatus
									isConnected={isCollabConnected}
									isSynced={isCollabSynced}
									collaborators={collaborators ?? []}
								/>,
								syncSlot,
							)}

						{/* Page-chrome action slot — Raw + Version history (action
			  buttons only). Portaled into Line 3 of the page-level masthead
			  alongside Save. The Manage Prompts gear lives inline next to
			  PromptSelector, not here. */}
						{actionSlot &&
							createPortal(
								<>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant={
														viewMode === "raw"
															? "secondary"
															: "ghost"
													}
													size="sm"
													onClick={
														handleViewModeToggle
													}
													aria-label={
														viewMode === "rich"
															? "View raw markdown"
															: "Switch to rich editor"
													}
												>
													{viewMode === "rich" ? (
														<Code2Icon className="size-4" />
													) : (
														<EyeIcon className="size-4" />
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{viewMode === "rich"
														? "Switch to raw markdown view"
														: "Switch to rich editor"}
												</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() =>
														setShowVersionHistory(
															true,
														)
													}
													disabled={
														isSaving ||
														isRegenerating
													}
													aria-label={`Version history, current v${
														(document as any)
															?.version || 1
													}`}
												>
													<HistoryIcon className="size-4 mr-1" />
													<span className="text-xs text-muted-foreground">
														v
														{(document as any)
															?.version || 1}
													</span>
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												<p>Version history</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</>,
								actionSlot,
							)}

						{/* Page-chrome save slot — Save split-button. Same UX as the
			  feature editor: primary "Save"/"Saved"/"Saving…" + dropdown
			  for "Save & close". */}
						{saveSlot &&
							createPortal(
								(() => {
									const isSaved =
										!isSaving && !hasUnsavedChanges;
									const isPrimaryDisabled =
										isSaving || isSaved;
									const primaryLabel = isSaving
										? "Saving…"
										: isSaved
											? "Saved"
											: "Save";
									const primaryAriaLabel = isSaving
										? "Saving"
										: isSaved
											? "Document saved, no changes to save"
											: "Save document";
									const primaryTooltip = isSaving
										? "Saving…"
										: isSaved
											? "No changes to save"
											: "Save document";
									const PrimaryIcon = isSaving
										? Loader2
										: isSaved
											? CheckIcon
											: SaveIcon;
									return (
										<div
											className="inline-flex shrink-0"
											aria-live="polite"
										>
											<Tooltip>
												<TooltipTrigger asChild>
													<span
														tabIndex={
															isPrimaryDisabled
																? 0
																: -1
														}
														className="inline-flex"
													>
														<Button
															type="button"
															size="sm"
															disabled={
																isPrimaryDisabled
															}
															aria-label={
																primaryAriaLabel
															}
															className="shrink-0 rounded-r-none"
															onClick={() => {
																isManualSaveRef.current = true;
																shouldRedirectAfterSaveRef.current = false;
																handleSave();
															}}
														>
															<PrimaryIcon
																className={`size-4 mr-2 ${
																	isSaving
																		? "animate-spin"
																		: ""
																}`}
																aria-hidden
															/>
															{primaryLabel}
														</Button>
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{primaryTooltip}
												</TooltipContent>
											</Tooltip>
											<DropdownMenu modal={false}>
												<DropdownMenuTrigger asChild>
													<Button
														type="button"
														size="sm"
														disabled={
															isPrimaryDisabled
														}
														aria-label="More save options"
														className="shrink-0 rounded-l-none border-l border-primary-foreground/30 px-2"
													>
														<ChevronDown
															className="size-4"
															aria-hidden
														/>
													</Button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end">
													<DropdownMenuItem
														onSelect={() => {
															isManualSaveRef.current = true;
															shouldRedirectAfterSaveRef.current = true;
															handleSave();
														}}
														className="cursor-pointer rounded-md bg-primary text-primary-foreground focus:bg-primary/90 focus:text-primary-foreground data-[highlighted]:bg-primary/90 data-[highlighted]:text-primary-foreground"
													>
														<XIcon
															className="mr-2 size-4"
															aria-hidden
														/>
														Save & Close
													</DropdownMenuItem>
												</DropdownMenuContent>
											</DropdownMenu>
										</div>
									);
								})(),
								saveSlot,
							)}
						{/* Polite live region — announces scroll-to-mention navigation to screen readers */}
						<div
							role="status"
							aria-live="polite"
							className="sr-only"
						>
							{scrollAnnouncement}
						</div>
					</HydratedMessagesProvider>
				</DocumentAssistantOutcomesProvider>
			</AttachmentRegistryProvider>
		</MentionStatusContext.Provider>
	);
}

// Regeneration confirmation dialog component
interface RegenerationConfirmDialogProps {
	previousContent: string;
	newContent: string;
	onAccept: () => void;
	onReject: () => void;
}

function RegenerationConfirmDialog({
	previousContent,
	newContent,
	onAccept,
	onReject,
}: RegenerationConfirmDialogProps) {
	const [accepted, setAccepted] = useState<boolean | null>(null);
	const [isVisible, setIsVisible] = useState(false);
	const [showStatus, setShowStatus] = useState(false);

	// Smooth mount animation
	useEffect(() => {
		const timer = setTimeout(() => {
			setIsVisible(true);
		}, 10);
		return () => clearTimeout(timer);
	}, []);

	// Delay status message appearance
	useEffect(() => {
		if (accepted !== null) {
			const timer = setTimeout(() => {
				setShowStatus(true);
			}, 150);
			return () => clearTimeout(timer);
		}
	}, [accepted]);

	const handleAccept = () => {
		setAccepted(true);
		setTimeout(() => {
			onAccept();
		}, 800);
	};

	const handleReject = () => {
		setAccepted(false);
		setTimeout(() => {
			onReject();
		}, 800);
	};

	return (
		<div
			data-testid="regeneration-confirm-modal"
			className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-2"
			style={{
				opacity: isVisible ? 1 : 0,
				transition: "opacity 0.2s ease-out",
			}}
		>
			<div
				className="bg-card border border-border rounded-lg shadow-2xl w-[98vw] h-[98vh] overflow-hidden flex flex-col"
				style={{
					transform: isVisible ? "scale(1)" : "scale(0.95)",
					transition: "transform 0.2s ease-out",
				}}
			>
				<div className="shrink-0 p-6 border-b border-border">
					<h3 className="text-lg font-semibold">
						Document Regeneration Complete
					</h3>
					<p className="text-sm text-muted-foreground mt-1">
						Review the changes and decide whether to accept or
						reject the new version.
					</p>
				</div>

				<div className="flex-1 p-6 min-h-0 overflow-auto">
					<div className="grid grid-cols-2 gap-4 h-full min-h-[600px]">
						<div className="flex flex-col h-full min-h-0">
							<h4 className="text-sm font-medium mb-2 text-muted-foreground shrink-0">
								Previous Version (
								{
									previousContent
										.split(/\s+/)
										.filter((w) => w.length > 0).length
								}{" "}
								words)
							</h4>
							<div className="flex-1 min-h-0 bg-muted/50 rounded-lg p-4 text-sm whitespace-pre-wrap font-mono overflow-y-auto overflow-x-auto">
								{previousContent}
							</div>
						</div>
						<div className="flex flex-col h-full min-h-0">
							<h4 className="text-sm font-medium mb-2 text-primary shrink-0">
								New Version (
								{
									newContent
										.split(/\s+/)
										.filter((w) => w.length > 0).length
								}{" "}
								words)
							</h4>
							<div className="flex-1 min-h-0 bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm whitespace-pre-wrap font-mono overflow-y-auto overflow-x-auto">
								{newContent}
							</div>
						</div>
					</div>
				</div>

				{accepted === null ? (
					<div className="shrink-0 p-6 border-t border-border flex justify-end gap-3">
						<Button
							variant="outline"
							onClick={handleReject}
							className="min-w-24"
						>
							Reject
						</Button>
						<Button onClick={handleAccept} className="min-w-24">
							Accept
						</Button>
					</div>
				) : (
					<div className="shrink-0 p-6 border-t border-border flex justify-center">
						{showStatus && (
							<div
								data-testid="status-display"
								className="bg-muted text-muted-foreground py-2 px-4 rounded transition-all duration-200 ease-out"
								style={{
									opacity: showStatus ? 1 : 0,
									transform: showStatus
										? "scale(1)"
										: "scale(0.95)",
								}}
							>
								{accepted ? "✓ Accepted" : "✗ Rejected"}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// Confirmation dialog component - matches reference implementation
interface ConfirmChangesProps {
	args: any;
	respond: any;
	status: any;
	onConfirm: () => void;
	onReject: () => void;
	originalLength?: number;
	newLength?: number;
	onMount?: () => void;
	onDone?: () => void;
}

function ConfirmChanges({
	respond,
	status,
	onConfirm,
	onReject,
	originalLength = 0,
	newLength = 0,
	onMount,
	onDone,
}: ConfirmChangesProps) {
	// Track user's choice locally, but also derive from status
	// This handles the case where component is recreated after action re-registration
	const [userChoice, setUserChoice] = useState<
		"accepted" | "rejected" | null
	>(null);
	const [hidden, setHidden] = useState(false);

	// Auto-dismiss after user makes a choice
	useEffect(() => {
		if (userChoice !== null) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [userChoice]);

	// Signal to parent that generation is done and confirm dialog is active
	useEffect(() => {
		onMount?.();
		return () => onDone?.();
	}, []);

	// Calculate content loss percentage
	const hasContentLoss = originalLength > 0 && newLength < originalLength;
	const contentLossPercent = hasContentLoss
		? Math.round(((originalLength - newLength) / originalLength) * 100)
		: 0;
	const isSignificantLoss = contentLossPercent > 20; // More than 20% content removed

	// If status is not "executing", the tool call has been responded to
	// Don't show anything for completed/old confirmations to avoid UI clutter
	const isCompleted = status !== "executing";

	// If completed but no local choice, this component was recreated after the action completed
	// Hide it completely to avoid cluttering the sidebar with old confirmations
	if (isCompleted && userChoice === null) {
		return null;
	}

	if (hidden) {
		return null;
	}

	// User just made a choice - show the result
	if (userChoice !== null) {
		return (
			<div
				data-testid="confirm-changes-modal"
				className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
			>
				<h2 className="text-lg font-bold mb-4 text-foreground">
					Confirm Changes
				</h2>
				<div className="flex justify-end">
					<div
						data-testid="status-display"
						className="mt-4 bg-muted text-muted-foreground py-2 px-4 rounded inline-block"
					>
						{userChoice === "accepted"
							? "✓ Changes accepted"
							: "✗ Changes discarded"}
					</div>
				</div>
			</div>
		);
	}

	// Show buttons for active confirmation
	return (
		<div
			data-testid="confirm-changes-modal"
			className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
		>
			<h2 className="text-lg font-bold mb-4 text-foreground">
				Confirm Changes
			</h2>
			{isSignificantLoss && (
				<div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
					<p className="text-sm text-destructive font-medium">
						⚠️ Warning: {contentLossPercent}% content reduction
						detected
					</p>
					<p className="text-xs text-destructive/80 mt-1">
						The AI removed significant content. Review the changes
						(red = removed, green = added) before accepting.
					</p>
				</div>
			)}
			<p className="mb-6 text-foreground">
				Do you want to accept the changes?
			</p>
			<div className="flex justify-end space-x-4">
				<button
					type="button"
					data-testid="reject-button"
					className="bg-muted text-muted-foreground py-2 px-4 rounded cursor-pointer hover:bg-muted/80"
					onClick={() => {
						setUserChoice("rejected");
						onReject();
					}}
				>
					Reject
				</button>
				<button
					type="button"
					data-testid="confirm-button"
					className="bg-primary text-primary-foreground py-2 px-4 rounded cursor-pointer hover:bg-primary/90"
					onClick={() => {
						setUserChoice("accepted");
						onConfirm();
					}}
				>
					Confirm
				</button>
			</div>
		</div>
	);
}
