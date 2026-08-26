"use client";

import type { Prisma } from "@repo/database";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import type { ClarifyingQuestionFrequency } from "@saas/shared/components/copilot/useClarifyingQuestions";
import { isMonitoringFeatureEnabled } from "@saas/shared/lib/feature-flags";
import { GoogleDriveIcon } from "@saas/workflows/lib/plugins/google-drive/icon";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DestructiveTooltip,
	type DestructiveTooltipCopy,
} from "@ui/components/destructive-tooltip";
import { AlertTriangleIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type ProjectTabMeta,
	useProjectTabCustomization,
} from "../lib/project-tab-preferences";
import { ActionItemRoutingSettings } from "./ActionItemRoutingSettings";
import { FieldMappingPanel } from "./field-mapping/FieldMappingPanel";
import { GoogleDocsSelectorDialog } from "./GoogleDocsSelectorDialog";
import { MeetingTranscriptSyncSettings } from "./MeetingTranscriptSyncSettings";
import { PrdSourceSettings } from "./PrdSourceSettings";
import { ProjectAiAssistantSettings } from "./ProjectAiAssistantSettings";
import { ProjectDatabricksKnowledgeSettings } from "./ProjectDatabricksKnowledgeSettings";
import { ProjectGeneralSettings } from "./ProjectGeneralSettings";
import { ProjectImplementationDefaultsSettings } from "./ProjectImplementationDefaultsSettings";
import { ProjectManagementSettings } from "./ProjectManagementSettings";
import { ProjectMembersSettings } from "./ProjectMembersSettings";
import { ProjectNewsletterSettings } from "./ProjectNewsletterSettings";
import { ProjectReadOnlyModeSettings } from "./ProjectReadOnlyModeSettings";
import { ProjectRepositoryIntegrationSettings } from "./ProjectRepositoryIntegrationSettings";
import { ProjectSettingsNav, type SettingsTab } from "./ProjectSettingsNav";
import { ProjectStageVisibilitySettings } from "./ProjectStageVisibilitySettings";
import { ProjectTabVisibilitySettings } from "./ProjectTabVisibilitySettings";
import { PublishingSuiteSettings } from "./PublishingSuiteSettings";
import { ProjectEnvironmentsSettings } from "./qa-settings/ProjectEnvironmentsSettings";
import { TestingSettingsPanel } from "./qa-settings/TestingSettingsPanel";
import { RagSettingsForm } from "./RagSettingsForm";
import { SlackChannelMonitorSettings } from "./SlackChannelMonitorSettings";
import {
	NAVIGATE_TO_SETTINGS_TAB_EVENT,
	type NavigateToSettingsTabDetail,
} from "./settings-tab-navigation";
import { resolveStoredSettingsTab } from "./settings-tab-storage";
import { TeamsChannelMonitorSettings } from "./TeamsChannelMonitorSettings";
import { TeamsChatMonitorSettings } from "./TeamsChatMonitorSettings";

type Project = {
	id: string;
	name: string;
	description: string | null;
	status: string;
	projectTypes: string[];
	icon: string | null;
	color: string | null;
	tags: string[] | null;
	techStack: string[] | null;
	features: string[] | null;
	goals: string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	organizationId?: string | null;
	projectManagementMcpServerId?: string | null;
	projectManagementMcpConfigId?: string | null;
	projectManagementContainerId?: string | null;
	projectManagementContainerName?: string | null;
	projectManagementAdditionalContext?: Prisma.JsonValue | null;
	pmFieldMappingEnabled?: boolean;
	prdSourceContextId?: string | null;
	prdSourceTitle?: string | null;
	prdSourceUrl?: string | null;
	repositoryUrl?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	defaultBranch?: string | null;
	implementationDefaultChannel?: string | null;
	implementationDefaultProvider?: string | null;
	meetingTranscriptSyncEnabled?: boolean;
	meetingTranscriptSyncIntervalMin?: number | null;
	meetingTranscriptSyncLastRun?: Date | string | null;
	meetingTranscriptAutoAnalyzeEnabled?: boolean;
	teamsChannelMonitorEnabled?: boolean;
	teamsChannelMonitorIntervalMin?: number | null;
	teamsChannelMonitorQuietWindowMin?: number | null;
	teamsChannelMonitorLastRun?: Date | string | null;
	teamsChatMonitorEnabled?: boolean;
	teamsChatMonitorIntervalMin?: number | null;
	teamsChatMonitorQuietWindowMin?: number | null;
	teamsChatMonitorLastRun?: Date | string | null;
	slackChannelMonitorEnabled?: boolean;
	slackChannelMonitorDebounceMs?: number | null;
	slackChannelMonitorMaxHoldMs?: number | null;
	slackChannelMonitorLastRun?: Date | string | null;
	actionItemRoutingEnabled?: boolean;
	// Attachment retention (Fizzy #1749). The stored override, plus the window
	// the purge would actually apply right now (resolved server-side through
	// project -> organization -> server default) for the form's placeholder.
	attachmentRetentionDays?: number | null;
	effectiveAttachmentRetentionDays?: number;
	userId: string;
	userRole?: string | null;
	// Server-resolved capability flag (PROJECT_SETTINGS_EDIT) that honours org
	// admins/owners without an explicit ProjectMember row — see get-project.ts.
	// Non-null boolean at runtime (from userHasProjectPermission).
	canEditSettings?: boolean;
	canUpdateProject?: boolean;
	// Publishing Suite manual-generate capability (PUBLISHING_TOPIC_CREATE),
	// which Editors hold too — deliberately separate from `canEditSettings`
	// (admin/owner only). See get-project.ts and PublishingSuiteSettings.tsx.
	canPublish?: boolean;
	hiddenMaturationStatuses?: string[] | null;
	readOnlyMode?: boolean | null;
	clarifyingQuestionFrequency?: ClarifyingQuestionFrequency | null;
	repositoryIntegrations?: Array<{
		id: string;
		status: string;
		provider: string;
		repositoryOwner: string;
		repositoryName: string;
	}>;
};

