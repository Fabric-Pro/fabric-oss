"use client";

import { CopilotKit } from "@copilotkit/react-core";
import "@copilotkit/react-ui/styles.css";
import { pmDetectedTypeDisplayName } from "@repo/utils";
import { AgentErrorBoundary } from "@saas/agents/components/AgentErrorBoundary";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import {
	AI_SIDEBAR_CONTENT_SHIFT_CLASS,
	useAiSidebarExpanded,
} from "@saas/shared/components/copilot/ai-sidebar-layout";
import { CopilotChatSessionProvider } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import type { MessageAttachmentListItem } from "@saas/shared/components/copilot/MessageAttachmentList";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import { useFocusMode } from "@saas/shared/contexts/FocusModeContext";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
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
import {
	AlertCircle,
	ArrowLeftIcon,
	ExternalLink,
	HomeIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFeatureMaturationV2Enabled } from "../../hooks/useFeatureMaturationV2Enabled";
import { useMaturationViewMode } from "../../hooks/useMaturationViewMode";
import { getPriorityLabel, transformStory } from "../../lib/stories/types";
import { StoryTestCoverageLine } from "../test-cases/StoryTestCoverageLine";
import { MaturationViewToggle } from "./maturation/MaturationViewToggle";
import { NeedsMoreInfoBadge } from "./NeedsMoreInfoBadge";
import { PmSyncChip } from "./pm-sync/PmSyncChip";
import { StoryPriorityControl } from "./priority/StoryPriorityControl";
import { StartWorkButton } from "./StartWorkButton";
import { StoryAttachmentsButton } from "./StoryAttachmentsButton";
import { StoryCommentsButton } from "./StoryCommentsButton";
import { StoryDetailsButton } from "./StoryDetailsButton";
import { StoryDownloadDropdown } from "./StoryDownloadDropdown";
import { StoryKindIcon } from "./StoryKindIcon";
import { StoryMeetingReferencesButton } from "./StoryMeetingReferencesButton";
import { StoryWorkspace } from "./StoryWorkspace";

