"use client";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import type { MessageAttachmentListItem } from "@saas/shared/components/copilot/MessageAttachmentList";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { SubscribeToggle } from "@saas/subscriptions/components/SubscribeToggle";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Avatar, AvatarFallback, AvatarImage } from "@ui/components/avatar";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbSeparator,
} from "@ui/components/breadcrumb";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ArrowLeftIcon, HomeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useCallback, useEffect, useMemo, useState } from "react";
import { useProjectPresence } from "../hooks";
import { DocumentAutoRefreshToggle } from "./DocumentAutoRefreshToggle";
import { DocumentEditor, getDocumentTypeLabel } from "./DocumentEditor";
import { DocumentTitleInlineEdit } from "./DocumentTitleInlineEdit";

// Error boundary to catch CopilotKit initialization failures
// Falls back to rendering the editor without AI features
class CopilotErrorBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode },
	{ hasError: boolean; error: Error | null }
> {
	constructor(props: { children: ReactNode; fallback: ReactNode }) {
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
			return this.props.fallback;
		}
		return this.props.children;
	}
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

	// Real-time presence for this project (tracking that we're editing this document)
	// Note: True collaborative editing is now handled by PartyKit + Yjs in the DocumentEditor
	const { activeUsers, isConnected } = useProjectPresence({
		projectId,
		activeTab: "documents",
		editingDocId: documentId,
		enabled: true,
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

	return (
		// Page chrome shifts its right edge when the CopilotKit chat
		// expands, so the entire masthead (title, breadcrumb, action bar,
		// editor body) slides as one piece — otherwise the breadcrumb +
		// action bar would stay full-width and get covered by the chat
		// panel. The CopilotKit wrapper's own margin-right is neutralised
		// in globals.css so the shift doesn't double-apply.
		<div
			className={`fixed inset-y-0 left-0 right-0 md:left-[72px] bg-background flex flex-col transition-[right] duration-300 ${
				isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""
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
						canEdit={
							project.userRole === "owner" ||
							project.userRole === "editor"
						}
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
													{u.userName
														.slice(0, 2)
														.toUpperCase()}
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
									className="flex items-center shrink-0 h-8 px-2"
									aria-label={`Document type: ${getDocumentTypeLabel(
										document.type,
									)}`}
								>
									<span className="text-xs font-mono uppercase tracking-wider text-foreground">
										{getDocumentTypeLabel(document.type)}
									</span>
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
				<div className="flex-1" />
				<div
					ref={setActionSlotEl}
					className="flex items-center gap-2"
				/>
				<div ref={setSaveSlotEl} className="flex items-center" />
			</div>

			{/* Editor body — DocumentEditor renders its inline AI/prompt row
			  (analog of feature-editor stage row) at the top of this region.
			  Collaborative editing with live cursors is handled by PartyKit +
			  Yjs inside DocumentEditor.
			  `overflow-hidden` prevents the body from leaking. The Tailwind
			  arbitrary direct-child selector (`[&>...]`) forces
			  `.copilotKitSidebarContentWrapper` — a real DOM div CopilotKit
			  injects as the immediate child between this wrapper and
			  DocumentEditor — to be `height: 100%`, otherwise it collapses
			  to `height: auto` and breaks the height chain that
			  DocumentEditor's inner `overflow-y-auto` scroll container
			  depends on. */}
			<div className="flex-1 min-h-0 overflow-hidden [&>.copilotKitSidebarContentWrapper]:h-full">
				<CopilotErrorBoundary
					fallback={
						<DocumentEditor
							projectId={projectId}
							documentId={documentId}
							isAiSidebarExpanded={isAiSidebarExpanded}
							actionSlot={actionSlotEl}
							saveSlot={saveSlotEl}
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
						/>
					}
				>
					<CopilotKit
						runtimeUrl={copilotRuntimeUrl}
						useSingleEndpoint
						agent="project_document_generator"
						showDevConsole={false}
						onError={onCopilotError}
					>
						<DocumentEditor
							projectId={projectId}
							documentId={documentId}
							isAiSidebarExpanded={isAiSidebarExpanded}
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
						/>
					</CopilotKit>
				</CopilotErrorBoundary>
			</div>
		</div>
	);
}