type Props = {
	project: Project;
	canDelete?: boolean;
	currentUserId?: string;
	/** Tab-bar metadata from ProjectDetails, for the visibility admin panel. */
	tabMeta?: readonly ProjectTabMeta[];
};

// Tab-scoped (sessionStorage) key for the active settings sub-tab. Mirrored by
// `navigateToProjectSettingsTab` — both must stay on sessionStorage so in-app
// deep links still work (same tab) without leaking sub-tab state across browser tabs.
const STORAGE_KEY_PREFIX = "fabric-project-settings-tab-";

// Only ungated sub-tabs are deep-linkable from a notification/CTA (never route a
// deep link into a role-gated tab like danger). Newsletter is ungated.
const DEEP_LINKABLE_SETTINGS_TABS: SettingsTab[] = ["newsletter"];

// The QA project tab is gated on this flag (`ProjectDetails.tsx`), and both QA
// settings pages configure that tab and nothing else — `ProjectEnvironment` has
// no non-QA consumer. Read once at module scope: `NEXT_PUBLIC_*` is inlined at
// build time, so this is a constant, not a runtime lookup.
const QA_SETTINGS_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES === "true";

// The Publishing Suite project tab is gated on this flag, and the settings
// sub-tab configures that page and nothing else. Read once at module scope
// for the same reason as `QA_SETTINGS_ENABLED` above — `NEXT_PUBLIC_*` is
// inlined at build time, so this is a constant, not a runtime lookup. One
// flag read drives both the nav's `showPublishing` prop and the gates object
// below.
const PUBLISHING_SUITE_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_PUBLISHING_SUITE === "true";

function useSettingsTab(projectId: string, pmFieldMappingEnabled: boolean) {
	const [tab, setTabState] = useState<SettingsTab>(() => {
		if (typeof window === "undefined") {
			return "general";
		}
		try {
			const stored = sessionStorage.getItem(
				`${STORAGE_KEY_PREFIX}${projectId}`,
			);
			return (
				resolveStoredSettingsTab(stored, {
					pmFieldMappingEnabled,
					qaEnabled: QA_SETTINGS_ENABLED,
					publishingEnabled: PUBLISHING_SUITE_ENABLED,
				}) ?? "general"
			);
		} catch {
			// ignore
		}
		return "general";
	});

	const setTab = useCallback(
		(next: SettingsTab) => {
			setTabState(next);
			try {
				sessionStorage.setItem(
					`${STORAGE_KEY_PREFIX}${projectId}`,
					next,
				);
			} catch {
				// ignore
			}
		},
		[projectId],
	);

	/**
	 * Switch sub-tab when something already on screen asks for one.
	 *
	 * The state above reads sessionStorage in its initializer, which runs once,
	 * on mount. That is enough when the deep link arrives from another tab —
	 * Settings mounts fresh and picks the key up. It is not enough when Settings
	 * is ALREADY open: `ProjectDetails` switches its top-level tab to "settings",
	 * which it already is, this component never remounts, and the click does
	 * nothing at all. Found in staging QA of the readiness checklist, where
	 * "Connect PM tool" landed you on Settings and every later item — "Edit
	 * description", "Connect codebase" — was then dead.
	 */
	useEffect(() => {
		const onNavigate = (event: Event) => {
			const detail = (event as CustomEvent<NavigateToSettingsTabDetail>)
				.detail;
			if (detail?.projectId !== projectId) {
				return;
			}
			const resolved = resolveStoredSettingsTab(detail.settingsTab, {
				pmFieldMappingEnabled,
				qaEnabled: QA_SETTINGS_ENABLED,
				publishingEnabled: PUBLISHING_SUITE_ENABLED,
			});
			// `null` means the requested tab is gated off for this viewer —
			// leave them where they are rather than bouncing them to General.
			if (resolved) {
				setTab(resolved);
			}
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, onNavigate);
		return () =>
			window.removeEventListener(
				NAVIGATE_TO_SETTINGS_TAB_EVENT,
				onNavigate,
			);
	}, [projectId, pmFieldMappingEnabled, setTab]);

	return [tab, setTab] as const;
}

