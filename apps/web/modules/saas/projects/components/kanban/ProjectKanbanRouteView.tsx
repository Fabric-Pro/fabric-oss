"use client";

import {
	KANBAN_COLUMN_TEMPLATES,
	type KanbanColumnTemplateId,
} from "@repo/database/src/kanban-column-templates";
import { useRegisterFabricAgentContext } from "@saas/agents/components/FabricAgentLauncher";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { BacklogChatPanel } from "@saas/projects/components/stories/BacklogChatPanel";
import { useKanbanStatus } from "@saas/projects/hooks/use-kanban-status";
import { shouldAutoOpenBacklogChat } from "@saas/projects/lib/backlog-chat-intake";
import { kanbanBridge } from "@saas/projects/lib/kanban-bridge";
import { buildStandaloneKanbanUrl } from "@saas/projects/lib/kanban-launch";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowUpIcon,
	CheckIcon,
	ColumnsIcon,
	CopyIcon,
	ExternalLinkIcon,
	Loader2Icon,
	MessageSquareIcon,
	RefreshCwIcon,
	TerminalIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface ProjectKanbanRouteViewProps {
	projectId: string;
	storyId?: string;
	organizationSlug?: string;
	/** When true, hides the back-navigation bar (used when rendered inside a tab) */
	embedded?: boolean;
	/** Called with the standalone URL once it is ready (embedded mode only) */
	onStandaloneUrlReady?: (url: string) => void;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const tStories = useTranslations("tooltips.stories");

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}, [text]);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					onClick={handleCopy}
					className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
					aria-label="Copy to clipboard"
				>
					{copied ? (
						<CheckIcon className="h-3.5 w-3.5 text-green-500" />
					) : (
						<CopyIcon className="h-3.5 w-3.5" />
					)}
				</button>
			</TooltipTrigger>
			<TooltipContent>{tStories("kanbanCopyCommand")}</TooltipContent>
		</Tooltip>
	);
}

