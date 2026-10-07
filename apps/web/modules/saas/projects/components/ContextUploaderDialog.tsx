"use client";

import { useAnalytics } from "@analytics";
import { ContextSourceSubmitFooter } from "@saas/context-sources/components/ContextSourceSubmitFooter";
import { FileSourceTabContent } from "@saas/context-sources/components/FileSourceTabContent";
import { TextSourceTabContent } from "@saas/context-sources/components/TextSourceTabContent";
import { UrlSourceTabContent } from "@saas/context-sources/components/UrlSourceTabContent";
import { useFileSourceForm } from "@saas/context-sources/hooks/use-file-source-form";
import { useTextSourceForm } from "@saas/context-sources/hooks/use-text-source-form";
import { useUrlSourceForm } from "@saas/context-sources/hooks/use-url-source-form";
import type {
	ContextSourceAdded,
	ContextSourceSubmitAdapter,
} from "@saas/context-sources/lib/submit-adapter";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { ConfluenceIcon } from "@saas/workflows/lib/plugins/confluence/icon";
import { GoogleDriveIcon } from "@saas/workflows/lib/plugins/google-drive/icon";
import { MicrosoftTeamsIcon } from "@saas/workflows/lib/plugins/microsoft-teams/icon";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	FileIcon,
	LinkIcon,
	LoaderIcon,
	SettingsIcon,
	SparklesIcon,
	TextIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { isConfluenceMcpConfig } from "../lib/confluence-mcp-config";
import { DOCUMENT_TAG_OPTIONS } from "../lib/document-tag-options";
import { ConfluenceResourceBrowser } from "./ConfluenceResourceBrowser";
import { GoogleDocsSelectorDialog } from "./GoogleDocsSelectorDialog";
import { NotionResourceBrowser } from "./NotionResourceBrowser";
import { SlackChannelSelectorDialog } from "./SlackChannelSelectorDialog";
import { TeamsChatSelectorDialog } from "./TeamsChatSelectorDialog";

// The File, Link and Text tab bodies are the shared context-source forms
// (`@saas/context-sources`), driven here by a project adapter. Everything only
// a project has stays in this file: Tag as Document, the readiness category
// requirement, wizard telemetry, and the Teams / Slack / Notion / Confluence /
// Google Docs tabs with their project-keyed caches.
//
// The two URL helpers are re-exported for the Link tab's regression tests,
// which predate the move and import them from here.
export {
	detectUrlScope,
	parseBulkUrlLines,
} from "@saas/context-sources/lib/url-source";

// Props.projectId is REQUIRED and stays required. The wizard pre-creation
// surface passes the DRAFT project's real `projectId` (Q1 DRAFT-as-host
// binding from the Unified Context Uploader Wizard spec §7.2). We
// deliberately do NOT add an optional `sessionId` prop here — both wizard
// and post-creation surfaces write directly to `ProjectContext` against
// the DRAFT/ACTIVE projectId. `WizardTempContext` is intentionally
// bypassed by the wizard surface after that spec.
type Props = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * Hosting surface tag used solely for telemetry routing on the new
	 * `project_context_added_during_wizard` event (spec
	 * `2026-05-23-unified-context-uploader-wizard` §9.2). The dialog
	 * behaves identically in both surfaces — the value is read-only inside
	 * the success branches that fire `trackEvent`.
	 *
	 * Defaults to `"post-creation"` so existing post-creation callers
	 * (project detail page, settings, etc.) keep their pre-spec behaviour
	 * without touching every call site. The wizard mount in
	 * `BasicInfoStep` passes `surface="wizard"` explicitly to drive the
	 * post-launch validation question: _does moving the entry point into
	 * the wizard actually drive more pre-creation context attachment?_
	 */
	surface?: "wizard" | "post-creation";
};

