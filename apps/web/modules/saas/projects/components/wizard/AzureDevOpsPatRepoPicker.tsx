"use client";

/**
 * Azure DevOps PAT Repository Picker (code-repository flow)
 *
 * A two-phase dialog, reused by BOTH wizard surfaces (new-project +
 * existing-project) and any future consolidated wizard:
 *
 *   1. CONNECT step — a labeled `type="password"` PAT input + an
 *      organization/URL input. The organization is parsed with the same URL
 *      regex the Settings ADO PAT form uses (`parseAzureOrganization` below),
 *      accepting either a bare org name or a full repo URL (both `dev.azure.com`
 *      and legacy `*.visualstudio.com`).
 *   2. REPO-LIST step — on submit we call `projects.azureDevOps.listRepos`
 *      (PAT-based discovery). The grouped, multi-select repo list mirrors the
 *      structure of `GitHubRepoPicker` (grouped by ADO project, checkbox rows,
 *      local filter). 401/403 surfaces an inline "Invalid PAT or insufficient
 *      permissions" with a retry back to the connect step.
 *
 * On confirm we build the canonical `AzureDevOpsRepo[]` (the discovery helper
 * already returns `dev.azure.com/{org}/{project}/_git/{repo}` URLs). If a
 * `projectId` is present (existing-flow or post-create new-flow) we create one
 * `ProjectRepositoryIntegration` per repo via the EXISTING
 * `repositoryIntegrations.connect` procedure before calling `onConfirm`. If no
 * `projectId` is present (pre-create new-flow), we just emit
 * `onConfirm(repos, creds)` and let the wizard call `connect` after `create`.
 *
 * SECURITY: the PAT lives ONLY in component state — it is never written to
 * sessionStorage and never logged. The wizard receives it via `onConfirm` so it
 * can complete the post-create `connect` calls, and is responsible for keeping
 * it out of any persisted snapshot (see spec §6).
 *
 * DESIGN: design-system tokens only (`bg-card`, `bg-muted`, `border-foreground/10`,
 * `text-muted-foreground`, `--primary` for active state). No hardcoded hex, no
 * gradient tiles, no glassmorphism — distinct from the legacy GitHub/GitLab
 * cards (judgment-call (c)). Motion is `motion-safe:` gated.
 */

import type { AzureDevOpsRepo } from "@repo/connectors";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	FolderIcon,
	Loader2Icon,
	LockIcon,
	SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

export type { AzureDevOpsRepo } from "@repo/connectors";

/** Azure DevOps brand glyph — shared with the Settings form / wizard card. */
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

interface RepoGroup {
	/** The owning ADO project (the "owner" bucket). */
	owner: string;
	repos: AzureDevOpsRepo[];
}

export interface AzureDevOpsPatRepoPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string | null;
	/** Present in the existing-flow + post-create new-flow. When set, the picker
	 *  creates one `ProjectRepositoryIntegration` per selected repo on confirm. */
	projectId?: string;
	initialRepos?: AzureDevOpsRepo[];
	onConfirm: (
		repos: AzureDevOpsRepo[],
		creds?: {
			pat: string;
			azureOrganization: string;
		},
	) => void;
}

/** The two phases of the dialog. */
type Step = "connect" | "repos";

/**
 * Parse the ADO organization from a raw org name OR a full repo URL.
 *
 * Mirrors the Settings ADO PAT form: a `dev.azure.com/{org}/...` or legacy
 * `{org}.visualstudio.com/...` URL yields `{org}`; anything without a slash or
 * dot is treated as a bare org name. Returns `null` when the value looks like a
 * URL but no org segment can be extracted.
 */
function parseAzureOrganization(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const looksLikeUrl =
		trimmed.includes("/") ||
		trimmed.includes("dev.azure.com") ||
		trimmed.includes("visualstudio.com");

	if (!looksLikeUrl) {
		// Bare organization name (e.g. "my-org").
		return trimmed;
	}

	const adoMatch = trimmed.match(/dev\.azure\.com\/([^/]+)/i);
	if (adoMatch) {
		return decodeURIComponent(adoMatch[1]);
	}

	const legacyMatch = trimmed.match(/\/\/([^.]+)\.visualstudio\.com/i);
	if (legacyMatch) {
		return legacyMatch[1];
	}

	return null;
}

