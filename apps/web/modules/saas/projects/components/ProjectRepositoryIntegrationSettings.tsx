"use client";

/**
 * Multi-Repository Settings — manages the list of connected repositories.
 *
 * Each connected repository is a ProjectRepositoryIntegration row.
 * Users can add repos via GitHub/GitLab OAuth browse, manual URL, or Azure DevOps PAT.
 * All repos are shared with the team via project-level credentials.
 */

import { classificationForRawKind } from "@repo/utils/pipeline-sync-failure-kinds";
import { InlineJobProgress } from "@saas/jobs/components/InlineJobProgress";
import type { JobListItem } from "@saas/jobs/hooks/use-jobs";
import {
	findJobForSource,
	useProjectJobProgress,
} from "@saas/jobs/hooks/use-project-job-progress";
import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { AttachRepositoryPatDialog } from "@saas/projects/components/AttachRepositoryPatDialog";
import { timeAgo } from "@saas/projects/components/test-cases/pipeline/pipeline-run";
import { repositoryProviderSupportsReconnect } from "@saas/projects/lib/repo-reconnect-capability";
import { getRepoStatusMeta } from "@saas/projects/lib/repo-status-meta";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	CodeIcon,
	EllipsisVerticalIcon,
	ExternalLink,
	GithubIcon,
	KeyIcon,
	Loader2Icon,
	type LucideIcon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	TrashIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	type CodeIndexDetails,
	CodeIndexDetailsPanel,
} from "./CodeIndexDetailsPanel";
import { EditRepositoryBranchDialog } from "./EditRepositoryBranchDialog";
import { FullReindexConfirmDialog } from "./FullReindexConfirmDialog";
// The repo pickers live under `wizard/` because project setup was their first
// caller, not because they are setup-only. They take a `projectId` and write
// project-scoped integrations, so Settings mounts the same components rather
// than growing a second, weaker discovery UI (Fizzy #2196).
import { AzureDevOpsPatRepoPicker } from "./wizard/AzureDevOpsPatRepoPicker";
import {
	type GitLabProject,
	GitLabProjectPicker,
} from "./wizard/GitLabProjectPicker";

// ─────────────────────────────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────────────────────────────
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

function GitLabIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="m23.546 10.93-.963-2.636-1.907-5.218a.405.405 0 0 0-.771 0l-1.907 5.218H5.999L4.092 3.076a.405.405 0 0 0-.771 0L1.413 8.294.45 10.93a.804.804 0 0 0 .293.898l11.255 8.18 11.255-8.18a.804.804 0 0 0 .293-.898z" />
		</svg>
	);
}

/** Detect provider from a repo URL */
function detectProvider(
	url: string,
): "GITHUB" | "GITLAB" | "AZURE_DEVOPS" | null {
	const trimmed = url.trim().toLowerCase();
	if (trimmed.includes("github.com")) {
		return "GITHUB";
	}
	if (trimmed.includes("gitlab.com")) {
		return "GITLAB";
	}
	if (
		trimmed.includes("dev.azure.com") ||
		trimmed.includes("visualstudio.com")
	) {
		return "AZURE_DEVOPS";
	}
	return null;
}

/**
 * Parse owner/name from a repo URL.
 *
 * The name group intentionally allows dots — repo names like `Example.Chat`
 * or `lodash.debounce` are valid. A trailing `.git` is stripped by the
 * `(?:\.git)?` suffix, not by excluding `.` from the character class.
 */
function parseRepoFromUrl(url: string): { owner: string; name: string } | null {
	const provider = detectProvider(url);
	if (provider === "GITHUB") {
		const m = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
		if (m) {
			return { owner: m[1], name: m[2] };
		}
	} else if (provider === "GITLAB") {
		const m = url.match(/gitlab\.com\/(.+?)\/([^/]+?)(?:\.git)?\/?$/i);
		if (m) {
			return { owner: m[1], name: m[2] };
		}
	} else if (provider === "AZURE_DEVOPS") {
		const m = url.match(
			/dev\.azure\.com\/([^/]+)\/(?:[^/]+\/)?_git\/(?:[^/]+\/)?([^/]+?)(?:\.git)?\/?$/i,
		);
		const m2 = url.match(
			/\/\/([^.]+)\.visualstudio\.com\/(?:[^/]+\/)?_git\/(?:[^/]+\/)?([^/]+?)(?:\.git)?\/?$/i,
		);
		if (m) {
			return { owner: m[1], name: m[2] };
		}
		if (m2) {
			return { owner: m2[1], name: m2[2] };
		}
	}
	return null;
}

// ─────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────

interface ProjectRepositoryIntegrationSettingsProps {
	project: {
		id: string;
		organizationId?: string | null;
		userId: string;
		userRole?: string | null;
		canEditSettings?: boolean;
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		defaultBranch?: string | null;
		repositoryIntegrations?: Array<{
			id: string;
			status: string;
			provider: string;
			repositoryOwner: string;
			repositoryName: string;
		}>;
	};
	currentUserId: string;
	/**
	 * Whether the QA / pipeline-results feature is enabled on this deployment
	 * (`NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES`). Gates the per-repository
	 * pipeline sync health note entirely — matches `QA_SETTINGS_ENABLED` in
	 * `ProjectSettings.tsx`, which also gates the QA settings sub-tabs this
	 * data belongs to. Defaults to `false` so a caller that forgets to pass it
	 * gets NO sync-health query rather than one that 404s against a
	 * feature-gated endpoint.
	 */
	qaEnabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────

/**
 * Helper to evaluate if a repository has a prior index record.
 * Returns true for any prior index record or status (READY, FAILED, PENDING, STALE,
 * or legacy project index) to enforce FR2 fail-safe protection.
 * Explicit null returns false.
 */
function hasPriorIndexRecord(
	codeIndex?: {
		status?: string;
		indexedAt?: string | Date | null;
		lastFullIndexAt?: string | Date | null;
	} | null,
	hasLegacyIndexRecord?: boolean,
): boolean {
	if (hasLegacyIndexRecord) {
		return true;
	}
	if (codeIndex === null) {
		return false;
	}
	return true;
}

export function ProjectRepositoryIntegrationSettings({
	project,
	currentUserId,
	qaEnabled = false,
}: ProjectRepositoryIntegrationSettingsProps) {
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.projectSettings");
	// Gate edit UI on the capability flag resolved via the permission matrix
	// on the backend (see `get-project.ts`). Falls back to legacy role-string
	// comparison for older payloads that predate `canEditSettings`.
	const canManageIntegrations =
		project.canEditSettings ?? project.userRole === "owner";
	const membersPath = useContextPath("members");
	// Job Hub: in-flight indexing runs for this project, resolved once here and
	// handed to each row. Keyed on the `repositoryIntegration` source the
	// indexing activities write. This is the live view of the run itself;
	// `CodeIndexDetailsPanel` reports the resulting index's state.
	const runningJobs = useProjectJobProgress(project.id);

	// ── Project-level integrations (the canonical repo list) ─────────
	const { data: integrations, isError: integrationsError } = useQuery({
		queryKey: ["projects", "repositoryIntegrations", "list", project.id],
		queryFn: () =>
			orpcClient.projects.repositoryIntegrations.list({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			}),
		// Poll while any repo is actively indexing so the per-repo progress bar
		// advances; stop once all repos settle.
		refetchInterval: (query) => {
			const list = query.state.data?.integrations ?? [];
			const anyIndexing = list.some(
				(i) =>
					i.codeIndex?.status === "INDEXING" ||
					i.codeIndex?.status === "PENDING",
			);
			return anyIndexing ? 3000 : false;
		},
	});

	const rawIntegrationList =
		integrations?.integrations ?? project.repositoryIntegrations ?? [];
	const hasLegacyIndexRecord = integrations
		? (integrations.hasLegacyIndexRecord ?? true)
		: false;

	// Per-repository pipeline sync health (card #2383's follow-through): the
	// QA-tab failure banner's reconnect link lands HERE, so this page must not
	// keep showing a repo as healthy while QA's own view of it is FAILED. Not
	// polled — a settings page a user opened to fix something is fine reading
	// once; the QA tab already polls the live state.
	//
	// The `orpc.projects.pipelineResults.syncHealth` accessor is read ONLY when
	// `qaEnabled` — not just gated via `enabled` on an eagerly-built options
	// object — so a deployment/test harness whose `orpc` mock predates this
	// endpoint (QA-feature-gated pages have several) never has to know it
	// exists.
	const syncHealthQuery = useQuery(
		qaEnabled
			? orpc.projects.pipelineResults.syncHealth.queryOptions({
					input: { projectId: project.id },
				})
			: {
					queryKey: [
						"pipeline-results-sync-health",
						"disabled",
					] as const,
					queryFn: () => [],
				},
	);
	const syncHealthByIntegrationId = new Map(
		(syncHealthQuery.data ?? []).map((health) => [
			health.integrationId,
			health,
		]),
	);

	// Whether Phase 2 code indexing is enabled on this deployment — gates the
	// per-repo index badge + Re-index/Cancel controls. Shares the query key with
	// CodeSearchToggle so it's fetched once.
	const { data: ragSettingsData } = useQuery(
		orpc.projects.ragSettings.get.queryOptions({
			input: {
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			},
		}),
	);
	const featureCodeIndexingEnabled =
		ragSettingsData?.featureCodeIndexingEnabled ?? false;

	// Fallback: show legacy project.repositoryUrl as a synthetic row for
	// pre-migration projects where the legacy repo isn't yet represented
	// in ProjectRepositoryIntegration.
	const legacyProvider = project.repositoryUrl
		? detectProvider(project.repositoryUrl)
		: null;
	const legacyAlreadyInList =
		legacyProvider &&
		rawIntegrationList.some(
			(i) =>
				i.repositoryOwner === project.repositoryOwner &&
				i.repositoryName === project.repositoryName &&
				i.provider === legacyProvider,
		);
	const legacyRepo =
		!legacyAlreadyInList &&
		project.repositoryUrl &&
		project.repositoryOwner &&
		project.repositoryName
			? [
					{
						id: "__legacy__",
						status: "ACTIVE",
						provider: legacyProvider ?? "GITHUB",
						repositoryOwner: project.repositoryOwner,
						repositoryName: project.repositoryName,
						isLegacy: true,
					},
				]
			: [];

	const integrationList = [...rawIntegrationList, ...legacyRepo];

	// AC-16: when the live status fetch fails (and we never got a successful
	// payload), we cannot assert any row is healthy — surface a notice and
	// render each row's indicator as indeterminate rather than (stale) green.
	const statusUnavailable = integrationsError && integrations === undefined;

	// ── GitHub connection status (for browse feature) ────────────────
	const githubStatusQuery = useQuery({
		queryKey: ["github-oauth-status", project.organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.github.status({
					organizationId: project.organizationId ?? null,
				});
			} catch {
				return { connected: false };
			}
		},
		staleTime: 30000,
	});
	const githubStatus = githubStatusQuery.data;