// Notion icon component.
//
// `aria-hidden="true"` because every render site in this file pairs the icon
// with a visible "Notion" text label (the tab label, the Notion Integration
// heading, the "Browse Notion Pages" button). The previous labeled-SVG variant
// caused the accessible name to compute as "NotionNotion" (icon-title +
// adjacent text), surfaced during staging Phase 2.A — anomaly A-2. Matches
// the SlackIcon pattern below + the canonical pattern in
// `marketing/home/components/BrandIcons.tsx#NotionIcon`.
function NotionIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.98-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466l1.823 1.447zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.84-.046.933-.56.933-1.167V6.354c0-.606-.233-.933-.746-.886l-15.177.887c-.56.046-.747.326-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.746 0-.933-.234-1.495-.933l-4.577-7.186v6.952l1.447.327s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.886.747-.933l3.222-.186zM2.077 1.028l13.681-.933c1.68-.14 2.1.093 2.8.606l3.876 2.754c.467.327.607.42.607.98v15.37c0 .96-.373 1.494-1.68 1.587l-15.458.934c-.98.047-1.447-.093-1.96-.747L.787 18.2c-.56-.7-.794-1.26-.794-1.96V2.42c0-.84.374-1.346 1.167-1.4l.917.008z" />
		</svg>
	);
}

// Slack icon component
function SlackIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
		>
			<path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
		</svg>
	);
}

// Static base list — full superset of tab IDs. The Google Docs tab is
// rendered (in both the tablist and the panels) only when its kill-switch
// flag is on. Keeping all IDs in the type lets `activeTab === "google-docs"`
// stay a real union member rather than a string drift.
const allTabs = [
	{ id: "file", label: "File", icon: FileIcon },
	{ id: "link", label: "Link", icon: LinkIcon },
	{ id: "text", label: "Text", icon: TextIcon },
	{ id: "teams", label: "Teams", icon: MicrosoftTeamsIcon },
	{ id: "slack", label: "Slack", icon: SlackIcon },
	{ id: "notion", label: "Notion", icon: NotionIcon },
	{ id: "confluence", label: "Confluence", icon: ConfluenceIcon },
	{ id: "google-docs", label: "Google Docs", icon: GoogleDriveIcon },
] as const;

type TabId = (typeof allTabs)[number]["id"];