export function AzureDevOpsPatRepoPicker({
	open,
	onOpenChange,
	organizationId,
	projectId,
	initialRepos,
	onConfirm,
}: AzureDevOpsPatRepoPickerProps) {
	// ── Connect-step state ───────────────────────────────────────────
	const [step, setStep] = useState<Step>("connect");
	const [pat, setPat] = useState("");
	const [organizationInput, setOrganizationInput] = useState("");
	// The org actually used for discovery + emitted in `onConfirm` creds.
	const [azureOrganization, setAzureOrganization] = useState("");
	const [connectError, setConnectError] = useState<string | null>(null);
	const [roleTagInput, setRoleTagInput] = useState("");

	// ── Discovery + list-step state ──────────────────────────────────
	const [isLoading, setIsLoading] = useState(false);
	const [groups, setGroups] = useState<RepoGroup[]>([]);
	const [listError, setListError] = useState<string | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		new Set(),
	);

	// ── Confirm state ────────────────────────────────────────────────
	const [isConnecting, setIsConnecting] = useState(false);
	const [confirmError, setConfirmError] = useState<string | null>(null);

	// Reset everything each time the dialog opens.
	useEffect(() => {
		if (open) {
			setStep("connect");
			setPat("");
			setOrganizationInput("");
			setAzureOrganization("");
			setConnectError(null);
			setIsLoading(false);
			setGroups([]);
			setListError(null);
			setSearchQuery("");
			setExpandedGroups(new Set());
			setIsConnecting(false);
			setConfirmError(null);
			// Pre-select any initial repos by their canonical URL.
			setSelectedRepos(
				new Set((initialRepos ?? []).map((repo) => repo.fullName)),
			);
		}
	}, [open, initialRepos]);

	const fetchRepos = async (org: string) => {
		setIsLoading(true);
		setListError(null);
		setConnectError(null);
		try {
			const result = await orpcClient.projects.azureDevOps.listRepos({
				organizationId: organizationId ?? null,
				pat,
				azureOrganization: org,
				projectId: projectId ?? undefined,
			});

			const nextGroups: RepoGroup[] = result.groups ?? [];
			setGroups(nextGroups);
			setStep("repos");

			// "No repositories found" comes back as an error string with empty
			// groups — surface it inside the list view (not as a connect error).
			if (result.error && nextGroups.length === 0) {
				setListError(result.error);
			} else if (nextGroups.length > 0) {
				// Auto-expand the first project group for quicker selection.
				setExpandedGroups(new Set([nextGroups[0].owner]));
			}
		} catch (error) {
			// 401/403 throws `BAD_REQUEST` "Invalid PAT or insufficient
			// permissions" — show it on the connect step so the user can retry.
			setConnectError(
				error instanceof Error
					? error.message
					: "Invalid PAT or insufficient permissions",
			);
		} finally {
			setIsLoading(false);
		}
	};

	const handleConnect = () => {
		const org = parseAzureOrganization(organizationInput);
		if (!org) {
			setConnectError(
				"Enter an organization or a dev.azure.com repo URL.",
			);
			return;
		}
		if (!pat.trim()) {
			setConnectError("Enter a personal access token.");
			return;
		}
		setAzureOrganization(org);
		void fetchRepos(org);
	};

	const filteredGroups = useMemo(() => {
		if (!searchQuery.trim()) {
			return groups;
		}
		const query = searchQuery.toLowerCase().trim();
		return groups
			.map((group) => ({
				...group,
				repos: group.repos.filter(
					(repo) =>
						repo.name.toLowerCase().includes(query) ||
						repo.projectName.toLowerCase().includes(query),
				),
			}))
			.filter((group) => group.repos.length > 0);
	}, [groups, searchQuery]);

	const toggleRepo = (fullName: string) => {
		setSelectedRepos((prev) => {
			const next = new Set(prev);
			if (next.has(fullName)) {
				next.delete(fullName);
			} else {
				next.add(fullName);
			}
			return next;
		});
	};

	const toggleGroupExpanded = (owner: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(owner)) {
				next.delete(owner);
			} else {
				next.add(owner);
			}
			return next;
		});
	};

	const selectedCountForGroup = (group: RepoGroup): number =>
		group.repos.filter((repo) => selectedRepos.has(repo.fullName)).length;

	const handleConfirm = async () => {
		const allRepos = groups.flatMap((group) => group.repos);
		const selected = allRepos.filter((repo) =>
			selectedRepos.has(repo.fullName),
		);
		if (selected.length === 0) {
			return;
		}

		const creds = {
			pat,
			azureOrganization,
		};

		const tag = roleTagInput.trim() || undefined;
		const selectedWithTag = selected.map((r) => ({
			...r,
			...(tag ? { roleTag: tag } : {}),
		}));

		// Pre-create new-flow (no projectId): defer `connect` to the wizard.
		if (!projectId) {
			onConfirm(selectedWithTag, creds);
			onOpenChange(false);
			return;
		}

		// Existing-flow / post-create new-flow: create one integration per repo
		// via the existing `connect` procedure before emitting onConfirm.
		setIsConnecting(true);
		setConfirmError(null);
		const failed: Array<{ name: string; reason: string }> = [];
		for (const repo of selected) {
			try {
				await orpcClient.projects.repositoryIntegrations.connect({
					projectId,
					organizationId: organizationId ?? null,
					provider: "AZURE_DEVOPS",
					authMethod: "PAT",
					repositoryUrl: repo.htmlUrl,
					repositoryOwner: azureOrganization,
					repositoryName: repo.name,
					defaultBranch: repo.defaultBranch,
					pat,
					azureOrganization,
					roleTag: tag,
				});
			} catch (err: unknown) {
				if ((err as { code?: string })?.code === "CONFLICT") {
					// Already connected is considered a success — keep in selection
					continue;
				}
				// Keep going on partial failure — report which repos failed along with the reason
				const reason =
					err instanceof Error ? err.message : "connection failed";
				failed.push({ name: repo.name, reason });
			}
		}
		setIsConnecting(false);

		if (failed.length > 0) {
			const details = failed
				.map((f) => `${f.name} (${f.reason})`)
				.join(", ");
			const errorMsg = `Could not connect: ${details}. The other repositories were connected.`;
			const failedNames = new Set(failed.map((f) => f.name));
			const connected = selectedWithTag.filter(
				(repo) => !failedNames.has(repo.name),
			);
			if (connected.length === 0) {
				// Nothing connected — keep the dialog open so the user can retry.
				setConfirmError(errorMsg);
				return;
			}
			toast.warning(errorMsg);
			onConfirm(connected, undefined);
			onOpenChange(false);
			return;
		}

		onConfirm(selectedWithTag, undefined);
		onOpenChange(false);
	};

	const totalFilteredRepos = filteredGroups.reduce(
		(sum, group) => sum + group.repos.length,
		0,
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
				<DialogHeader className="shrink-0">
					<DialogTitle className="flex items-center gap-2">
						<AzureDevOpsIcon className="size-5" />
						Select Azure DevOps Repositories
					</DialogTitle>
					<DialogDescription>
						{step === "connect"
							? "Enter a read-only personal access token and your organization to browse repositories."
							: `Select repositories from ${azureOrganization}.`}
					</DialogDescription>
				</DialogHeader>

				{/* ── Loading ──────────────────────────────────────── */}
				{isLoading && (
					<div className="flex flex-col items-center justify-center gap-3 py-12">
						<Loader2Icon className="size-6 text-muted-foreground motion-safe:animate-spin" />
						<p className="text-sm text-muted-foreground">
							Connecting to Azure DevOps...
						</p>
					</div>
				)}

				{/* ── Connect step ─────────────────────────────────── */}
				{!isLoading && step === "connect" && (
					<div className="flex flex-col gap-4 rounded-lg border border-foreground/10 bg-card p-4">
						<div className="space-y-1.5">
							<Label htmlFor="ado-organization">
								Organization or repository URL
							</Label>
							<Input
								id="ado-organization"
								placeholder="my-organization or https://dev.azure.com/org/project/_git/repo"
								value={organizationInput}
								onChange={(event) => {
									setOrganizationInput(event.target.value);
									setConnectError(null);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										handleConnect();
									}
								}}
								className="font-mono text-sm"
							/>
						</div>

						<div className="space-y-1.5">
							<Label htmlFor="ado-pat">
								Personal access token (read-only scope)
							</Label>
							<Input
								id="ado-pat"
								type="password"
								placeholder="Paste your PAT here"
								value={pat}
								onChange={(event) => {
									setPat(event.target.value);
									setConnectError(null);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										handleConnect();
									}
								}}
								className="font-mono text-sm"
							/>
							<p className="text-xs text-muted-foreground">
								Generate a PAT in Azure DevOps with{" "}
								<strong>Code (Read)</strong> scope.
							</p>
						</div>

						{connectError && (
							<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
								<AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
								<span>{connectError}</span>
							</div>
						)}
					</div>
				)}

				{/* ── Repo list step ───────────────────────────────── */}
				{!isLoading && step === "repos" && (
					<div className="flex min-h-0 flex-1 flex-col gap-3">
						{/* Local filter */}
						{groups.length > 0 && (
							<div className="relative shrink-0">
								<SearchIcon className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground" />
								<Input
									placeholder="Filter repositories..."
									value={searchQuery}
									onChange={(event) =>
										setSearchQuery(event.target.value)
									}
									className="pl-10"
								/>
							</div>
						)}

						{/* List area */}
						<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-foreground/10 bg-card">
							{groups.length === 0 ? (
								<div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
									<AlertCircleIcon className="size-8 opacity-50" />
									<p className="font-medium">
										{listError ??
											"No repositories found in this organization."}
									</p>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setStep("connect")}
									>
										Back
									</Button>
								</div>
							) : filteredGroups.length === 0 ? (
								<div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
									<SearchIcon className="size-8 opacity-50" />
									<p className="font-medium">
										No repositories match your filter
									</p>
								</div>
							) : (
								<div className="space-y-1 p-1">
									{filteredGroups.map((group) => {
										const isExpanded = expandedGroups.has(
											group.owner,
										);
										const selectedCount =
											selectedCountForGroup(group);

										return (
											<div
												key={group.owner}
												className="rounded-lg border border-foreground/10"
											>
												{/* Group header */}
												<button
													type="button"
													onClick={() =>
														toggleGroupExpanded(
															group.owner,
														)
													}
													className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-muted"
												>
													{isExpanded ? (
														<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />
													) : (
														<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
													)}
													<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
													<span className="truncate font-medium text-sm">
														{group.owner}
													</span>
													<span className="ml-auto flex items-center gap-2">
														{selectedCount > 0 && (
															<span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-primary text-xs">
																{selectedCount}
															</span>
														)}
														<span className="shrink-0 text-muted-foreground text-xs">
															{group.repos.length}{" "}
															repo
															{group.repos
																.length !== 1
																? "s"
																: ""}
														</span>
													</span>
												</button>

												{/* Expanded repo rows */}
												{isExpanded && (
													<div className="space-y-0.5 border-foreground/10 border-t px-2 py-1.5">
														{group.repos.map(
															(repo) => {
																const isSelected =
																	selectedRepos.has(
																		repo.fullName,
																	);
																return (
																	// biome-ignore lint/a11y/useSemanticElements: row contains a nested Checkbox; nesting <button> inside <button> is invalid HTML
																	<div
																		key={
																			repo.fullName
																		}
																		role="button"
																		tabIndex={
																			0
																		}
																		aria-pressed={
																			isSelected
																		}
																		onClick={() =>
																			toggleRepo(
																				repo.fullName,
																			)
																		}
																		onKeyDown={(
																			event,
																		) => {
																			if (
																				event.key ===
																					"Enter" ||
																				event.key ===
																					" "
																			) {
																				event.preventDefault();
																				toggleRepo(
																					repo.fullName,
																				);
																			}
																		}}
																		className={cn(
																			"flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
																			isSelected
																				? "bg-primary/10"
																				: "hover:bg-muted",
																		)}
																	>
																		<Checkbox
																			checked={
																				isSelected
																			}
																			onCheckedChange={() =>
																				toggleRepo(
																					repo.fullName,
																				)
																			}
																			onClick={(
																				event,
																			) =>
																				event.stopPropagation()
																			}
																			aria-label={`Select ${repo.name}`}
																		/>
																		<LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
																		<div className="min-w-0 flex-1">
																			<span className="truncate font-medium text-sm">
																				{
																					repo.name
																				}
																			</span>
																			<p className="mt-0.5 line-clamp-1 text-muted-foreground text-xs">
																				{
																					repo.projectName
																				}
																			</p>
																		</div>
																	</div>
																);
															},
														)}
													</div>
												)}
											</div>
										);
									})}
								</div>
							)}
						</div>

						{filteredGroups.length > 0 && (
							<div className="flex shrink-0 items-center justify-between text-muted-foreground text-xs">
								<span>
									{totalFilteredRepos} repositor
									{totalFilteredRepos === 1 ? "y" : "ies"}
									{searchQuery.trim()
										? " matching filter"
										: ""}
								</span>
								<span>{selectedRepos.size} selected</span>
							</div>
						)}

						{confirmError && (
							<div className="flex shrink-0 items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
								<AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
								<span>{confirmError}</span>
							</div>
						)}
					</div>
				)}

				<DialogFooter className="shrink-0 border-foreground/10 border-t pt-4 flex items-center justify-between gap-3">
					{step === "repos" && (
						<Input
							type="text"
							placeholder="Role tag (e.g. Legacy)"
							className="h-9 text-xs w-48"
							maxLength={50}
							value={roleTagInput}
							onChange={(e) => setRoleTagInput(e.target.value)}
						/>
					)}
					<div className="flex items-center gap-2 ml-auto">
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isConnecting}
						>
							Cancel
						</Button>
						{step === "connect" ? (
							<Button
								onClick={handleConnect}
								disabled={
									isLoading ||
									!pat.trim() ||
									!organizationInput.trim()
								}
								className="gap-2"
							>
								<AzureDevOpsIcon className="size-4" />
								Connect
							</Button>
						) : (
							<Button
								onClick={handleConfirm}
								disabled={
									selectedRepos.size === 0 || isConnecting
								}
								className="gap-2"
							>
								{isConnecting ? (
									<Loader2Icon className="size-4 motion-safe:animate-spin" />
								) : (
									<AzureDevOpsIcon className="size-4" />
								)}
								{selectedRepos.size > 0
									? `Add ${selectedRepos.size} Repo${selectedRepos.size !== 1 ? "s" : ""}`
									: "Select Repositories"}
							</Button>
						)}
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
