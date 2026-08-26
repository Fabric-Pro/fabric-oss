"use client";

/**
 * Status bar for the Atlas tab.
 *
 * Surfaces what commit was analysed, how long ago, which branch is monitored
 * (editable via a searchable branch picker), and whether the analysis is stale
 * (new commits on the branch, or an incomparable history). Hosts the Analyse /
 * Re-analyse action, which is a split button: the primary click re-runs while
 * respecting manual node edits, the chevron opens "Re-analyse from fresh".
 *
 * Non-blocking re-analysis (R2): when a previously-READY analysis is being
 * re-run in the background, `status.activeRun` is set while `status.status`
 * stays READY — the served graph keeps rendering and this bar shows a small
 * "Analysing in background…" indicator (with elapsed time) instead of blanking
 * the view. A first-ever build keeps `status.status` PENDING/ANALYZING and is
 * driven by the full-screen analysing state upstream.
 *
 * Credential states are server-computed: `getStatus` already attempts a
 * refresh for refreshable integrations, so a non-ACTIVE `repositoryStatus`
 * here means "a refresh was attempted (or is impossible) and failed". The bar
 * then shows an actionable chip + Reconnect button that deep-links to the
 * repository connection settings, and the commit indicator slot switches to a
 * "monitoring paused" notice instead of silently disappearing:
 *
 * - `canAutoRefreshCredentials` true (GitHub OAuth with a stored refresh
 *   token): Re-analyse stays enabled — clicking retries the refresh
 *   server-side and only fails with the specific re-auth error.
 * - PAT-based integrations: Re-analyse is disabled (a PAT can never refresh
 *   itself) with token-specific guidance.
 * - OAuth without a refresh path: Re-analyse is disabled with reconnect
 *   guidance.
 * - DISCONNECTED keeps the previous behaviour: the map stays viewable,
 *   re-analysis is blocked, and reconnecting happens by re-adding the repo.
 */
import type { AtlasStatus, RepoBranch, RepoOption } from "@repo/atlas/types";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@ui/components/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	CheckIcon,
	ChevronDownIcon,
	GitBranchIcon,
	GitCommitHorizontalIcon,
	HistoryIcon,
	Loader2Icon,
	PauseCircleIcon,
	PencilIcon,
	PinIcon,
	RefreshCwIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { navigateToProjectSettingsTab } from "../settings-tab-navigation";
import { AtlasHistoryPanel } from "./AtlasHistoryPanel";
import { AtlasRepoSelector } from "./AtlasRepoSelector";
import { formatRelativeTime, isAnalysisInFlight } from "./atlas-utils";

interface AtlasStatusBarProps {
	projectId: string;
	status: AtlasStatus;
	/**
	 * Start (or re-run) an analysis. `fresh: true` ignores the user's manual
	 * node edits and rebuilds from scratch; the default respects them.
	 */
	onAnalyze: (options?: { fresh?: boolean }) => void;
	isAnalyzing: boolean;
	/** Whether the analysis-history panel is currently open. */
	showHistory?: boolean;
	/**
	 * Toggle the analysis-history panel. History is a page-level action, so it
	 * sits beside Re-analyse here. When omitted, the History button is hidden.
	 */
	onToggleHistory?: () => void;
	/**
	 * Override the contents of the history popover. The status bar owns the
	 * History toggle button + popover chrome, but the SYSTEM view swaps in the
	 * cross-repo relationship history instead of the per-repo analysis history.
	 * When omitted, the default per-repo `AtlasHistoryPanel` is used.
	 */
	historyPanel?: React.ReactNode;
	/**
	 * Analysable repositories for this project. The first item in the status
	 * bar's left cluster is a compact repository dropdown — shown even for a
	 * single repo (as the labelled analysis source). When empty, the bar falls
	 * back to `status.repository` so the source is still surfaced.
	 */
	repositories?: RepoOption[];
	/** Currently scoped repository integration id (null = project default). */
	repositoryIntegrationId?: string | null;
	/** Switch the analysed source repository (persisted upstream). */
	onRepoChange?: (repositoryIntegrationId: string | null) => void;
	/** Disable the repo dropdown (e.g. while an analysis request is pending). */
	repoChangeDisabled?: boolean;
}

/**
 * Credential affordance derived from the server-computed status. "ok" also
 * covers "no repository at all" (`repositoryStatus` null).
 */
type CredentialState =
	| "ok"
	| "reconnectable"
	| "patExpired"
	| "reconnectNeeded"
	| "repoUnavailable"
	| "disconnected";

