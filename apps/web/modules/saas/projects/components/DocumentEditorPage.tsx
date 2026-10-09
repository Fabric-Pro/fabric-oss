"use client";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { isDeprecatedDocumentType } from "@repo/utils/document-type-catalog";
import { isGlossyEligible } from "@repo/utils/glossy/eligibility";
import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import type { MessageAttachmentListItem } from "@saas/shared/components/copilot/MessageAttachmentList";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { SubscribeToggle } from "@saas/subscriptions/components/SubscribeToggle";
import { getAvatarInitials } from "@shared/lib/avatar-initials";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import { Badge } from "@ui/components/badge";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ArrowLeftIcon,
	HomeIcon,
	Loader2Icon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ErrorInfo, ReactNode } from "react";
import {
	Component,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { type DocumentChangeEvent, useProjectPresence } from "../hooks";
import {
	needsLegacyGlossyEdition,
	useLegacyGlossyEdition,
} from "../hooks/use-legacy-glossy-edition";
import { isDocumentGenerationRunning } from "../lib/document-pipeline";
import { buildGlossyEditionRoute } from "../lib/stories/routes";
import { DocumentAutoRefreshToggle } from "./DocumentAutoRefreshToggle";
import { DocumentEditor, getDocumentTypeLabel } from "./DocumentEditor";
import { DocumentEditorAiUnavailable } from "./DocumentEditorAiUnavailable";
import { DocumentTitleInlineEdit } from "./DocumentTitleInlineEdit";
import {
	DeprecatedDocumentTypeBadge,
	FeaturesDeprecationNotice,
} from "./FeaturesDeprecationNotice";
import { ProposalAnalysisPanel } from "./proposal-artifact/ProposalAnalysisPanel";
import {
	PROPOSAL_ARTIFACT_TYPOGRAPHY_CLASS,
	ProposalLiveSections,
} from "./proposal-artifact/ProposalLiveSections";
import { ProposalStylePanel } from "./proposal-artifact/ProposalStylePanel";
import {
	analysisTabIndicator,
	awaitingAnalysisOfLatestGeneration,
	proposalAnalysisQueryKey,
	useProposalAnalysis,
} from "./proposal-artifact/use-proposal-analysis";

// Error boundary to catch CopilotKit initialization failures. The fallback
// must not mount anything that calls a CopilotKit hook — `<DocumentEditor>`
// does, unconditionally, and on 1.70 those throw without a provider above
// them, so it cannot be the fallback (Fizzy #2393). The fallback receives
// the caught error so the AI-free panel can surface its message.
class CopilotErrorBoundary extends Component<
	{ children: ReactNode; fallback: (error: Error | null) => ReactNode },
	{ hasError: boolean; error: Error | null }
> {
	constructor(props: {
		children: ReactNode;
		fallback: (error: Error | null) => ReactNode;
	}) {
		super(props);
		this.state = { hasError: false, error: null };
	}

	static getDerivedStateFromError(error: Error) {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, errorInfo: ErrorInfo) {
		console.error(
			"[CopilotErrorBoundary] CopilotKit failed to initialize:",
			error,
			errorInfo,
		);
	}

	render() {
		if (this.state.hasError) {
			return this.props.fallback(this.state.error);
		}
		return this.props.children;
	}
}

/**
 * The editor's way to the document's Glossy page (Fizzy #2589, R1). A gated
 * masthead control like `DocumentAutoRefreshToggle`: nothing renders unless
 * the organization has the `GLOSSY_EDITION` rollout gate on (R40) and the
 * document type is Glossy-eligible (R2). Viewers get it too — the page shows
 * them the preview and downloads.
 *
 * A Proposal under the `PROPOSAL_ARTIFACT` gate is written client-ready and
 * needs no Glossy edition, so it keeps the link only while a published legacy
 * edition exists to open (Fizzy #2801).
 */
function GlossyVersionLink({
	href,
	projectId,
	documentId,
	documentType,
}: {
	/** Absent outside an organization route: the Glossy page has no other. */
	href: string | null;
	projectId: string;
	documentId: string;
	documentType: string | null | undefined;
}) {
	const enabled = useFeatureFlag("GLOSSY_EDITION");
	const proposalArtifactEnabled = useFeatureFlag("PROPOSAL_ARTIFACT");
	const eligible = enabled && !!href && isGlossyEligible(documentType ?? "");
	const needsLegacyEdition = needsLegacyGlossyEdition(
		documentType,
		proposalArtifactEnabled,
	);
	const hasLegacyEdition = useLegacyGlossyEdition(
		projectId,
		documentId,
		eligible && needsLegacyEdition,
	);
	if (
		!eligible ||
		!href ||
		(needsLegacyEdition && hasLegacyEdition !== true)
	) {
		return null;
	}
	return <GlossyVersionLinkButton href={href} />;
}

function GlossyVersionLinkButton({ href }: { href: string }) {
	const t = useTranslations("projects.glossyEntry");
	return (
		<Button variant="ghost" size="sm" asChild className="shrink-0">
			<Link href={href}>
				<SparklesIcon className="size-4" aria-hidden="true" />
				{t("editorLink")}
			</Link>
		</Button>
	);
}

/** The tabs of a Proposal's page in artifact mode (Fizzy #2801). */
type ProposalArtifactTab = "main" | "analysis" | "style";

/**
 * What the Internal Analysis tab shows beside its label. Each state carries
 * words, not only an icon or a colour: a spinner says it is waiting or
 * running, a finished run says how many findings are Blocking, and a failed
 * one says so.
 */
function AnalysisTabIndicator({
	indicator,
}: {
	indicator: ReturnType<typeof analysisTabIndicator>;
}) {
	const t = useTranslations(
		"projects.proposalArtifactPage.analysisIndicator",
	);
	switch (indicator.kind) {
		case "pending":
		case "running":
			return (
				<Badge variant="info">
					<Loader2Icon
						className="motion-safe:animate-spin"
						aria-hidden="true"
					/>
					{t(indicator.kind)}
				</Badge>
			);
		case "complete":
			return indicator.blockingCount > 0 ? (
				<Badge variant="error">
					{t("blocking", { count: indicator.blockingCount })}
				</Badge>
			) : null;
		case "failed":
			return (
				<Badge variant="error">
					<AlertCircleIcon aria-hidden="true" />
					{t("failed")}
				</Badge>
			);
		default:
			return null;
	}
}

/**
 * Stands where the editor's prompt selector would: the run writes an
 * artifact Proposal from the library's client proposal prompt and ignores a
 * prompt chosen here (Fizzy #2801).
 */
function LibraryPromptLabel() {
	const t = useTranslations("projects.proposalArtifactEntry");
	return (
		<span
			className="inline-flex h-8 min-w-0 items-center rounded-md border border-border bg-muted/40 px-3 text-xs"
			title={t("libraryPromptHint")}
		>
			<span className="truncate">{t("libraryPrompt")}</span>
		</span>
	);
}

/**
 * The live Main of a generating Proposal, with the Retry a stalled run
 * offers. The editor that would otherwise offer it is hidden while the run
 * is under way, so the retry starts the run from here, as the documents
 * list's Regenerate does.
 */
function ProposalLiveMain({
	projectId,
	documentId,
	organizationId,
	document,
	canRetry,
}: {
	projectId: string;
	documentId: string;
	organizationId: string | null | undefined;
	document: {
		title: string;
		content: string | null;
		liveContent?: string | null;
		status?: string | null;
		generationProgress?: number | null;
		generationError?: string | null;
		generationStartedAt?: Date | string | null;
		updatedAt?: Date | string | null;
	};
	canRetry: boolean;
}) {
	const t = useTranslations("projects.proposalArtifactPage.live");
	const queryClient = useQueryClient();
	const retry = useMutation(
		orpc.projects.documents.generate.mutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.get.queryKey({
						input: { id: documentId, projectId, organizationId },
					}),
				});
			},
			onError: (error) => {
				toast.error(t("retryFailed", { message: error.message }));
			},
		}),
	);

	return (
		<ProposalLiveSections
			liveContent={document.liveContent}
			savedContent={document.content}
			status={document.status ?? "GENERATING"}
			progress={document.generationProgress ?? 0}
			title={document.title}
			generationError={document.generationError}
			generationStartedAt={document.generationStartedAt}
			updatedAt={document.updatedAt}
			onRetry={
				canRetry ? () => retry.mutate({ id: documentId }) : undefined
			}
			isRetrying={retry.isPending}
		/>
	);
}