type Props = {
	projectId: string;
	storyId: string;
	organizationSlug?: string;
	/**
	 * Group D hydration props. The parent
	 * RSC page fetches the caller's most recent ACTIVE feature-assistant
	 * conversation server-side and passes it down. The payload flows into
	 * `<HydratedMessagesProvider>` (mounted inside `<StoryWorkspace>`
	 * around `<CopilotSidebar>`) where `<CustomMessages>` reads it to
	 * render historical turns immediately on first paint — avoiding the
	 * empty-greeting flash (AC-7) without depending on CopilotKit's
	 * unreliable `agent.messages` lifecycle. `documentRefKind` defaults
	 * to `"USER_STORY"` because this component IS the feature editor
	 * surface.
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

// The classic editor UI has been retired.
// This code was left intentionally as a hardcoded feature flag in case
// a rollback is needed to make the classic editor available again.
// Set this to true to instantly restore the classic editor toggle.
const ENABLE_CLASSIC_EDITOR = false;

export function StoryWorkspacePage({
	projectId,
	storyId,
	organizationSlug,
	documentRefKind = "USER_STORY",
	initialAssistantMessages = [],
	initialAssistantConversationId = null,
	initialAssistantVisibility = "SHARED",
	initialAssistantVisibilityLockedAt = null,
}: Props) {
	const { setIsFullscreen } = useFullscreen();
	const { isFocusMode, registerFocusModeAvailable } = useFocusMode();
	const router = useRouter();
	const { organizationId, basePath } = useOrganizationContext();
	const onCopilotError = useCopilotErrorHandler();

	// Register Focus Mode availability while Spec Review is mounted
	useEffect(() => {
		return registerFocusModeAvailable();
	}, [registerFocusModeAvailable]);

	// Feature Maturation V2 routing. The org flag gates the
	// three-tab editor; personal context short-circuits to `false` (v1 only).
	// The session toggle lets a flagged user flip back to v1 for a demo without
	// losing v2 content (it is read-only here and cache-backed). The toggle is
	// rendered in the shared action bar below, so it stays reachable in both
	// modes within the session.
	const maturationV2Enabled = useFeatureMaturationV2Enabled();
	const { viewMode: maturationViewMode, setViewMode: setMaturationViewMode } =
		useMaturationViewMode();
	const showMaturationV2 =
		maturationV2Enabled &&
		(!ENABLE_CLASSIC_EDITOR || maturationViewMode === "v2");

	// Mirror of `DocumentEditorPage.initialPersistedMessageIds` — list of
	// hydrated message ids passed to `<CopilotPersistenceHook>` so it
	// doesn't re-fire `appendTurnForDocument` for already-persisted
	// messages on every reload. See `CopilotPersistenceHook.tsx` for the
	// dedupe-ref semantics.
	const initialPersistedMessageIds = useMemo<readonly string[]>(() => {
		return initialAssistantMessages
			.map((m) => (m as { id?: unknown }).id)
			.filter((id): id is string => typeof id === "string");
	}, [initialAssistantMessages]);

	// Mirror of `DocumentEditorPage.initialAttachmentsByMessageId` —
	// pre-populates the live `<AttachmentRegistryProvider>` map so the
	// hydrated user bubbles with attachments render rich previews on
	// reload instead of legacy `[Attached: …]` filename captions.
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

	// Slot mounts for the new title-top/breadcrumb/action layout. `StoryWorkspace`
	// portals its editable title input + save split-button into these so its
	// internal state (title, isSaving, hasUnsavedChanges, regenerate mutation)
	// stays local while the chrome is owned by the page-level layout.
	const [titleSlotEl, setTitleSlotEl] = useState<HTMLDivElement | null>(null);
	const [actionSlotEl, setActionSlotEl] = useState<HTMLDivElement | null>(
		null,
	);
	const [saveSlotEl, setSaveSlotEl] = useState<HTMLDivElement | null>(null);
	// Track CopilotKit sidebar expanded state so the fixed-position page
	// chrome shifts its right edge in lockstep — otherwise the breadcrumb
	// and action bar (which sit outside the wrapper) get covered by the
	// chat panel.
	const isAiSidebarExpanded = useAiSidebarExpanded();

	// Set fullscreen mode on mount, reset on unmount
	useEffect(() => {
		setIsFullscreen(true);
		return () => {
			setIsFullscreen(false);
		};
	}, [setIsFullscreen]);

	// Fetch the story
	const {
		data: storyData,
		isLoading: isStoryLoading,
		refetch: refetchStory,
	} = useQuery(
		orpc.projects.stories.get.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
	);

	// Wait for org context to load on org routes before querying
	const isOrgRoute = !!organizationSlug;
	const orgContextReady = !isOrgRoute || organizationId !== undefined;

	// Fetch project
	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const { data: projectData, isLoading: isProjectLoading } = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	// PM capabilities — drives the cloud-sync toggle's `hasPmIntegration`
	// signal and the `pmToolName` tooltip display. Same query the roadmap
	// uses (`StoriesRoadmap.tsx:367`) so editor and roadmap stay in sync on
	// integration state.
	const { data: pmCapabilitiesData } = useQuery({
		...orpc.projects.stories.pmCapabilities.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: orgContextReady,
	});
	// Pass `undefined` (not `?? false`) while the pmCapabilities query is in
	// flight so the cloud toggle renders an invisible placeholder rather than
	// briefly flashing Red on a cold-cache load.
	const hasPmIntegration: boolean | undefined =
		pmCapabilitiesData?.configured;
	const pmToolName =
		pmDetectedTypeDisplayName(pmCapabilitiesData?.detectedType) ??
		"your PM tool";

	// Include org context loading in overall loading state
	const isLoading = isStoryLoading || isProjectLoading || !orgContextReady;
	const story = storyData?.story
		? transformStory(
				storyData.story as Parameters<typeof transformStory>[0],
			)
		: null;
	const canEdit: boolean = storyData?.canEdit ?? false;
	const canAddTags: boolean = storyData?.canAddTags ?? false;
	const canManageAllTags: boolean = storyData?.canManageAllTags ?? false;
	const project = projectData?.project;

	// Build the back URL using basePath from context. Mirrors the breadcrumb
	// trail-end (Roadmap) so deletion-redirects land where the user came from.
	const backUrl = `${basePath}/projects/${projectId}?tab=stories`;
	const priorityLabel = story ? getPriorityLabel(story.priority) : "";

	const handleClose = () => {
		router.push(backUrl);
	};

	// Redirect to feature list when story is deleted (story transitions from loaded to null)
	const storyWasLoadedRef = useRef(false);
	if (!isLoading && story) {
		storyWasLoadedRef.current = true;
	}
	useEffect(() => {
		if (!isLoading && !story && storyWasLoadedRef.current) {
			router.push(backUrl);
		}
	}, [isLoading, story, backUrl, router]);

	// Memoized so the `<CopilotKit>` prop reference is stable across re-renders.
	// Without memoization the template string is rebuilt every render, which
	// triggers CopilotKit to re-run its mount-time AG-UI handshakes (info /
	// agent/connect) on each render. The feature editor re-renders frequently
	// (story query refetches, AG-UI state ticks, integration-query resolves),
	// so each storm causes <StoryWorkspace> to re-mount the title/action/save
	// portals into the page-level header slots — visible as the multiple
	// flashes on the title bar + breadcrumb area on cold load and on nav-back.
	// Mirrors the fix applied to the document editor in PR #688.
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

	if (!story || !project) {
		return (
			<div className="fixed inset-y-0 right-0 left-0 bg-background flex items-center justify-center md:left-[72px]">
				<p className="text-muted-foreground">
					{!story ? "Feature not found" : "Project not found"}
				</p>
			</div>
		);
	}

	return (
		// Page chrome shifts its right edge when the CopilotKit chat opens
		// so the entire masthead (title, breadcrumb, action bar, editor)
		// slides as one piece — otherwise the breadcrumb + action bar stay
		// full-width and get covered by the chat panel. CopilotKit's
		// wrapper-margin is neutralised globally so this shift doesn't
		// double-apply.
		<div
			className={`fixed inset-y-0 left-0 right-0 md:left-[72px] bg-background flex flex-col transition-[right] duration-300 ${
				isAiSidebarExpanded ? AI_SIDEBAR_CONTENT_SHIFT_CLASS : ""
			}`}
		>
			{/* Three-line header (title → breadcrumb → action bar). Each row is
			  semantically distinct: line 1 is the page heading (highest visual
			  weight), line 2 is navigational context (smaller), line 3 is the
			  primary actions for this surface. */}

			{/* Line 1 — Title (slot, populated by StoryWorkspace via portal).
			  Generous top padding gives the heading air; pb-1 keeps it
			  visually attached to the breadcrumb that contextualizes it.
			  `min-h-14` (56px) reserves vertical space even when the slot
			  is empty (e.g. while the editor renders the AI-missing
			  AgentErrorBoundary fallback). Without it, the title row
			  collapses to 24px and the breadcrumb row — which carries the
			  PM-sync cloud toggle on its right edge — slides up under the
			  `position:fixed` AI Credits button that shows on accounts
			  without an AI provider, making the cloud toggle's tooltip
			  unreachable to hover/focus. */}
			{!isFocusMode && (
				<>
					<div
						ref={setTitleSlotEl}
						className="flex items-center gap-3 px-6 pt-5 pb-1 bg-background min-w-0 min-h-14"
					/>

					{/* Line 2 — Breadcrumb. All items clickable, including the trail-end
					  "Roadmap" pointer back to where the user came from. The bottom
					  border separates the navigational header (title + breadcrumb)
					  from the action bar below it. The PM-sync cloud toggle is
					  right-aligned on the same row, mirroring the doc editor's Yjs
					  sync pill placement at `DocumentEditorPage.tsx:284–349`. */}
					<div className="flex items-center gap-3 px-6 pb-4 bg-background border-b min-w-0">
						{/* The scroll lives on the breadcrumb, not the row: on the row it
						  would carry the PM chip off-screen with it. `whitespace-nowrap`
						  overrides the primitive's `wrap-break-word` — with `min-w-0`
						  letting the items shrink, that was breaking the project name
						  across three lines, and the overflowing text ran under the chip
						  (the boxes did not intersect, so only a screenshot showed it). */}
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
								{/* The two ancestor crumbs are dropped below `sm`. A 375px
								  row cannot hold five crumbs beside a ~170px status chip,
								  and the trail that survives — project, then Roadmap — is
								  the part that says where you are and how to get back. */}
								{organizationSlug && (
									<>
										<BreadcrumbItem className="hidden sm:inline-flex">
											<BreadcrumbLink
												href={basePath}
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
										href={`${basePath}/projects`}
										className="text-xs"
									>
										Projects
									</BreadcrumbLink>
								</BreadcrumbItem>
								<BreadcrumbSeparator className="hidden sm:block" />
								<BreadcrumbItem className="min-w-0">
									<BreadcrumbLink
										href={`${basePath}/projects/${projectId}`}
										className="text-xs truncate"
										// Truncation is visual only — the full name stays in
										// the DOM for assistive tech — so this restores it for
										// sighted users on any width that clips it.
										title={project.name}
									>
										{project.name}
									</BreadcrumbLink>
								</BreadcrumbItem>
								{/* Roadmap is dropped below `sm` as well. It is the only
								  remaining flexible crumb's competitor for a ~130px rail, and
								  it cost the project name everything: measured on a phone, the
								  name got 12px of the 114px it needs, rendering as "F..".
								  Nothing is lost — the action bar below carries a dedicated,
								  labelled "Back to roadmap" control at every width. */}
								<BreadcrumbSeparator className="hidden sm:block" />
								<BreadcrumbItem className="hidden sm:inline-flex">
									<BreadcrumbLink
										href={`${basePath}/projects/${projectId}?tab=stories`}
										className="text-xs"
									>
										Roadmap
									</BreadcrumbLink>
								</BreadcrumbItem>
							</BreadcrumbList>
						</Breadcrumb>
						{/* `shrink-0`: the chip is a control, so the breadcrumb absorbs
						  the shrinking rather than the chip being squeezed to unreadable. */}
						<div className="ml-auto flex shrink-0 items-center gap-2">
							{/* Single PM-sync chip: ONE status chip (Synced / Not synced
							  / Paused / PM sync failed / Conflict) with an auto-sync
							  tooltip → click → a dropdown with everything behind it
							  (open card, push/force, pull, pause/resume, review problem).
							  Replaces the old cloud toggle + status badges so the row
							  never shows two or three elements. */}
							<PmSyncChip
								storyId={story.id}
								projectId={projectId}
								organizationId={organizationId ?? null}
								itemType={
									story.kind === "BUG" ? "bug" : "story"
								}
								identifier={story.identifier}
								fabricTitle={story.title}
								fabricDescription={story.description ?? ""}
								fabricUpdatedAt={story.lastEditedAt}
								fabricAuthor={story.lastEditedByName}
								fabricSource={story.lastEditedSource}
								pmAutoSyncEnabled={story.pmAutoSyncEnabled}
								externalId={story.externalId ?? null}
								externalUrl={story.externalUrl ?? null}
								lastPmSyncStatus={
									story.lastPmSyncStatus ?? null
								}
								lastPmSyncError={story.lastPmSyncError ?? null}
								lastPmSyncAttemptAt={
									story.lastPmSyncAttemptAt ?? null
								}
								hasPmIntegration={hasPmIntegration}
								pmToolName={pmToolName}
							/>
						</div>
					</div>
				</>
			)}

			{/* Line 3 — Action bar. Back arrow + identifier badge (priority dot
			  + F-###) on the left, sized to match the action buttons on the
			  right so the row reads as a single horizontal beat. StoryWorkspace
			  portals state-coupled items (Show raw, Version history) into
			  actionSlotEl, then Save trails after StartWork via saveSlotEl. The
			  single border-b is the masthead's bottom edge. */}
			<div className="flex items-center gap-2 px-6 py-2 border-b bg-background min-w-0 overflow-x-auto">
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								onClick={handleClose}
								className="shrink-0 -ml-2 size-8 text-muted-foreground hover:text-foreground"
								aria-label="Back to roadmap"
							>
								<ArrowLeftIcon className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							<p>Back to roadmap</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				<TooltipProvider>
					<Tooltip>
						<TooltipTrigger asChild>
							{/* `role="img"`: the icon and the identifier read as one
							  thing, and the priority is carried only by the icon's
							  colour. Without a role, `aria-label` on a bare div is
							  dropped by screen readers, so the priority reached
							  sighted users only. */}
							<div
								role="img"
								className="flex items-center gap-2 shrink-0 h-8 px-2"
								aria-label={`${story.kind === "BUG" ? "Bug" : "Feature"} ${story.identifier}, priority ${priorityLabel}`}
							>
								<StoryKindIcon
									kind={story.kind}
									priority={story.priority}
									className="size-4"
								/>
								<span className="text-xs font-mono uppercase tracking-wider text-foreground">
									{story.identifier}
								</span>
							</div>
						</TooltipTrigger>
						<TooltipContent>
							<p className="font-medium">
								{story.kind === "BUG" ? "Bug" : "Feature"} ID —{" "}
								{story.identifier}
							</p>
						</TooltipContent>
					</Tooltip>
				</TooltipProvider>
				{/* Priority as an editable chip — same band, same editor and the
				    same write path as the roadmap Priority view, so a change here
				    lands in the item's priority history too. */}
				<StoryPriorityControl
					projectId={projectId}
					organizationId={organizationId ?? null}
					storyId={story.id}
					identifier={story.identifier}
					priority={story.priority}
					priorityChangedAt={story.priorityChangedAt}
					priorityChangeReason={story.priorityChangeReason ?? null}
					canEdit={canEdit}
					draftingStage={story.draftingStage ?? null}
					statusId={story.statusId}
				/>
				{/* Read-only "Tested by N cases" coverage rollup. Rendered here in the
				    always-present action bar — NOT inside the AI-gated editor — so it
				    shows even when no AI provider is configured. Gated on the Test
				    Cases feature flag so it (and its query to a gated procedure) is
				    absent when the feature is off. */}
				{process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES ===
					"true" && (
					<StoryTestCoverageLine
						projectId={projectId}
						storyId={storyId}
						organizationId={organizationId ?? null}
					/>
				)}
				{/* The Blocked chip on the detail lives in the action bar as an
				    interactive control (edit reason / unblock) — see StoryWorkspace. */}
				{story.kind === "BUG" && story.needsMoreInfo && (
					<NeedsMoreInfoBadge
						size="detail"
						tooltip={
							<>
								<p>This bug needs more info to act on.</p>
								<p className="text-xs text-muted-foreground">
									Edit the description with new details, then
									click "Re-evaluate Bug" in the editor
									toolbar.
								</p>
							</>
						}
					/>
				)}
				<div className="flex-1" />
				{maturationV2Enabled && ENABLE_CLASSIC_EDITOR && (
					<MaturationViewToggle
						viewMode={maturationViewMode}
						onChange={setMaturationViewMode}
					/>
				)}
				<StoryDownloadDropdown
					variant="icon"
					story={story}
					project={{
						id: project.id,
						name: project.name,
					}}
				/>
				<StoryDetailsButton
					story={story}
					projectId={projectId}
					organizationId={project.organizationId ?? null}
					pmToolName={pmToolName}
				/>
				<StoryAttachmentsButton
					story={story}
					projectId={projectId}
					organizationId={project.organizationId ?? null}
					canEdit={canEdit}
				/>
				<StoryCommentsButton
					story={story}
					projectId={projectId}
					organizationId={project.organizationId ?? null}
				/>
				{/* #1902 — meetings whose action items reference this work item.
				    Renders nothing when there are none, so it adds no chrome to
				    a project that does not use meeting linking. */}
				<StoryMeetingReferencesButton
					storyId={storyId}
					storyIdentifier={story.identifier ?? null}
					projectId={projectId}
					organizationId={project.organizationId ?? null}
				/>
				<div
					ref={setActionSlotEl}
					className="flex items-center gap-2"
				/>
				<StartWorkButton
					projectId={projectId}
					storyId={storyId}
					story={story}
					size="sm"
					repositoryOwner={project.repositoryOwner}
					repositoryName={project.repositoryName}
					defaultBranch={project.defaultBranch}
					repoUrl={project.repositoryUrl || ""}
					implementationDefaultChannel={
						project.implementationDefaultChannel as
							| "BACKGROUND_AGENTS"
							| "LOCAL_AGENTS"
							| null
							| undefined
					}
					implementationDefaultProvider={
						project.implementationDefaultProvider as
							| "BACKGROUND_AGENTS"
							| "KANBAN_LOCAL"
							| null
							| undefined
					}
					onImplementationStarted={() => refetchStory()}
				/>
				<div ref={setSaveSlotEl} className="flex items-center" />
			</div>

			{/* F-171 reporter strip (REQ-8, REQ-15). Bug detail pages only —
			  shows where the bug came from and who reported it. Placement is
			  a dev decision per Gap 1; a slim strip below the action bar is
			  unobtrusive and easy to scan. Hidden when none of the fields
			  are populated (legacy bugs created before the F-171 migration). */}
			{story.kind === "BUG" &&
				(story.reporterName ||
					story.reporterSource ||
					story.reporterSourceUrl) && (
					<div className="flex items-center gap-3 px-6 py-1.5 border-b bg-muted/30 text-xs text-muted-foreground">
						{story.reporterSource && (
							<span className="inline-flex items-center gap-1 rounded-full bg-background px-2 py-0.5 font-medium uppercase tracking-wider text-[10px]">
								Reported via {story.reporterSource}
							</span>
						)}
						{story.reporterName && (
							<span>
								by{" "}
								<span className="text-foreground">
									{story.reporterName}
								</span>
							</span>
						)}
						{story.reporterSourceUrl && (
							<a
								href={story.reporterSourceUrl}
								target="_blank"
								rel="noreferrer"
								className="text-primary hover:underline"
							>
								View source thread →
							</a>
						)}
					</div>
				)}

			{/* Editor body fills the remaining viewport. `overflow-hidden`
			  prevents the body from leaking. The Tailwind arbitrary
			  direct-child selector (`[&>...]`) forces
			  `.copilotKitSidebarContentWrapper` — a real DOM div CopilotKit
			  injects as the immediate child between this wrapper and
			  StoryWorkspace — to be `height: 100%`, otherwise it collapses
			  to `height: auto` and breaks the height chain that
			  StoryWorkspace's inner `overflow-y-auto` scroll container
			  depends on. */}
			<div className="flex-1 min-h-0 overflow-hidden [&>.copilotKitSidebarContentWrapper]:h-full">
				{/* AgentErrorBoundary catches the `useAgent: Agent
				    'project_document_generator' not found` throw that fires
				    when the CopilotKit runtime returns 400 because no AI
				    provider is configured. Without this boundary the entire
				    feature workspace renders Next.js's `__next_error__`
				    fallback and the user sees "This page couldn't load",
				    making the editor unusable until an AI provider is
				    configured. The fallback below keeps the page chrome
				    (breadcrumb with the PM-sync toggle, back button, etc.)
				    intact and tells the user exactly how to recover. */}
				<AgentErrorBoundary
					fallback={
						<div className="flex h-full items-center justify-center p-6">
							<div className="max-w-md w-full bg-card border border-border rounded-lg p-6 shadow-sm">
								<div className="flex items-start gap-4">
									<div className="shrink-0">
										<AlertCircle className="h-6 w-6 text-highlight" />
									</div>
									<div className="flex-1 space-y-2">
										<h2 className="text-base font-semibold text-foreground">
											AI assistant unavailable
										</h2>
										<p className="text-sm text-muted-foreground">
											The feature editor uses CopilotKit
											to provide AI-assisted grooming. Add
											an OpenAI, Anthropic, Vercel AI
											Gateway, or OpenRouter key to enable
											the editor.
										</p>
										<Link
											href={`${basePath}/settings/ai-providers`}
											className="inline-flex items-center gap-2 mt-2 text-sm font-medium text-primary hover:text-primary/80"
										>
											Configure AI provider
											<ExternalLink className="h-3.5 w-3.5" />
										</Link>
									</div>
								</div>
							</div>
						</div>
					}
				>
					<CopilotKit
						runtimeUrl={copilotRuntimeUrl}
						// The 1.70 client defaults to probing GET <runtimeUrl>/info
						// before falling back to single-route POST; our route is
						// POST-only, so that probe 405s and surfaces as an error
						// toast. useSingleEndpoint skips the probe — keep every
						// <CopilotKit> mount in sync with this one.
						useSingleEndpoint
						agent="project_document_generator"
						showDevConsole={false}
						onError={onCopilotError}
					>
						{/* One `useCopilotChatInternal()` for the whole
						  surface. On 1.70 every call site of that hook (and
						  of `useCopilotChat`) opens its own agent/connect,
						  so the read-only consumers below share this one
						  instead of each connecting — Fizzy #2389. */}
						<CopilotChatSessionProvider>
							{/* StoryWorkspace is ALWAYS rendered — both v1 and v2 —
						  so the maturation stage dropdown, Enhance, Start work,
						  and all surrounding chrome stay intact. When
						  `maturationV2` is true the editor region is fronted by
						  the three-tab control (Clean Spec tab IS this same
						  TipTap editor); when false it renders the classic
						  single editor unchanged. */}
							<StoryWorkspace
								story={story}
								canEdit={canEdit}
								canAddTags={canAddTags}
								canManageAllTags={canManageAllTags}
								maturationV2={showMaturationV2}
								projectId={projectId}
								projectName={project.name}
								projectRepository={{
									url: project.repositoryUrl,
									owner: project.repositoryOwner,
									name: project.repositoryName,
									branch: project.defaultBranch,
								}}
								onClose={handleClose}
								onStoryUpdated={() => refetchStory()}
								titleSlot={titleSlotEl}
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
						</CopilotChatSessionProvider>
					</CopilotKit>
				</AgentErrorBoundary>
			</div>
		</div>
	);
}