function deriveCredentialState(status: AtlasStatus): CredentialState {
	const repoStatus = status.repositoryStatus;
	if (repoStatus == null || repoStatus === "ACTIVE") {
		return "ok";
	}
	if (repoStatus === "DISCONNECTED") {
		return "disconnected";
	}
	// The credential is fine but cannot read THIS repository — reconnecting
	// refreshes the wrong grant, so this state must not offer a Reconnect CTA.
	if (repoStatus === "REPO_UNAVAILABLE") {
		return "repoUnavailable";
	}
	// The server is the only authority on refreshability — never guess from
	// the provider alone.
	if (status.canAutoRefreshCredentials) {
		return "reconnectable";
	}
	if (status.repository?.authMethod === "PAT") {
		return "patExpired";
	}
	return "reconnectNeeded";
}

type BranchErrorKey =
	| "branchErrorNotFound"
	| "branchErrorCredentials"
	| "branchErrorNetwork"
	| "branchErrorGeneric";

/**
 * Map a failed branch save to the matching inline-error copy. The server
 * tags each failure with a structured marker (`error.data.code`) — branch
 * missing on the remote, unusable credentials, disconnected integration,
 * remote unreachable. Message heuristics keep the mapping working when the
 * structured marker is unavailable; anything unrecognised falls back to the
 * generic message.
 */
function mapBranchSaveErrorKey(error: unknown): BranchErrorKey {
	const code = (error as { code?: unknown } | null)?.code;
	const dataCode = (error as { data?: { code?: unknown } } | null)?.data
		?.code;
	if (dataCode === "BRANCH_NOT_FOUND") {
		return "branchErrorNotFound";
	}
	if (
		dataCode === "REPOSITORY_CREDENTIALS_EXPIRED" ||
		dataCode === "REPOSITORY_DISCONNECTED"
	) {
		return "branchErrorCredentials";
	}
	if (dataCode === "REPOSITORY_UNREACHABLE") {
		return "branchErrorNetwork";
	}
	const message =
		error instanceof Error ? error.message : String(error ?? "");
	if (
		/branch/i.test(message) &&
		/not\s+found|wasn'?t\s+found|doesn'?t\s+exist|does\s+not\s+exist/i.test(
			message,
		)
	) {
		return "branchErrorNotFound";
	}
	if (
		/credential|token|reconnect|re-?authenticat|unauthori[sz]ed|expired|disconnected/i.test(
			message,
		)
	) {
		return "branchErrorCredentials";
	}
	if (
		code === "INTERNAL_SERVER_ERROR" ||
		/reach|network|unavailable|timed?\s*out|upstream|unreachable/i.test(
			message,
		)
	) {
		return "branchErrorNetwork";
	}
	return "branchErrorGeneric";
}

/**
 * Compact elapsed formatter for the background-run indicator: whole seconds
 * under a minute, then "{m}m {s}s", then "{h}h {m}m". Ticks cleanly on a
 * 1s interval without the jittery sub-second decimals of `formatDuration`.
 */
