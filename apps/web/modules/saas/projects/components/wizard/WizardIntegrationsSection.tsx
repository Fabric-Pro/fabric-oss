"use client";

/**
 * Wizard "Code Repository" section.
 *
 * GitHub and GitLab repo selection drives the code-based flow (the wizard
 * branches on `selectedGitHubRepos.length > 0 || selectedGitLabRepos.length > 0`
 * to switch to the 2-step CODE_BASED_STEPS flow at
 * `ProjectCreationWizard.tsx:139-142`).
 *
 * Teams / Slack / Notion pickers were previously hosted here. After the
 * 2026-05-23 unified context uploader spec (§7.4) those flows live in the
 * `<ContextUploaderDialog>` mounted from `BasicInfoStep.tsx` instead — the
 * dialog writes those selections as `ProjectContext` rows directly against
 * the DRAFT projectId. The `TeamsChatSelection` / `NotionPageSelection` type
 * exports remain (active callers in `create-integration-contexts.ts` and
 * `ProjectCreationWizard.tsx`) per the call-graph audit in
 * `fabric/specs/2026-05-23-unified-context-uploader-wizard/planning/group-9-call-graph.md`.
 * (The former `useExistingProjectOnboarding.ts` /
 * `ExistingProjectIntegrationsSection.tsx` callers were removed with the
 * Existing flow in the 2026-05-27 unified-project-setup spec, §10.)
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { GithubIcon, PlusIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	GitHubBrandIcon,
	GitLabBrandIcon,
} from "../../../data-connections/components/ProviderIcon";
import {
	AzureDevOpsPatRepoPicker,
	type AzureDevOpsRepo,
} from "./AzureDevOpsPatRepoPicker";
import { type GitHubRepo, GitHubRepoPicker } from "./GitHubRepoPicker";
import { type GitLabProject, GitLabProjectPicker } from "./GitLabProjectPicker";

// Types for integration selections.
//
// The Teams chat / Notion page shapes are kept exported because other
// surfaces still depend on them (back-compat for legacy DRAFTs + the
// `ExistingProjectFlow` post-creation surface). The wizard no longer
// renders these pickers — see file header.
export interface TeamsChatSelection {
	selectionType: "chat" | "channel";
	chatId?: string; // Present for group chats
	teamId?: string; // Present for channels
	channelId?: string; // Present for channels
	channelName?: string; // Present for channels
	teamName?: string; // Present for channels
	topic: string; // Display name for both
	memberCount?: number;
	mcpConfigId: string;
}

export interface NotionPageSelection {
	pageId: string;
	title: string;
	url?: string;
	mcpConfigId: string;
	icon?: string;
	documentTag?: string | null;
	type?: "page" | "database";
	lastEdited?: string;
}

export type { GitHubRepo, GitLabProject, AzureDevOpsRepo };

/**
 * Azure DevOps brand glyph for the wizard card.
 *
 * Drawn with `currentColor` so the card can paint it in the Azure DevOps brand
 * blue (`text-[#0078D7]`) at the call site — matching GitHub/GitLab, which also
 * render in their brand colors. Brand marks are the documented exception to the
 * design-token rule (they cannot be tokenized), consistent with `ProviderIcon`.
 */
function AzureDevOpsIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.707V2.882z" />
		</svg>
	);
}

/**
 * Human-readable identifier for an ADO repo chip.
 *
 * `AzureDevOpsRepo.fullName` is the canonical `dev.azure.com/{org}/{project}/_git/{repo}`
 * web URL (the stable selection key), which is too long for a chip. Show the
 * `{project}/{repo}` pair instead — matching the `org/repo` style of the
 * GitHub/GitLab chips.
 */
function adoRepoLabel(repo: AzureDevOpsRepo): string {
	return `${repo.projectName}/${repo.name}`;
}

interface WizardIntegrationsSectionProps {
	sessionId: string;
	organizationId?: string;
	selectedGitHubRepos?: GitHubRepo[];
	onGitHubReposChange?: (repos: GitHubRepo[]) => void;
	selectedGitLabRepos?: GitLabProject[];
	onGitLabReposChange?: (repos: GitLabProject[]) => void;
	selectedAzureDevOpsRepos?: AzureDevOpsRepo[];
	/**
	 * Provide to render the Azure DevOps card. The picker captures a PAT and,
	 * when a (DRAFT or ACTIVE) `projectId` is present, creates one
	 * `ProjectRepositoryIntegration` per selected repo at confirm time.
	 */
	onAzureDevOpsReposChange?: (
		repos: AzureDevOpsRepo[],
		creds?: { pat: string; azureOrganization: string },
	) => void;
	/** When provided, repo pickers use project-level shared credentials as fallback */
	projectId?: string;
}

