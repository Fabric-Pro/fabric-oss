"use client";

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
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
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	BuildingIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	GitForkIcon,
	GithubIcon,
	GlobeIcon,
	Loader2Icon,
	LockIcon,
	PlusIcon,
	SearchIcon,
	StarIcon,
	UserIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface GitHubRepo {
	name: string;
	fullName: string;
	description: string | null;
	isPrivate: boolean;
	htmlUrl: string;
	language: string | null;
	defaultBranch: string;
	updatedAt: string;
	stars: number;
	isFork: boolean;
	owner: string;
	roleTag?: string | null;
}

interface RepoGroup {
	owner: string;
	ownerType: "user" | "org";
	repos: GitHubRepo[];
}

interface GitHubRepoPickerProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string | null;
	onConfirm: (repos: GitHubRepo[]) => void;
	initialRepos?: GitHubRepo[];
	/** When provided, uses project-level shared credentials if the user has no personal GitHub connection */
	projectId?: string;
}

const LANGUAGE_COLORS: Record<string, string> = {
	TypeScript: "bg-blue-500",
	JavaScript: "bg-yellow-400",
	Python: "bg-green-500",
	Rust: "bg-orange-600",
	Go: "bg-cyan-500",
	Java: "bg-red-500",
	"C#": "bg-purple-500",
	"C++": "bg-pink-500",
	Ruby: "bg-red-600",
	Swift: "bg-orange-500",
	Kotlin: "bg-violet-500",
	PHP: "bg-indigo-400",
	Dart: "bg-teal-500",
	Scala: "bg-red-400",
};

function formatUpdatedDate(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

	if (diffDays === 0) {
		return "today";
	}
	if (diffDays === 1) {
		return "yesterday";
	}
	if (diffDays < 30) {
		return `${diffDays}d ago`;
	}
	if (diffDays < 365) {
		return `${Math.floor(diffDays / 30)}mo ago`;
	}
	return `${Math.floor(diffDays / 365)}y ago`;
}