function formatElapsedCompact(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${totalSeconds % 60}s`;
	}
	const hours = Math.floor(totalMinutes / 60);
	return `${hours}h ${totalMinutes % 60}m`;
}

/**
 * Non-blocking background-run chip. Isolated so its 1s elapsed tick re-renders
 * only this subtree, not the whole status bar (which hosts the branch picker /
 * re-analyse dropdown). Uses the emerald "AI-active" token.
 */
function BackgroundRunIndicator({
	startedAt,
	label,
}: {
	startedAt: string;
	label: string;
}) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);
	const elapsedMs = Math.max(0, now - new Date(startedAt).getTime());
	return (
		<span
			className="flex items-center gap-1.5 text-secondary"
			aria-live="polite"
		>
			<Loader2Icon
				aria-hidden="true"
				className="size-3.5 motion-safe:animate-spin"
			/>
			{label}
			<span className="text-muted-foreground tabular-nums">
				{formatElapsedCompact(elapsedMs)}
			</span>
		</span>
	);
}

export function AtlasStatusBar({
	projectId,
	status,
	onAnalyze,
	isAnalyzing,
	showHistory = false,
	onToggleHistory,
	historyPanel,
	repositories = [],
	repositoryIntegrationId = null,
	onRepoChange,
	repoChangeDisabled = false,
}: AtlasStatusBarProps) {
	const t = useTranslations("projects.atlas.status");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const branchInputId = useId();

	const [branchPopoverOpen, setBranchPopoverOpen] = useState(false);
	const [branchInput, setBranchInput] = useState("");
	const [branchFilter, setBranchFilter] = useState("");
	const [branchError, setBranchError] = useState<string | null>(null);

	const isAnalyzed = status.status === "READY" && !!status.analyzedShortSha;
	// A background re-run of an already-READY analysis: the served graph keeps
	// rendering and the bar shows a non-blocking indicator instead of blanking.
	const backgroundRun = status.activeRun ?? null;
	const backgroundRunActive = backgroundRun != null;
	const inFlight =
		isAnalysisInFlight(status.status) || isAnalyzing || backgroundRunActive;
	// Diffstat-style drift between the analysed snapshot and the branch tip:
	// ahead = commits on the tip not in the snapshot; behind = commits in the
	// snapshot no longer reachable from the tip (history rewritten). `behind`
	// is null when the provider can't compute it.
	const aheadCount =
		typeof status.newCommitCount === "number"
			? status.newCommitCount
			: null;
	const behindCount =
		typeof status.behindCommitCount === "number"
			? status.behindCommitCount
			: null;
	const hasAheadCommits = isAnalyzed && (aheadCount ?? 0) > 0;
	const hasBehindCommits = isAnalyzed && (behindCount ?? 0) > 0;
	const reanalyseRecommended =
		isAnalyzed &&
		!backgroundRunActive &&
		(status.commitsComparable === false ||
			hasAheadCommits ||
			hasBehindCommits);

	const credentialState = deriveCredentialState(status);
	// Credentials are unusable and no automatic recovery is left — commit
	// monitoring is paused until the user restores access (by reconnecting, or
	// for repoUnavailable, by granting the app access / re-adding with a PAT).
	const credentialsDead =
		credentialState === "reconnectable" ||
		credentialState === "patExpired" ||
		credentialState === "reconnectNeeded" ||
		credentialState === "repoUnavailable";
	const chipKey =
		credentialState === "patExpired"
			? ("patExpired" as const)
			: credentialState === "repoUnavailable"
				? ("repoUnavailable" as const)
				: ("reconnectNeeded" as const);
	// Re-analyse stays enabled while a refresh could still succeed
	// ("reconnectable" — the click retries it server-side); it is disabled
	// only when no refresh path exists.
	const reanalyzeDisabledKey =
		credentialState === "patExpired"
			? ("reanalyzeDisabledPat" as const)
			: credentialState === "repoUnavailable"
				? ("reanalyzeDisabledRepo" as const)
				: credentialState === "reconnectNeeded" ||
						credentialState === "disconnected"
					? ("reanalyzeDisabledReconnect" as const)
					: null;

	const integrationId = status.repository?.repositoryIntegrationId ?? null;
	const monitoredBranch = status.repository?.defaultBranch ?? "";
	// The monitored branch differs from the analysed one — the change applies
	// on the next analysis run (informational, deliberately not amber).
	const showReanalyzeHint =
		isAnalyzed &&
		!backgroundRunActive &&
		!!status.branch &&
		!!status.repository &&
		status.repository.defaultBranch !== status.branch;

	const relative = formatRelativeTime(status.analyzedAt);
	// Why is a re-analysis suggested? Either new commits exist, or the analysed
	// commit can no longer be compared to the branch head / commits were
	// removed from it (rewritten history) — the history wording wins whenever
	// snapshot commits disappeared from the branch.
	const recommendedReason =
		hasBehindCommits || !hasAheadCommits
			? t("reanalyzeReasonIncomparable")
			: t("reanalyzeReasonNewCommits", {
					count: aheadCount ?? 0,
					branch: status.branch ?? "",
				});

	// Compact `+N −M` indicator beside the analysed-commit chip. Hidden while
	// the history is incomparable (counts would be meaningless) and while
	// credentials are dead (the slot shows "monitoring paused" instead).
	const showCommitDiff =
		isAnalyzed &&
		status.commitsComparable !== false &&
		!credentialsDead &&
		(hasAheadCommits || hasBehindCommits);
	const commitDiffAriaLabel = [
		hasAheadCommits
			? t("commitDiffAriaAhead", { count: aheadCount ?? 0 })
			: null,
		hasBehindCommits
			? t("commitDiffAriaBehind", { count: behindCount ?? 0 })
			: null,
	]
		.filter(Boolean)
		.join(", ");

	// ── Branch picker (lazy-loaded on open) ─────────────────────────────────
	const branchListInput = {
		projectId,
		repositoryIntegrationId: integrationId,
		organizationId: organizationId ?? null,
	};
	const branchListQueryKey = orpc.atlas.branches.list.queryKey({
		input: branchListInput,
	});
	const branchesQuery = useQuery({
		...orpc.atlas.branches.list.queryOptions({
			input: branchListInput,
		}),
		// Only hit the live connector once the picker is actually opened.
		enabled: branchPopoverOpen,
	});

	// Default/main first, then pinned, then the rest (alpha within each tier).
	const sortedBranches = useMemo(() => {
		const list = branchesQuery.data?.branches ?? [];
		const tier = (b: RepoBranch) => (b.isDefault ? 0 : b.isPinned ? 1 : 2);
		return [...list].sort((a, b) => {
			const byTier = tier(a) - tier(b);
			return byTier !== 0 ? byTier : a.name.localeCompare(b.name);
		});
	}, [branchesQuery.data?.branches]);

	const trimmedFilter = branchFilter.trim();
	const filterMatchesBranch = sortedBranches.some(
		(b) => b.name === trimmedFilter,
	);
	// Preserve the ability to set ANY branch (e.g. a brand-new one not in the
	// listed page) — the free-text fallback the picker replaced could do that.
	const showCustomBranch = trimmedFilter.length > 0 && !filterMatchesBranch;

	const updateBranchMutation = useMutation(
		orpc.projects.repositoryIntegrations.updateBranch.mutationOptions({
			onSuccess: () => {
				// The status payload carries the monitored branch (and the
				// re-analyse hint depends on it); the repo list shows it too.
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.status.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.listRepositories.key(),
				});
				setBranchPopoverOpen(false);
				toast.success(t("branchSaved"));
			},
			onError: (error, variables) => {
				const code = (error as { code?: unknown } | null)?.code;
				if (code === "FORBIDDEN") {
					// Server-authoritative permission gate — same calm toast
					// pattern as the Re-analyse action.
					toast.error(t("branchErrorGeneric"), {
						description:
							error instanceof Error
								? error.message
								: String(error),
					});
					return;
				}
				const key = mapBranchSaveErrorKey(error);
				setBranchError(
					key === "branchErrorNotFound"
						? t("branchErrorNotFound", {
								branch: variables.branch,
							})
						: t(key),
				);
			},
		}),
	);

	// Replace the pinned-branches set (per project+repo). Optimistic on the
	// branch-list cache so the pin fills instantly; invalidate status afterwards
	// (repository.pinnedBranches feeds back into the bar).
	const setPinnedMutation = useMutation(
		orpc.atlas.branches.setPinned.mutationOptions({
			onMutate: async (variables: { branches: string[] }) => {
				await queryClient.cancelQueries({
					queryKey: branchListQueryKey,
				});
				const previous = queryClient.getQueryData(branchListQueryKey);
				queryClient.setQueryData(
					branchListQueryKey,
					(old: { branches: RepoBranch[] } | undefined) => {
						if (!old?.branches) {
							return old;
						}
						const pinned = new Set(variables.branches);
						return {
							...old,
							branches: old.branches.map((b) => ({
								...b,
								isPinned: pinned.has(b.name),
							})),
						};
					},
				);
				return { previous };
			},
			onError: (_error, _variables, context) => {
				const previous = (
					context as
						| { previous?: { branches: RepoBranch[] } | undefined }
						| undefined
				)?.previous;
				if (previous) {
					queryClient.setQueryData(branchListQueryKey, previous);
				}
				toast.error(t("branchPinError"));
			},
			onSettled: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.branches.list.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.status.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.listRepositories.key(),
				});
			},
		}),
	);

	// Switch-when-ready: snapshot the served commit when a background run
	// begins, and once it clears announce the result — but only when the
	// analysis actually advanced (commit moved, or a fresh re-run on the same
	// commit changed `analyzedAt`). The graph/overview already reflect the new
	// data via the polled refetch; this is just a calm "it's updated" nudge.
	const runStartRef = useRef<{
		sha: string | null;
		at: string | null;
	} | null>(null);
	const prevActiveRunRef = useRef(false);
	useEffect(() => {
		const isActive = status.activeRun != null;
		if (isActive && !prevActiveRunRef.current) {
			runStartRef.current = {
				sha: status.analyzedCommitSha,
				at: status.analyzedAt,
			};
		} else if (!isActive && prevActiveRunRef.current) {
			const start = runStartRef.current;
			const advanced =
				!!start &&
				((status.analyzedCommitSha != null &&
					status.analyzedCommitSha !== start.sha) ||
					(status.analyzedAt != null &&
						status.analyzedAt !== start.at));
			if (advanced && status.analyzedShortSha) {
				toast.success(
					t("backgroundRunUpdated", {
						sha: status.analyzedShortSha,
					}),
				);
			}
			runStartRef.current = null;
		}
		prevActiveRunRef.current = isActive;
	}, [
		status.activeRun,
		status.analyzedCommitSha,
		status.analyzedAt,
		status.analyzedShortSha,
		t,
	]);

	const handleReconnect = useCallback(() => {
		navigateToProjectSettingsTab(projectId, "development");
	}, [projectId]);

	const handleBranchPopoverOpenChange = useCallback(
		(open: boolean) => {
			setBranchPopoverOpen(open);
			if (open) {
				setBranchInput(monitoredBranch);
				setBranchFilter("");
				setBranchError(null);
			}
		},
		[monitoredBranch],
	);

	// Set the monitored branch from the picker (or the typed custom entry).
	const handleSelectBranch = useCallback(
		(name: string) => {
			const next = name.trim();
			if (!next || !integrationId || updateBranchMutation.isPending) {
				return;
			}
			if (next === monitoredBranch) {
				// Already monitored — nothing to save, just close.
				setBranchPopoverOpen(false);
				return;
			}
			setBranchError(null);
			updateBranchMutation.mutate({
				projectId,
				organizationId: organizationId ?? null,
				integrationId,
				branch: next,
			});
		},
		[
			integrationId,
			monitoredBranch,
			organizationId,
			projectId,
			updateBranchMutation,
		],
	);

	// Free-text fallback (shown only when the live branch list fails to load).
	const handleBranchSubmit = useCallback(
		(event: React.FormEvent) => {
			event.preventDefault();
			handleSelectBranch(branchInput);
		},
		[branchInput, handleSelectBranch],
	);

	const handleTogglePin = useCallback(
		(branch: RepoBranch) => {
			if (!integrationId || setPinnedMutation.isPending) {
				return;
			}
			const currentPins = sortedBranches
				.filter((b) => b.isPinned)
				.map((b) => b.name);
			const nextPins = branch.isPinned
				? currentPins.filter((name) => name !== branch.name)
				: [...currentPins, branch.name];
			setPinnedMutation.mutate({
				projectId,
				repositoryIntegrationId: integrationId,
				branches: nextPins,
				organizationId: organizationId ?? null,
			});
		},
		[
			integrationId,
			organizationId,
			projectId,
			setPinnedMutation,
			sortedBranches,
		],
	);

	// Repository dropdown options — the full analysable list when provided,
	// otherwise the resolved repository from `status` so the source is always
	// surfaced (shown even for a single repo as the labelled analysis source).
	const repoOptions: RepoOption[] =
		repositories.length > 0
			? repositories
			: status.repository
				? [status.repository]
				: [];

	// ── Left-cluster segments, in display order: repo · branch · commit ·
	// last-update · message. Each is built without a leading separator; the
	// renderer interleaves a subtle "·" between present segments.
	const repoSegment =
		repoOptions.length > 0 ? (
			<AtlasRepoSelector
				repositories={repoOptions}
				value={repositoryIntegrationId}
				onChange={onRepoChange ?? (() => {})}
				disabled={repoChangeDisabled}
			/>
		) : null;

	const branchSegment = status.branch ? (
		<span className="flex min-w-0 items-center gap-1">
			<GitBranchIcon
				aria-hidden="true"
				className="size-3.5 text-muted-foreground"
			/>
			<span className="truncate text-muted-foreground">
				{status.branch}
			</span>
			{integrationId && (
				<Popover
					open={branchPopoverOpen}
					onOpenChange={handleBranchPopoverOpenChange}
				>
					<Tooltip>
						<TooltipTrigger asChild>
							<PopoverTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									aria-label={t("editBranch")}
									className="size-6 text-muted-foreground hover:text-foreground"
								>
									<PencilIcon
										aria-hidden="true"
										className="size-3"
									/>
								</Button>
							</PopoverTrigger>
						</TooltipTrigger>
						<TooltipContent>{t("editBranch")}</TooltipContent>
					</Tooltip>
					<PopoverContent align="start" className="w-80 p-0">
						{branchesQuery.isError ? (
							// The live branch list failed — fall back to a plain
							// free-text input so a branch can still be set.
							<form
								onSubmit={handleBranchSubmit}
								className="space-y-3 p-3"
							>
								<div className="space-y-1">
									<h4 className="font-medium text-sm text-foreground">
										{t("branchPopoverTitle")}
									</h4>
									<p className="text-xs text-muted-foreground">
										{t("branchListError")}
									</p>
								</div>
								<div className="space-y-1.5">
									<Label
										htmlFor={branchInputId}
										className="text-xs"
									>
										{t("branchInputLabel")}
									</Label>
									<Input
										id={branchInputId}
										value={branchInput}
										onChange={(event) =>
											setBranchInput(event.target.value)
										}
										autoComplete="off"
										spellCheck={false}
										className="h-8"
									/>
								</div>
								<p
									aria-live="polite"
									className="text-sm text-destructive"
								>
									{branchError}
								</p>
								<div className="flex justify-end gap-2">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() =>
											setBranchPopoverOpen(false)
										}
									>
										{t("branchCancel")}
									</Button>
									<Button
										type="submit"
										size="sm"
										disabled={
											updateBranchMutation.isPending ||
											!branchInput.trim()
										}
										className="gap-1.5"
									>
										{updateBranchMutation.isPending && (
											<Loader2Icon
												aria-hidden="true"
												className="size-3.5 motion-safe:animate-spin"
											/>
										)}
										{t("branchSave")}
									</Button>
								</div>
							</form>
						) : (
							<Command>
								<CommandInput
									value={branchFilter}
									onValueChange={setBranchFilter}
									placeholder={t("branchSearchPlaceholder")}
								/>
								{branchesQuery.isLoading ? (
									<div className="flex items-center justify-center py-6">
										<Loader2Icon
											aria-label={t(
												"branchSearchPlaceholder",
											)}
											className="size-5 text-muted-foreground motion-safe:animate-spin"
										/>
									</div>
								) : (
									<CommandList>
										<CommandEmpty>
											{t("branchEmpty")}
										</CommandEmpty>
										<CommandGroup
											heading={t("branchListHeading")}
										>
											{sortedBranches.map((branch) => {
												const isCurrent =
													branch.name ===
													monitoredBranch;
												return (
													<CommandItem
														key={branch.name}
														value={branch.name}
														disabled={
															updateBranchMutation.isPending
														}
														onSelect={() =>
															handleSelectBranch(
																branch.name,
															)
														}
														className="gap-2"
													>
														<GitBranchIcon
															aria-hidden="true"
															className="size-3.5 shrink-0 text-muted-foreground"
														/>
														<span className="min-w-0 flex-1 truncate">
															{branch.name}
														</span>
														{branch.isDefault && (
															<Badge
																variant="outline"
																className="px-1.5 py-0 text-[10px] uppercase tracking-[0.1em]"
															>
																{t(
																	"branchDefaultBadge",
																)}
															</Badge>
														)}
														{isCurrent && (
															<CheckIcon
																aria-label={t(
																	"branchCurrent",
																)}
																className="size-3.5 shrink-0 text-primary"
															/>
														)}
														<button
															type="button"
															aria-label={
																branch.isPinned
																	? t(
																			"unpinBranch",
																			{
																				branch: branch.name,
																			},
																		)
																	: t(
																			"pinBranch",
																			{
																				branch: branch.name,
																			},
																		)
															}
															aria-pressed={
																branch.isPinned
															}
															disabled={
																setPinnedMutation.isPending
															}
															onPointerDown={(
																event,
															) =>
																event.stopPropagation()
															}
															onKeyDown={(
																event,
															) => {
																// Keep Enter/Space on the pin toggle
																// from bubbling to cmdk's root handler
																// (which would also select the branch).
																if (
																	event.key ===
																		"Enter" ||
																	event.key ===
																		" "
																) {
																	event.stopPropagation();
																}
															}}
															onClick={(
																event,
															) => {
																event.preventDefault();
																event.stopPropagation();
																handleTogglePin(
																	branch,
																);
															}}
															className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
														>
															<PinIcon
																aria-hidden="true"
																className={cn(
																	"size-3.5",
																	branch.isPinned &&
																		"fill-current text-primary",
																)}
															/>
														</button>
													</CommandItem>
												);
											})}
											{showCustomBranch && (
												<CommandItem
													value={trimmedFilter}
													disabled={
														updateBranchMutation.isPending
													}
													onSelect={() =>
														handleSelectBranch(
															trimmedFilter,
														)
													}
													className="gap-2"
												>
													<GitBranchIcon
														aria-hidden="true"
														className="size-3.5 shrink-0 text-muted-foreground"
													/>
													<span className="min-w-0 flex-1 truncate">
														{t("branchUseCustom", {
															branch: trimmedFilter,
														})}
													</span>
												</CommandItem>
											)}
										</CommandGroup>
										{branchError && (
											<p
												aria-live="polite"
												className="border-t border-border/60 px-3 py-2 text-sm text-destructive"
											>
												{branchError}
											</p>
										)}
									</CommandList>
								)}
							</Command>
						)}
					</PopoverContent>
				</Popover>
			)}
		</span>
	) : null;

	const commitSegment = (
		<span className="flex items-center gap-1.5 text-muted-foreground">
			<GitCommitHorizontalIcon aria-hidden="true" className="size-4" />
			{t("analyzed")}
			<code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
				{status.analyzedShortSha}
			</code>
			{showCommitDiff && (
				<Tooltip>
					<TooltipTrigger asChild>
						{/* Read-only composite indicator: role="img" makes the
						    aria-label valid and announces both numbers as one
						    summary. */}
						<span
							role="img"
							aria-label={commitDiffAriaLabel}
							className="flex cursor-help items-center gap-1 font-mono text-xs"
						>
							{hasAheadCommits && (
								<span className="text-secondary">
									{`+${aheadCount}`}
								</span>
							)}
							{hasBehindCommits && (
								<span className="text-destructive">
									{`−${behindCount}`}
								</span>
							)}
						</span>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{hasAheadCommits && (
							<p>
								{t("commitDiffTooltipAhead", {
									count: aheadCount ?? 0,
									branch: status.branch ?? "",
								})}
							</p>
						)}
						{hasBehindCommits && (
							<p>
								{t("commitDiffTooltipBehind", {
									count: behindCount ?? 0,
								})}
							</p>
						)}
					</TooltipContent>
				</Tooltip>
			)}
		</span>
	);

	const lastUpdateSegment = relative ? (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="text-muted-foreground">{relative}</span>
			</TooltipTrigger>
			<TooltipContent>
				{status.analyzedAt
					? new Date(status.analyzedAt).toLocaleString()
					: relative}
			</TooltipContent>
		</Tooltip>
	) : null;

	// Trailing message chips (background-run indicator / re-analyse hint /
	// monitoring-paused / credential chip + Reconnect / re-analyse recommended)
	// — grouped as the last segment.
	const messageNodes: React.ReactNode[] = [];
	if (backgroundRunActive && backgroundRun) {
		messageNodes.push(
			<BackgroundRunIndicator
				key="background"
				startedAt={backgroundRun.startedAt}
				label={t("analyzingInBackground")}
			/>,
		);
	}
	if (showReanalyzeHint) {
		messageNodes.push(
			<span
				key="hint"
				className="flex items-center gap-1 text-muted-foreground"
			>
				<RefreshCwIcon aria-hidden="true" className="size-3" />
				{t("reanalyzeToApply", { branch: monitoredBranch })}
			</span>,
		);
	}
	if (credentialsDead) {
		// Commit-indicator slot: monitoring is paused, never silently empty and
		// never a stale count (the +N −M indicator beside the sha chip is hidden).
		// The paused tooltip is per-state: for a No-access row "Reconnect the
		// repository" would contradict the chip beside it.
		const pausedTooltipKey =
			credentialState === "repoUnavailable"
				? ("monitoringPausedRepoUnavailableTooltip" as const)
				: ("monitoringPausedTooltip" as const);
		messageNodes.push(
			<Tooltip key="paused">
				<TooltipTrigger asChild>
					<span className="flex cursor-help items-center gap-1 text-muted-foreground">
						<PauseCircleIcon
							aria-hidden="true"
							className="size-3.5"
						/>
						{t("monitoringPaused")}
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{t(pausedTooltipKey)}
				</TooltipContent>
			</Tooltip>,
		);
		messageNodes.push(
			<span key="cred" className="flex items-center gap-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<span className="flex cursor-help items-center gap-1 text-highlight">
							<AlertTriangleIcon
								aria-hidden="true"
								className="size-3.5"
							/>
							{t(chipKey)}
						</span>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{t(`${chipKey}Tooltip`)}
					</TooltipContent>
				</Tooltip>
				{credentialState !== "repoUnavailable" && (
					// No-access rows: reconnecting cannot help (the chip above says
					// what will), so the CTA would walk a futile OAuth round trip.
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={handleReconnect}
								className="h-7 border-highlight/40 bg-highlight/5 hover:bg-highlight/10"
							>
								{t("reconnect")}
							</Button>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							{t("reconnectTooltip")}
						</TooltipContent>
					</Tooltip>
				)}
			</span>,
		);
	} else if (reanalyseRecommended) {
		messageNodes.push(
			<Tooltip key="recommended">
				<TooltipTrigger asChild>
					<span className="flex cursor-help items-center gap-1 text-highlight">
						<AlertTriangleIcon
							aria-hidden="true"
							className="size-3.5"
						/>
						{t("reanalyzeRecommended")}
					</span>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{recommendedReason}
				</TooltipContent>
			</Tooltip>,
		);
	}

	// Ordered segments: repo first, then (analysed) branch · commit · last
	// update · messages — or just the "not analysed" note.
	const leftSegments: { key: string; node: React.ReactNode }[] = [];
	if (repoSegment) {
		leftSegments.push({ key: "repo", node: repoSegment });
	}
	if (isAnalyzed) {
		if (branchSegment) {
			leftSegments.push({ key: "branch", node: branchSegment });
		}
		leftSegments.push({ key: "commit", node: commitSegment });
		if (lastUpdateSegment) {
			leftSegments.push({ key: "time", node: lastUpdateSegment });
		}
		if (messageNodes.length > 0) {
			leftSegments.push({
				key: "messages",
				node: (
					<div className="flex flex-wrap items-center gap-2">
						{messageNodes}
					</div>
				),
			});
		}
	} else {
		leftSegments.push({
			key: "not-analyzed",
			node: (
				<span className="text-muted-foreground">
					{t("notAnalyzed")}
				</span>
			),
		});
	}

	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3",
				credentialState !== "ok"
					? "border-highlight/40 bg-highlight/5"
					: "border-border/60 bg-card/70",
			)}
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
				{leftSegments.map((segment, index) => (
					<Fragment key={segment.key}>
						{index > 0 && (
							<span
								aria-hidden="true"
								className="text-muted-foreground/50"
							>
								·
							</span>
						)}
						{segment.node}
					</Fragment>
				))}
			</div>

			<div className="flex items-center gap-2">
				{isAnalyzed && onToggleHistory && (
					<Popover
						open={showHistory}
						onOpenChange={(open) => {
							// Mirror Radix's requested open state into the parent
							// toggle (open on trigger click, close on Escape /
							// click-outside / re-click).
							if (open !== showHistory) {
								onToggleHistory();
							}
						}}
					>
						<PopoverTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={t("historyTooltip")}
								className={cn(
									"gap-1.5",
									showHistory && "bg-accent text-foreground",
								)}
							>
								<HistoryIcon
									aria-hidden="true"
									className="size-4"
								/>
								{t("history")}
							</Button>
						</PopoverTrigger>
						<PopoverContent
							align="end"
							className="w-[28rem] max-w-[calc(100vw-2rem)] overflow-hidden border-border/60 bg-card p-0"
						>
							{historyPanel ?? (
								<AtlasHistoryPanel
									projectId={projectId}
									repositoryIntegrationId={
										repositoryIntegrationId
									}
									onClose={onToggleHistory}
								/>
							)}
						</PopoverContent>
					</Popover>
				)}
				{reanalyzeDisabledKey ? (
					<Tooltip>
						<TooltipTrigger asChild>
							{/* A disabled button doesn't emit pointer events, so
							    the tooltip trigger sits on a wrapper span that
							    receives the hover. */}
							<span className="inline-flex">
								<Button
									type="button"
									size="sm"
									variant="outline"
									disabled
									className="pointer-events-none gap-1.5"
								>
									<RefreshCwIcon
										aria-hidden="true"
										className="size-4"
									/>
									{t("reanalyze")}
								</Button>
							</span>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							{t(reanalyzeDisabledKey)}
						</TooltipContent>
					</Tooltip>
				) : isAnalyzed ? (
					// Split button: primary = normal re-analyse (respects manual
					// edits); the chevron opens "Re-analyse from fresh". Both are
					// disabled while any run is in flight.
					<div className="inline-flex items-center">
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => onAnalyze({ fresh: false })}
							disabled={inFlight}
							className="gap-1.5 rounded-r-none"
						>
							{inFlight ? (
								<>
									<Loader2Icon
										aria-hidden="true"
										className="size-4 motion-safe:animate-spin"
									/>
									{t("analyzing")}
								</>
							) : (
								<>
									<RefreshCwIcon
										aria-hidden="true"
										className="size-4"
									/>
									{t("reanalyze")}
								</>
							)}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									size="icon-sm"
									variant="outline"
									aria-label={t("analyzeOptions")}
									disabled={inFlight}
									className="-ml-px rounded-l-none px-1"
								>
									<ChevronDownIcon
										aria-hidden="true"
										className="size-4"
									/>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-72">
								<DropdownMenuItem
									onSelect={() => onAnalyze({ fresh: false })}
									className="flex-col items-start gap-0.5"
								>
									<span className="flex items-center gap-1.5 font-medium">
										<RefreshCwIcon
											aria-hidden="true"
											className="size-3.5"
										/>
										{t("reanalyzeNormal")}
									</span>
									<span className="text-xs text-muted-foreground">
										{t("reanalyzeNormalHint")}
									</span>
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() => onAnalyze({ fresh: true })}
									className="flex-col items-start gap-0.5"
								>
									<span className="flex items-center gap-1.5 font-medium">
										<SparklesIcon
											aria-hidden="true"
											className="size-3.5"
										/>
										{t("reanalyzeFresh")}
									</span>
									<span className="text-xs text-muted-foreground">
										{t("reanalyzeFreshHint")}
									</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				) : (
					// First-ever Analyse: single plain button (no fresh option).
					<Button
						type="button"
						size="sm"
						variant="default"
						onClick={() => onAnalyze({ fresh: false })}
						disabled={inFlight}
						className="gap-1.5"
					>
						{inFlight ? (
							<>
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
								{t("analyzing")}
							</>
						) : (
							<>
								<SparklesIcon
									aria-hidden="true"
									className="size-4"
								/>
								{t("analyze")}
							</>
						)}
					</Button>
				)}
			</div>
		</div>
	);
}