export function ContextUploaderDialog({
	projectId,
	open,
	onOpenChange,
	surface = "post-creation",
}: Props) {
	const _t = useTranslations();
	const t = useTranslations("tooltips.contextSources");
	const queryClient = useQueryClient();

	// Visible tab set — drop the Google Docs tab when its kill-switch is off.
	// Computed each render so a flag flip (env-driven, build-time today) is
	// picked up without further plumbing.
	const tabs = useMemo(
		() =>
			isMonitoringFeatureEnabled("feature-google-docs-context")
				? allTabs
				: allTabs.filter((tab) => tab.id !== "google-docs"),
		[],
	);

	const [activeTab, setActiveTab] = useState<TabId>("file");
	const [googleDocsDialogOpen, setGoogleDocsDialogOpen] = useState(false);

	// "Tag as Document" — project-only. Applies to every queued file (per
	// spec §7.1 — multi-file is "drop a batch", not a per-file editor), and
	// imports a tagged file as a project document.
	const [fileDocumentTag, setFileDocumentTag] = useState<string>("");

	// Classifying a link source only exists as a requirement alongside the
	// readiness checklist that consumes it. With the flag off this whole field
	// is absent and the link flow behaves exactly as it did before.
	const requireKnowledgeBaseCategory = useFeatureFlag("PROJECT_READINESS");

	// Teams dialog state
	const [teamsDialogOpen, setTeamsDialogOpen] = useState(false);

	// Slack dialog state
	const [slackDialogOpen, setSlackDialogOpen] = useState(false);

	// Notion dialog state
	const [notionDialogOpen, setNotionDialogOpen] = useState(false);
	const [selectedNotionMcpConfigId, setSelectedNotionMcpConfigId] = useState<
		string | null
	>(null);

	// Confluence dialog state
	const [confluenceDialogOpen, setConfluenceDialogOpen] = useState(false);
	const [selectedConfluenceMcpConfigId, setSelectedConfluenceMcpConfigId] =
		useState<string | null>(null);

	// Get organization context
	const { organizationId, organizationSlug, basePath } =
		useOrganizationContext();
	const buildReturnUrl = useSettingsReturnUrl();

	// Analytics — `project_context_url_added` (URL Context Sources spec §13,
	// Group 10.1) fires for every accepted link, and
	// `project_context_added_during_wizard` (spec
	// `2026-05-23-unified-context-uploader-wizard` §9.2) once per successful
	// File / Link / Text row. Both stay project-only: the shared forms report
	// each addition through `onSourceAdded` and this dialog names the events.
	const { trackEvent } = useAnalytics();

	const handleSourceAdded = (added: ContextSourceAdded) => {
		if (added.contextType === "LINK") {
			trackEvent("project_context_url_added", {
				scope: added.scope,
				refreshMode: added.refreshMode,
				maxPages: added.maxPages,
				projectId,
				...(organizationId ? { organizationId } : {}),
			});
		}
		// `contextType` is the spec-defined enum value (LINK for a URL), not
		// the server-side type literal.
		trackEvent("project_context_added_during_wizard", {
			surface,
			contextType: added.contextType,
		});
	};

	// The project's side of the shared forms: each submission becomes a
	// `projects.contexts.*` call against this project, and the list the forms
	// refresh is this project's contexts list.
	const adapter = useMemo<ContextSourceSubmitAdapter>(
		() => ({
			createUploadUrl: async ({ filename, mimeType, size }) => {
				const { signedUploadUrl, contextId, contentType } =
					await orpcClient.projects.contexts.createUploadUrl({
						projectId,
						filename,
						mimeType,
						size,
						...(fileDocumentTag
							? { documentTag: fileDocumentTag }
							: {}),
					});
				if (!signedUploadUrl) {
					throw new Error(
						"Storage provider does not support direct uploads for project contexts",
					);
				}
				return { signedUploadUrl, contextId, contentType };
			},
			processFile: ({ contextId }) =>
				orpcClient.projects.contexts.processFile({
					projectId,
					contextId,
				}),
			processLink: (link) =>
				orpcClient.projects.contexts.processLink({
					projectId,
					...(organizationId ? { organizationId } : {}),
					...link,
				}),
			createText: ({ title, content }) =>
				orpcClient.projects.contexts.create({
					projectId,
					type: "TEXT",
					content,
					metadata: {
						title,
					},
				}),
			listQueryKey: orpc.projects.contexts.list.queryKey({
				input: { projectId },
			}),
		}),
		[projectId, organizationId, fileDocumentTag],
	);

	// A submit that leaves nothing to review closes the dialog and starts the
	// next one from a clean form.
	const closeAndReset = () => {
		onOpenChange(false);
		resetForm();
	};

	const fileForm = useFileSourceForm({
		adapter,
		onSourceAdded: handleSourceAdded,
		onComplete: closeAndReset,
	});
	const linkForm = useUrlSourceForm({
		adapter,
		open,
		organizationId,
		organizationSlug,
		requireKnowledgeBaseCategory,
		allowLiveRefresh: true,
		onSourceAdded: handleSourceAdded,
		onComplete: closeAndReset,
	});
	const textForm = useTextSourceForm({
		adapter,
		onSourceAdded: handleSourceAdded,
		onComplete: closeAndReset,
	});

	// Fetch MCP configs that have Notion tools
	const { data: notionMcpConfigs, isLoading: notionConfigsLoading } =
		useQuery({
			queryKey: ["mcp-configs-notion", organizationId],
			queryFn: async () => {
				// Fetch configs for current context (personal or org)
				const allConfigs = await orpcClient.mcp.configs.list({
					organizationId: organizationId ?? undefined,
				});

				// Also fetch personal configs if in org context
				let personalMcpConfigs: typeof allConfigs = [];
				if (organizationId) {
					try {
						personalMcpConfigs = await orpcClient.mcp.configs.list(
							{},
						);
					} catch {
						// Ignore personal config fetch errors
					}
				}

				const combinedConfigs = organizationId
					? [...allConfigs, ...personalMcpConfigs]
					: allConfigs;

				// Filter to configs that likely have Notion tools
				return combinedConfigs.filter(
					(cfg: (typeof allConfigs)[number]) => {
						if (!cfg.enabled) {
							return false;
						}
						const server = cfg.mcpServer;
						if (!server) {
							return false;
						}
						const key = server.key?.toLowerCase() || "";
						const name = server.name?.toLowerCase() || "";
						return (
							key.includes("notion") || name.includes("notion")
						);
					},
				);
			},
		});

	// Fetch existing Notion contexts for this project (to pass syncedPageIds)
	const { data: notionContexts } = useQuery({
		queryKey: ["project-notion-contexts", projectId],
		queryFn: async () => {
			const result = await orpcClient.projects.contexts.list({
				projectId,
				organizationId: organizationId ?? undefined,
			});
			// Filter to INTEGRATION type with Notion metadata, excluding PRD source
			return (result?.contexts || []).filter((ctx) => {
				if (ctx.type !== "INTEGRATION") {
					return false;
				}
				const metadata = ctx.metadata as Record<string, unknown>;
				if (!metadata?.notionPageId) {
					return false;
				}
				if (metadata?.isPrdSource) {
					return false;
				}
				return true;
			});
		},
	});

	// Fetch MCP configs that have Confluence tools. Detection uses the stable
	// linked-catalog signal (server tags / key "atlassian") — never the
	// user-editable config name (see `isConfluenceMcpConfig`).
	const { data: confluenceMcpConfigs, isLoading: confluenceConfigsLoading } =
		useQuery({
			queryKey: ["mcp-configs-confluence", organizationId],
			queryFn: async () => {
				const allConfigs = await orpcClient.mcp.configs.list({
					organizationId: organizationId ?? undefined,
				});

				let personalMcpConfigs: typeof allConfigs = [];
				if (organizationId) {
					try {
						personalMcpConfigs = await orpcClient.mcp.configs.list(
							{},
						);
					} catch {
						// Ignore personal config fetch errors
					}
				}

				const combinedConfigs = organizationId
					? [...allConfigs, ...personalMcpConfigs]
					: allConfigs;

				return combinedConfigs.filter(
					(cfg: (typeof allConfigs)[number]) =>
						cfg.enabled && isConfluenceMcpConfig(cfg),
				);
			},
		});

	// Fetch existing Confluence contexts for this project (to pass syncedPageIds)
	const { data: confluenceContexts } = useQuery({
		queryKey: ["project-confluence-contexts", projectId],
		queryFn: async () => {
			const result = await orpcClient.projects.contexts.list({
				projectId,
				organizationId: organizationId ?? undefined,
			});
			return (result?.contexts || []).filter((ctx) => {
				if (ctx.type !== "INTEGRATION") {
					return false;
				}
				const metadata = ctx.metadata as Record<string, unknown>;
				return !!metadata?.confluencePageId;
			});
		},
	});

	const resetForm = () => {
		fileForm.reset();
		setFileDocumentTag("");
		linkForm.reset();
		textForm.reset();
		setActiveTab("file");
	};

	const isLoading =
		fileForm.isLoading || linkForm.isLoading || textForm.isLoading;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				// Escape, the backdrop, and the built-in close button are their
				// own dismissal paths — Cancel being disabled does not cover
				// them. Letting one through mid-submit does not cancel the
				// in-flight upload/crawl/save; it leaves it running to
				// force-close and reset whatever the user reopens next
				// (mirrors CreateDocumentDialog.tsx).
				if (isLoading && !next) {
					return;
				}
				onOpenChange(next);
			}}
		>
			{/* `max-w-3xl` gives the seven-tab row enough room to sit on one
			    line without scrolling at desktop widths.
			    `grid-cols-[minmax(0,1fr)]` caps the grid column at the dialog
			    width so the tab row can't grow the column past the dialog box
			    and crop content off the right edge; on narrower viewports the
			    tab row scrolls (see below) rather than overflowing. */}
			<DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-3xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<div className="rounded-lg border border-border bg-card p-2 text-primary">
							<SparklesIcon className="size-4" />
						</div>
						Add Context
					</DialogTitle>
					<DialogDescription>
						Add context to your project by uploading files, adding
						links, or pasting text. This helps generate better, more
						accurate documents.
					</DialogDescription>
				</DialogHeader>

				{/* Custom Tabs */}
				<div
					className="relative"
					role="tablist"
					aria-label="Context source"
				>
					{/* `min-w-0 overflow-x-auto` lets the seven-tab row scroll
					    horizontally instead of forcing the dialog wider than its
					    container; `no-scrollbar` keeps the editorial look (matches
					    the ProjectDetails tab row). */}
					<div className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1.5">
						{tabs.map((tab) => {
							const Icon = tab.icon;
							const isActive = activeTab === tab.id;

							return (
								<button
									key={tab.id}
									type="button"
									role="tab"
									aria-selected={isActive}
									aria-controls={`context-tabpanel-${tab.id}`}
									id={`context-tab-${tab.id}`}
									onClick={() => setActiveTab(tab.id)}
									disabled={isLoading}
									className={cn(
										"relative flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-medium text-sm transition-colors",
										isActive
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:text-foreground",
										isLoading &&
											"cursor-not-allowed opacity-50",
									)}
								>
									<Icon
										className={cn(
											"size-4",
											isActive && "text-primary",
										)}
									/>
									<span>{tab.label}</span>
								</button>
							);
						})}
					</div>

					{/* Editorial underline — single primary token, no gradient */}
					<div className="relative mt-1 h-0.5 w-full overflow-hidden rounded-full bg-border">
						<div
							className="absolute h-full rounded-full bg-primary motion-safe:transition-[left] motion-safe:duration-300 motion-safe:ease-out"
							style={{
								width: `${100 / tabs.length}%`,
								left: `${(tabs.findIndex((t) => t.id === activeTab) / tabs.length) * 100}%`,
							}}
						/>
					</div>
				</div>

				{/* Tab Content */}
				<div className="mt-4">
					{/* File upload tab — multi-file */}
					{activeTab === "file" && (
						<FileSourceTabContent
							form={fileForm}
							isLoading={isLoading}
						>
							{/* Document type tag */}
							<div>
								<Label htmlFor="file-document-tag">
									Tag as Document (Optional)
								</Label>
								<select
									id="file-document-tag"
									value={fileDocumentTag}
									onChange={(e) =>
										setFileDocumentTag(e.target.value)
									}
									disabled={isLoading}
									className="mt-2 flex h-9 w-full rounded-md border border-input bg-background text-foreground px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								>
									{DOCUMENT_TAG_OPTIONS.map((opt) => (
										<option
											key={opt.value}
											value={opt.value}
											className="bg-background text-foreground"
										>
											{opt.value === ""
												? "None - Context only"
												: opt.label}
										</option>
									))}
								</select>
								<p className="mt-1 text-xs text-muted-foreground">
									Tag this file as a project document to use
									it directly instead of generating one
								</p>
							</div>
						</FileSourceTabContent>
					)}

					{/* Link tab — URL Context Sources */}
					{activeTab === "link" && (
						<UrlSourceTabContent
							form={linkForm}
							isLoading={isLoading}
						/>
					)}

					{/* Text tab */}
					{activeTab === "text" && (
						<TextSourceTabContent
							form={textForm}
							isLoading={isLoading}
						/>
					)}

					{/* Teams tab */}
					{activeTab === "teams" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-teams"
							aria-labelledby="context-tab-teams"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-primary">
								<MicrosoftTeamsIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Microsoft Teams Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Connect your Teams group chats to include
								conversation context in document generation.
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										onClick={() => setTeamsDialogOpen(true)}
										className="gap-2"
									>
										<MicrosoftTeamsIcon className="size-4" />
										Select Teams Chats
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("selectTeamsChats")}
								</TooltipContent>
							</Tooltip>
						</div>
					)}

					{/* Slack tab */}
					{activeTab === "slack" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-slack"
							aria-labelledby="context-tab-slack"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-primary">
								<SlackIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Slack Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Connect your Slack workspace channels to include
								conversation context in document generation.
							</p>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										onClick={() => setSlackDialogOpen(true)}
										className="gap-2"
									>
										<SlackIcon className="size-4" />
										Select Slack Channels
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("selectSlackChannels")}
								</TooltipContent>
							</Tooltip>
						</div>
					)}

					{/* Google Docs tab — opens the picker-session-backed dialog */}
					{activeTab === "google-docs" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-google-docs"
							aria-labelledby="context-tab-google-docs"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-foreground">
								<GoogleDriveIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Google Docs Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Pick Google Docs from your connected Google
								account and add them as project context.
							</p>
							<Button
								onClick={() => setGoogleDocsDialogOpen(true)}
								className="gap-2"
							>
								<GoogleDriveIcon className="size-4" />
								Pick Google Docs
							</Button>
						</div>
					)}

					{/* Notion tab */}
					{activeTab === "notion" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-notion"
							aria-labelledby="context-tab-notion"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-foreground">
								<NotionIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Notion Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Sync Notion pages to include as context for
								document generation.
							</p>
							{notionConfigsLoading ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<LoaderIcon className="size-4 motion-safe:animate-spin" />
									<span>Loading...</span>
								</div>
							) : (notionMcpConfigs?.length ?? 0) === 0 ? (
								<>
									<p className="mb-4 text-sm text-muted-foreground">
										No Notion MCP server configured
									</p>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button variant="outline" asChild>
												<Link
													href={buildReturnUrl(
														`${basePath}/mcp-servers`,
													)}
												>
													<SettingsIcon className="size-4 mr-2" />
													Configure MCP
												</Link>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("configureMcp")}
										</TooltipContent>
									</Tooltip>
								</>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											onClick={() => {
												if (notionMcpConfigs?.[0]) {
													setSelectedNotionMcpConfigId(
														notionMcpConfigs[0].id,
													);
													setNotionDialogOpen(true);
												}
											}}
											className="gap-2"
										>
											<NotionIcon className="size-4" />
											Browse Notion Pages
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("browseNotionPages")}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					)}

					{/* Confluence tab */}
					{activeTab === "confluence" && (
						<div
							className="flex flex-col items-center justify-center py-8 motion-safe:animate-stagger"
							role="tabpanel"
							id="context-tabpanel-confluence"
							aria-labelledby="context-tab-confluence"
						>
							<div className="mb-4 rounded-2xl border border-border bg-card p-4 text-foreground">
								<ConfluenceIcon className="size-8" />
							</div>
							<h3 className="mb-2 font-medium text-foreground">
								Confluence Integration
							</h3>
							<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
								Sync Confluence pages to include as context for
								document generation.
							</p>
							{confluenceConfigsLoading ? (
								<div className="flex items-center gap-2 text-muted-foreground">
									<LoaderIcon className="size-4 motion-safe:animate-spin" />
									<span>Loading...</span>
								</div>
							) : (confluenceMcpConfigs?.length ?? 0) === 0 ? (
								<>
									<p className="mb-4 text-sm text-muted-foreground">
										No Confluence MCP server configured
									</p>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button variant="outline" asChild>
												<Link
													href={buildReturnUrl(
														`${basePath}/mcp-servers`,
													)}
												>
													<SettingsIcon className="size-4 mr-2" />
													Configure MCP
												</Link>
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("configureMcp")}
										</TooltipContent>
									</Tooltip>
								</>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											onClick={() => {
												if (confluenceMcpConfigs?.[0]) {
													setSelectedConfluenceMcpConfigId(
														confluenceMcpConfigs[0]
															.id,
													);
													setConfluenceDialogOpen(
														true,
													);
												}
											}}
											className="gap-2"
										>
											<ConfluenceIcon className="size-4" />
											Browse Confluence Pages
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("browseConfluencePages")}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					)}
				</div>

				{/* Footer - hidden for teams/slack/notion/confluence/google-docs tabs (they have their own buttons) */}
				{(activeTab === "file" ||
					activeTab === "link" ||
					activeTab === "text") && (
					<ContextSourceSubmitFooter
						tab={activeTab}
						file={fileForm}
						link={linkForm}
						text={textForm}
						isLoading={isLoading}
						onCancel={() => onOpenChange(false)}
					/>
				)}
			</DialogContent>

			{/* Teams chat selector dialog */}
			<TeamsChatSelectorDialog
				projectId={projectId}
				open={teamsDialogOpen}
				onOpenChange={setTeamsDialogOpen}
				onSuccess={() => {
					// Spec `2026-05-23-unified-context-uploader-wizard`
					// §9.2: INTEGRATION rows carry a granular
					// `integrationKind` so post-launch validation can
					// separate Teams vs Slack vs Notion attachment rates
					// without parsing a contextType.
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "TEAMS",
					});
					// Close the main dialog after successful chat selection
					onOpenChange(false);
				}}
			/>

			{/* Slack channel selector dialog */}
			<SlackChannelSelectorDialog
				projectId={projectId}
				open={slackDialogOpen}
				onOpenChange={setSlackDialogOpen}
				onSuccess={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "SLACK",
					});
					// Close the main dialog after successful channel selection
					onOpenChange(false);
				}}
			/>

			{/* Google Docs picker — uses the Google Picker SDK under the hood,
			    so the heavy lifting (auth, MIME filter, multi-select) is
			    Google's; we just ingest the picks via `addGoogleDocs`. The
			    `onAdded` split (vs `onOpenChange`) means analytics + the
			    outer-dialog close only fire on a *successful* pick, not on
			    cancel. */}
			<GoogleDocsSelectorDialog
				open={googleDocsDialogOpen}
				onOpenChange={setGoogleDocsDialogOpen}
				projectId={projectId}
				organizationId={organizationId ?? null}
				onAdded={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "GOOGLE_DRIVE",
					});
					onOpenChange(false);
				}}
			/>

			{/* Notion resource browser dialog */}
			<NotionResourceBrowser
				open={notionDialogOpen}
				onOpenChange={setNotionDialogOpen}
				mcpConfigId={selectedNotionMcpConfigId}
				projectId={projectId}
				organizationId={organizationId ?? null}
				syncedPageIds={
					notionContexts
						?.map(
							(ctx) =>
								(ctx.metadata as Record<string, unknown>)
									?.notionPageId as string,
						)
						.filter(Boolean) ?? []
				}
				onResourcesAdded={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "NOTION",
					});
					// Invalidate contexts and close dialog
					queryClient.invalidateQueries({
						queryKey: ["project-notion-contexts", projectId],
					});
					queryClient.invalidateQueries({
						queryKey: orpc.projects.contexts.list.queryKey({
							input: { projectId },
						}),
					});
					onOpenChange(false);
				}}
			/>
			{/* Confluence resource browser dialog */}
			<ConfluenceResourceBrowser
				open={confluenceDialogOpen}
				onOpenChange={setConfluenceDialogOpen}
				mcpConfigId={selectedConfluenceMcpConfigId}
				projectId={projectId}
				organizationId={organizationId ?? null}
				syncedPageIds={
					confluenceContexts
						?.map(
							(ctx) =>
								(ctx.metadata as Record<string, unknown>)
									?.confluencePageId as string,
						)
						.filter(Boolean) ?? []
				}
				onResourcesAdded={() => {
					trackEvent("project_context_added_during_wizard", {
						surface,
						contextType: "INTEGRATION",
						integrationKind: "CONFLUENCE",
					});
					queryClient.invalidateQueries({
						queryKey: ["project-confluence-contexts", projectId],
					});
					queryClient.invalidateQueries({
						queryKey: orpc.projects.contexts.list.queryKey({
							input: { projectId },
						}),
					});
					onOpenChange(false);
				}}
			/>
		</Dialog>
	);
}