export function GitHubRepoPicker({
	open,
	onOpenChange,
	organizationId,
	onConfirm,
	initialRepos,
	projectId,
}: GitHubRepoPickerProps) {
	const integrationsPathRaw = useContextPath("settings/integrations");
	const buildReturnUrl = useSettingsReturnUrl();
	const integrationsPath = buildReturnUrl(integrationsPathRaw);
	const [groups, setGroups] = useState<RepoGroup[]>([]);
	const [username, setUsername] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isConfigured, setIsConfigured] = useState(true);
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set());
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
		new Set(),
	);
	const [orgSearchValue, setOrgSearchValue] = useState("");
	const [isSearchingOrg, setIsSearchingOrg] = useState(false);
	const [orgSearchError, setOrgSearchError] = useState<string | null>(null);
	const [hasLoaded, setHasLoaded] = useState(false);
	const [roleTagInput, setRoleTagInput] = useState("");

	const fetchRepos = async () => {
		setIsLoading(true);
		setError(null);
		try {
			const result = await orpcClient.projects.github.listRepos({
				organizationId: organizationId ?? null,
				projectId: projectId ?? undefined,
			});

			if (!result.configured) {
				setIsConfigured(false);
				setGroups([]);
				return;
			}

			if (
				result.error &&
				(!result.groups || result.groups.length === 0)
			) {
				setError(result.error);
				setGroups([]);
				return;
			}

			setIsConfigured(true);
			setUsername(result.username ?? null);
			setGroups(result.groups ?? []);
			setHasLoaded(true);

			// Auto-expand first group
			if (result.groups && result.groups.length > 0) {
				setExpandedGroups(new Set([result.groups[0].owner]));
			}
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to load repositories",
			);
		} finally {
			setIsLoading(false);
		}
	};

	const searchOrgRepos = async (orgName: string) => {
		if (!orgName.trim()) {
			return;
		}

		// Check if org is already loaded
		if (
			groups.some(
				(g) => g.owner.toLowerCase() === orgName.trim().toLowerCase(),
			)
		) {
			setOrgSearchError(`"${orgName.trim()}" is already loaded.`);
			return;
		}

		setIsSearchingOrg(true);
		setOrgSearchError(null);
		try {
			const result = await orpcClient.projects.github.listRepos({
				organizationId: organizationId ?? null,
				searchOrg: orgName.trim(),
				projectId: projectId ?? undefined,
			});

			if (result.error) {
				setOrgSearchError(result.error);
				return;
			}

			if (result.groups && result.groups.length > 0) {
				setGroups((prev) => [...prev, ...result.groups]);
				setExpandedGroups((prev) => {
					const next = new Set(prev);
					for (const g of result.groups) {
						next.add(g.owner);
					}
					return next;
				});
				setOrgSearchValue("");
				if (result.username && !username) {
					setUsername(result.username);
				}
			} else {
				setOrgSearchError(
					`No repositories found for "${orgName.trim()}".`,
				);
			}
		} catch (err) {
			setOrgSearchError(
				err instanceof Error
					? err.message
					: "Failed to search organization",
			);
		} finally {
			setIsSearchingOrg(false);
		}
	};

	useEffect(() => {
		if (open) {
			setSearchQuery("");
			setOrgSearchValue("");
			setOrgSearchError(null);
			setHasLoaded(false);
			// Initialize selection from initialRepos
			const initial = new Set(
				(initialRepos ?? []).map((r) => r.fullName),
			);
			setSelectedRepos(initial);
			fetchRepos();
		}
	}, [open]);

	const filteredGroups = useMemo(() => {
		if (!searchQuery.trim()) {
			return groups;
		}
		const q = searchQuery.toLowerCase().trim();
		return groups
			.map((group) => ({
				...group,
				repos: group.repos.filter(
					(repo) =>
						repo.name.toLowerCase().includes(q) ||
						repo.fullName.toLowerCase().includes(q) ||
						repo.description?.toLowerCase().includes(q),
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

	const selectedCountForGroup = (group: RepoGroup): number => {
		return group.repos.filter((r) => selectedRepos.has(r.fullName)).length;
	};

	const handleConfirm = () => {
		const allRepos = groups.flatMap((g) => g.repos);
		const selected = allRepos.filter((r) => selectedRepos.has(r.fullName));
		if (selected.length > 0) {
			const tag = roleTagInput.trim() || undefined;
			const reposWithTag = selected.map((r) => ({
				...r,
				...(tag ? { roleTag: tag } : {}),
			}));
			onConfirm(reposWithTag);
			onOpenChange(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[80vh] max-w-2xl flex-col overflow-hidden">
				<DialogHeader className="shrink-0">
					<DialogTitle className="flex items-center gap-2">
						<GithubIcon className="size-5" />
						Select GitHub Repositories
					</DialogTitle>
					<DialogDescription>
						Search for your GitHub organization to browse its
						repositories.
					</DialogDescription>
				</DialogHeader>

				{isLoading && (
					<div className="flex flex-col items-center justify-center gap-3 py-12">
						<Loader2Icon className="size-6 animate-spin text-muted-foreground" />
						<p className="text-sm text-muted-foreground">
							Connecting to GitHub...
						</p>
					</div>
				)}

				{!isLoading && !isConfigured && (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="rounded-full bg-amber-500/10 p-4">
							<AlertCircleIcon className="size-8 text-highlight" />
						</div>
						<div>
							<p className="font-medium text-foreground/70">
								GitHub Not Connected
							</p>
							<p className="mt-1 text-sm text-foreground/50">
								Connect GitHub in Integrations to browse and
								select repositories for this project.
							</p>
						</div>
						<Button asChild variant="outline">
							<a href={integrationsPath} className="gap-2">
								<ExternalLinkIcon className="size-4" />
								Go to Integrations
							</a>
						</Button>
					</div>
				)}

				{!isLoading &&
					isConfigured &&
					error &&
					groups.length === 0 &&
					!hasLoaded && (
						<div className="flex flex-col items-center gap-4 py-8 text-center">
							<div className="rounded-full bg-destructive/10 p-4">
								<AlertCircleIcon className="size-8 text-destructive" />
							</div>
							<div>
								<p className="font-medium text-foreground/70">
									Failed to load repositories
								</p>
								<p className="mt-1 text-sm text-foreground/50">
									{error}
								</p>
							</div>
							<Button variant="outline" onClick={fetchRepos}>
								Try Again
							</Button>
						</div>
					)}

				{!isLoading &&
					isConfigured &&
					(hasLoaded || groups.length > 0) && (
						<div className="flex min-h-0 flex-1 flex-col gap-3">
							{/* Organization Search */}
							<div className="shrink-0 space-y-2">
								<div className="flex gap-2">
									<div className="relative flex-1">
										<BuildingIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
										<Input
											placeholder="Enter organization name (e.g. Fabric-Pro)..."
											value={orgSearchValue}
											onChange={(e) => {
												setOrgSearchValue(
													e.target.value,
												);
												setOrgSearchError(null);
											}}
											onKeyDown={(e) => {
												if (e.key === "Enter") {
													searchOrgRepos(
														orgSearchValue,
													);
												}
											}}
											className="pl-10"
											disabled={isSearchingOrg}
										/>
									</div>
									<Button
										variant="outline"
										size="default"
										onClick={() =>
											searchOrgRepos(orgSearchValue)
										}
										disabled={
											!orgSearchValue.trim() ||
											isSearchingOrg
										}
										className="gap-1.5 shrink-0"
									>
										{isSearchingOrg ? (
											<Loader2Icon className="size-4 animate-spin" />
										) : (
											<PlusIcon className="size-4" />
										)}
										Add Org
									</Button>
								</div>
								{orgSearchError && (
									<p className="text-xs text-destructive">
										{orgSearchError}
									</p>
								)}
							</div>

							{/* Filter repos (local) */}
							{groups.length > 0 && (
								<div className="relative shrink-0">
									<SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
									<Input
										placeholder="Filter repositories..."
										value={searchQuery}
										onChange={(e) =>
											setSearchQuery(e.target.value)
										}
										className="pl-10"
									/>
								</div>
							)}

							{/* Repo List */}
							<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
								{groups.length === 0 ? (
									<div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
										<BuildingIcon className="size-8 opacity-50" />
										<p className="font-medium">
											Search for an organization above
										</p>
										<p className="text-center text-xs">
											Type your GitHub organization name
											and press Enter or click "Add Org"
										</p>
									</div>
								) : filteredGroups.length === 0 ? (
									<div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
										<SearchIcon className="size-8 opacity-50" />
										<p className="font-medium">
											No repositories match your filter
										</p>
										<p className="text-center text-xs">
											Try a different search term
										</p>
									</div>
								) : (
									<div className="space-y-1 p-1">
										{filteredGroups.map((group) => {
											const isExpanded =
												expandedGroups.has(group.owner);
											const selectedCount =
												selectedCountForGroup(group);

											return (
												<div
													key={group.owner}
													className="rounded-lg border"
												>
													{/* Group Header */}
													<button
														type="button"
														onClick={() =>
															toggleGroupExpanded(
																group.owner,
															)
														}
														className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-accent/50"
													>
														{isExpanded ? (
															<ChevronDownIcon className="size-4 shrink-0 text-foreground/50" />
														) : (
															<ChevronRightIcon className="size-4 shrink-0 text-foreground/50" />
														)}
														{group.ownerType ===
														"user" ? (
															<UserIcon className="size-4 shrink-0 text-foreground/50" />
														) : (
															<BuildingIcon className="size-4 shrink-0 text-foreground/50" />
														)}
														<span className="truncate font-medium text-sm">
															{group.owner}
														</span>
														{group.ownerType ===
															"user" &&
															username ===
																group.owner && (
																<span className="text-xs text-muted-foreground">
																	(You)
																</span>
															)}
														<span className="ml-auto flex items-center gap-2">
															{selectedCount >
																0 && (
																<span className="rounded-full bg-primary/20 px-1.5 py-0.5 text-primary text-xs">
																	{
																		selectedCount
																	}
																</span>
															)}
															<span className="shrink-0 text-foreground/40 text-xs">
																{
																	group.repos
																		.length
																}{" "}
																repo
																{group.repos
																	.length !==
																1
																	? "s"
																	: ""}
															</span>
														</span>
													</button>

													{/* Expanded Repo List */}
													{isExpanded && (
														<div className="space-y-0.5 border-t px-2 py-1.5">
															{group.repos.map(
																(repo) => {
																	const isSelected =
																		selectedRepos.has(
																			repo.fullName,
																		);
																	const langColor =
																		repo.language
																			? (LANGUAGE_COLORS[
																					repo
																						.language
																				] ??
																				"bg-gray-400")
																			: null;

																	return (
																		// biome-ignore lint/a11y/useSemanticElements: list row contains nested Checkbox; nesting <button> inside <button> is invalid HTML
																		<div
																			key={
																				repo.fullName
																			}
																			role="button"
																			tabIndex={
																				0
																			}
																			onClick={() =>
																				toggleRepo(
																					repo.fullName,
																				)
																			}
																			onKeyDown={(
																				e,
																			) => {
																				if (
																					e.key ===
																						"Enter" ||
																					e.key ===
																						" "
																				) {
																					e.preventDefault();
																					toggleRepo(
																						repo.fullName,
																					);
																				}
																			}}
																			className={cn(
																				"flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
																				isSelected
																					? "bg-primary/10"
																					: "hover:bg-accent/50",
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
																					e,
																				) =>
																					e.stopPropagation()
																				}
																				className="mt-0.5"
																			/>
																			<div className="mt-0.5 shrink-0">
																				{repo.isPrivate ? (
																					<LockIcon className="size-3.5 text-muted-foreground" />
																				) : (
																					<GlobeIcon className="size-3.5 text-muted-foreground" />
																				)}
																			</div>
																			<div className="min-w-0 flex-1">
																				<div className="flex items-center gap-2">
																					<span className="truncate font-medium text-sm">
																						{
																							repo.name
																						}
																					</span>
																					{repo.isFork && (
																						<GitForkIcon className="size-3.5 shrink-0 text-muted-foreground" />
																					)}
																				</div>
																				{repo.description && (
																					<p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
																						{
																							repo.description
																						}
																					</p>
																				)}
																				<div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
																					{repo.language &&
																						langColor && (
																							<span className="flex items-center gap-1">
																								<span
																									className={cn(
																										"inline-block size-2 rounded-full",
																										langColor,
																									)}
																								/>
																								{
																									repo.language
																								}
																							</span>
																						)}
																					{repo.stars >
																						0 && (
																						<span className="flex items-center gap-1">
																							<StarIcon className="size-3" />
																							{repo.stars.toLocaleString()}
																						</span>
																					)}
																					<span>
																						Updated{" "}
																						{formatUpdatedDate(
																							repo.updatedAt,
																						)}
																					</span>
																				</div>
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
								<div className="flex items-center justify-between shrink-0 text-xs text-muted-foreground">
									<span>
										{filteredGroups.reduce(
											(sum, g) => sum + g.repos.length,
											0,
										)}{" "}
										repositor
										{filteredGroups.reduce(
											(sum, g) => sum + g.repos.length,
											0,
										) === 1
											? "y"
											: "ies"}
										{searchQuery.trim()
											? " matching filter"
											: ""}
									</span>
									<span>{selectedRepos.size} selected</span>
								</div>
							)}
						</div>
					)}

				<DialogFooter className="shrink-0 border-t pt-4 flex items-center justify-between gap-3">
					<Input
						type="text"
						placeholder="Role tag (e.g. Legacy)"
						className="h-9 text-xs w-48"
						maxLength={50}
						value={roleTagInput}
						onChange={(e) => setRoleTagInput(e.target.value)}
					/>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							onClick={handleConfirm}
							disabled={selectedRepos.size === 0}
							className="gap-2"
						>
							<GithubIcon className="size-4" />
							{selectedRepos.size > 0
								? `Add ${selectedRepos.size} Repo${selectedRepos.size !== 1 ? "s" : ""}`
								: "Select Repositories"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