/**
 * Keeps the scroll offsets inside `root` across it being hidden. A box with
 * `display: none` loses its offset, so every scroll inside is recorded and
 * written back when the subtree is shown again: switching tabs, or a
 * generation finishing, returns the editor where the reader left it.
 */
function useKeptScrollPositions(root: HTMLElement | null, shown: boolean) {
	const positionsRef = useRef(new Map<Element, number>());

	useEffect(() => {
		if (!root) {
			return;
		}
		const record = (event: Event) => {
			if (event.target instanceof Element) {
				positionsRef.current.set(event.target, event.target.scrollTop);
			}
		};
		root.addEventListener("scroll", record, {
			capture: true,
			passive: true,
		});
		return () => {
			root.removeEventListener("scroll", record, { capture: true });
		};
	}, [root]);

	useLayoutEffect(() => {
		if (!shown) {
			return;
		}
		for (const [element, top] of positionsRef.current) {
			if (element.isConnected) {
				element.scrollTop = top;
			} else {
				positionsRef.current.delete(element);
			}
		}
	}, [shown]);
}

type Props = {
	projectId: string;
	documentId: string;
	organizationSlug?: string;
	/**
	 * Group D hydration props. The parent
	 * RSC page fetches the caller's most recent ACTIVE document-assistant
	 * conversation server-side and passes it down. The payload flows
	 * into `<HydratedMessagesProvider>` (mounted inside `<DocumentEditor>`
	 * around `<CopilotSidebar>`) where `<CustomMessages>` reads it to
	 * render historical turns immediately on first paint — avoiding the
	 * empty-greeting flash (AC-7) without depending on CopilotKit's
	 * unreliable `agent.messages` lifecycle.
	 *
	 * Defaults to `[]` / `null` / `"PROJECT_DOCUMENT"` to stay backwards-
	 * compatible with any callers that haven't been migrated yet (e.g.
	 * deep-link previews from Storybook stories).
	 */
	documentRefKind?: "PROJECT_DOCUMENT" | "USER_STORY";
	initialAssistantMessages?: ReadonlyArray<unknown>;
	initialAssistantConversationId?: string | null;
	/**
	 * Group E. Visibility metadata from the
	 * same SSR fetch as `initialAssistantConversationId`. Drives the
	 * visibility chip's pre-lock / post-lock state on first paint. Defaults
	 * to the brand-new-thread state.
	 */
	initialAssistantVisibility?: "SHARED" | "PRIVATE";
	initialAssistantVisibilityLockedAt?: string | null;
};