	// ── GitLab connection status ────────────────────────────────────
	const { data: gitlabStatus } = useQuery({
		queryKey: ["gitlab-oauth-status", project.organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.integrations.gitlab.status({
					organizationId: project.organizationId ?? null,
				});
			} catch {
				return { connected: false };
			}
		},
		staleTime: 30000,
	});

	const hasGitHubTeamCreds = integrationList.some(
		(i) => i.provider === "GITHUB" && i.status === "ACTIVE",
	);
	const canBrowseGitHub =
		githubStatus?.connected === true || hasGitHubTeamCreds;

	// ── GitHub repo list (for browse dropdown) ───────────────────────
	const reposQuery = useQuery({
		queryKey: ["github-repos-project", project.organizationId, project.id],
		queryFn: async () => {
			try {
				const result = await orpcClient.projects.github.listRepos({
					organizationId: project.organizationId ?? null,
					projectId: project.id,
				});
				if (!result.configured) {
					return { repos: [], error: null };
				}
				const repos = (result.groups ?? []).flatMap((g) =>
					g.repos.map((r) => ({
						id: `${g.owner}/${r.name}`,
						name: r.name,
						fullName: r.fullName,
						owner: r.owner || g.owner,
						private: r.isPrivate,
						defaultBranch: r.defaultBranch,
						description: r.description,
						url: r.htmlUrl,
					})),
				);
				return { repos, error: result.error ?? null };
			} catch {
				return { repos: [], error: null };
			}
		},
		enabled: canBrowseGitHub,
		staleTime: 60000,
	});
	const reposData = reposQuery.data;
	const isLoadingRepos = reposQuery.isLoading;

	// ── Local state ──────────────────────────────────────────────────
	const [isAddingRepo, setIsAddingRepo] = useState(false);
	const [selectedRepoUrl, setSelectedRepoUrl] = useState("");
	const [manualRepoUrl, setManualRepoUrl] = useState("");
	const [isConnectingOAuth, setIsConnectingOAuth] = useState(false);
	const [editTarget, setEditTarget] = useState<{
		id: string;
		repositoryOwner: string;
		repositoryName: string;
		defaultBranch: string;
		provider: string;
	} | null>(null);
	// Tracks whether the current OAuth popup is adding a project repo (true)
	// or just connecting the user's account for browsing (false)
	const [isOAuthForProjectRepo, setIsOAuthForProjectRepo] = useState(false);
	const [showPatForm, setShowPatForm] = useState(false);
	const [patValue, setPatValue] = useState("");
	const [roleTagInput, setRoleTagInput] = useState("");
	const [adoOrganization, setAdoOrganization] = useState("");
	const [adoRepoUrl, setAdoRepoUrl] = useState("");
	const [isSubmittingPat, setIsSubmittingPat] = useState(false);
	const [showGitLabPicker, setShowGitLabPicker] = useState(false);
	const [showAdoPicker, setShowAdoPicker] = useState(false);

	// Reset form state when project changes
	useEffect(() => {
		setIsAddingRepo(false);
		setSelectedRepoUrl("");
		setManualRepoUrl("");
		setShowPatForm(false);
		setRoleTagInput("");
		setShowGitLabPicker(false);
		setShowAdoPicker(false);
	}, [project.id]);

	// ── Mutations ────────────────────────────────────────────────────
	const disconnectIntegrationMutation = useMutation({
		mutationFn: async (integrationId: string) =>
			orpcClient.projects.repositoryIntegrations.disconnect({
				projectId: project.id,
				integrationId,
				organizationId: project.organizationId ?? null,
			}),
		onSuccess: () => {
			toast.success("Repository removed");
			invalidateAll();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to remove repository",
			);
		},
	});

	const clearLegacyRepoMutation = useMutation({
		mutationFn: async () =>
			orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId ?? null,
				repositoryUrl: null,
				repositoryOwner: null,
				repositoryName: null,
				defaultBranch: null,
			}),
		onSuccess: () => {
			toast.success("Repository removed");
			invalidateAll();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to remove repository",
			);
		},
	});

	const reindexMutation = useMutation({
		mutationFn: (variables: {
			integrationId: string;
			mode: "incremental" | "full";
		}) =>
			orpcClient.projects.repositoryIntegrations.reindex({
				projectId: project.id,
				integrationId: variables.integrationId,
				organizationId: project.organizationId ?? null,
				mode: variables.mode,
			}),
		onSuccess: (result, variables) => {
			// Surface the incremental nuance: already-current, or a fall-back to a
			// full rebuild when there was no baseline to diff against.
			if (result?.upToDate) {
				toast.success("Index already up to date");
			} else if (result?.fellBackToFull) {
				toast.success(
					"No incremental baseline — started a full re-index",
				);
			} else {
				toast.success("Re-indexing started");
			}
			queryClient.setQueryData(
				["projects", "repositoryIntegrations", "list", project.id],
				(old: any) => {
					if (!old?.integrations) {
						return old;
					}
					return {
						...old,
						integrations: old.integrations.map((item: any) =>
							item.id === variables.integrationId
								? {
										...item,
										codeIndex: {
											...(item.codeIndex ?? {}),
											status: "PENDING",
										},
									}
								: item,
						),
					};
				},
			);
			invalidateAll();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start re-indexing",
			);
		},
	});

	const cancelReindexMutation = useMutation({
		mutationFn: (integrationId: string) =>
			orpcClient.projects.repositoryIntegrations.cancelReindex({
				projectId: project.id,
				integrationId,
				organizationId: project.organizationId ?? null,
			}),
		onSuccess: () => {
			toast.success("Indexing cancelled");
			invalidateAll();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to cancel indexing",
			);
		},
	});

	const invalidateAll = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: ["projects", "repositoryIntegrations"],
		});
		queryClient.invalidateQueries({
			queryKey: orpc.projects.get.queryKey({
				input: {
					id: project.id,
					organizationId: project.organizationId ?? undefined,
				},
			}),
		});
		queryClient.invalidateQueries({ queryKey: ["projects"] });
	}, [queryClient, project.id, project.organizationId]);

	// ── OAuth popup listener ─────────────────────────────────────────
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}
			if (
				event.data?.type === "github_oauth_success" ||
				event.data?.type === "gitlab_oauth_success"
			) {
				if (isOAuthForProjectRepo) {
					// Project-level repo was added via OAuth. The callback may
					// have attached a verdict caveat (repo connected but not
					// readable) — surface it instead of a blanket success line.
					toast.success(
						typeof event.data.message === "string" &&
							event.data.message
							? event.data.message
							: "Repository connected!",
					);
					invalidateAll();
					setIsAddingRepo(false);
					setSelectedRepoUrl("");
					setManualRepoUrl("");
				} else {
					// Account-level connect — refresh browse state, keep panel open
					toast.success(
						"Account connected! You can now browse repositories.",
					);
					queryClient.invalidateQueries({
						queryKey: ["github-oauth-status"],
					});
					queryClient.invalidateQueries({
						queryKey: ["gitlab-oauth-status"],
					});
					queryClient.invalidateQueries({
						queryKey: ["github-repos-project"],
					});
				}
				setIsConnectingOAuth(false);
				setIsOAuthForProjectRepo(false);
			} else if (
				event.data?.type === "github_oauth_error" ||
				event.data?.type === "gitlab_oauth_error"
			) {
				toast.error(
					event.data.message || "Failed to connect repository",
				);
				setIsConnectingOAuth(false);
				setIsOAuthForProjectRepo(false);
			}
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [invalidateAll, isOAuthForProjectRepo, queryClient]);

	// ── Handlers ─────────────────────────────────────────────────────
	const openOAuthPopup = useCallback((url: string, name: string) => {
		const w = 600;
		const h = 700;
		const left = window.screenX + (window.outerWidth - w) / 2;
		const top = window.screenY + (window.outerHeight - h) / 2;
		window.open(
			url,
			name,
			`width=${w},height=${h},left=${left},top=${top}`,
		);
	}, []);

	const handleAddGitHubRepo = useCallback(
		async (
			repoUrl: string,
			owner: string,
			name: string,
			branch: string,
			roleTag?: string | null,
		) => {
			setIsConnectingOAuth(true);
			setIsOAuthForProjectRepo(true);
			try {
				const tagToUse =
					roleTag === null
						? undefined
						: (roleTag ?? (roleTagInput.trim() || undefined));
				const callbackUrl = `${window.location.origin}/api/integrations/github/oauth/callback`;
				const result = await orpcClient.integrations.github.start({
					redirectUri: callbackUrl,
					returnUrl:
						window.location.pathname +
						window.location.search +
						window.location.hash,
					organizationId: project.organizationId ?? null,
					targetType: "project",
					projectId: project.id,
					repositoryUrl: repoUrl,
					repositoryOwner: owner,
					repositoryName: name,
					defaultBranch: branch,
					roleTag: tagToUse,
				});
				setRoleTagInput("");
				openOAuthPopup(result.authorizationUrl, "github-oauth-project");
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to start GitHub connection",
				);
				setIsConnectingOAuth(false);
			}
		},
		[project.id, project.organizationId, openOAuthPopup, roleTagInput],
	);

	const handleAddGitLabRepo = useCallback(
		async (
			repoUrl: string,
			owner: string,
			name: string,
			branch: string,
			roleTag?: string | null,
		) => {
			setIsConnectingOAuth(true);
			setIsOAuthForProjectRepo(true);
			try {
				const tagToUse =
					roleTag === null
						? undefined
						: (roleTag ?? (roleTagInput.trim() || undefined));
				const callbackUrl = `${window.location.origin}/api/integrations/gitlab/oauth/callback`;
				const result = await orpcClient.integrations.gitlab.start({
					redirectUri: callbackUrl,
					returnUrl:
						window.location.pathname +
						window.location.search +
						window.location.hash,
					organizationId: project.organizationId ?? null,
					targetType: "project",
					projectId: project.id,
					repositoryUrl: repoUrl,
					repositoryOwner: owner,
					repositoryName: name,
					defaultBranch: branch,
					roleTag: tagToUse,
				});
				setRoleTagInput("");
				openOAuthPopup(result.authorizationUrl, "gitlab-oauth-project");
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "Failed to start GitLab connection",
				);
				setIsConnectingOAuth(false);
			}
		},
		[project.id, project.organizationId, openOAuthPopup, roleTagInput],
	);

	const handleReconnect = useCallback(
		(integration: {
			provider: string;
			repositoryUrl?: string | null;
			repositoryOwner: string;
			repositoryName: string;
			defaultBranch?: string | null;
		}) => {
			const url =
				integration.repositoryUrl ??
				`https://${integration.provider === "GITLAB" ? "gitlab" : "github"}.com/${integration.repositoryOwner}/${integration.repositoryName}`;
			const branch = integration.defaultBranch ?? "main";
			if (integration.provider === "GITHUB") {
				handleAddGitHubRepo(
					url,
					integration.repositoryOwner,
					integration.repositoryName,
					branch,
					null,
				);
			} else if (integration.provider === "GITLAB") {
				handleAddGitLabRepo(
					url,
					integration.repositoryOwner,
					integration.repositoryName,
					branch,
					null,
				);
			}
		},
		[handleAddGitHubRepo, handleAddGitLabRepo],
	);

	const handleConnectGitHub = useCallback(async () => {
		setIsConnectingOAuth(true);
		try {
			const callbackUrl = `${window.location.origin}/api/integrations/github/oauth/callback`;
			const result = await orpcClient.integrations.github.start({
				redirectUri: callbackUrl,
				returnUrl:
					window.location.pathname +
					window.location.search +
					window.location.hash,
				organizationId: project.organizationId ?? null,
			});
			openOAuthPopup(result.authorizationUrl, "github-oauth");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start GitHub connection",
			);
			setIsConnectingOAuth(false);
		}
	}, [project.organizationId, openOAuthPopup]);

	const handleConnectGitLab = useCallback(async () => {
		setIsConnectingOAuth(true);
		try {
			const callbackUrl = `${window.location.origin}/api/integrations/gitlab/oauth/callback`;
			const result = await orpcClient.integrations.gitlab.start({
				redirectUri: callbackUrl,
				returnUrl:
					window.location.pathname +
					window.location.search +
					window.location.hash,
				organizationId: project.organizationId ?? null,
			});
			openOAuthPopup(result.authorizationUrl, "gitlab-oauth");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to start GitLab connection",
			);
			setIsConnectingOAuth(false);
		}
	}, [project.organizationId, openOAuthPopup]);

	const handleAddFromGitHubBrowse = useCallback(() => {
		if (!selectedRepoUrl || !reposData?.repos) {
			return;
		}
		const repo = reposData.repos.find((r) => r.url === selectedRepoUrl);
		if (!repo) {
			return;
		}
		// Check if this repo is already connected
		const alreadyConnected = integrationList.some(
			(i) =>
				i.repositoryOwner === repo.owner &&
				i.repositoryName === repo.name &&
				i.provider === "GITHUB",
		);
		if (alreadyConnected) {
			toast.error("This repository is already connected");
			return;
		}
		handleAddGitHubRepo(
			repo.url,
			repo.owner,
			repo.name,
			repo.defaultBranch || "main",
		);
	}, [selectedRepoUrl, reposData, integrationList, handleAddGitHubRepo]);

	/**
	 * GitLab picker confirm.
	 *
	 * GitLab repos can only be attached through the OAuth start endpoint
	 * (`connect` rejects authMethod OAUTH by design), and that endpoint always
	 * returns an authorization URL — so each repo costs one popup. Adding a
	 * whole multi-selection would fire popups in a loop and be blocked. We take
	 * the first not-yet-connected repo and say so plainly rather than silently
	 * dropping the rest.
	 */
	const handleGitLabPickerConfirm = useCallback(
		(repos: GitLabProject[]) => {
			setShowGitLabPicker(false);
			const fresh = repos.filter(
				(repo) =>
					!integrationList.some(
						(i) =>
							i.provider === "GITLAB" &&
							i.repositoryOwner === repo.owner &&
							i.repositoryName === repo.name,
					),
			);
			if (fresh.length === 0) {
				if (repos.length > 0) {
					toast.error("Those repositories are already connected");
				}
				return;
			}
			const [first, ...rest] = fresh;
			if (rest.length > 0) {
				toast.info(
					`Adding ${first.fullName}. GitLab repositories are authorized one at a time — add the other ${rest.length} after this one finishes.`,
				);
			}
			handleAddGitLabRepo(
				first.htmlUrl,
				first.owner,
				first.name,
				first.defaultBranch || "main",
				first.roleTag || undefined,
			);
		},
		[integrationList, handleAddGitLabRepo],
	);

	/**
	 * Azure DevOps picker confirm. The picker persists one integration per
	 * selected repo itself (PAT auth via `connect`) when given a `projectId`,
	 * so there is nothing to write here — just pick up what it created.
	 */
	const handleAdoPickerConfirm = useCallback(() => {
		setShowAdoPicker(false);
		invalidateAll();
	}, [invalidateAll]);

	const handleAddFromManualUrl = useCallback(() => {
		const url = manualRepoUrl.trim();
		if (!url) {
			return;
		}
		const provider = detectProvider(url);
		const parsed = parseRepoFromUrl(url);
		if (!parsed) {
			toast.error(
				"Could not parse repository URL. Use format: https://github.com/owner/repo, https://gitlab.com/owner/repo, or https://dev.azure.com/org/project/_git/repo",
			);
			return;
		}
		// Check duplicate (include provider — same repo on different providers is valid)
		const alreadyConnected = integrationList.some(
			(i) =>
				i.repositoryOwner === parsed.owner &&
				i.repositoryName === parsed.name &&
				i.provider === provider,
		);
		if (alreadyConnected) {
			toast.error("This repository is already connected");
			return;
		}
		if (provider === "GITHUB") {
			handleAddGitHubRepo(url, parsed.owner, parsed.name, "main");
		} else if (provider === "GITLAB") {
			handleAddGitLabRepo(url, parsed.owner, parsed.name, "main");
		} else if (provider === "AZURE_DEVOPS") {
			// Pre-fill the PAT form with the URL
			setAdoRepoUrl(url);
			setAdoOrganization(parsed.owner);
			setShowPatForm(true);
			setManualRepoUrl("");
		} else {
			toast.error("Unsupported repository provider");
		}
	}, [
		manualRepoUrl,
		integrationList,
		handleAddGitHubRepo,
		handleAddGitLabRepo,
	]);

	// Connect any provider (Azure DevOps, GitHub, GitLab) with a PAT. Azure DevOps
	// also needs the organization; GitHub/GitLab need only the URL + token. A
	// scoped PAT is the reliable way to pull CI pipeline results from GitHub,
	// since the GitHub App's OAuth token is Contents-scoped and can't read Actions.
	const handleConnectPat = useCallback(async () => {
		const url = adoRepoUrl.trim();
		if (!patValue.trim() || !url) {
			toast.error("Enter the repository URL and access token.");
			return;
		}

		const provider = detectProvider(url);
		const parsed = parseRepoFromUrl(url);
		if (!provider || !parsed) {
			toast.error("Unsupported or unparseable repository URL");
			return;
		}
		if (provider === "AZURE_DEVOPS" && !adoOrganization.trim()) {
			toast.error("Organization name is required for Azure DevOps");
			return;
		}

		setIsSubmittingPat(true);
		try {
			await orpcClient.projects.repositoryIntegrations.connect({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
				provider,
				authMethod: "PAT",
				repositoryUrl: url,
				repositoryOwner: parsed.owner,
				repositoryName: parsed.name,
				pat: patValue,
				roleTag: roleTagInput.trim() || undefined,
				...(provider === "AZURE_DEVOPS"
					? { azureOrganization: adoOrganization.trim() }
					: {}),
			});

			toast.success("Repository connected!");
			setShowPatForm(false);
			setPatValue("");
			setRoleTagInput("");
			setAdoOrganization("");
			setAdoRepoUrl("");
			setIsAddingRepo(false);
			invalidateAll();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to connect repository",
			);
		} finally {
			setIsSubmittingPat(false);
		}
	}, [
		project.id,
		project.organizationId,
		patValue,
		roleTagInput,
		adoOrganization,
		adoRepoUrl,
		invalidateAll,
	]);

	// ── Derived state ────────────────────────────────────────────────
	const hasRepos = integrationList.length > 0;

	// ═════════════════════════════════════════════════════════════════
	// RENDER
	// ═════════════════════════════════════════════════════════════════

	return (
		<Card className="border-foreground/10 col-span-full">
			<CardHeader>
				<div className="flex items-center gap-3">
					<div className="rounded-lg bg-gradient-to-br from-gray-500/20 to-gray-600/20 p-2">
						<CodeIcon className="size-4 text-gray-500" />
					</div>
					<div className="flex-1">
						<CardTitle className="text-base">
							Repositories
						</CardTitle>
						<CardDescription>
							Connect GitHub, GitLab, or Azure DevOps repositories
							for AI-powered code analysis.
						</CardDescription>
					</div>
					{canManageIntegrations && !isAddingRepo && (
						<Button
							variant="outline"
							size="sm"
							onClick={() => setIsAddingRepo(true)}
						>
							<PlusIcon className="mr-1 h-3 w-3" />
							Add Repository
						</Button>
					)}
				</div>
			</CardHeader>

			<CardContent className="space-y-4">
				{/* ── Connected repositories list ─────────────────── */}
				{hasRepos ? (
					<div className="space-y-2">
						{statusUnavailable && (
							<p
								className="text-xs text-muted-foreground"
								role="status"
							>
								Couldn't load current repository status —
								showing the last known state may be unavailable.
								Try refreshing.
							</p>
						)}
						{integrationList.map((integration) => {
							const isLegacy =
								"isLegacy" in integration &&
								integration.isLegacy === true;
							// The configured branch only travels on canonical
							// `list` rows. Project-payload fallback rows (rendered
							// before the list resolves, or if it fails) lack it.
							const rowBranch =
								"defaultBranch" in integration &&
								typeof integration.defaultBranch === "string"
									? integration.defaultBranch
									: null;
							// Gate Edit/Reconnect on a known branch so we can never
							// silently reset the monitored branch to "main" (FR-5).
							const branchKnown = rowBranch !== null;
							return (
								<IntegrationStatusRow
									key={integration.id}
									integration={integration}
									syncHealth={
										syncHealthByIntegrationId.get(
											integration.id,
										) ?? null
									}
									indexingJob={findJobForSource(
										runningJobs,
										"repositoryIntegration",
										integration.id,
									)}
									projectId={project.id}
									organizationId={
										project.organizationId ?? null
									}
									onAttached={invalidateAll}
									statusUnavailable={statusUnavailable}
									canManageIntegrations={
										canManageIntegrations
									}
									isLegacy={isLegacy}
									branchKnown={branchKnown}
									hasLegacyIndexRecord={hasLegacyIndexRecord}
									featureCodeIndexingEnabled={
										featureCodeIndexingEnabled
									}
									onReindex={(mode) =>
										reindexMutation.mutate({
											integrationId: integration.id,
											mode,
										})
									}
									onCancelReindex={() =>
										cancelReindexMutation.mutate(
											integration.id,
										)
									}
									isReindexing={
										reindexMutation.isPending &&
										reindexMutation.variables
											?.integrationId === integration.id
									}
									isCancellingReindex={
										cancelReindexMutation.isPending &&
										cancelReindexMutation.variables ===
											integration.id
									}
									onReconnect={() =>
										handleReconnect(integration)
									}
									onEdit={() => {
										if (rowBranch) {
											setEditTarget({
												id: integration.id,
												repositoryOwner:
													integration.repositoryOwner,
												repositoryName:
													integration.repositoryName,
												defaultBranch: rowBranch,
												provider: integration.provider,
											});
										}
									}}
									onDisconnect={() =>
										isLegacy
											? clearLegacyRepoMutation.mutate()
											: disconnectIntegrationMutation.mutate(
													integration.id,
												)
									}
									isDisconnecting={
										isLegacy
											? clearLegacyRepoMutation.isPending
											: disconnectIntegrationMutation.isPending
									}
								/>
							);
						})}
					</div>
				) : !isAddingRepo ? (
					<div className="rounded-lg border border-dashed p-6 text-center">
						<CodeIcon className="mx-auto h-8 w-8 text-muted-foreground/50 mb-2" />
						<p className="text-sm text-muted-foreground mb-3">
							{canManageIntegrations ? (
								"No repositories connected. Add a repository to enable AI code analysis."
							) : (
								<>
									No repositories connected. A project admin
									or owner can configure this — see{" "}
									<a
										href={membersPath}
										className="underline underline-offset-4 hover:text-foreground"
									>
										project members
									</a>
									.
								</>
							)}
						</p>
						{canManageIntegrations && (
							<Button
								variant="outline"
								size="sm"
								onClick={() => setIsAddingRepo(true)}
							>
								<PlusIcon className="mr-1 h-3 w-3" />
								Add Repository
							</Button>
						)}
					</div>
				) : null}

				{/* ── Add repository section ──────────────────────── */}
				{isAddingRepo && canManageIntegrations && (
					<div className="space-y-4 rounded-lg border p-4 bg-muted/20">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">
								Add Repository
							</span>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => {
											setIsAddingRepo(false);
											setSelectedRepoUrl("");
											setManualRepoUrl("");
											setShowPatForm(false);
										}}
										aria-label="Cancel adding repository"
									>
										<XIcon className="h-4 w-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{t("repositoryCancelAdd")}
								</TooltipContent>
							</Tooltip>
						</div>

						{/* GitHub browse */}
						{canBrowseGitHub && (
							<div className="space-y-3 rounded-lg border p-3 bg-card">
								<div className="flex items-center gap-2">
									<GithubIcon className="h-4 w-4 text-muted-foreground" />
									<Label className="text-xs font-medium">
										Browse GitHub Repositories
									</Label>
								</div>
								{isLoadingRepos ? (
									<div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
										<Loader2Icon className="h-4 w-4 animate-spin" />
										Loading repositories...
									</div>
								) : reposData?.error ? (
									<div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
										<AlertTriangleIcon className="h-4 w-4 shrink-0" />
										<span>{reposData.error}</span>
									</div>
								) : (
									<div className="flex gap-2">
										<Select
											value={selectedRepoUrl}
											onValueChange={setSelectedRepoUrl}
										>
											<SelectTrigger className="flex-1">
												<SelectValue placeholder="Select a repository" />
											</SelectTrigger>
											<SelectContent className="max-h-60 overflow-y-auto">
												{reposData?.repos.map(
													(repo) => (
														<SelectItem
															key={repo.id}
															value={repo.url}
														>
															<div className="flex items-center gap-2">
																<span className="font-medium">
																	{
																		repo.fullName
																	}
																</span>
																{repo.private && (
																	<span className="text-xs text-muted-foreground">
																		(private)
																	</span>
																)}
															</div>
														</SelectItem>
													),
												)}
											</SelectContent>
										</Select>
										<Input
											type="text"
											placeholder="Role tag (e.g. Legacy)"
											className="h-9 text-xs w-36"
											maxLength={50}
											value={roleTagInput}
											onChange={(e) =>
												setRoleTagInput(e.target.value)
											}
										/>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													size="sm"
													onClick={
														handleAddFromGitHubBrowse
													}
													disabled={
														isConnectingOAuth ||
														!selectedRepoUrl
													}
												>
													{isConnectingOAuth ? (
														<Loader2Icon className="h-4 w-4 animate-spin" />
													) : (
														"Add"
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												{t("repositoryAddFromBrowse")}
											</TooltipContent>
										</Tooltip>
									</div>
								)}
							</div>
						)}

						{/* Connect GitHub (if not available) */}
						{!canBrowseGitHub && (
							<div className="rounded-lg border border-dashed p-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<GithubIcon className="h-4 w-4 text-muted-foreground" />
										<span className="text-sm">
											Connect GitHub to browse
											repositories
										</span>
									</div>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												onClick={handleConnectGitHub}
												disabled={isConnectingOAuth}
											>
												{isConnectingOAuth ? (
													<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
												) : (
													<GithubIcon className="mr-2 h-4 w-4" />
												)}
												Connect
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("repositoryConnectGithub")}
										</TooltipContent>
									</Tooltip>
								</div>
							</div>
						)}

						{/* GitLab browse. Before #2196 the not-connected state
						    below was the only GitLab affordance here: it
						    promised "connect to browse", and once you connected
						    it simply vanished with no browser behind it. */}
						{gitlabStatus?.connected === true ? (
							<div className="rounded-lg border p-3 bg-card">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<GitLabIcon className="h-4 w-4 text-muted-foreground" />
										<Label className="text-xs font-medium">
											Browse GitLab Repositories
										</Label>
									</div>
									<Button
										variant="outline"
										size="sm"
										onClick={() =>
											setShowGitLabPicker(true)
										}
										disabled={isConnectingOAuth}
									>
										Browse
									</Button>
								</div>
							</div>
						) : (
							<div className="rounded-lg border border-dashed p-3">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-2">
										<GitLabIcon className="h-4 w-4 text-muted-foreground" />
										<span className="text-sm">
											Connect GitLab to browse
											repositories
										</span>
									</div>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												onClick={handleConnectGitLab}
												disabled={isConnectingOAuth}
											>
												{isConnectingOAuth ? (
													<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
												) : (
													<GitLabIcon className="mr-2 h-4 w-4" />
												)}
												Connect
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("repositoryConnectGitlab")}
										</TooltipContent>
									</Tooltip>
								</div>
							</div>
						)}

						{/* Azure DevOps browse. No connected-state check: the
						    picker collects the PAT itself, the same way it does
						    during project setup. */}
						<div className="rounded-lg border p-3 bg-card">
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<AzureDevOpsIcon className="h-4 w-4 text-muted-foreground" />
									<Label className="text-xs font-medium">
										Browse Azure DevOps Repositories
									</Label>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setShowAdoPicker(true)}
									disabled={isConnectingOAuth}
								>
									Browse
								</Button>
							</div>
						</div>

						{/* Divider */}
						<div
							className="flex items-center gap-3"
							aria-hidden="true"
						>
							<span className="h-px flex-1 bg-border" />
							<span className="text-xs uppercase text-muted-foreground">
								or enter URL directly
							</span>
							<span className="h-px flex-1 bg-border" />
						</div>

						{/* Manual URL entry */}
						<div className="space-y-3 rounded-lg border p-3 bg-card">
							<Label className="text-xs text-muted-foreground">
								Repository URL (GitHub, GitLab, or Azure DevOps)
							</Label>
							<div className="flex gap-2">
								<Input
									type="url"
									placeholder="https://github.com/org/repo"
									className="font-mono text-sm flex-1"
									value={manualRepoUrl}
									onChange={(e) =>
										setManualRepoUrl(e.target.value)
									}
								/>
								<Input
									type="text"
									placeholder="Role tag (e.g. Legacy)"
									className="h-9 text-xs w-36"
									maxLength={50}
									value={roleTagInput}
									onChange={(e) =>
										setRoleTagInput(e.target.value)
									}
								/>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											size="sm"
											onClick={handleAddFromManualUrl}
											disabled={
												isConnectingOAuth ||
												!manualRepoUrl.trim()
											}
										>
											{isConnectingOAuth ? (
												<Loader2Icon className="h-4 w-4 animate-spin" />
											) : (
												"Add"
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("repositoryAddFromUrl")}
									</TooltipContent>
								</Tooltip>
							</div>
						</div>

						{/* Connect with a token (PAT) — Azure DevOps, GitHub, or GitLab */}
						{showPatForm &&
							(() => {
								const patProvider = detectProvider(adoRepoUrl);
								const isAdo = patProvider === "AZURE_DEVOPS";
								const hint =
									patProvider === "GITHUB"
										? "GitHub: a classic PAT with 'repo', or a fine-grained token with Contents: Read + Actions: Read (Actions: Read is required to pull CI pipeline results)."
										: patProvider === "GITLAB"
											? "GitLab: a token with 'read_api' scope."
											: isAdo
												? "Azure DevOps: Code (Read); add Test Management (Read) to pull pipeline results."
												: "Paste a GitHub, GitLab, or Azure DevOps repository URL above.";
								return (
									<div className="rounded-lg border p-3 bg-card space-y-3">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-2">
												<KeyIcon className="h-4 w-4" />
												<span className="text-sm font-medium">
													Connect with a token (PAT)
												</span>
											</div>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															setShowPatForm(
																false,
															)
														}
														aria-label="Close PAT form"
													>
														<XIcon className="h-4 w-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t(
														"repositoryClosePatForm",
													)}
												</TooltipContent>
											</Tooltip>
										</div>
										<div>
											<Label className="text-xs text-muted-foreground mb-1 block">
												Repository URL
											</Label>
											<Input
												type="url"
												placeholder="https://github.com/org/repo, https://gitlab.com/group/repo, or https://dev.azure.com/org/project/_git/repo"
												value={adoRepoUrl}
												onChange={(e) =>
													setAdoRepoUrl(
														e.target.value,
													)
												}
												className="text-sm font-mono"
											/>
										</div>
										{isAdo && (
											<div>
												<Label className="text-xs text-muted-foreground mb-1 block">
													Organization name
												</Label>
												<Input
													placeholder="my-organization"
													value={adoOrganization}
													onChange={(e) =>
														setAdoOrganization(
															e.target.value,
														)
													}
													className="text-sm"
												/>
											</div>
										)}
										<div>
											<Label className="text-xs text-muted-foreground mb-1 block">
												Role Tag (optional)
											</Label>
											<Input
												type="text"
												placeholder="Role tag (e.g. Legacy, Primary, Auth Service)"
												maxLength={50}
												value={roleTagInput}
												onChange={(e) =>
													setRoleTagInput(
														e.target.value,
													)
												}
												className="text-sm"
											/>
										</div>
										<div>
											<Label className="text-xs text-muted-foreground mb-1 block">
												Personal Access Token
											</Label>
											<Input
												type="password"
												placeholder="Paste your token here"
												value={patValue}
												onChange={(e) =>
													setPatValue(e.target.value)
												}
												className="text-sm font-mono"
											/>
										</div>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													size="sm"
													onClick={handleConnectPat}
													disabled={
														isSubmittingPat ||
														!patValue.trim() ||
														!adoRepoUrl.trim() ||
														(isAdo &&
															!adoOrganization.trim())
													}
												>
													{isSubmittingPat ? (
														<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
													) : null}
													Test & Connect
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												{t("repositoryTestConnectPat")}
											</TooltipContent>
										</Tooltip>
										<p className="text-xs text-muted-foreground">
											{hint}
										</p>
									</div>
								);
							})()}

						{/* Show PAT connect button if not already shown */}
						{!showPatForm && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setShowPatForm(true)}
								className="w-full"
							>
								<KeyIcon className="mr-2 h-4 w-4" />
								Connect with a token (PAT)
							</Button>
						)}
					</div>
				)}

				{/* ── Code search toggle ──────────────────────── */}
				{hasRepos && (
					<CodeSearchToggle
						projectId={project.id}
						organizationId={project.organizationId ?? null}
					/>
				)}

				<p className="text-xs text-muted-foreground">
					AI agents use connected repositories for code analysis and
					document generation across all repos.
				</p>
			</CardContent>

			{editTarget && (
				<EditRepositoryBranchDialog
					open
					onOpenChange={(open) => {
						if (!open) {
							setEditTarget(null);
						}
					}}
					integration={editTarget}
					projectId={project.id}
					organizationId={project.organizationId ?? null}
					onSaved={invalidateAll}
				/>
			)}

			<GitLabProjectPicker
				open={showGitLabPicker}
				onOpenChange={setShowGitLabPicker}
				organizationId={project.organizationId ?? null}
				projectId={project.id}
				onConfirm={handleGitLabPickerConfirm}
			/>

			<AzureDevOpsPatRepoPicker
				open={showAdoPicker}
				onOpenChange={setShowAdoPicker}
				organizationId={project.organizationId ?? null}
				projectId={project.id}
				onConfirm={handleAdoPickerConfirm}
			/>
		</Card>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Integration status row