export function ProjectSettings({
	project,
	canDelete = false,
	currentUserId,
	tabMeta,
}: Props) {
	const tabCustomization = useProjectTabCustomization({
		projectId: project.id,
	});
	const pmFieldMappingEnabled = project.pmFieldMappingEnabled ?? false;
	const [settingsTab, setSettingsTab] = useSettingsTab(
		project.id,
		pmFieldMappingEnabled,
	);
	// Honor a `?settingsTab=<id>` deep link so the approval notification (and any
	// future cross-page CTA) can land directly on the Newsletter sub-tab instead
	// of whatever sub-tab sessionStorage last recorded. Mirrors the `?tab`
	// handling in `ProjectDetails.tsx` — only deep-linkable (ungated) sub-tabs
	// switch, so a stray/malicious param can't route into a role-gated tab.
	const settingsSearchParams = useSearchParams();
	useEffect(() => {
		const requested = settingsSearchParams.get("settingsTab");
		if (
			requested &&
			DEEP_LINKABLE_SETTINGS_TABS.includes(requested as SettingsTab)
		) {
			setSettingsTab(requested as SettingsTab);
		}
	}, [settingsSearchParams]);
	const [googleDocsDialogOpen, setGoogleDocsDialogOpen] = useState(false);
	const googleDocsContextEnabled = isMonitoringFeatureEnabled(
		"feature-google-docs-context",
	);
	const router = useRouter();
	const { basePath } = useOrganizationContext();
	const { confirm } = useConfirmationAlert();
	const t = useTranslations("tooltips.projectSettings");
	const deleteProjectCopy = t.raw("deleteProject") as DestructiveTooltipCopy;

	const deleteMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.delete({ id: project.id });
		},
		onSuccess: () => {
			toast.success("Project moved to trash", {
				description:
					"You can restore it within 7 days from the Deleted tab.",
			});
			router.push(`${basePath}/projects`);
		},
		onError: (error) => {
			toast.error("Failed to delete project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	function handleDelete() {
		confirm({
			title: "Delete Project",
			message: `Are you sure you want to delete "${project.name}"? The project will be moved to trash and automatically deleted after 7 days. You can restore it from the Deleted tab.`,
			confirmLabel: "Delete",
			cancelLabel: "Cancel",
			destructive: true,
			onConfirm: () => {
				deleteMutation.mutate();
			},
		});
	}

	// Status indicators for nav items
	const navStatus = {
		knowledge: !!(
			project.prdSourceContextId || project.meetingTranscriptSyncEnabled
		),
		development: !!(
			project.repositoryUrl ||
			(project.repositoryIntegrations &&
				project.repositoryIntegrations.length > 0) ||
			// PM lives on Development only while the flag is off.
			(!pmFieldMappingEnabled && project.projectManagementMcpConfigId)
		),
		"project-management": !!(
			pmFieldMappingEnabled && project.projectManagementMcpConfigId
		),
		members: true, // always has at least the owner
	};

	const sectionTitleClass =
		"text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground";

	// Admin-configurable settings (Read-only mode, clarifying-question frequency)
	// are gated on PROJECT_SETTINGS_EDIT. Prefer the server's capability flag,
	// which honours org admins/owners who have no explicit ProjectMember row —
	// the same fallback the settings mutations enforce. Fall back to the raw
	// role string only for payloads that predate `canEditSettings`. Using the
	// raw role alone would show an authorized org admin a disabled control.
	const canEditSettings =
		project.canEditSettings ??
		(project.userRole === "owner" || project.userRole === "project_admin");

	const canEditStageVisibility =
		project.canUpdateProject ??
		(canEditSettings || project.userRole === "editor");

	return (
		<div className="flex flex-col gap-6 lg:flex-row">
			<ProjectSettingsNav
				activeTab={settingsTab}
				onTabChange={setSettingsTab}
				status={navStatus}
				showDanger={canDelete}
				showProjectManagement={pmFieldMappingEnabled}
				showQa={QA_SETTINGS_ENABLED}
				showPublishing={PUBLISHING_SUITE_ENABLED}
			/>

			<div
				data-onboarding-target="project-settings-content"
				className="min-w-0 flex-1"
			>
				<div className="mb-4 flex justify-end">
					<PageTourButton pageId="settings" />
				</div>
				{settingsTab === "general" && (
					<div className="space-y-6">
						<ProjectGeneralSettings project={project} />
						<ProjectReadOnlyModeSettings
							project={project}
							canEdit={canEditSettings}
						/>
						<ProjectAiAssistantSettings
							project={project}
							canEdit={canEditSettings}
						/>
						<ProjectStageVisibilitySettings
							project={project}
							canEdit={canEditStageVisibility}
						/>
						{tabMeta && (
							<ProjectTabVisibilitySettings
								tabs={tabMeta}
								config={tabCustomization.config}
								canEdit={canEditSettings}
								saving={tabCustomization.saveConfig.isPending}
								onSave={(cfg, handlers) =>
									tabCustomization.saveConfig.mutate(cfg, {
										onError: handlers.onError,
										onSuccess: () =>
											toast.success(
												"Tab visibility saved",
											),
									})
								}
							/>
						)}
					</div>
				)}

				{settingsTab === "knowledge" && (
					<div className="space-y-4">
						<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
							<div>
								<p className={sectionTitleClass}>
									Project Knowledge
								</p>
								<h3 className="mt-2 text-xl font-semibold text-foreground">
									Source material Fabric can search and reuse
								</h3>
								<p className="mt-2 max-w-3xl text-sm text-muted-foreground">
									Connect the systems where your PRDs, docs,
									and reference material already live. Fabric
									keeps these sources available as project
									knowledge so agents and research runs can
									work from the same source of truth.
								</p>
							</div>
							{googleDocsContextEnabled && (
								<Button
									variant="outline"
									size="sm"
									className="shrink-0"
									onClick={() =>
										setGoogleDocsDialogOpen(true)
									}
								>
									<GoogleDriveIcon className="mr-2 size-4" />
									Add from Google Docs
								</Button>
							)}
						</div>
						{googleDocsContextEnabled && (
							<GoogleDocsSelectorDialog
								open={googleDocsDialogOpen}
								onOpenChange={setGoogleDocsDialogOpen}
								projectId={project.id}
								organizationId={project.organizationId ?? null}
							/>
						)}
						<div className="grid gap-6 2xl:grid-cols-2">
							<PrdSourceSettings project={project} />
							<ProjectDatabricksKnowledgeSettings
								projectId={project.id}
								organizationId={project.organizationId ?? null}
								canEdit={canEditSettings}
							/>
							<div data-onboarding-target="settings-meeting-transcripts">
								<MeetingTranscriptSyncSettings
									projectId={project.id}
									organizationId={
										project.organizationId ?? null
									}
									project={project}
								/>
							</div>
							{/* One anchor around all three: the readiness item is
							    "a chat app is connected", and any of these
							    satisfies it. */}
							<div
								className="space-y-4"
								data-onboarding-target="settings-chat-monitors"
							>
								<TeamsChannelMonitorSettings
									projectId={project.id}
									organizationId={
										project.organizationId ?? null
									}
									project={project}
								/>
								<TeamsChatMonitorSettings
									projectId={project.id}
									organizationId={
										project.organizationId ?? null
									}
									project={project}
								/>
								<SlackChannelMonitorSettings
									projectId={project.id}
									organizationId={
										project.organizationId ?? null
									}
									project={project}
								/>
							</div>
							{/* Governs what happens to what the four cards above
							    capture, so it belongs beside them rather than in
							    any one of their settings. */}
							<ActionItemRoutingSettings
								projectId={project.id}
								organizationId={project.organizationId ?? null}
								project={project}
								canEdit={canEditSettings}
							/>
						</div>
					</div>
				)}

				{settingsTab === "development" && (
					<div className="space-y-6">
						<div>
							<p className={sectionTitleClass}>Development</p>
							<h3 className="mt-2 text-xl font-semibold text-foreground">
								Project management and repository
							</h3>
							<p className="mt-2 max-w-3xl text-sm text-muted-foreground">
								Connect project management tools, repositories,
								and configure the local development path Fabric
								Agent should use when work is delegated.
							</p>
						</div>
						{/* When the field-mapping flag is on the PM card moves to
						    its own Project Management tab; otherwise it stays here
						    so no capability is lost. */}
						{!pmFieldMappingEnabled && (
							<ProjectManagementSettings project={project} />
						)}
						<ProjectImplementationDefaultsSettings
							project={project}
						/>
						{currentUserId && (
							<ProjectRepositoryIntegrationSettings
								project={project}
								currentUserId={currentUserId}
								qaEnabled={QA_SETTINGS_ENABLED}
							/>
						)}
					</div>
				)}

				{pmFieldMappingEnabled &&
					settingsTab === "project-management" && (
						<div className="space-y-6">
							<div>
								<p className={sectionTitleClass}>
									Project Management
								</p>
								<h3 className="mt-2 text-xl font-semibold text-foreground">
									PM tool connection & field mapping
								</h3>
								<p className="mt-2 max-w-3xl text-sm text-muted-foreground">
									Connect your project management tool and
									configure how its work-item fields map into
									Fabric.
								</p>
							</div>
							<ProjectManagementSettings project={project} />
							<FieldMappingPanel project={project} />
						</div>
					)}

				{settingsTab === "members" && (
					<div className="space-y-4">
						<div>
							<p className={sectionTitleClass}>
								Access & Collaboration
							</p>
							<h3 className="mt-2 text-xl font-semibold text-foreground">
								Team access
							</h3>
						</div>
						<ProjectMembersSettings
							projectId={project.id}
							organizationId={project.organizationId}
						/>
					</div>
				)}

				{settingsTab === "retrieval" && (
					<RagSettingsForm projectId={project.id} />
				)}

				{settingsTab === "environments" && (
					<ProjectEnvironmentsSettings
						projectId={project.id}
						canEdit={canEditSettings}
					/>
				)}

				{settingsTab === "testing" && (
					// Nine short sections behind their own rail, rather than one
					// ~4,000px column. The panel owns the section order and the
					// composition — see `testing-sections.ts`.
					<TestingSettingsPanel
						project={project}
						canEdit={canEditSettings}
					/>
				)}

				{settingsTab === "newsletter" && (
					<div className="space-y-4">
						<div>
							<p className={sectionTitleClass}>
								Stakeholder Updates
							</p>
							<h3 className="mt-2 text-xl font-semibold text-foreground">
								Release notes newsletter
							</h3>
						</div>
						<ProjectNewsletterSettings
							projectId={project.id}
							organizationId={project.organizationId ?? null}
							canEdit={canEditSettings}
							onNavigateToRepositories={() =>
								setSettingsTab("development")
							}
							onNavigateToChatChannels={() =>
								setSettingsTab("knowledge")
							}
						/>
					</div>
				)}

				{settingsTab === "publishing" && (
					<div className="space-y-4">
						<div>
							<p className={sectionTitleClass}>Publishing</p>
							<h3 className="mt-2 text-xl font-semibold text-foreground">
								Topic suggestions
							</h3>
						</div>
						<PublishingSuiteSettings
							projectId={project.id}
							organizationId={project.organizationId ?? null}
							canEdit={canEditSettings}
							canGenerate={project.canPublish ?? canEditSettings}
						/>
					</div>
				)}

				{settingsTab === "danger" && canDelete && (
					<Card className="rounded-2xl border border-destructive/30 bg-destructive/[0.04]">
						<div className="p-6">
							<p className={sectionTitleClass}>Danger Zone</p>
							<h3 className="mt-2 text-lg font-semibold">
								Delete this project
							</h3>

							<div className="mt-5 rounded-xl border border-destructive/20 bg-background/60 p-5">
								<div className="flex items-start gap-3">
									<div className="rounded-xl border border-destructive/15 bg-destructive/10 p-2">
										<AlertTriangleIcon
											className="h-5 w-5 text-destructive"
											aria-hidden
										/>
									</div>
									<div className="flex-1">
										<p className="text-sm text-muted-foreground">
											The project will be moved to trash
											and automatically deleted after 7
											days. You can restore it from the
											Deleted tab.
										</p>
										<DestructiveTooltip
											copy={deleteProjectCopy}
										>
											<Button
												variant="destructive"
												onClick={handleDelete}
												disabled={
													deleteMutation.isPending
												}
												className="mt-4 w-full sm:w-auto"
											>
												{deleteMutation.isPending
													? "Deleting..."
													: "Delete This Project"}
											</Button>
										</DestructiveTooltip>
									</div>
								</div>
							</div>
						</div>
					</Card>
				)}
			</div>
		</div>
	);
}