export function WizardIntegrationsSection({
	sessionId: _sessionId, // Kept for backwards compatibility
	organizationId: _organizationIdProp, // Kept for backwards compatibility but we use context
	selectedGitHubRepos,
	onGitHubReposChange,
	selectedGitLabRepos,
	onGitLabReposChange,
	selectedAzureDevOpsRepos,
	onAzureDevOpsReposChange,
	projectId,
}: WizardIntegrationsSectionProps) {
	// CRITICAL: Use organization context directly from the hook, not from
	// props. This ensures the organizationId matches where integrations
	// were configured. Same pattern as working TeamsChatSelectorDialog.
	const { organizationId } = useOrganizationContext();
	const t = useTranslations("tooltips.contextSources");

	// Dialog states
	const [githubDialogOpen, setGithubDialogOpen] = useState(false);
	const [gitlabDialogOpen, setGitlabDialogOpen] = useState(false);
	const [azureDevOpsDialogOpen, setAzureDevOpsDialogOpen] = useState(false);

	return (
		<div className="space-y-4">
			{/* Section Header */}
			<div className="flex items-center justify-between">
				<div>
					<h4 className="font-medium text-sm">Code Repository</h4>
					<p className="text-xs text-muted-foreground mt-0.5">
						Connect a repository so Fabric can ground
						recommendations and generated docs in your existing
						code.
					</p>
				</div>
			</div>

			{/* Integration Cards */}
			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{/* GitHub Card */}
				{onGitHubReposChange && (
					<div
						className={cn(
							"rounded-lg border p-4 transition-colors",
							(selectedGitHubRepos?.length ?? 0) > 0
								? "border-border bg-muted"
								: "border-border hover:border-foreground/20",
						)}
					>
						<div className="flex items-start justify-between">
							<div className="flex items-center gap-3 min-w-0 flex-1">
								<div className="rounded-lg border border-border bg-muted p-2">
									<GitHubBrandIcon className="size-4 text-foreground" />
								</div>
								<div className="min-w-0">
									<h5 className="font-medium text-sm">
										GitHub
									</h5>
									<p className="text-xs text-muted-foreground">
										Add repositories Fabric should use as
										reference material
									</p>
									<p className="text-xs text-muted-foreground mt-0.5 truncate">
										{(selectedGitHubRepos?.length ?? 0) > 0
											? `${selectedGitHubRepos?.length} repo${selectedGitHubRepos?.length !== 1 ? "s" : ""} added`
											: "No repositories added"}
									</p>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setGithubDialogOpen(true)}
								className="shrink-0"
							>
								<PlusIcon className="size-4 mr-1" />
								Add
							</Button>
						</div>

						{(selectedGitHubRepos?.length ?? 0) > 0 && (
							<div className="mt-3 space-y-1.5">
								{selectedGitHubRepos?.map((repo) => (
									<div
										key={repo.fullName}
										className="flex items-center justify-between rounded-md bg-muted px-2 py-1.5"
									>
										<span className="text-xs truncate flex-1 flex items-center gap-1">
											<GithubIcon className="size-3 shrink-0 text-muted-foreground" />
											{repo.fullName}
											{repo.language && (
												<span className="text-muted-foreground ml-1">
													({repo.language})
												</span>
											)}
											{repo.roleTag && (
												<Badge
													variant="outline"
													className="text-[10px] px-1 py-0 h-4"
												>
													{repo.roleTag}
												</Badge>
											)}
										</span>
										<button
											type="button"
											onClick={() =>
												onGitHubReposChange(
													(
														selectedGitHubRepos ??
														[]
													).filter(
														(r) =>
															r.fullName !==
															repo.fullName,
													),
												)
											}
											className="ml-2 cursor-pointer text-muted-foreground hover:text-foreground"
										>
											<XIcon className="size-3.5" />
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{/* GitLab Card */}
				{onGitLabReposChange && (
					<div
						className={cn(
							"rounded-lg border p-4 transition-colors",
							(selectedGitLabRepos?.length ?? 0) > 0
								? "border-border bg-muted"
								: "border-border hover:border-foreground/20",
						)}
					>
						<div className="flex items-start justify-between">
							<div className="flex items-center gap-3 min-w-0 flex-1">
								<div className="rounded-lg border border-border bg-muted p-2">
									<GitLabBrandIcon className="size-4 text-[#FC6D26]" />
								</div>
								<div className="min-w-0">
									<h5 className="font-medium text-sm">
										GitLab
									</h5>
									<p className="text-xs text-muted-foreground">
										Add repositories Fabric should use as
										reference material
									</p>
									<p className="text-xs text-muted-foreground mt-0.5 truncate">
										{(selectedGitLabRepos?.length ?? 0) > 0
											? `${selectedGitLabRepos?.length} repo${selectedGitLabRepos?.length !== 1 ? "s" : ""} added`
											: "No repositories added"}
									</p>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setGitlabDialogOpen(true)}
								className="shrink-0"
							>
								<PlusIcon className="size-4 mr-1" />
								Add
							</Button>
						</div>

						{(selectedGitLabRepos?.length ?? 0) > 0 && (
							<div className="mt-3 space-y-1.5">
								{selectedGitLabRepos?.map((repo) => (
									<div
										key={repo.fullName}
										className="flex items-center justify-between rounded-md bg-muted px-2 py-1.5"
									>
										<span className="text-xs truncate flex-1 flex items-center gap-1">
											<GitLabBrandIcon className="size-3 shrink-0 text-muted-foreground" />
											{repo.fullName}
											{repo.language && (
												<span className="text-muted-foreground ml-1">
													({repo.language})
												</span>
											)}
											{repo.roleTag && (
												<Badge
													variant="outline"
													className="text-[10px] px-1 py-0 h-4"
												>
													{repo.roleTag}
												</Badge>
											)}
										</span>
										<button
											type="button"
											onClick={() =>
												onGitLabReposChange(
													(
														selectedGitLabRepos ??
														[]
													).filter(
														(r) =>
															r.fullName !==
															repo.fullName,
													),
												)
											}
											className="ml-2 cursor-pointer text-muted-foreground hover:text-foreground"
										>
											<XIcon className="size-3.5" />
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{/* Azure DevOps Card — brand-blue glyph, matching the
				    GitHub/GitLab cards above. */}
				{onAzureDevOpsReposChange && (
					<div
						className={cn(
							"rounded-lg border p-4 transition-colors",
							(selectedAzureDevOpsRepos?.length ?? 0) > 0
								? "border-primary/40 bg-primary/5"
								: "border-foreground/10 hover:border-foreground/20",
						)}
					>
						<div className="flex items-start justify-between">
							<div className="flex items-center gap-3 min-w-0 flex-1">
								<div className="rounded-lg border border-border bg-muted p-2">
									<AzureDevOpsIcon className="size-4 text-[#0078D7]" />
								</div>
								<div className="min-w-0">
									<h5 className="font-medium text-sm">
										Azure DevOps
									</h5>
									<p className="text-xs text-muted-foreground">
										Add repositories Fabric should use as
										reference material
									</p>
									<p className="text-xs text-muted-foreground mt-0.5 truncate">
										{(selectedAzureDevOpsRepos?.length ??
											0) > 0
											? `${selectedAzureDevOpsRepos?.length} repo${selectedAzureDevOpsRepos?.length !== 1 ? "s" : ""} added`
											: "No repositories added"}
									</p>
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setAzureDevOpsDialogOpen(true)}
								className="shrink-0"
							>
								<PlusIcon className="size-4 mr-1" />
								Add
							</Button>
						</div>

						{(selectedAzureDevOpsRepos?.length ?? 0) > 0 && (
							<div className="mt-3 space-y-1.5">
								{selectedAzureDevOpsRepos?.map((repo) => (
									<div
										key={repo.fullName}
										className="flex items-center justify-between rounded-md bg-muted/50 px-2 py-1.5"
									>
										<span className="text-xs truncate flex-1 flex items-center gap-1">
											<AzureDevOpsIcon className="size-3 shrink-0 text-muted-foreground" />
											{adoRepoLabel(repo)}
											{repo.roleTag && (
												<Badge
													variant="outline"
													className="text-[10px] px-1 py-0 h-4"
												>
													{repo.roleTag}
												</Badge>
											)}
										</span>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													aria-label={`Remove ${adoRepoLabel(repo)}`}
													onClick={() =>
														onAzureDevOpsReposChange(
															(
																selectedAzureDevOpsRepos ??
																[]
															).filter(
																(r) =>
																	r.fullName !==
																	repo.fullName,
															),
														)
													}
													className="ml-2 cursor-pointer text-muted-foreground hover:text-foreground"
												>
													<XIcon className="size-3.5" />
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{t("removeSelectedRepo")}
											</TooltipContent>
										</Tooltip>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</div>

			{/* GitHub repo picker */}
			{onGitHubReposChange && (
				<GitHubRepoPicker
					open={githubDialogOpen}
					onOpenChange={setGithubDialogOpen}
					organizationId={organizationId}
					initialRepos={selectedGitHubRepos ?? []}
					onConfirm={(repos) => onGitHubReposChange(repos)}
					projectId={projectId}
				/>
			)}

			{/* GitLab project picker */}
			{onGitLabReposChange && (
				<GitLabProjectPicker
					open={gitlabDialogOpen}
					onOpenChange={setGitlabDialogOpen}
					organizationId={organizationId}
					initialRepos={selectedGitLabRepos ?? []}
					onConfirm={(repos) => onGitLabReposChange(repos)}
					projectId={projectId}
				/>
			)}

			{/* Azure DevOps PAT picker. When a DRAFT/ACTIVE projectId is present,
			    the picker creates the integration(s) via `connect` at confirm
			    time and omits `creds`. When no projectId exists yet (pre-create flow),
			    it passes `creds` so the wizard can complete `connect` after project creation. */}
			{onAzureDevOpsReposChange && (
				<AzureDevOpsPatRepoPicker
					open={azureDevOpsDialogOpen}
					onOpenChange={setAzureDevOpsDialogOpen}
					organizationId={organizationId}
					initialRepos={selectedAzureDevOpsRepos ?? []}
					onConfirm={(repos, creds) =>
						onAzureDevOpsReposChange(repos, creds)
					}
					projectId={projectId}
				/>
			)}
		</div>
	);
}