export function DocumentEditorPage({
	projectId,
	documentId,
	organizationSlug,
	documentRefKind = "PROJECT_DOCUMENT",
	initialAssistantMessages = [],
	initialAssistantConversationId = null,
	initialAssistantVisibility = "SHARED",
	initialAssistantVisibilityLockedAt = null,
}: Props) {
	const { setIsFullscreen } = useFullscreen();
	const { organizationId } = useOrganizationContext();
	const onCopilotError = useCopilotErrorHandler();
	const router = useRouter();

	// Derive the list of message ids that came back from the SSR-loaded
	// conversation so `<CopilotPersistenceHook>` can pre-seed its dedupe
	// set. Without this, every page reload re-fires `appendTurnForDocument`
	// for each hydrated message (the server is idempotent on `message.id`
	// so no data harm, but each call costs an oRPC round-trip + DB read).
	// `useMemo` keeps the array reference stable across re-renders so the
	// downstream hook's `useRef + ref-guard` pattern doesn't re-seed on
	// every parent tick.
	const initialPersistedMessageIds = useMemo<readonly string[]>(() => {
		return initialAssistantMessages
			.map((m) => (m as { id?: unknown }).id)
			.filter((id): id is string => typeof id === "string");
	}, [initialAssistantMessages]);

	// Derive the per-message-id attachment map from the SSR-loaded
	// conversation envelope so the live `AttachmentRegistry` map is
	// pre-populated for every persisted user message that had file
	// uploads. Without this, the hydrated bubble falls back to the
	// legacy `[Attached: …]` filename caption until the next live
	// upload populates the registry — which means previews silently
	// disappear after every page reload.
	const initialAttachmentsByMessageId = useMemo<
		ReadonlyMap<string, MessageAttachmentListItem[]>
	>(() => {
		const m = new Map<string, MessageAttachmentListItem[]>();
		for (const raw of initialAssistantMessages) {
			if (!raw || typeof raw !== "object") {
				continue;
			}
			const msg = raw as {
				id?: unknown;
				role?: unknown;
				attachments?: unknown;
			};
			if (typeof msg.id !== "string") {
				continue;
			}
			if (msg.role !== "user") {
				continue;
			}
			if (!Array.isArray(msg.attachments)) {
				continue;
			}
			const batch = msg.attachments
				.filter(
					(a): a is Record<string, unknown> =>
						!!a && typeof a === "object",
				)
				.map((a) => ({
					id: typeof a.id === "string" ? a.id : undefined,
					s3Path: typeof a.s3Path === "string" ? a.s3Path : undefined,
					name: typeof a.name === "string" ? a.name : undefined,
					mimeType:
						typeof a.mimeType === "string" ? a.mimeType : undefined,
					sizeBytes:
						typeof a.sizeBytes === "number"
							? a.sizeBytes
							: undefined,
					kind:
						a.kind === "image" || a.kind === "file"
							? a.kind
							: undefined,
					previewUrl:
						typeof a.previewUrl === "string"
							? a.previewUrl
							: undefined,
				})) as MessageAttachmentListItem[];
			if (batch.length > 0) {
				m.set(msg.id, batch);
			}
		}
		return m;
	}, [initialAssistantMessages]);

	// Back URL — mirrors the breadcrumb's trail-end (Documents tab) so the
	// arrow lands on the same place the user came from.
	const backUrl = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}?tab=documents`
		: `/app/projects/${projectId}?tab=documents`;
	const handleClose = useCallback(() => {
		router.push(backUrl);
	}, [router, backUrl]);
	const roadmapUrl = organizationSlug
		? `/app/${organizationSlug}/projects/${projectId}?tab=stories`
		: `/app/projects/${projectId}?tab=stories`;

	// Slot mounts for the page-chrome action bar (line 3). DocumentEditor
	// portals its state-coupled chrome into these so the page-level layout
	// stays consistent with the feature editor's Line 3 pattern.
	const [actionSlotEl, setActionSlotEl] = useState<HTMLDivElement | null>(
		null,
	);
	const [saveSlotEl, setSaveSlotEl] = useState<HTMLDivElement | null>(null);
	// Sync-status slot lives on the breadcrumb row (line 2) so the user
	// sees presence/connection signals next to navigational context, while
	// the action bar stays focused on action buttons.
	const [syncSlotEl, setSyncSlotEl] = useState<HTMLDivElement | null>(null);

	// Track CopilotKit sidebar expanded state so the fixed-position page
	// shrinks its right edge to match the docked AI panel; without this the
	// document action bar gets hidden behind it.
	const isAiSidebarExpanded = useAiSidebarExpanded();

	// Set fullscreen mode on mount, reset on unmount
	useEffect(() => {
		setIsFullscreen(true);
		return () => {
			setIsFullscreen(false);
		};
	}, [setIsFullscreen]);

	// Wait for org context to load on org routes before querying
	const isOrgRoute = !!organizationSlug;
	const orgContextReady = !isOrgRoute || organizationId !== undefined;

	// IMPORTANT: Pass organizationId (null in personal context) so the
	// document fetch resolves the SAME tenant as the route, not the viewer's
	// session active-org. A mentioned user often opens the doc while their
	// active org differs; without this the fetch fell back to the wrong org
	// and 404'd. Mirrors the project query below.
	const { data: documentData, isLoading: isDocumentLoading } = useQuery({
		...orpc.projects.documents.get.queryOptions({
			input: { id: documentId, projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const { data: projectData, isLoading: isProjectLoading } = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	// A Proposal under the `PROPOSAL_ARTIFACT` gate is written in one run from
	// the library's client proposal prompt, whoever starts it. Its page — a
	// live Main tab, Internal Analysis and Style — is for members of the
	// owning organization; a project guest keeps today's page (Fizzy #2801).
	const proposalArtifactEnabled = useFeatureFlag("PROPOSAL_ARTIFACT");
	const isGuestInOrg = useIsGuestInOrg();
	const isArtifactProposal =
		proposalArtifactEnabled &&
		documentRefKind === "PROJECT_DOCUMENT" &&
		documentData?.document?.type === "PROPOSAL";
	const artifactMode = isArtifactProposal && !isGuestInOrg;
	const tTabs = useTranslations("projects.proposalArtifactPage.tabs");
	const [activeTab, setActiveTab] = useState<ProposalArtifactTab>("main");
	const tabIdBase = useId();
	const isGenerationRunning = isDocumentGenerationRunning(
		documentData?.document?.status ?? "",
	);
	// The latest generation's start lets the analysis keep looking for that
	// generation's run after it ends, without depending on a nudge.
	const analysisQuery = useProposalAnalysis({
		projectId,
		documentId,
		enabled: artifactMode,
		generationStartedAt: documentData?.document?.generationStartedAt,
		generationRunning: isGenerationRunning,
	});
	// Between a generation's end and its run being recorded, what the tab
	// holds is the previous Main's run; a failed generation records none.
	const awaitingNewAnalysis =
		artifactMode &&
		documentData?.document?.status !== "FAILED" &&
		awaitingAnalysisOfLatestGeneration(analysisQuery.data, {
			generationStartedAt: documentData?.document?.generationStartedAt,
			generationRunning: isGenerationRunning,
		});
	// A guest gets neither the label, which names an internal library prompt,
	// nor the selector, whose choice the run would ignore for them as well:
	// `false`, not `undefined`, since the editor falls back to the selector
	// on a nullish value.
	const promptSelectorReplacement = useMemo(
		() =>
			isArtifactProposal ? (
				isGuestInOrg ? (
					false
				) : (
					<LibraryPromptLabel />
				)
			) : undefined,
		[isArtifactProposal, isGuestInOrg],
	);

	// The page switches on the server's status, never on the editor's: while
	// a run is queued or writing, the Main tab shows the live sections and the
	// editor stays mounted but hidden, so the regeneration it started can
	// still be reviewed — and rejected — once the run completes.
	const showLiveMain = artifactMode && isGenerationRunning;
	const isEditorShown =
		!artifactMode || (activeTab === "main" && !showLiveMain);
	const [editorRegionEl, setEditorRegionEl] = useState<HTMLDivElement | null>(
		null,
	);
	useKeptScrollPositions(editorRegionEl, isEditorShown);

	// Each section a run saves, and each step of its Internal Analysis, comes
	// with a `document_change` nudge for this document. In artifact mode the
	// page refetches the document on one instead of waiting for the next
	// poll, and the analysis too once no run is writing: the analysis cannot
	// change before the run's final save, and a run nudges every section. The
	// handler reads the mode, the run state and the tenant through refs so
	// its identity — which the realtime connection depends on — never
	// changes.
	const queryClient = useQueryClient();
	const artifactModeRef = useRef(artifactMode);
	artifactModeRef.current = artifactMode;
	const isGenerationRunningRef = useRef(isGenerationRunning);
	isGenerationRunningRef.current = isGenerationRunning;
	const organizationIdRef = useRef(organizationId);
	organizationIdRef.current = organizationId;
	const handleDocumentChange = useCallback(
		(event: DocumentChangeEvent) => {
			if (event.documentId !== documentId || !artifactModeRef.current) {
				return;
			}
			void queryClient.invalidateQueries({
				queryKey: orpc.projects.documents.get.queryKey({
					input: {
						id: documentId,
						projectId,
						organizationId: organizationIdRef.current,
					},
				}),
			});
			if (isGenerationRunningRef.current) {
				return;
			}
			void queryClient.invalidateQueries({
				queryKey: proposalAnalysisQueryKey(projectId, documentId),
			});
		},
		[queryClient, projectId, documentId],
	);

	// The end of a run starts its analysis, so the analysis is asked for
	// again when the page sees the run end — whether or not a nudge arrives.
	const wasGenerationRunningRef = useRef(isGenerationRunning);
	useEffect(() => {
		const runEnded =
			wasGenerationRunningRef.current && !isGenerationRunning;
		wasGenerationRunningRef.current = isGenerationRunning;
		if (runEnded && artifactMode) {
			void queryClient.invalidateQueries({
				queryKey: proposalAnalysisQueryKey(projectId, documentId),
			});
		}
	}, [isGenerationRunning, artifactMode, queryClient, projectId, documentId]);

	// Real-time presence for this project (tracking that we're editing this document)
	// Note: True collaborative editing is now handled by PartyKit + Yjs in the DocumentEditor
	const { activeUsers, isConnected } = useProjectPresence({
		projectId,
		activeTab: "documents",
		editingDocId: documentId,
		enabled: true,
		onDocumentChange: handleDocumentChange,
	});

	// Include org context loading in overall loading state
	const isLoading = isDocumentLoading || isProjectLoading || !orgContextReady;
	const document = documentData?.document;
	const project = projectData?.project;

	// Filter out others editing this document (current user is tracked by session)
	const othersEditingThisDoc = activeUsers.filter(
		(u) => u.editingDocId === documentId,
	);

	// Memoized so the `<CopilotKit>` prop reference is stable across re-renders.
	// Presence ticks and query refetches re-render this page frequently; without
	// memoization, CopilotKit re-runs its mount-time AG-UI handshakes (info /
	// agent/connect) on each render, burning the per-user 500/min rate-limit
	// budget on a single document load.
	const copilotRuntimeUrl = useMemo(() => {
		const orgId = project?.organizationId;
		return orgId
			? `/api/copilotkit?organizationId=${orgId}`
			: "/api/copilotkit";
	}, [project?.organizationId]);

	if (isLoading) {
		return (
			<div className="fixed inset-y-0 right-0 left-0 bg-background flex items-center justify-center md:left-[72px]">
				<div className="space-y-6 w-full max-w-4xl p-6">
					<Skeleton className="h-8 w-full" />
					<Skeleton className="h-96 w-full" />
				</div>
			</div>
		);
	}

	if (!document || !project) {
		return (
			<div className="fixed inset-y-0 right-0 left-0 bg-background flex items-center justify-center md:left-[72px]">
				<p className="text-muted-foreground">
					{!document ? "Document not found" : "Project not found"}
				</p>
			</div>
		);
	}

	// Both marks key on the ref kind as well as the type: a live Roadmap
	// feature is not a deprecated document, whatever its type field says.
	const isProjectDocument = documentRefKind === "PROJECT_DOCUMENT";
	const isTypeDeprecated =
		isProjectDocument &&
		!!document.type &&
		isDeprecatedDocumentType(document.type);
	const isFeaturesSnapshot =
		isProjectDocument && document.type === "USER_STORY";
	// Only a project document has a Glossy page, and only on an org route.
	const glossyHref =
		isProjectDocument && organizationSlug
			? buildGlossyEditionRoute(
					`/app/${organizationSlug}`,
					projectId,
					documentId,
				)
			: null;
	// Who may edit the document: the title, the Style tab and the Retry of a
	// stalled run all follow it.
	const canEdit =
		project.userRole === "owner" || project.userRole === "editor";
	const tabId = (tab: ProposalArtifactTab) => `${tabIdBase}-tab-${tab}`;
	const panelId = (tab: ProposalArtifactTab) => `${tabIdBase}-panel-${tab}`;
	// The Main panel's wrapper renders on every page; only in artifact mode is
	// it a tab panel.
	const mainPanelProps = artifactMode
		? {
				id: panelId("main"),
				role: "tabpanel",
				"aria-labelledby": tabId("main"),
			}
		: {};

	return (
		// Page chrome shifts its right edge when the CopilotKit chat
		// expands, so the entire masthead (title, breadcrumb, action bar,
		// editor body) slides as one piece — otherwise the breadcrumb +
		// action bar would stay full-width and get covered by the chat
		// panel. The CopilotKit wrapper's own margin-right is neutralised
		// in globals.css so the shift doesn't double-apply. The chat lives
		// inside the editor, so while the editor is hidden (another tab, or
		// a Proposal's live Main) the page takes its full width back.
		<div
			className={`fixed inset-y-0 left-0 right-0 md:left-[72px] bg-background flex flex-col transition-[right] duration-300 ${
				isAiSidebarExpanded && isEditorShown
					? AI_SIDEBAR_CONTENT_SHIFT_CLASS
					: ""
			}`}
		>
			{/* Three-line header (title → breadcrumb → action bar) consistent
			  with the feature editor. Line 1 = page heading (highest weight),
			  line 2 = navigational context (smaller), line 3 = the action bar
			  which lives inside DocumentEditor itself. */}

			{/* Line 1 — Document title (large, editable inline). Generous top
			  padding lets the title breathe; the inline-edit component handles
			  its own typography (matching the feature editor's title weight). */}
			<div className="flex items-center gap-3 px-6 pt-5 pb-1 bg-background min-w-0">
				<div className="relative flex-1 min-w-0">
					<DocumentTitleInlineEdit
						projectId={projectId}
						documentId={documentId}
						organizationId={organizationId}
						title={document.title}
						canEdit={canEdit}
						alwaysEditable
						inputClassName="h-auto py-1.5 px-3 text-xl md:text-2xl font-semibold tracking-tight border border-transparent shadow-none w-full transition-colors hover:bg-muted/40 hover:border-border focus-visible:bg-background focus-visible:border-input focus-visible:ring-1 focus-visible:ring-ring cursor-text truncate"
					/>
				</div>
			</div>

			{/* Line 2 — Breadcrumb. AI loading + presence indicators pinned
			  right. (Documents don't carry an identifier badge analogous to
			  the feature editor's F-### so the breadcrumb stands alone.) The
			  bottom border separates the navigational header from the
			  action bar below. */}
			{/* Same shape, and the same fix, as the feature header. The
			  `BreadcrumbList` primitive carries `wrap-break-word`; with `min-w-0`
			  letting the items shrink, a phone broke the project name across
			  several lines under the status cluster. The scroll belongs on the
			  breadcrumb — on the row it carries the cluster off-screen with it. */}
			<div className="flex items-center gap-3 px-6 pb-4 bg-background border-b min-w-0">
				<Breadcrumb className="min-w-0 overflow-x-auto">
					<BreadcrumbList className="text-xs gap-1.5 flex-nowrap min-w-0 whitespace-nowrap">
						<BreadcrumbItem>
							<BreadcrumbLink
								href="/app"
								className="text-xs flex items-center"
								title="Go to home"
							>
								<HomeIcon className="size-3" />
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						{/* Ancestors and the trail-end pointer drop below `sm`:
						  they leave the project name — the only flexible crumb —
						  nothing to occupy, and on the feature header that
						  measured as 12px of the 114px it needed. */}
						{organizationSlug && (
							<>
								<BreadcrumbItem className="hidden sm:inline-flex">
									<BreadcrumbLink
										href={`/app/${organizationSlug}`}
										className="text-xs"
									>
										Organization
									</BreadcrumbLink>
								</BreadcrumbItem>
								<BreadcrumbSeparator className="hidden sm:block" />
							</>
						)}
						<BreadcrumbItem className="hidden sm:inline-flex">
							<BreadcrumbLink
								href={
									organizationSlug
										? `/app/${organizationSlug}/projects`
										: "/app/projects"
								}
								className="text-xs"
							>
								Projects
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator className="hidden sm:block" />
						<BreadcrumbItem className="min-w-0">
							<BreadcrumbLink
								href={
									organizationSlug
										? `/app/${organizationSlug}/projects/${projectId}`
										: `/app/projects/${projectId}`
								}
								className="text-xs truncate"
								title={project.name}
							>
								{project.name}
							</BreadcrumbLink>
						</BreadcrumbItem>
						<BreadcrumbSeparator className="hidden sm:block" />
						<BreadcrumbItem className="hidden sm:inline-flex">
							<BreadcrumbLink
								href={
									organizationSlug
										? `/app/${organizationSlug}/projects/${projectId}?tab=documents`
										: `/app/projects/${projectId}?tab=documents`
								}
								className="text-xs"
							>
								Documents
							</BreadcrumbLink>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<div className="flex-1" />

				{/* Status cluster — Also editing avatars + project-presence
				  pulse + Yjs Synced pill. Sits next to the breadcrumb so the
				  navigational context row carries all the "where am I / who
				  else is here / am I in sync" signals together. Avatars +
				  pill are sized to fit inside the row's text line height
				  (~16 px) so the row stays 33 px even when other users join
				  — items-center would otherwise stretch the row. */}
				<TooltipProvider>
					{othersEditingThisDoc.length > 0 && (
						<div className="flex items-center gap-2 shrink-0">
							{/* The avatars carry this on a phone; the words are what
							  squeezed the project name out of the breadcrumb beside
							  them. `sr-only` rather than `hidden`, so the cluster
							  still announces what the faces mean. */}
							<span className="sr-only sm:not-sr-only text-xs text-muted-foreground">
								Also editing:
							</span>
							<div className="flex -space-x-1.5">
								{othersEditingThisDoc.slice(0, 3).map((u) => (
									<Tooltip key={u.userId}>
										<TooltipTrigger asChild>
											<Avatar className="size-4 border border-background ring-1 ring-amber-500/50">
												<AvatarImage
													src={u.userImage}
													alt={u.userName}
												/>
												<AvatarFallback className="text-[8px] bg-linear-to-br from-amber-500 to-orange-600 text-white">
													{getAvatarInitials(
														u.userName,
													)}
												</AvatarFallback>
											</Avatar>
										</TooltipTrigger>
										<TooltipContent>
											<p>{u.userName}</p>
											<p className="text-xs text-highlight">
												Currently editing
											</p>
										</TooltipContent>
									</Tooltip>
								))}
								{othersEditingThisDoc.length > 3 && (
									<div className="size-4 rounded-full bg-muted flex items-center justify-center text-[8px] border border-background">
										+{othersEditingThisDoc.length - 3}
									</div>
								)}
							</div>
						</div>
					)}
					{isConnected && (
						<Tooltip>
							<TooltipTrigger asChild>
								<span
									className="size-2 rounded-full bg-green-500 animate-pulse shrink-0"
									aria-label="Connected to project presence"
								/>
							</TooltipTrigger>
							<TooltipContent>
								<p>Live presence connected</p>
								<p className="text-xs text-muted-foreground">
									You'll see other collaborators on this
									project in real time.
								</p>
							</TooltipContent>
						</Tooltip>
					)}
				</TooltipProvider>
				<div ref={setSyncSlotEl} className="flex items-center" />
			</div>

			{/* Line 3 — Action bar. Mirrors the feature editor's Line 3:
			  Back arrow on the left, then the document type chip (analog of
			  the feature editor's F-### badge), then a spacer, then the
			  portaled action buttons (Settings, Raw, Version history, Save). */}
			<div className="flex items-center gap-2 px-6 py-2 border-b bg-background min-w-0 overflow-x-auto">
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleClose}
								className="shrink-0 -ml-2 size-8 text-muted-foreground hover:text-foreground"
								aria-label="Back to documents"
							>
								<ArrowLeftIcon className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Back to documents</p>
						</TooltipContent>
					</Tooltip>
					{document.type && (
						<Tooltip>
							<TooltipTrigger asChild>
								<div
									className="flex items-center gap-2 shrink-0 h-8 px-2"
									aria-label={`Document type: ${getDocumentTypeLabel(
										document.type,
									)}${isTypeDeprecated ? " (deprecated)" : ""}`}
								>
									<span className="text-xs font-mono uppercase tracking-wider text-foreground">
										{getDocumentTypeLabel(document.type)}
									</span>
									{isTypeDeprecated && (
										<DeprecatedDocumentTypeBadge />
									)}
								</div>
							</TooltipTrigger>
							<TooltipContent>
								<p className="font-medium">
									Document type —{" "}
									{getDocumentTypeLabel(document.type)}
								</p>
								<p className="text-xs text-muted-foreground">
									Determines which prompts and templates apply
									to this document.
								</p>
							</TooltipContent>
						</Tooltip>
					)}
				</TooltipProvider>
				<SubscribeToggle
					subjectType="DOCUMENT"
					subjectId={documentId}
					projectId={projectId}
				/>
				<DocumentAutoRefreshToggle
					documentId={documentId}
					projectId={projectId}
				/>
				<GlossyVersionLink
					href={glossyHref}
					projectId={projectId}
					documentId={documentId}
					documentType={document.type}
				/>
				<div className="flex-1" />
				{/* The editor's own controls (Raw, Version history, Save) go
				  with it when it is hidden: on another tab they would act on
				  a document nobody is looking at. */}
				<div
					ref={setActionSlotEl}
					hidden={!isEditorShown}
					className="flex items-center gap-2"
				/>
				<div
					ref={setSaveSlotEl}
					hidden={!isEditorShown}
					className="flex items-center"
				/>
			</div>

			{/* A Features document is a snapshot now, not a Roadmap source. */}
			{isFeaturesSnapshot && (
				<div className="border-b bg-background px-6 py-2">
					<FeaturesDeprecationNotice roadmapHref={roadmapUrl} />
				</div>
			)}

			{/* A Proposal in artifact mode (Fizzy #2801): Main Document,
			  Internal Analysis and Style. Only the tab list renders here; the
			  panels below are force-mounted and the inactive ones carry
			  `hidden`, which takes them out of the tab order and the
			  accessibility tree without unmounting the editor. */}
			{artifactMode && (
				<Tabs
					value={activeTab}
					onValueChange={(value) =>
						setActiveTab(value as ProposalArtifactTab)
					}
					className="shrink-0 border-b bg-background px-6 pt-2 overflow-x-auto"
				>
					<TabsList aria-label={tTabs("label")}>
						<TabsTrigger
							value="main"
							id={tabId("main")}
							aria-controls={panelId("main")}
						>
							{tTabs("main")}
						</TabsTrigger>
						<TabsTrigger
							value="analysis"
							id={tabId("analysis")}
							aria-controls={panelId("analysis")}
							className="gap-2"
						>
							{tTabs("analysis")}
							<AnalysisTabIndicator
								indicator={analysisTabIndicator(
									analysisQuery.data,
								)}
							/>
						</TabsTrigger>
						<TabsTrigger
							value="style"
							id={tabId("style")}
							aria-controls={panelId("style")}
						>
							{tTabs("style")}
						</TabsTrigger>
					</TabsList>
				</Tabs>
			)}

			{/* Editor body — DocumentEditor renders its inline AI/prompt row
			  (analog of feature-editor stage row) at the top of this region.
			  Collaborative editing with live cursors is handled by PartyKit +
			  Yjs inside DocumentEditor.
			  `overflow-hidden` prevents the body from leaking. The Tailwind
			  arbitrary direct-child selectors (`[&>...]`) force the two
			  real DOM divs CopilotKit injects between this wrapper and
			  DocumentEditor — `.copilotKitSidebarContentWrapper` and, inside
			  it, `.copilotKitModalChildrenWrapper` — to be `height: 100%`.
			  Both are auto-height blocks by default (react-ui's own
			  stylesheet says so), and one auto-height block anywhere in
			  the chain collapses DocumentEditor's percentage height and
			  leaves its inner `overflow-y-auto` scroll container unbounded:
			  wheel scrolling dies and the scrollbar disappears while keyboard
			  scrolling still works. Every wrapper between this element and the
			  workspace root must carry a definite height, which is why the
			  selectors sit on the innermost wrapper, the editor region.

			  The two wrappers render on every page, so the editor never moves
			  in the tree when a Proposal's artifact mode settles: the outer one
			  is the Main tab panel in artifact mode, the inner one the region
			  hidden while a run writes the live sections. */}
			<div className="flex-1 min-h-0 overflow-hidden">
				<div
					{...mainPanelProps}
					hidden={artifactMode && activeTab !== "main"}
					className="h-full"
				>
					{showLiveMain && (
						<ProposalLiveMain
							projectId={projectId}
							documentId={documentId}
							organizationId={organizationId}
							document={document}
							canRetry={canEdit}
						/>
					)}
					<div
						ref={setEditorRegionEl}
						hidden={showLiveMain}
						className={cn(
							"h-full [&>.copilotKitSidebarContentWrapper]:h-full [&>.copilotKitSidebarContentWrapper>.copilotKitModalChildrenWrapper]:h-full",
							artifactMode && PROPOSAL_ARTIFACT_TYPOGRAPHY_CLASS,
						)}
					>
						<CopilotErrorBoundary
							fallback={(error) => (
								<DocumentEditorAiUnavailable
									content={document.content}
									error={error}
								/>
							)}
						>
							<CopilotKit
								runtimeUrl={copilotRuntimeUrl}
								useSingleEndpoint
								agent="project_document_generator"
								showDevConsole={false}
								onError={onCopilotError}
							>
								{/* One `useCopilotChatInternal()` for the whole
						  surface — every call site of that hook (and of
						  `useCopilotChat`) opens its own agent/connect on
						  1.70, so the consumers inside share this one
						  instead of each connecting (Fizzy #2389). */}
								<CopilotChatSessionProvider>
									<DocumentEditor
										projectId={projectId}
										documentId={documentId}
										isAiSidebarExpanded={
											isAiSidebarExpanded
										}
										actionSlot={actionSlotEl}
										saveSlot={saveSlotEl}
										syncSlot={syncSlotEl}
										documentRefKind={documentRefKind}
										initialAssistantConversationId={
											initialAssistantConversationId
										}
										initialAssistantVisibility={
											initialAssistantVisibility
										}
										initialAssistantVisibilityLockedAt={
											initialAssistantVisibilityLockedAt
										}
										initialAssistantMessages={
											initialAssistantMessages as ReadonlyArray<
												Record<string, unknown>
											>
										}
										initialPersistedMessageIds={
											initialPersistedMessageIds
										}
										initialAttachmentsByMessageId={
											initialAttachmentsByMessageId
										}
										suppressGenerationOverlay={artifactMode}
										attachToServerRun={
											showLiveMain && canEdit
										}
										promptSelectorReplacement={
											promptSelectorReplacement
										}
									/>
								</CopilotChatSessionProvider>
							</CopilotKit>
						</CopilotErrorBoundary>
					</div>
				</div>
				{artifactMode && (
					<>
						<div
							id={panelId("analysis")}
							role="tabpanel"
							aria-labelledby={tabId("analysis")}
							hidden={activeTab !== "analysis"}
							className="h-full overflow-y-auto"
						>
							<div className="mx-auto w-full max-w-4xl p-6">
								<ProposalAnalysisPanel
									projectId={projectId}
									documentId={documentId}
									isGenerating={isGenerationRunning}
									awaitingNewRun={awaitingNewAnalysis}
								/>
							</div>
						</div>
						<div
							id={panelId("style")}
							role="tabpanel"
							aria-labelledby={tabId("style")}
							hidden={activeTab !== "style"}
							className="h-full overflow-y-auto"
						>
							<div className="mx-auto w-full max-w-4xl p-6">
								<ProposalStylePanel
									projectId={projectId}
									documentId={documentId}
									canEdit={canEdit}
									isGenerating={isGenerationRunning}
								/>
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