// ─────────────────────────────────────────────────────────────────────

export function IntegrationStatusRow({
	integration,
	projectId,
	organizationId,
	statusUnavailable,
	canManageIntegrations,
	onReconnect,
	onEdit,
	onDisconnect,
	isDisconnecting,
	isLegacy,
	hasLegacyIndexRecord,
	branchKnown = true,
	featureCodeIndexingEnabled = false,
	onReindex,
	onCancelReindex,
	isReindexing = false,
	isCancellingReindex = false,
	indexingJob,
	syncHealth = null,
	onAttached,
}: {
	integration: {
		id: string;
		status: string;
		provider: string;
		repositoryOwner: string;
		repositoryName: string;
		/**
		 * The status writer's own explanation (which probe failed, which HTTP
		 * status, what to do). The fixed per-status hint above says the remedy
		 * category; this names the actual cause. Absent on project-payload
		 * fallback rows.
		 */
		lastError?: string | null;
		roleTag?: string | null;
		codeIndex?: (CodeIndexDetails & { filesIndexed: number }) | null;
	};
	projectId: string;
	organizationId: string | null;
	statusUnavailable?: boolean;
	canManageIntegrations: boolean;
	onReconnect: () => void;
	onEdit: () => void;
	onDisconnect: () => void;
	isDisconnecting: boolean;
	isLegacy?: boolean;
	hasLegacyIndexRecord?: boolean;
	/**
	 * Whether the row's configured branch is known. Project-payload fallback
	 * rows (rendered before the canonical list resolves, or if it fails) lack
	 * `defaultBranch`; gating Edit/Reconnect on this prevents silently resetting
	 * the monitored branch to "main" (FR-5). Defaults to `true`.
	 */
	branchKnown?: boolean;
	/** Whether Phase 2 code indexing is enabled — gates the per-repo controls. */
	featureCodeIndexingEnabled?: boolean;
	onReindex?: (mode: "incremental" | "full") => void;
	onCancelReindex?: () => void;
	isReindexing?: boolean;
	isCancellingReindex?: boolean;
	/**
	 * In-flight indexing run for this repo, if any. Passed in rather than
	 * queried here: this row is presentational and its other data (`codeIndex`,
	 * the handlers) arrives the same way, so it stays renderable without a
	 * QueryClient.
	 */
	indexingJob?: JobListItem;
	/**
	 * This repo's pipeline-results sync health (card #2383's follow-through),
	 * joined by the caller from `syncHealth` + this row's integration id. Null
	 * when QA is disabled on this deployment or the repo has never attempted a
	 * sync — both render nothing, not an empty note.
	 */
	syncHealth?: {
		lastFetchedAt: string | Date | null;
		status: string | null;
		lastError: string | null;
		lastErrorKind: string | null;
	} | null;
	/** Called after the attach-PAT dialog successfully rebinds a credential. */
	onAttached?: () => void;
}) {
	const [showFullReindexConfirm, setShowFullReindexConfirm] = useState(false);
	// AC5 (Fizzy #2252): attaching a PAT to the existing row — the no-disconnect
	// remedy for a No-access row and an escape hatch for any credential swap.
	const [patDialogOpen, setPatDialogOpen] = useState(false);
	// Deep link to the GitHub App installation page, shown on No-access GitHub
	// rows when the deployment knows its app slug. Installing the app fixes the
	// root cause directly; absent slug → no button (PAT attach still available).
	const githubAppInstallUrl = process.env.NEXT_PUBLIC_FABRIC_GITHUB_APP_SLUG
		? `https://github.com/apps/${process.env.NEXT_PUBLIC_FABRIC_GITHUB_APP_SLUG}/installations/new`
		: null;
	const meta = getRepoStatusMeta(
		statusUnavailable ? "__UNAVAILABLE__" : integration.status,
	);
	const StatusIcon = meta.icon;

	const ProviderIcon =
		integration.provider === "GITHUB"
			? GithubIcon
			: integration.provider === "GITLAB"
				? GitLabIcon
				: AzureDevOpsIcon;

	const canReconnect =
		!isLegacy &&
		branchKnown &&
		repositoryProviderSupportsReconnect(integration.provider);
	// REPO_UNAVAILABLE means the credential is fine but cannot read THIS
	// repository — reconnecting refreshes the wrong grant and lands back on the
	// same badge, so the menu must not offer it (Disconnect/Edit remain; the
	// hint names the real fix).
	const rowMenuReconnect =
		canReconnect && integration.status !== "REPO_UNAVAILABLE";
	const canEdit = !isLegacy && branchKnown;
	const repoLabel = `${integration.repositoryOwner}/${integration.repositoryName}`;

	const [isEditingTag, setIsEditingTag] = useState(false);
	const [editingRoleTagValue, setEditingRoleTagValue] = useState(
		integration.roleTag || "",
	);

	const queryClient = useQueryClient();
	const updateTagMutation = useMutation({
		mutationFn: async ({ roleTag }: { roleTag: string | null }) =>
			orpcClient.projects.repositoryIntegrations.updateTag({
				integrationId: integration.id,
				projectId,
				roleTag,
				expectedPreviousRoleTag: integration.roleTag ?? null,
				organizationId: organizationId ?? null,
			}),
		onSuccess: () => {
			toast.success("Role tag updated");
			setIsEditingTag(false);
			queryClient.invalidateQueries({
				queryKey: ["projects", "repositoryIntegrations"],
			});
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update role tag",
			);
		},
	});

	// Three independent conditions, all required before this row offers a
	// Reconnect button:
	//  - the failure KIND is one reconnecting actually fixes — a missing or
	//    rejected credential, never a missing permission or an SSO requirement
	//    (see `sync-failure-classification.ts`'s module doc);
	//  - `canReconnect` — Azure DevOps (PAT-based) has no in-app reconnect flow
	//    on this page at all, so the note there stays text-only;
	//  - `canManageIntegrations` — the viewer is allowed to PERFORM it. Sync
	//    health is readable at viewer tier (the procedure gates on
	//    `TEST_CASE_READ`), so a viewer legitimately sees this row; offering
	//    them a button that walks an OAuth round trip and ends at a mutation
	//    they cannot authorise is worse than offering nothing. Only the action
	//    is suppressed — the failure sentence still renders, because knowing
	//    the sync is broken is exactly what a viewer should be able to see.
	const syncHealthReconnectFixes =
		canManageIntegrations &&
		canReconnect &&
		(classificationForRawKind(syncHealth?.lastErrorKind)?.reconnectFixes ??
			false);

	const isIndexStateKnown =
		!statusUnavailable &&
		"codeIndex" in integration &&
		integration.codeIndex !== undefined;
	const hasPriorIndex =
		!isIndexStateKnown ||
		hasPriorIndexRecord(integration.codeIndex, hasLegacyIndexRecord);

	return (
		<div className={`rounded-lg border p-3 ${meta.bgColor}`}>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<StatusIcon
						className={`h-4 w-4 ${meta.iconColor}`}
						aria-label={meta.label}
					/>
					<div>
						<div className="flex items-center gap-2">
							<ProviderIcon className="h-3.5 w-3.5 text-muted-foreground" />
							<span className="text-sm">{repoLabel}</span>
							<Badge variant="outline" className="text-xs">
								{integration.provider === "GITHUB"
									? "GitHub"
									: integration.provider === "GITLAB"
										? "GitLab"
										: "Azure DevOps"}
							</Badge>
							{isEditingTag ? (
								<div className="flex items-center gap-1.5">
									<Input
										type="text"
										placeholder="Role tag (e.g. Legacy)"
										className="h-6 text-xs w-32"
										maxLength={50}
										value={editingRoleTagValue}
										onChange={(e) =>
											setEditingRoleTagValue(
												e.target.value,
											)
										}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												updateTagMutation.mutate({
													roleTag:
														editingRoleTagValue.trim() ||
														null,
												});
											} else if (e.key === "Escape") {
												setIsEditingTag(false);
											}
										}}
									/>
									<Button
										size="sm"
										className="h-6 px-2 text-xs"
										onClick={() =>
											updateTagMutation.mutate({
												roleTag:
													editingRoleTagValue.trim() ||
													null,
											})
										}
										disabled={updateTagMutation.isPending}
									>
										Save
									</Button>
									<Button
										size="sm"
										variant="ghost"
										className="h-6 px-1.5 text-xs"
										onClick={() => setIsEditingTag(false)}
									>
										Cancel
									</Button>
								</div>
							) : (
								<div className="flex items-center gap-1">
									<Badge
										variant={
											integration.roleTag
												? "secondary"
												: "outline"
										}
										className="text-xs font-semibold"
									>
										{integration.roleTag || "Untagged"}
									</Badge>
									{canManageIntegrations && !isLegacy && (
										<Button
											variant="ghost"
											size="sm"
											className="h-5 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
											onClick={() => {
												setIsEditingTag(true);
												setEditingRoleTagValue(
													integration.roleTag || "",
												);
											}}
										>
											Edit Tag
										</Button>
									)}
								</div>
							)}
							<span className="text-xs text-muted-foreground">
								{meta.label}
							</span>
						</div>
						{meta.hint && (
							<p className="text-xs text-muted-foreground mt-0.5">
								{meta.hint}
							</p>
						)}
						{integration.lastError && (
							// Unclamped: this is the actual cause, the sentence a person
							// triaging needs in full, and a title tooltip would hide the
							// overflow from touch and keyboard users.
							<p className="text-muted-foreground mt-0.5 text-xs break-words">
								{integration.lastError}
							</p>
						)}
						{integration.status === "REPO_UNAVAILABLE" &&
							integration.provider === "GITHUB" &&
							canManageIntegrations &&
							githubAppInstallUrl && (
								// AC5's other half: for an app-less GitHub repo,
								// installing the app fixes the root cause directly —
								// no credential swap needed. Gated on the deploy
								// knowing its app slug.
								<a
									href={githubAppInstallUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-xs text-primary-ink underline underline-offset-2 hover:text-primary/80"
								>
									Install the GitHub App
									<ExternalLink className="h-3 w-3" />
								</a>
							)}
						{/* Pipeline sync health (card #2383): the repo's code-index
						    status above can be green while QA's CI-results pull is
						    failing (e.g. the token lost "Actions: read" but can
						    still read code) — this line is what keeps the two from
						    contradicting each other on the page the QA-tab banner's
						    reconnect link sends people to. */}
						{syncHealth?.status === "FAILED" ? (
							<div className="mt-1 flex flex-wrap items-center gap-2">
								<p className="text-destructive text-xs">
									Pipeline sync failing
									{syncHealth.lastError
										? `: ${syncHealth.lastError}`
										: ""}
								</p>
								{syncHealthReconnectFixes && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										className="h-6 px-2 text-xs"
										onClick={onReconnect}
									>
										Reconnect
									</Button>
								)}
							</div>
						) : (
							syncHealth?.lastFetchedAt && (
								<p className="mt-1 text-muted-foreground text-xs">
									Pipeline sync last succeeded{" "}
									{timeAgo(syncHealth.lastFetchedAt)}
								</p>
							)
						)}
						{indexingJob && (
							<div className="mt-1 text-xs">
								<InlineJobProgress job={indexingJob} />
							</div>
						)}
						{featureCodeIndexingEnabled && !isLegacy && (
							<CodeIndexDetailsPanel
								projectId={projectId}
								organizationId={organizationId}
								repositoryIntegrationId={integration.id}
								codeIndex={integration.codeIndex ?? null}
								isStateKnown={isIndexStateKnown}
								hasLegacyIndexRecord={hasLegacyIndexRecord}
								canManageIntegrations={canManageIntegrations}
								onReindex={onReindex}
								isReindexing={isReindexing}
							/>
						)}
					</div>
				</div>
				{canManageIntegrations && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="text-muted-foreground"
								aria-label={`Manage ${repoLabel}`}
							>
								<EllipsisVerticalIcon className="h-4 w-4" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							{rowMenuReconnect && (
								<DropdownMenuItem onClick={onReconnect}>
									<RefreshCwIcon className="mr-2 size-4" />
									Reconnect
								</DropdownMenuItem>
							)}
							{canEdit && (
								<DropdownMenuItem onClick={onEdit}>
									<PencilIcon className="mr-2 size-4" />
									Edit branch
								</DropdownMenuItem>
							)}
							{!isLegacy && (
								// AC5 (Fizzy #2252): swap this row's credential for a
								// validated PAT without disconnecting — THE remedy for
								// a No-access row.
								<DropdownMenuItem
									onClick={() => setPatDialogOpen(true)}
								>
									<KeyIcon className="mr-2 size-4" />
									Connect with a token (PAT)
								</DropdownMenuItem>
							)}
							{featureCodeIndexingEnabled && !isLegacy && (
								<>
									{(canReconnect || canEdit) && (
										<DropdownMenuSeparator />
									)}
									{integration.codeIndex?.status ===
									"INDEXING" ? (
										<DropdownMenuItem
											onClick={onCancelReindex}
											disabled={isCancellingReindex}
										>
											<XIcon className="mr-2 size-4" />
											Cancel indexing
										</DropdownMenuItem>
									) : (
										<DropdownMenuItem
											onClick={() => {
												if (hasPriorIndex) {
													setShowFullReindexConfirm(
														true,
													);
												} else {
													onReindex?.("full");
												}
											}}
											disabled={isReindexing}
											className={
												hasPriorIndex
													? "text-destructive focus:text-destructive"
													: "text-emerald-600 dark:text-emerald-400 focus:text-emerald-600 dark:focus:text-emerald-400"
											}
										>
											{hasPriorIndex ? (
												<RefreshCwIcon className="mr-2 size-4" />
											) : (
												<PlayIcon className="mr-2 size-4" />
											)}
											{hasPriorIndex
												? "Full re-index"
												: "Index codebase"}
										</DropdownMenuItem>
									)}
								</>
							)}
							{(canReconnect ||
								canEdit ||
								(featureCodeIndexingEnabled && !isLegacy)) && (
								<DropdownMenuSeparator />
							)}
							<DropdownMenuItem
								onClick={onDisconnect}
								disabled={isDisconnecting}
								className="text-destructive focus:text-destructive"
							>
								<TrashIcon className="mr-2 size-4" />
								Disconnect
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
			<FullReindexConfirmDialog
				open={showFullReindexConfirm}
				onOpenChange={setShowFullReindexConfirm}
				repoLabel={repoLabel}
				isReindexing={isReindexing}
				onConfirm={() => {
					setShowFullReindexConfirm(false);
					onReindex?.("full");
				}}
			/>
			{patDialogOpen && (
				<AttachRepositoryPatDialog
					open
					onOpenChange={setPatDialogOpen}
					integration={{
						id: integration.id,
						repositoryOwner: integration.repositoryOwner,
						repositoryName: integration.repositoryName,
						provider: integration.provider,
						status: integration.status,
					}}
					projectId={projectId}
					onSaved={() => onAttached?.()}
				/>
			)}
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Code index status
// ─────────────────────────────────────────────────────────────────────

/**
 * Honest, user-facing description of how code search is currently served for the
 * project — a pre-built index, or live on-demand repository queries. Deliberately
 * carries no deployment internals (no env-var names, no worker instructions): the
 * previous banner was removed for leaking those. Colours are design tokens only.
 *
 * `indexStatus` crosses an API boundary as a widened string, so the switch fails
 * safe to the "live search" reading for MISSING / unknown values. A pending or
 * errored status lookup is reported honestly ("checking" / "couldn't check")
 * rather than being mistaken for an unindexed project.
 */
function getCodeIndexStatusMeta({
	featureCodeIndexingEnabled,
	isPending,
	isError,
	indexStatus,
	filesIndexed,
}: {
	featureCodeIndexingEnabled: boolean;
	isPending: boolean;
	isError: boolean;
	indexStatus: string | undefined;
	filesIndexed: number;
}): { icon: LucideIcon; iconColor: string; spin?: boolean; text: string } {
	if (!featureCodeIndexingEnabled) {
		return {
			icon: SearchIcon,
			iconColor: "text-muted-foreground",
			text: "Live on-demand search — agents query the connected repository directly. Code isn't pre-indexed on this deployment.",
		};
	}

	// The status lookup failed — say so plainly rather than claiming the code
	// isn't indexed (it may well be); live search covers the gap meanwhile.
	if (isError) {
		return {
			icon: AlertTriangleIcon,
			iconColor: "text-muted-foreground",
			text: "Couldn't check the code index status — agents use live search meanwhile.",
		};
	}

	// Neutral placeholder while the status loads (including offline/paused, when
	// isPending stays true), so an already-indexed project never briefly reads
	// as "not indexed yet".
	if (isPending) {
		return {
			icon: Loader2Icon,
			iconColor: "text-muted-foreground",
			spin: true,
			text: "Checking the code index status…",
		};
	}

	switch (indexStatus) {
		case "READY": {
			const suffix =
				filesIndexed > 0
					? ` · ${filesIndexed.toLocaleString()} files`
					: "";
			return {
				icon: CheckCircle2Icon,
				iconColor: "text-secondary",
				text: `Code indexed — agents search the pre-built index.${suffix}`,
			};
		}
		case "INDEXING":
			return {
				icon: Loader2Icon,
				iconColor: "text-highlight",
				spin: true,
				text: "Building the code index…",
			};
		case "PENDING":
			return {
				icon: Loader2Icon,
				iconColor: "text-highlight",
				spin: true,
				text: "Code index queued…",
			};
		case "STALE":
			return {
				icon: AlertTriangleIcon,
				iconColor: "text-highlight",
				text: "Code index is out of date — it refreshes on the next change.",
			};
		case "FAILED":
			return {
				icon: AlertTriangleIcon,
				iconColor: "text-destructive",
				text: "Code indexing failed — agents fall back to live search.",
			};
		default:
			return {
				icon: SearchIcon,
				iconColor: "text-muted-foreground",
				text: "Not indexed yet — agents use live search until the code index is built.",
			};
	}
}

function CodeIndexStatusRow({
	featureCodeIndexingEnabled,
	isPending,
	isError,
	indexStatus,
	filesIndexed,
}: {
	featureCodeIndexingEnabled: boolean;
	isPending: boolean;
	isError: boolean;
	indexStatus: string | undefined;
	filesIndexed: number;
}) {
	const meta = getCodeIndexStatusMeta({
		featureCodeIndexingEnabled,
		isPending,
		isError,
		indexStatus,
		filesIndexed,
	});
	const Icon = meta.icon;
	return (
		<output className="flex items-start gap-2 px-3 text-xs text-muted-foreground">
			<Icon
				className={cn(
					"mt-0.5 size-3.5 shrink-0",
					meta.iconColor,
					meta.spin && "motion-safe:animate-spin",
				)}
				aria-hidden="true"
			/>
			<span>{meta.text}</span>
		</output>
	);
}

// ─────────────────────────────────────────────────────────────────────
// Code search toggle
// ─────────────────────────────────────────────────────────────────────

export function CodeSearchToggle({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const queryClient = useQueryClient();

	const ragQueryOptions = orpc.projects.ragSettings.get.queryOptions({
		input: { projectId, organizationId },
	});

	const { data: ragSettings } = useQuery(ragQueryOptions);
	const isEnabled = ragSettings?.settings?.codeSearchEnabled ?? false;
	const featureCodeIndexingEnabled =
		ragSettings?.featureCodeIndexingEnabled ?? false;

	const codeIndexStatusQuery = useQuery({
		...orpc.agents.codeIndex.status.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: isEnabled && featureCodeIndexingEnabled,
	});

	const updateMutation = useMutation({
		mutationFn: (enabled: boolean) =>
			orpcClient.projects.ragSettings.update({
				projectId,
				organizationId,
				codeSearchEnabled: enabled,
				codeSearchProvider: enabled ? "api" : null,
			}),
		onMutate: async (enabled) => {
			await queryClient.cancelQueries({
				queryKey: ragQueryOptions.queryKey,
			});
			const previous = queryClient.getQueryData(ragQueryOptions.queryKey);
			queryClient.setQueryData(
				ragQueryOptions.queryKey,
				(old: typeof previous) => {
					if (!old) {
						return old;
					}
					return {
						...old,
						settings: {
							...old.settings,
							codeSearchEnabled: enabled,
							codeSearchProvider: enabled ? "api" : null,
						},
					};
				},
			);
			return { previous };
		},
		onError: (error, _enabled, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					ragQueryOptions.queryKey,
					context.previous,
				);
			}
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update code search setting",
			);
		},
		onSettled: () => {
			queryClient.invalidateQueries({
				queryKey: ragQueryOptions.queryKey,
			});
		},
	});

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between rounded-lg border p-3 bg-muted/20">
				<div className="space-y-0.5">
					<Label
						htmlFor="code-search-toggle"
						className="text-sm font-medium"
					>
						Enable code search for AI agents
					</Label>
					<p className="text-xs text-muted-foreground">
						Agents can search repository code, read files, and
						browse the directory structure across all connected
						repos.
					</p>
				</div>
				<Switch
					id="code-search-toggle"
					checked={isEnabled}
					onCheckedChange={(checked) =>
						updateMutation.mutate(checked)
					}
					disabled={updateMutation.isPending}
					aria-label="Enable code search for AI agents"
				/>
			</div>
			{isEnabled && (
				<CodeIndexStatusRow
					featureCodeIndexingEnabled={featureCodeIndexingEnabled}
					isPending={codeIndexStatusQuery.isPending}
					isError={codeIndexStatusQuery.isError}
					indexStatus={codeIndexStatusQuery.data?.status}
					filesIndexed={codeIndexStatusQuery.data?.filesIndexed ?? 0}
				/>
			)}
		</div>
	);
}