export function ProjectKanbanRouteView({
	projectId,
	storyId,
	organizationSlug,
	embedded = false,
	onStandaloneUrlReady,
}: ProjectKanbanRouteViewProps) {
	const fabricAgentContext = useMemo(
		() => ({
			projectId,
			storyId: storyId ?? null,
			prompt: "Answer using the current project roadmap and project context when relevant.",
		}),
		[projectId, storyId],
	);

	useRegisterFabricAgentContext(fabricAgentContext);

	const router = useRouter();
	const tStories = useTranslations("tooltips.stories");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const { confirm } = useConfirmationAlert();

	// Project + backlog: the engagement profile decides whether the chat opens
	// by itself (inverted-loop Slice 6) and names the CopilotKit runtime.
	const { data: projectData } = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);
	const { data: storiesData, isLoading: storiesLoading } = useQuery(
		orpc.projects.stories.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const { data: statusesData } = useQuery(
		orpc.projects.stories.statuses.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const statuses = useMemo(
		() =>
			[...(statusesData?.statuses ?? [])].sort(
				(a, b) => a.order - b.order,
			),
		[statusesData?.statuses],
	);

	// AI Backlog Update chat. Under EXPLORE an empty backlog opens straight
	// into it, once per mount so closing it stays closed.
	const [chatOpen, setChatOpen] = useState(false);
	const autoOpenedChatRef = useRef(false);
	useEffect(() => {
		if (autoOpenedChatRef.current) {
			return;
		}
		if (
			shouldAutoOpenBacklogChat({
				profile: projectData?.project?.engagementProfile,
				backlogLoaded: !storiesLoading && storiesData !== undefined,
				storyCount: storiesData?.stories?.length ?? 0,
			})
		) {
			autoOpenedChatRef.current = true;
			setChatOpen(true);
		}
	}, [projectData?.project?.engagementProfile, storiesLoading, storiesData]);

	// Column title presets (inverted-loop Slice 0). Titles apply by position
	// to the existing columns; missing columns are created. Two-phase rename
	// (unique temp names first) so no intermediate step trips the per-project
	// unique name constraint.
	const [applyingTemplate, setApplyingTemplate] = useState(false);
	const applyColumnTemplate = useCallback(
		(templateId: KanbanColumnTemplateId) => {
			const template = KANBAN_COLUMN_TEMPLATES.find(
				(t) => t.id === templateId,
			);
			if (!template) {
				return;
			}
			const toCreate = Math.max(
				0,
				template.titles.length - statuses.length,
			);
			confirm({
				title: `Apply "${template.name}" preset?`,
				message:
					toCreate > 0
						? `${template.description}. ${toCreate} new column${toCreate > 1 ? "s" : ""} will be created.`
						: template.description,
				confirmLabel: "Apply",
				cancelLabel: "Cancel",
				onConfirm: async () => {
					setApplyingTemplate(true);
					try {
						const tempPrefix = `__col_${Date.now()}_`;
						for (const [i, status] of statuses.entries()) {
							await orpcClient.projects.stories.statuses.update({
								projectId,
								organizationId,
								statusId: status.id,
								name: `${tempPrefix}${i}`,
							});
						}
						for (const [i, title] of template.titles.entries()) {
							const existing = statuses[i];
							if (existing) {
								await orpcClient.projects.stories.statuses.update(
									{
										projectId,
										organizationId,
										statusId: existing.id,
										name: title,
									},
								);
							} else {
								await orpcClient.projects.stories.statuses.create(
									{
										projectId,
										organizationId,
										name: title,
										color: "#6B7280",
										order: i,
									},
								);
							}
						}
						// Columns beyond the template keep their position but
						// get their original title back.
						for (const [i, status] of statuses.entries()) {
							if (i >= template.titles.length) {
								await orpcClient.projects.stories.statuses.update(
									{
										projectId,
										organizationId,
										statusId: status.id,
										name: status.name,
									},
								);
							}
						}
						await queryClient.invalidateQueries({
							queryKey:
								orpc.projects.stories.statuses.list.queryKey({
									input: { projectId, organizationId },
								}),
						});
						kanbanBridge.pullFromFabric();
					} finally {
						setApplyingTemplate(false);
					}
				},
			});
		},
		[confirm, organizationId, projectId, queryClient, statuses],
	);
	const { prepareKanbanLaunch } = useKanbanStatus();
	const [iframeUrl, setIframeUrl] = useState<string | null>(null);
	const [standaloneUrl, setStandaloneUrl] = useState<string | null>(null);
	const [kanbanNotRunning, setKanbanNotRunning] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const projectDetailsUrl = useMemo(
		() =>
			organizationSlug
				? `/app/${organizationSlug}/projects/${projectId}`
				: `/app/projects/${projectId}`,
		[organizationSlug, projectId],
	);

	const launch = useCallback(async () => {
		setIsLoading(true);
		setKanbanNotRunning(false);
		setError(null);
		setIframeUrl(null);
		setStandaloneUrl(null);

		const launchTarget = await prepareKanbanLaunch(projectId, storyId);

		if (!launchTarget) {
			setError("Could not prepare Fabric Kanban launch.");
			setIsLoading(false);
			return;
		}

		if (launchTarget.mode === "not-running") {
			setKanbanNotRunning(true);
			setIsLoading(false);
			return;
		}

		if (launchTarget.mode === "external") {
			const openedWindow = window.open(
				launchTarget.url,
				"_blank",
				"noopener,noreferrer",
			);
			if (!openedWindow) {
				window.location.href = launchTarget.url;
				return;
			}
			router.replace(projectDetailsUrl);
			return;
		}

		const embedUrl = launchTarget.url;
		const standalone = buildStandaloneKanbanUrl(embedUrl);
		setIframeUrl(embedUrl);
		setStandaloneUrl(standalone);
		onStandaloneUrlReady?.(standalone);
		setIsLoading(false);
	}, [prepareKanbanLaunch, projectId, storyId, projectDetailsUrl, router]);

	useEffect(() => {
		void launch();
	}, [launch]);

	// Connect kanban bridge when iframe is mounted
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe || !iframeUrl) {
			return;
		}

		kanbanBridge.connect(iframe, {
			onReady: () => {
				// Scope the board to this project
				kanbanBridge.loadWorkspace(projectId, projectId);
				// Navigate to the specific story/feature if provided
				if (storyId) {
					kanbanBridge.selectTask(storyId);
				}
				// Auto-pull any queued features so new stories show up immediately
				kanbanBridge.pullFromFabric();
			},
			onClose: () => {
				// X button in the kanban embed bar → go back to the project
				router.push(projectDetailsUrl);
			},
		});

		return () => {
			kanbanBridge.disconnect();
		};
	}, [iframeUrl, projectId, storyId, projectDetailsUrl, router]);

	// Fix scrolling issue: when user clicks inside iframe, wheel events are captured by iframe.
	// We track mouse position to allow parent scrolling when mouse is outside iframe.
	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) {
			return;
		}

		// Track if mouse is over iframe
		let isMouseOverIframe = false;

		const handleMouseEnter = () => {
			isMouseOverIframe = true;
		};

		const handleMouseLeave = () => {
			isMouseOverIframe = false;
		};

		iframe.addEventListener("mouseenter", handleMouseEnter);
		iframe.addEventListener("mouseleave", handleMouseLeave);

		// Handle wheel events on document to catch events not captured by iframe
		const handleWheel = (e: WheelEvent) => {
			// If mouse is not over iframe, allow parent to handle scrolling
			if (!isMouseOverIframe) {
				// The wheel event will naturally bubble if the target is the parent doc
				// But if it's targeting the iframe, we need to let it through
				const rect = iframe.getBoundingClientRect();
				const isOverIframe =
					e.clientX >= rect.left &&
					e.clientX <= rect.right &&
					e.clientY >= rect.top &&
					e.clientY <= rect.bottom;

				if (!isOverIframe) {
					// Mouse is outside iframe - stop iframe from capturing this event
					e.stopPropagation();
				}
			}
		};

		// Use capture phase to intercept wheel events before they reach iframe
		document.addEventListener("wheel", handleWheel, { capture: true });

		return () => {
			iframe.removeEventListener("mouseenter", handleMouseEnter);
			iframe.removeEventListener("mouseleave", handleMouseLeave);
			document.removeEventListener("wheel", handleWheel, {
				capture: true,
			});
		};
	}, []);

	const headerBar = embedded ? null : (
		<div className="flex shrink-0 items-center justify-between border-b border-border bg-card px-4 py-2">
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => router.push(projectDetailsUrl)}
					>
						<ArrowLeftIcon className="mr-2 h-4 w-4" />
						Back to roadmap
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{tStories("kanbanBackToRoadmap")}
				</TooltipContent>
			</Tooltip>
			<div className="flex items-center gap-2">
				{/* AI Update — the same backlog chat the Roadmap hosts */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant={chatOpen ? "secondary" : "outline"}
							size="sm"
							onClick={() => setChatOpen((prev) => !prev)}
							aria-pressed={chatOpen}
						>
							<MessageSquareIcon className="mr-2 h-4 w-4" />
							AI Update
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{tStories("aiUpdateRoadmap")}
					</TooltipContent>
				</Tooltip>
				{/* Column title presets (inverted-loop Slice 0) */}
				<DropdownMenu>
					<Tooltip>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									disabled={
										applyingTemplate ||
										statuses.length === 0
									}
									aria-label="Apply a column title preset"
								>
									{applyingTemplate ? (
										<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
									) : (
										<ColumnsIcon className="mr-2 h-4 w-4" />
									)}
									Column preset
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs text-xs leading-5">
							{tStories("kanbanColumnPreset")}
						</TooltipContent>
					</Tooltip>
					<DropdownMenuContent align="end" className="w-72">
						<DropdownMenuLabel>
							Apply column titles
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						{KANBAN_COLUMN_TEMPLATES.map((template) => (
							<DropdownMenuItem
								key={template.id}
								onSelect={() =>
									applyColumnTemplate(template.id)
								}
								className="flex flex-col items-start gap-0.5"
							>
								<span className="font-medium">
									{template.name}
								</span>
								<span className="text-xs text-muted-foreground">
									{template.description}
								</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
				{standaloneUrl && (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									window.open(
										"http://localhost:3484",
										"_blank",
										"noopener,noreferrer",
									)
								}
							>
								<ExternalLinkIcon className="mr-2 h-4 w-4" />
								Open in tab
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{tStories("kanbanOpenInTab")}
						</TooltipContent>
					</Tooltip>
				)}
			</div>
		</div>
	);

	// The chat mounts beside whichever state the board is in (loading,
	// offline, live), so the Explore auto-open never depends on the external
	// Kanban being reachable.
	const chatPanel = chatOpen ? (
		<BacklogChatPanel
			organizationId={organizationId ?? null}
			projectId={projectId}
			projectName={projectData?.project?.name ?? "Project"}
			engagementProfile={projectData?.project?.engagementProfile}
			hasTeamsIntegration={false}
			hasSlackIntegration={false}
			hasNotionIntegration={false}
			hasPMTool={false}
			pmToolName="PM Tool"
			backlogSummary={`${storiesData?.stories?.length ?? 0} work items across ${statuses.length} statuses`}
			onClose={() => setChatOpen(false)}
			onChangesApplied={() => {
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
				kanbanBridge.pullFromFabric();
			}}
		/>
	) : null;

	if (kanbanNotRunning) {
		return (
			<div className="flex h-full flex-col">
				{headerBar}
				{chatPanel}
				<div className="flex flex-1 items-center justify-center overflow-auto p-8">
					<div className="w-full max-w-sm space-y-8">
						{/* Logo + heading */}
						<div className="flex flex-col items-center gap-5 text-center">
							<div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-border bg-card shadow-sm">
								<FabricLogo size={36} />
								{/* Offline indicator */}
								<span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background bg-muted">
									<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
								</span>
							</div>
							<div className="space-y-2">
								<h2 className="font-semibold tracking-tight text-foreground">
									Fabric Kanban is not running
								</h2>
								<p className="text-sm leading-relaxed text-muted-foreground">
									Start the Kanban CLI locally to view this
									board
									<br />
									embedded right here.
								</p>
							</div>
						</div>

						{/* Steps */}
						<div className="rounded-lg border border-border bg-card divide-y divide-border overflow-hidden">
							{/* Step 1 */}
							<div className="px-4 py-3 space-y-2">
								<div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
									<TerminalIcon className="h-3 w-3" />
									Step 1 — Install
								</div>
								<div className="flex items-center justify-between gap-2">
									<code className="select-all font-mono text-xs text-foreground">
										npm install -g @fabriccode/kanban
									</code>
									<CopyButton text="npm install -g @fabriccode/kanban" />
								</div>
							</div>

							{/* Step 2 */}
							<div className="px-4 py-3 space-y-2">
								<div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
									<TerminalIcon className="h-3 w-3" />
									Step 2 — Run in embed mode
								</div>
								<div className="flex items-center justify-between gap-2">
									<code className="select-all font-mono text-xs text-foreground">
										fabric-kanban --embed
									</code>
									<CopyButton text="fabric-kanban --embed" />
								</div>
								<p className="text-xs text-muted-foreground">
									Run from your project's repository
									directory.
								</p>
							</div>
						</div>

						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									onClick={() => void launch()}
									className="w-full"
									variant="outline"
									size="sm"
								>
									<RefreshCwIcon className="mr-2 h-3.5 w-3.5" />
									Check again
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tStories("kanbanCheckAgain")}
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="flex h-full flex-col">
				{headerBar}
				{chatPanel}
				<div className="flex flex-1 items-center justify-center p-8">
					<div className="w-full max-w-md space-y-4 text-center">
						<p className="text-sm text-muted-foreground">{error}</p>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									onClick={() => void launch()}
									variant="outline"
								>
									<RefreshCwIcon className="mr-2 h-4 w-4" />
									Try again
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tStories("kanbanTryAgain")}
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</div>
		);
	}

	if (isLoading || !iframeUrl) {
		return (
			<div className="flex h-full flex-col">
				{headerBar}
				{chatPanel}
				<div className="flex flex-1 items-center justify-center">
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2Icon className="h-4 w-4 animate-spin" />
						Connecting to Fabric Kanban…
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{headerBar}
			{chatPanel}
			<div
				ref={containerRef}
				className="relative min-h-0 flex-1"
				style={{ overscrollBehavior: "contain" }}
			>
				<iframe
					ref={iframeRef}
					src={iframeUrl}
					title="Fabric Kanban"
					className="h-full w-full border-0"
					allow="clipboard-read; clipboard-write"
					sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
				/>
				{/* Scroll navigation buttons - portalled to body so fixed positioning escapes ancestor stacking contexts */}
				{embedded &&
					typeof document !== "undefined" &&
					createPortal(
						<div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={() =>
											window.scrollTo({
												top: 0,
												behavior: "smooth",
											})
										}
										className="bg-background/80 backdrop-blur-sm shadow-md"
										aria-label="Scroll to top"
									>
										<ArrowUpIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{tStories("kanbanScrollToTop")}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											const iframe = iframeRef.current;
											if (iframe) {
												iframe.scrollIntoView({
													behavior: "smooth",
													block: "start",
												});
											}
										}}
										className="bg-background/80 backdrop-blur-sm shadow-md"
										aria-label="Scroll to kanban"
									>
										<ArrowDownIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{tStories("kanbanScrollToKanban")}
								</TooltipContent>
							</Tooltip>
						</div>,
						document.body,
					)}
			</div>
		</div>
	);
}
