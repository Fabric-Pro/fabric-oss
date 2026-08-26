"use client";

import type { Prisma } from "@repo/database";
import { pmDetectedTypeDisplayName } from "@repo/utils";
import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
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
import { formatDistanceToNow } from "date-fns";
import {
	ArrowRightIcon,
	CheckCircle2Icon,
	ClockIcon,
	ListTodoIcon,
	Loader2Icon,
	PencilIcon,
	ShieldAlertIcon,
	TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { pickDefaultGitLabContainer } from "../lib/pick-default-gitlab-container";
import { getPmProviderLabel } from "../lib/pm-provider-label";
import { derivePmSyncStatus, type PmSyncStatus } from "../lib/pm-sync-status";
import {
	analyzePMToolCapabilities,
	containerIdFieldHint,
	fetchContainersWithHierarchy,
	type McpTool,
} from "../lib/pm-tool-analyzer";
import { buildProjectSyncLogRoute } from "../lib/stories/routes";
import { GitLabLabelStatusMapEditor } from "./pm-integration/GitLabLabelStatusMapEditor";
import { PmToolConnectedBanner } from "./pm-integration/PmToolConnectedBanner";
import { TerminalStatusEditor } from "./pm-integration/TerminalStatusEditor";
import { PMToolSelect } from "./pm-tool-select";

type Project = {
	id: string;
	name: string;
	organizationId?: string | null;
	projectManagementMcpServerId?: string | null;
	projectManagementMcpConfigId?: string | null;
	projectManagementContainerId?: string | null;
	projectManagementContainerName?: string | null;
	projectManagementAdditionalContext?: Prisma.JsonValue | null;
	autoPushPmSync?: boolean | null;
	userRole?: string | null;
	pmAutoCloseEnabled?: boolean;
	pmTerminalStatuses?: string[];
	// Hourly state-poll bookkeeping (already returned by get-project via
	// getProjectById's `include`; surfaced here for the "Last synced" line).
	adoStatePollActive?: boolean | null;
	lastAdoStatePollAt?: Date | string | null;
	syncAttachments?: boolean | null;
	// Server-computed via the PROJECT_SETTINGS_EDIT permission (see
	// get-project.ts) — honours org admins/project admins who have no
	// `userRole === "owner"` but whom `update-project`'s PROJECT_UPDATE gate
	// still accepts. Optional because older cached payloads predate the flag.
	canEditSettings?: boolean;
};

type Props = {
	project: Project;
};

function PmSyncStatusLine({ status }: { status: PmSyncStatus }) {
	if (status.kind === "disabled") {
		return null;
	}

	if (status.kind === "not-enrolled") {
		return (
			<p className="text-xs text-muted-foreground">
				Ticket-status sync is not enabled yet for this project.
			</p>
		);
	}

	if (status.kind === "awaiting") {
		return (
			<p className="text-xs text-muted-foreground">
				Ticket statuses have not been checked yet — the first sync runs
				within the hour.
			</p>
		);
	}

	const relative = formatDistanceToNow(status.at, { addSuffix: true });

	if (status.kind === "stale") {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<p
						className="flex items-center gap-1.5 text-xs text-highlight"
						aria-label={`Ticket statuses last checked ${relative}; this is overdue`}
					>
						<TriangleAlertIcon className="size-3.5" aria-hidden />
						Ticket statuses checked {relative}
					</p>
				</TooltipTrigger>
				<TooltipContent>
					The hourly status sync looks overdue (last run more than two
					hours ago). It should catch up on the next cycle.
				</TooltipContent>
			</Tooltip>
		);
	}

	// kind === "ok"
	return (
		<p
			className="flex items-center gap-1.5 text-xs text-muted-foreground"
			aria-label={`Ticket statuses last checked ${relative}`}
		>
			<ClockIcon className="size-3.5" aria-hidden />
			Ticket statuses checked {relative}
		</p>
	);
}

export function ProjectManagementSettings({ project }: Props) {
	const queryClient = useQueryClient();
	const t = useTranslations("tooltips.projectSettings");
	const tPm = useTranslations("projects.projectManagement.testSync");
	const mcpSettingsUrl = useContextPath("mcp-servers");
	const { organizationName, basePath } = useOrganizationContext();
	const syncLogUrl = buildProjectSyncLogRoute(basePath, project.id);
	const [selectedMcpConfigId, setSelectedMcpConfigId] = useState<
		string | null
	>(null);
	// Track the chosen MCP server id alongside the config id so default-only
	// selections (server picked but no tenant config yet) round-trip cleanly
	// through the same save mutation the wizard uses.
	const [selectedMcpServerId, setSelectedMcpServerId] = useState<
		string | null
	>(project.projectManagementMcpServerId ?? null);
	const [selectedContainerId, setSelectedContainerId] = useState<
		string | null
	>(project.projectManagementContainerId || null);
	const [containers, setContainers] = useState<
		Array<{ id: string; name: string }>
	>([]);
	const [isLoadingContainers, setIsLoadingContainers] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Informational message that does NOT disable the save button (unlike
	// `error`). Used when the user's GitLab account doesn't list the codebase
	// repo, so we can't pre-select it — the user picks manually.
	const [notice, setNotice] = useState<string | null>(null);
	// Tracks whether the user has manually interacted with the container
	// picker. Used to disable the late-arriving codebase-default effect so
	// it cannot silently override an explicit user choice (including the
	// deliberate "Select..." deselect).
	const [userTouchedContainer, setUserTouchedContainer] = useState(false);
	const [detectedPMType, setDetectedPMType] = useState<string | null>(null);
	const [isChangingBoard, setIsChangingBoard] = useState(false);
	// GitLab REST has no MCPConfig (it uses a WorkflowIntegration token), so
	// `selectedMcpConfigId` is always null. This flag drives the container
	// picker / save path for that REST case independently of mcpConfigId.
	const [isRestGitLab, setIsRestGitLab] = useState(false);
	// Track saved configuration locally for immediate UI updates
	const [savedContainerName, setSavedContainerName] = useState<string | null>(
		project.projectManagementContainerName as string | null,
	);
	const [savedMcpConfigId, setSavedMcpConfigId] = useState<string | null>(
		null,
	);
	const [savedMcpServerName, setSavedMcpServerName] = useState<string | null>(
		null,
	);

	// Optimistic overrides for the PM-integration toggles. These switches read
	// their value from the `project` PROP (sourced upstream from a oRPC
	// `projects.get` query, not a local `useQuery` at this key), so a
	// `setQueryData` cache patch would never re-render this component. Local
	// override state flips the switch the instant the user clicks, then a
	// `useEffect` clears the override once the prop catches up to the new value.
	// On error the mutation rolls the override back to `null`.
	const [autoPushOverride, setAutoPushOverride] = useState<boolean | null>(
		null,
	);
	const [autoCloseOverride, setAutoCloseOverride] = useState<boolean | null>(
		null,
	);
	const [syncAttachmentsOverride, setSyncAttachmentsOverride] = useState<
		boolean | null
	>(null);

	const autoPushChecked = autoPushOverride ?? project.autoPushPmSync ?? false;
	const autoCloseChecked =
		autoCloseOverride ?? project.pmAutoCloseEnabled ?? false;
	const syncAttachmentsChecked =
		syncAttachmentsOverride ?? project.syncAttachments ?? false;

	// Clear each override once the refetched prop agrees with it, so the prop
	// resumes being the single source of truth (and a later external change is
	// not masked by a stale override).
	useEffect(() => {
		if (
			autoPushOverride !== null &&
			(project.autoPushPmSync ?? false) === autoPushOverride
		) {
			setAutoPushOverride(null);
		}
	}, [project.autoPushPmSync, autoPushOverride]);

	useEffect(() => {
		if (
			autoCloseOverride !== null &&
			(project.pmAutoCloseEnabled ?? false) === autoCloseOverride
		) {
			setAutoCloseOverride(null);
		}
	}, [project.pmAutoCloseEnabled, autoCloseOverride]);

	useEffect(() => {
		if (
			syncAttachmentsOverride !== null &&
			(project.syncAttachments ?? false) === syncAttachmentsOverride
		) {
			setSyncAttachmentsOverride(null);
		}
	}, [project.syncAttachments, syncAttachmentsOverride]);

	// Query key that feeds the `project` prop. The prop is sourced upstream from
	// `orpc.projects.get` (ProjectDetails.tsx:612, input `{ id, organizationId }`
	// where organizationId is the explicit context value — `null` for personal,
	// never `undefined`, to block session fallback). Toggle mutations must
	// invalidate THIS key so a successful save refetches the prop and the
	// override-clearing effects fire deterministically. `?? null` normalizes the
	// optional prop to the same explicit-null shape the upstream query uses so
	// the keys match byte-for-byte.
	const projectGetQueryKey = useMemo(
		() =>
			orpc.projects.get.queryKey({
				input: {
					id: project.id,
					organizationId: project.organizationId ?? null,
				},
			}),
		[project.id, project.organizationId],
	);

	const isProjectOwner = project.userRole === "owner";
	// Same source of truth ProjectSettings uses for the adjacent read-only-mode
	// switch (`canEditSettings`): the server's PROJECT_UPDATE gate on this
	// mutation accepts owner OR PROJECT_SETTINGS_EDIT, so a raw `isProjectOwner`
	// check would hide the attachment-sync switch from a project/org admin the
	// server authorizes. Falls back to `isProjectOwner` for payloads that
	// predate `canEditSettings`.
	const canEditProjectManagementSettings =
		project.canEditSettings ?? isProjectOwner;

	// Derive whether PM is configured from persisted project fields
	// This avoids a flash of "No PM tools configured" while configs are still loading
	const isPMConfigured = !!(
		savedMcpConfigId ||
		project.projectManagementMcpServerId ||
		project.projectManagementMcpConfigId
	);

	const pmSyncStatus = derivePmSyncStatus({
		// Durable connection signal — mirror the poller's enrollment criteria
		// (it requires projectManagementMcpServerId + a container id). Do NOT
		// use savedContainerName: it's seeded from the nullable *display* field
		// projectManagementContainerName, so a polled project with a real
		// container id but null name would wrongly hide the indicator.
		hasPmToolConnected: Boolean(
			project.projectManagementMcpServerId &&
				project.projectManagementContainerId,
		),
		adoStatePollActive: project.adoStatePollActive,
		lastAdoStatePollAt: project.lastAdoStatePollAt,
		now: Date.now(),
	});

	// Fetch MCP configurations - STRICT CONTEXT ISOLATION
	// Only show configs from the current context (personal OR org, never both)
	const { data: mcpConfigs } = useQuery({
		queryKey: ["mcpConfigs", project.organizationId],
		queryFn: async () => {
			if (project.organizationId) {
				// Org project: only show org MCP configs
				return await orpcClient.mcp.configs.list({
					organizationId: project.organizationId,
				});
			}
			// Personal project: only show personal MCP configs
			return await orpcClient.mcp.configs.list({});
		},
	});

	// Backend-resolved PM capabilities — the authoritative source for the
	// connected tool's `detectedType` (handles server-id/sentinel/stale-config
	// resolution). Used to label the connected-config card for tools without an
	// MCPConfig (GitLab REST). Same query StoriesRoadmap uses, so React Query
	// dedupes it across the two views.
	const { data: pmCapabilities } = useQuery({
		queryKey: [
			"pmCapabilities",
			project.id,
			project.organizationId ?? null,
		],
		queryFn: () =>
			orpcClient.projects.stories.pmCapabilities({
				projectId: project.id,
			}),
		staleTime: 60_000,
	});

	// Repository integrations for this project — used to derive the GitLab
	// codebase repo path so the PM container picker can default to it when
	// GitLab is the selected PM tool.
	const { data: repoIntegrationsData, error: repoIntegrationsError } =
		useQuery({
			queryKey: [
				"projects.repositoryIntegrations",
				project.id,
				project.organizationId ?? null,
			],
			queryFn: () =>
				orpcClient.projects.repositoryIntegrations.list({
					projectId: project.id,
					organizationId: project.organizationId ?? null,
				}),
			staleTime: 60_000,
		});

	const gitlabCodebaseFullName = useMemo(() => {
		const row = repoIntegrationsData?.integrations.find(
			(r) => r.provider === "GITLAB",
		);
		if (!row) {
			return null;
		}
		return `${row.repositoryOwner}/${row.repositoryName}`;
	}, [repoIntegrationsData]);

	// Surface a soft notice + console error if the repository-integrations
	// query fails. Without this, a network/auth failure leaves
	// `gitlabCodebaseFullName` null forever and the picker silently fails to
	// default — invisible UX regression with zero telemetry.
	useEffect(() => {
		if (!repoIntegrationsError) {
			return;
		}
		setNotice(
			"Couldn't load this project's repository integrations. The GitLab container picker won't auto-default — pick manually.",
		);
		// TODO: route through a shared client-side logger when one is
		// adopted for this app. `@repo/logs` is server-only today.
		if (typeof console !== "undefined") {
			console.error(
				"[ProjectManagementSettings] repositoryIntegrations.list failed",
				repoIntegrationsError,
			);
		}
	}, [repoIntegrationsError]);

	// Lightweight mirror of the same query PMToolSelect uses internally — React
	// Query dedupes by key so this is free at runtime. We need the result here
	// to decide whether the post-OAuth nudge banner should be shown.
	//
	// Tri-state usage at the banner mount: only suppress the banner when we
	// KNOW GitLab isn't connected (data resolved + option absent). During
	// load or on error we render nothing rather than collapsing every
	// non-success state into a single `false` that hides the banner from
	// connected users.
	const {
		data: availablePmTools,
		error: pmToolsError,
		isLoading: isLoadingPmTools,
	} = useQuery({
		queryKey: ["mcp.availablePmTools", project.organizationId ?? null],
		queryFn: () =>
			orpcClient.mcp.availablePmTools.list({
				organizationId: project.organizationId ?? null,
			}),
		staleTime: 30_000,
	});

	// Filter to only Project Management MCP servers
	// Memoize to prevent infinite re-renders in useEffect dependencies
	// ALSO apply strict tenant isolation client-side as defense-in-depth
	const pmMcpConfigs = useMemo(
		() =>
			(mcpConfigs || []).filter((c: any) => {
				if (!c.enabled) {
					return false;
				}
				const server = c.mcpServer;
				if (!server) {
					return false;
				}

				// STRICT TENANT ISOLATION: Double-check config belongs to current context
				// Org project: config must have matching organizationId
				// Personal project: config must have null organizationId
				if (project.organizationId) {
					if (c.organizationId !== project.organizationId) {
						return false;
					}
				} else {
					if (c.organizationId !== null) {
						return false;
					}
				}

				if (server.category === "Project Management") {
					return true;
				}
				if (
					Array.isArray(server.tags) &&
					server.tags.includes("project-management")
				) {
					return true;
				}
				return false;
			}),
		[mcpConfigs, project.organizationId],
	);

	// Resolve saved config when configs load
	// Prefer exact configId match, fall back to serverId match
	useEffect(() => {
		if (pmMcpConfigs.length === 0) {
			return;
		}
		// Already resolved
		if (savedMcpConfigId) {
			return;
		}

		// 1. Try exact match by projectManagementMcpConfigId (deterministic)
		const configId = project.projectManagementMcpConfigId;
		if (configId) {
			const config = pmMcpConfigs.find((c: any) => c.id === configId);
			if (config) {
				setSavedMcpConfigId(config.id);
				setSelectedMcpConfigId(config.id);
				setSavedMcpServerName(
					config.displayName || config.mcpServer?.name || null,
				);
				return;
			}
		}

		// 2. Fall back to serverId match (for projects saved before configId was stored)
		const serverId = project.projectManagementMcpServerId;
		if (serverId) {
			const config = pmMcpConfigs.find(
				(c: any) => c.mcpServer?.id === serverId,
			);
			if (config) {
				setSavedMcpConfigId(config.id);
				setSelectedMcpConfigId(config.id);
				setSelectedMcpServerId(config.mcpServer?.id ?? serverId);
				setSavedMcpServerName(
					config.displayName || config.mcpServer?.name || null,
				);
			}
		}
	}, [
		pmMcpConfigs,
		savedMcpConfigId,
		project.projectManagementMcpConfigId,
		project.projectManagementMcpServerId,
	]);

	// Test PM sync - creates a test work item to verify connection
	const testPMSyncMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.testPMSync({
				projectId: project.id,
			});
		},
		onSuccess: (data) => {
			if (data.success) {
				const providerLabel = getPmProviderLabel(data.pmToolType);
				const title = data.externalUrl
					? tPm("successTitle")
					: data.message;
				const description = data.externalUrl
					? providerLabel
						? tPm("successDescriptionWithProvider", {
								provider: providerLabel,
							})
						: tPm("successDescriptionFallback")
					: undefined;
				toast.success(title, {
					description,
					action: data.externalUrl
						? {
								label: tPm("openAction"),
								onClick: () =>
									window.open(data.externalUrl, "_blank"),
							}
						: undefined,
				});
			} else {
				// Backend populates `message` with the real, provider-named
				// cause (e.g. "GitLab access token expired and refresh
				// failed"). Fall back to a generic line only if it arrived
				// empty so the toast never shows an empty body.
				toast.error(tPm("failedTitle"), {
					description:
						data.message?.trim() ||
						"Sync did not complete. Check Settings → Integrations.",
				});
			}
		},
		onError: (err: Error) => {
			toast.error("Test failed", { description: err.message });
		},
	});

	// Mutation to update project
	// SECURITY FIX: Save mcpServerId instead of mcpConfigId
	// This ensures each user uses their own MCP credentials when syncing
	const updateMutation = useMutation({
		mutationFn: async (data: {
			mcpServerId: string | null;
			mcpConfigId: string | null;
			containerId: string | null;
			containerName: string | null;
			additionalContext: Record<string, unknown> | null;
		}) => {
			// Pass null through verbatim — collapsing it to undefined makes
			// Prisma skip the column, leaving the previous provider's values
			// (e.g. a Fizzy MCPConfig and account_slug) on the row after a
			// switch to a provider that doesn't use those fields.
			return await orpcClient.projects.update({
				id: project.id,
				// IMPORTANT: Pass null explicitly for personal projects to prevent
				// resolveOrganizationId from falling back to session's activeOrganizationId
				organizationId: project.organizationId,
				projectManagementMcpServerId: data.mcpServerId,
				projectManagementMcpConfigId: data.mcpConfigId,
				projectManagementContainerId: data.containerId,
				projectManagementContainerName: data.containerName,
				projectManagementAdditionalContext: data.additionalContext,
			});
		},
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({ queryKey: projectGetQueryKey });
			// Update local state for immediate UI feedback
			setSavedContainerName(variables.containerName);
			// Use the config ID directly — no need to re-resolve from server ID
			setSavedMcpConfigId(variables.mcpConfigId);
			const savedConfig = pmMcpConfigs.find(
				(c: any) => c.id === variables.mcpConfigId,
			);
			setSavedMcpServerName(
				savedConfig?.displayName ||
					savedConfig?.mcpServer?.name ||
					null,
			);
			setIsChangingBoard(false);
			toast.success("Project management settings saved!");
		},
		onError: (error) => {
			toast.error(`Failed to save: ${error.message || "Unknown error"}`);
		},
	});

	// Mutation to toggle autoPushPmSync independently of the full settings form
	const updateProjectMutation = useMutation({
		mutationFn: async (data: { autoPushPmSync: boolean }) => {
			return await orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				autoPushPmSync: data.autoPushPmSync,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: projectGetQueryKey });
		},
		onError: (error) => {
			// Roll the optimistic switch back to the server value.
			setAutoPushOverride(null);
			toast.error(`Failed to save: ${error.message || "Unknown error"}`);
		},
	});

	// Terminal-status state + mutations (card #1360 Phase A)
	const [terminalStatuses, setTerminalStatuses] = useState<string[]>(
		project.pmTerminalStatuses ?? [],
	);
	const [isSuggesting, setIsSuggesting] = useState(false);

	const updateAutoCloseMutation = useMutation({
		mutationFn: async (pmAutoCloseEnabled: boolean) =>
			orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				pmAutoCloseEnabled,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: projectGetQueryKey }),
		onError: (e) => {
			// Roll the optimistic switch back to the server value.
			setAutoCloseOverride(null);
			toast.error(`Failed to save: ${e.message || "Unknown error"}`);
		},
	});

	const updateSyncAttachmentsMutation = useMutation({
		mutationFn: async (syncAttachments: boolean) =>
			orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				syncAttachments,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: projectGetQueryKey }),
		onError: (e) => {
			setSyncAttachmentsOverride(null);
			toast.error(`Failed to save: ${e.message || "Unknown error"}`);
		},
	});

	const updateTerminalStatusesMutation = useMutation({
		mutationFn: async (next: string[]) =>
			orpcClient.projects.update({
				id: project.id,
				organizationId: project.organizationId,
				pmTerminalStatuses: next,
			}),
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: projectGetQueryKey }),
		onError: (e) =>
			toast.error(`Failed to save: ${e.message || "Unknown error"}`),
	});

	const persistTerminalStatuses = (next: string[]) => {
		setTerminalStatuses(next);
		updateTerminalStatusesMutation.mutate(next);
	};

	const handleSuggestStatuses = async () => {
		setIsSuggesting(true);
		try {
			const res =
				await orpcClient.projects.pmStateChanges.suggestTerminalStatuses(
					{
						id: project.id,
						organizationId: project.organizationId,
					},
				);
			persistTerminalStatuses(res.terminalStatuses);
			if (res.usedFallback) {
				toast.message("Used default statuses (AI unavailable).");
			}
		} catch (e: unknown) {
			toast.error(
				`Failed to suggest: ${
					e instanceof Error ? e.message : "Unknown error"
				}`,
			);
		} finally {
			setIsSuggesting(false);
		}
	};

	// Store additional context for selected container
	const [additionalContext, setAdditionalContext] = useState<
		Record<string, unknown>
	>({});
	// Azure DevOps: board/team selection + area path + iteration for backlog visibility
	// GitLab: labelStatusMap lives inside this same bag as a nested object, so we
	// widen the type from Record<string,string> to Record<string,unknown>.
	const savedContext = project.projectManagementAdditionalContext as
		| Record<string, unknown>
		| null
		| undefined;
	const asString = (v: unknown): string => (typeof v === "string" ? v : "");
	// selectedTeamId must be team ID (not name). Saved context stores team name;
	// an effect below resolves name → ID when teams load.
	const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
	const [areaPath, setAreaPath] = useState<string>(
		asString(savedContext?.areaPath),
	);
	const [iterationPath, setIterationPath] = useState<string>(
		asString(savedContext?.iterationPath),
	);
	const [workItemType, setWorkItemType] = useState<string>(
		asString(savedContext?.workItemType) || "User Story",
	);

	// GitLab: label → statusId map lives inside additionalContext under
	// `labelStatusMap`. Seed local state from the persisted value.
	const savedLabelStatusMap = (() => {
		const raw = savedContext?.labelStatusMap;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return {};
		}
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
			if (
				typeof k === "string" &&
				typeof v === "string" &&
				k.length > 0 &&
				v.length > 0
			) {
				out[k] = v;
			}
		}
		return out;
	})();
	const [labelStatusMap, setLabelStatusMap] =
		useState<Record<string, string>>(savedLabelStatusMap);

	const isGitLab = detectedPMType === "gitlab";

	// Whether GitLab is the connected PM tool. Combines the interaction-driven
	// local signal (`isGitLab`, only set once the user (re)opens the tool
	// picker or GitLab REST containers load) with the backend-resolved
	// `pmCapabilities` query, which is fetched on mount regardless of user
	// interaction — so a page load for an ALREADY GitLab-connected project
	// reflects this without requiring the picker to be touched.
	// `detectedType` is "gitlab" (MCP) or "gitlab-rest" (REST fallback).
	// Fizzy #1745: the attachment-sync toggle must render for GitLab only —
	// its `Project.syncAttachments` column has no reader for any other tool.
	const isGitLabConnected =
		isGitLab ||
		pmCapabilities?.detectedType === "gitlab" ||
		pmCapabilities?.detectedType === "gitlab-rest";

	// Label shown under "Connected to {board}" in the current-config card.
	// Prefer the MCP connection's own name (e.g. "ADO by Example V2"); fall
	// back to the PM tool's provider name derived from the backend-detected
	// type. GitLab REST has no MCPConfig (`savedMcpServerName` stays null), so
	// without this fallback its subtitle rendered blank. `getPMCapabilities`
	// already resolves the server-id/sentinel/stale-config forms to a canonical
	// `detectedType` (e.g. "gitlab-rest"), so reusing it here is robust to the
	// id-form drift the picker's own matching can't see.
	const connectedProviderLabel =
		savedMcpServerName ??
		pmDetectedTypeDisplayName(pmCapabilities?.detectedType) ??
		null;

	// Provider name for the toggle sentences below ("Sync attachments with X").
	// Deliberately NOT `connectedProviderLabel`: that one prefers the
	// connection's own name ("ADO by Example V2"), and these sentences need the
	// tool, not the connection. Deliberately NOT
	// `getPmProviderLabel(project.projectManagementMcpServerId)` either — that
	// column stores the MCP server's CUID, so a provider-key lookup on it always
	// missed and both labels silently degraded to the generic wording on a page
	// already showing "via Fizzy" two rows above (Fizzy #1746).
	const pmProviderName =
		pmDetectedTypeDisplayName(pmCapabilities?.detectedType) ??
		"the PM tool";

	// ADO-specific UI: project → board/team → area-path cascade. The three
	// queries below (teams, work item types, team field values) and the
	// matching Select UI exist because ADO's data model requires picking a
	// team beneath the project to know where work items land. GitLab/Jira/
	// Fizzy don't have this concept — they use the generic container picker
	// only. Do not generalize these branches.

	// Fetch ADO teams/boards when project is selected (for board selection)
	const containerForTeams =
		selectedContainerId ?? project.projectManagementContainerId;
	const { data: teamsData, isLoading: isLoadingTeams } = useQuery({
		queryKey: ["pmTeams", project.id, containerForTeams, detectedPMType],
		queryFn: async () => {
			return await orpcClient.projects.stories.listProjectTeams({
				projectId: project.id,
				containerId: containerForTeams ?? undefined,
			});
		},
		enabled:
			!!project.id &&
			!!containerForTeams &&
			detectedPMType === "azure-devops",
	});
	const teams = teamsData?.teams ?? [];
	const teamsError = teamsData?.error;

	// Fetch ADO work item types when project is selected
	const containerForWorkItemTypes =
		selectedContainerId ?? project.projectManagementContainerId;
	const { data: workItemTypesData } = useQuery({
		queryKey: [
			"pmWorkItemTypes",
			project.id,
			containerForWorkItemTypes,
			detectedPMType,
		],
		queryFn: async () => {
			return await orpcClient.projects.stories.listProjectWorkItemTypes({
				projectId: project.id,
				containerId: containerForWorkItemTypes ?? undefined,
			});
		},
		enabled:
			!!project.id &&
			!!containerForWorkItemTypes &&
			detectedPMType === "azure-devops",
	});
	const workItemTypes = workItemTypesData?.workItemTypes ?? [];
	const workItemTypesError = workItemTypesData?.error;

	// Fetch the team's real default area path (ADO teamfieldvalues) when a
	// team is selected. Avoids the TF401347 bug caused by synthesising
	// `${projectName}\${teamName}` — that path only exists if the ADO admin
	// ticked "Create area path" when creating the team.
	const { data: teamFieldValuesData } = useQuery({
		queryKey: [
			"pmTeamFieldValues",
			project.id,
			containerForTeams,
			selectedTeamId,
		],
		queryFn: async () => {
			return await orpcClient.projects.stories.getTeamFieldValues({
				projectId: project.id,
				containerId: containerForTeams ?? "",
				teamId: selectedTeamId ?? "",
			});
		},
		enabled:
			!!project.id &&
			!!containerForTeams &&
			!!selectedTeamId &&
			detectedPMType === "azure-devops",
	});
	const teamDefaultArea = teamFieldValuesData?.defaultArea ?? null;

	// GitLab: fetch project statuses so the label→status editor can render a
	// Select with the real Kanban column names. Only fires when GitLab is in
	// scope to avoid pulling statuses for unrelated PM tools.
	const { data: statusesData } = useQuery({
		queryKey: [
			"projectStoryStatuses",
			project.id,
			project.organizationId ?? null,
		],
		queryFn: () =>
			orpcClient.projects.stories.statuses.list({
				projectId: project.id,
				organizationId: project.organizationId ?? null,
			}),
		enabled: !!project.id && isGitLab,
	});
	const statuses = useMemo(
		() =>
			(statusesData?.statuses ?? []).map(
				(s: { id: string; name: string }) => ({
					id: s.id,
					name: s.name,
				}),
			),
		[statusesData],
	);

	// Sync selectedTeamId from saved context when teams load
	useEffect(() => {
		const savedTeam = asString(savedContext?.team);
		if (teams.length > 0 && savedTeam && !selectedTeamId) {
			const match = teams.find(
				(t) => t.name === savedTeam || t.id === savedTeam,
			);
			if (match) {
				setSelectedTeamId(match.id);
			}
		}
	}, [teams, savedContext?.team, selectedTeamId]);

	// Sync workItemType when ADO types load and current value isn't in the list
	useEffect(() => {
		if (
			workItemTypes.length > 0 &&
			!workItemTypes.some((w) => w.name === workItemType)
		) {
			setWorkItemType(workItemTypes[0].name);
		}
	}, [workItemTypes, workItemType]);

	// Fetch containers when MCP config is selected
	// Uses dynamic PM tool analysis instead of hardcoded provider logic
	const fetchContainers = useCallback(
		async (mcpConfigId: string, preserveSelection = false) => {
			setIsLoadingContainers(true);
			setError(null);
			setContainers([]);
			if (!preserveSelection) {
				setSelectedContainerId(null);
				setAdditionalContext({});
				// Reset team/area/iteration – old values are invalid for a different container
				setSelectedTeamId(null);
				setAreaPath("");
				setIterationPath("");
			}

			try {
				// Get available tools with their schemas using the oRPC client
				// IMPORTANT: Pass organizationId explicitly for tenant isolation
				const { tools: toolsList } = await orpcClient.mcp.tools.list({
					serverIds: [mcpConfigId],
					organizationId: project.organizationId ?? null,
				});

				if (!toolsList || toolsList.length === 0) {
					setError("No tools available from this MCP server");
					return;
				}

				// Convert to McpTool format for analyzer
				const tools: McpTool[] = toolsList.map((t) => ({
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema as McpTool["inputSchema"],
					parameters: t.parameters,
				}));

				// Analyze PM capabilities dynamically
				const capabilities = analyzePMToolCapabilities(tools);

				setDetectedPMType(capabilities.detectedType ?? null);

				if (
					!capabilities.hasPMCapabilities ||
					capabilities.containerHierarchy.length === 0
				) {
					setError(
						"This MCP server does not appear to have project management capabilities",
					);
					return;
				}

				// Fetch containers using the detected hierarchy
				// Pass organizationId for tenant isolation in MCP API calls
				const {
					containers: fetchedContainers,
					additionalContext: context,
				} = await fetchContainersWithHierarchy(
					mcpConfigId,
					capabilities.containerHierarchy,
					project.organizationId || undefined,
					{
						cloudIdResolverTool: capabilities.cloudIdResolverTool,
						idFieldHint: containerIdFieldHint(
							capabilities.taskCreation?.containerParam,
						),
					},
				);

				if (fetchedContainers.length === 0) {
					setError(
						"No boards/projects found. Please check your MCP server configuration.",
					);
					return;
				}

				setContainers(fetchedContainers);
				setAdditionalContext(context);
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: "Failed to load boards/projects",
				);
			} finally {
				setIsLoadingContainers(false);
			}
		},
		[project.organizationId],
	);

	// GitLab REST: list the user's GitLab projects over the REST
	// WorkflowIntegration token (no MCPConfig). Each repo's `fullName`
	// (owner/repo path) is the GitLab REST container id.
	const fetchGitLabRestContainers = useCallback(
		async (preserveSelection = false) => {
			setIsLoadingContainers(true);
			setError(null);
			setNotice(null);
			setContainers([]);
			if (!preserveSelection) {
				setSelectedContainerId(null);
			}

			try {
				const res = await orpcClient.projects.gitlab.listRepos({
					organizationId: project.organizationId ?? null,
					projectId: project.id,
				});

				if (!res.configured) {
					setError(
						res.error ||
							"Connect your GitLab account in Settings → Integrations to select a project.",
					);
					return;
				}

				const mapped = res.groups
					.flatMap((g) => g.repos)
					.map((r) => ({ id: r.fullName, name: r.fullName }));

				if (mapped.length === 0) {
					// `configured: true` with empty groups can still carry an
					// actionable error (e.g. a rejected/expired token that needs
					// reconnecting) — surface it instead of the generic message.
					setError(
						res.error ||
							"No GitLab projects found for your account.",
					);
					return;
				}

				setContainers(mapped);
				setDetectedPMType("gitlab");

				// Decide whether to apply the default selection.
				//
				// On initial mount (preserveSelection=true), keep the user's
				// saved container only if it actually maps to a fetched repo.
				// If it doesn't — the common case being a numeric GitLab
				// project id from the auto-wire's numeric-preferred resolver
				// — fall through to the helper so we can recover via the
				// codebase repo path.
				//
				// On user-driven re-selection (preserveSelection=false),
				// always apply the default.
				const savedContainer =
					project.projectManagementContainerId ?? null;
				const savedStillValid =
					savedContainer !== null &&
					mapped.some((c) => c.id === savedContainer);

				if (preserveSelection && savedStillValid) {
					setSelectedContainerId(savedContainer);
				} else {
					const optionsForHelper = mapped.map((m) => ({
						fullName: m.id,
						name: m.name,
					}));
					const defaultFullName = pickDefaultGitLabContainer(
						optionsForHelper,
						savedContainer,
						gitlabCodebaseFullName,
					);
					setSelectedContainerId(defaultFullName);

					if (
						defaultFullName === null &&
						gitlabCodebaseFullName &&
						!mapped.some((c) => c.id === gitlabCodebaseFullName)
					) {
						setNotice(
							`Codebase repo "${gitlabCodebaseFullName}" isn't visible in your GitLab account — pick manually.`,
						);
					}
				}
			} catch (err) {
				setError(
					err instanceof Error
						? err.message
						: "Failed to load GitLab projects",
				);
			} finally {
				setIsLoadingContainers(false);
			}
		},
		[
			project.organizationId,
			project.id,
			project.projectManagementContainerId,
			gitlabCodebaseFullName,
		],
	);

	// Re-apply the codebase default when `gitlabCodebaseFullName` becomes
	// available AFTER the user already picked GitLab REST (race: query
	// resolves after the click). Only fires when nothing is selected and
	// we're on the REST path with containers loaded.
	useEffect(() => {
		if (
			userTouchedContainer ||
			!isRestGitLab ||
			selectedContainerId !== null ||
			containers.length === 0 ||
			!gitlabCodebaseFullName
		) {
			return;
		}
		const match = containers.find((c) => c.id === gitlabCodebaseFullName);
		if (match) {
			setSelectedContainerId(match.id);
			setNotice(null);
		}
	}, [
		userTouchedContainer,
		isRestGitLab,
		selectedContainerId,
		containers,
		gitlabCodebaseFullName,
	]);

	// Auto-load containers when there's an existing configuration and user wants to change
	// Only auto-load if the saved config is in the user's available configs list
	useEffect(() => {
		if (isChangingBoard && selectedMcpConfigId && pmMcpConfigs.length > 0) {
			// Check if the saved config belongs to the current user's available configs
			const isOwnConfig = pmMcpConfigs.some(
				(c: any) => c.id === selectedMcpConfigId,
			);
			if (isOwnConfig) {
				fetchContainers(selectedMcpConfigId, true);
			}
		}
	}, [isChangingBoard, selectedMcpConfigId, pmMcpConfigs, fetchContainers]);

	// Unified handler used by `<PMToolSelect />`. Receives both the
	// MCPConfig id (null for default-only) and the catalog server id, plus
	// the configured / default flags from the picker. Mirrors the wizard's
	// `setProjectManagementTool` behaviour so settings round-trips cleanly.
	const handlePMToolChange = (next: {
		mcpConfigId: string | null;
		mcpServerId: string | null;
		isDefault: boolean;
		isConfigured: boolean;
		transport: "mcp" | "rest" | null;
	}) => {
		// Clear any stale notice from a prior selection (e.g. "Codebase repo
		// X isn't visible") so it doesn't linger under unrelated pickers.
		setNotice(null);
		setUserTouchedContainer(false);
		setSelectedMcpServerId(next.mcpServerId);
		if (next.transport === "rest" && next.mcpServerId) {
			// GitLab REST: no MCPConfig — load projects via the REST token.
			setIsRestGitLab(true);
			setSelectedMcpConfigId(null);
			fetchGitLabRestContainers();
		} else if (next.mcpConfigId) {
			setIsRestGitLab(false);
			setSelectedMcpConfigId(next.mcpConfigId);
			fetchContainers(next.mcpConfigId);
		} else {
			// "None" or default-only stub — clear the container picker
			// and any tool-specific local state; the user must finish
			// configuring the MCP server before sync can run.
			setIsRestGitLab(false);
			setSelectedMcpConfigId(null);
			setContainers([]);
			setSelectedContainerId(null);
			setSelectedTeamId(null);
			setAreaPath("");
			setIterationPath("");
		}
	};

	// Preserve the field-mapping config owned by the sibling
	// FieldMappingPanel on this same tab. Local `additionalContext` state is
	// initialised once at mount, so a mapping saved by the panel afterward would
	// be dropped when this card rebuilds the merged context. Re-read it from the
	// freshest persisted project prop (refreshed after the panel invalidates
	// projects.get) so a connection-card save never clobbers it.
	const preserveFieldMapping = (mergedContext: Record<string, unknown>) => {
		const persisted = project.projectManagementAdditionalContext as Record<
			string,
			unknown
		> | null;
		if (persisted?.fieldMapping !== undefined) {
			mergedContext.fieldMapping = persisted.fieldMapping;
		}
	};

	// Handle save
	// SECURITY FIX: Save the MCP SERVER ID, not the config ID
	// This ensures each user uses their own credentials when syncing
	const handleSave = () => {
		// GitLab REST: persist the server id + selected project (container).
		// No mcpConfigId exists for the REST WorkflowIntegration path.
		if (isRestGitLab) {
			if (!selectedContainerId) {
				toast.error("Please select a board/project");
				return;
			}
			if (!selectedMcpServerId) {
				toast.error("Could not determine GitLab server");
				return;
			}
			const container = containers.find(
				(c) => c.id === selectedContainerId,
			);
			const mergedContext: Record<string, unknown> = {
				...additionalContext,
			};
			if (isGitLab && Object.keys(labelStatusMap).length > 0) {
				mergedContext.labelStatusMap = labelStatusMap;
			} else {
				delete mergedContext.labelStatusMap;
			}
			preserveFieldMapping(mergedContext);
			updateMutation.mutate({
				mcpServerId: selectedMcpServerId,
				mcpConfigId: null,
				containerId: selectedContainerId,
				containerName: container?.name || null,
				additionalContext:
					Object.keys(mergedContext).length > 0
						? mergedContext
						: null,
			});
			return;
		}

		if (!selectedMcpConfigId) {
			// Two sub-paths share this branch:
			//   1. "None" — user wants to disconnect entirely. Both ids null.
			//   2. Default-only — user picked a platform-default PM tool
			//      without a tenant MCPConfig yet. Persist the server id so
			//      the picker keeps showing the chosen tool after reload;
			//      the "Configure now" link is the user's next step.
			updateMutation.mutate({
				mcpServerId: selectedMcpServerId,
				mcpConfigId: null,
				containerId: null,
				containerName: null,
				additionalContext: null,
			});
			return;
		}

		if (!selectedContainerId) {
			toast.error("Please select a board/project");
			return;
		}

		// Get the server ID from the selected config
		const selectedConfig = pmMcpConfigs.find(
			(c: any) => c.id === selectedMcpConfigId,
		);
		const mcpServerId =
			selectedConfig?.mcpServer?.id || selectedConfig?.mcpServerId;

		if (!mcpServerId) {
			toast.error("Could not determine MCP server ID");
			return;
		}

		const container = containers.find((c) => c.id === selectedContainerId);
		const mergedContext: Record<string, unknown> = { ...additionalContext };
		// Resolve System.AreaPath. Priority:
		//   1. Explicit user input in the areaPath field (normalised).
		//   2. Selected team's real default area (from ADO teamfieldvalues).
		//   3. Project root (container name) as a safe fallback that always exists.
		// Never synthesise `${projectName}\${teamName}` — that path only exists
		// when the ADO admin ticked "Create area path" on team creation, which
		// is rare and causes TF401347 on push for default/custom-area teams.
		const manualAreaPath = areaPath.trim();
		if (manualAreaPath) {
			mergedContext.areaPath = manualAreaPath.replace(/\//g, "\\");
		} else if (selectedTeamId && teams.length > 0) {
			const resolved = teamDefaultArea ?? container?.name ?? "";
			if (resolved) {
				mergedContext.areaPath = resolved;
			} else {
				delete mergedContext.areaPath;
			}
		}
		// Persist team name so backlog-resolution logic can still target the
		// team's backlog on push, independent of AreaPath.
		if (selectedTeamId && teams.length > 0) {
			const team = teams.find((t) => t.id === selectedTeamId);
			if (team) {
				mergedContext.team = team.name;
			}
		}
		if (iterationPath.trim()) {
			mergedContext.iterationPath = iterationPath.trim();
		}
		if (workItemType.trim()) {
			mergedContext.workItemType = workItemType.trim();
		}
		// GitLab: persist labelStatusMap when in use; strip it otherwise so
		// switching PM tools cannot leave stale maps behind.
		if (isGitLab && Object.keys(labelStatusMap).length > 0) {
			mergedContext.labelStatusMap = labelStatusMap;
		} else {
			delete mergedContext.labelStatusMap;
		}
		preserveFieldMapping(mergedContext);
		updateMutation.mutate({
			mcpServerId: mcpServerId,
			mcpConfigId: selectedMcpConfigId,
			containerId: selectedContainerId,
			containerName: container?.name || null,
			additionalContext:
				Object.keys(mergedContext).length > 0 ? mergedContext : null,
		});
	};

	return (
		<Card className="h-full">
			<CardHeader>
				<CardTitle className="flex items-center gap-2">
					<ListTodoIcon className="w-5 h-5" />
					Project Management Integration
				</CardTitle>
				<CardDescription>
					Connect this project to a project management tool to push
					tasks automatically. Configure MCP servers in settings.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				<PmSyncStatusLine status={pmSyncStatus} />
				{/* Permission notice for non-owners */}
				{!isProjectOwner && (
					<div className="p-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30">
						<div className="flex items-start gap-3">
							<ShieldAlertIcon className="h-5 w-5 text-destructive mt-0.5 shrink-0" />
							<div>
								<p className="text-sm font-medium text-destructive">
									Owner access required
								</p>
								<p className="text-sm text-destructive/80 mt-1">
									Configuring project management integrations
									requires Owner access. Contact the project
									owner to set up or change this integration.
								</p>
							</div>
						</div>
					</div>
				)}

				{/* Current Configuration - styled like GitHub Connection */}
				{isPMConfigured && savedContainerName && !isChangingBoard && (
					<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-3">
								<div className="h-8 w-8 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center">
									<ListTodoIcon className="h-4 w-4 text-success dark:text-green-400" />
								</div>
								<div>
									<div className="flex items-center gap-1.5">
										<CheckCircle2Icon className="h-4 w-4 text-success dark:text-green-400" />
										<span className="text-sm font-medium text-success">
											Connected to {savedContainerName}
										</span>
									</div>
									{connectedProviderLabel && (
										<p className="text-xs text-success dark:text-green-400">
											via {connectedProviderLabel}
										</p>
									)}
								</div>
							</div>
							{isProjectOwner && (
								<div className="flex items-center gap-1">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												disabled={
													testPMSyncMutation.isPending
												}
												onClick={() =>
													testPMSyncMutation.mutate()
												}
												className="text-green-700 border-green-200 hover:bg-green-50 dark:text-green-300 dark:border-green-800 dark:hover:bg-green-900/30"
											>
												{testPMSyncMutation.isPending ? (
													<Loader2Icon className="h-4 w-4 animate-spin" />
												) : (
													"Test Sync"
												)}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("testPmSync")}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												onClick={() =>
													setIsChangingBoard(true)
												}
												aria-label="Change board"
												className="text-green-700 hover:text-green-800 hover:bg-green-100 dark:text-green-300 dark:hover:bg-green-900/50"
											>
												<PencilIcon className="h-4 w-4" />
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("changeBoard")}
										</TooltipContent>
									</Tooltip>
								</div>
							)}
						</div>
					</div>
				)}

				{/* The log records what THIS card configures, but it lives on the
				    Roadmap — so point at it from here. Shown only alongside a live
				    connection so it doesn't sit directly above the "no tools
				    configured" warning; a project that synced and later
				    disconnected still HAS log rows, and reaches them from the
				    roadmap toolbar. No role gate — the log is PROJECT_READ, same
				    as the change history it sits beside. */}
				{isPMConfigured && savedContainerName && (
					<Link
						href={syncLogUrl}
						className="inline-flex items-center gap-1 rounded-sm text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						View sync log on the Roadmap
						<ArrowRightIcon className="size-3.5" aria-hidden />
					</Link>
				)}

				{/* No PM servers configured - only show if no saved config exists */}
				{pmMcpConfigs.length === 0 &&
					!isPMConfigured &&
					isProjectOwner && (
						<div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
							<p className="text-sm text-highlight/80">
								No project management tools configured.{" "}
								<a
									href={mcpSettingsUrl}
									className="text-primary hover:underline"
								>
									Configure one in MCP Servers
								</a>
							</p>
						</div>
					)}

				{/* Warning: saved config no longer available. Only fires when the
				    project actually had a tenant MCPConfig pinned that is now
				    gone — never for default-only projects, which carry only a
				    server id and surface their guidance via PMToolSelect's
				    "Configure now" helper text. */}
				{pmMcpConfigs.length === 0 &&
					project.projectManagementMcpConfigId &&
					!savedContainerName &&
					!isChangingBoard &&
					isProjectOwner && (
						<div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
							<p className="text-sm text-highlight/80">
								The configured project management tool is no
								longer available (it may have been disabled or
								removed).{" "}
								<a
									href={mcpSettingsUrl}
									className="text-primary hover:underline"
								>
									Configure a new one in MCP Servers
								</a>
							</p>
						</div>
					)}

				{/* PM Tool Selector — mirrors the wizard's `<PMToolSelect />` so
				    the post-creation Settings panel surfaces the same option
				    set: platform defaults plus tenant MCPConfigs deduped by
				    key. Gating no longer depends on `pmMcpConfigs.length > 0`
				    because defaults always render. */}
				{isProjectOwner &&
					(!isPMConfigured ||
						!savedContainerName ||
						isChangingBoard) && (
						<>
							{(() => {
								// Tri-state: render nothing while loading or on
								// error. Only suppress the banner when we KNOW
								// the option list resolved and GitLab is absent.
								if (isLoadingPmTools || pmToolsError) {
									return null;
								}
								const gitlabOption = availablePmTools?.find(
									(o) => o.key === "gitlab-official",
								);
								const tenantHasGitlab = Boolean(gitlabOption);
								const projectSelectedGitlab = Boolean(
									gitlabOption &&
										selectedMcpServerId ===
											gitlabOption.mcpServerId,
								);
								return (
									<PmToolConnectedBanner
										projectId={project.id}
										provider="gitlab"
										tenantConnected={tenantHasGitlab}
										projectSelected={projectSelectedGitlab}
										onUseProvider={() => {
											if (!gitlabOption) {
												return;
											}
											// Mirror PMToolSelect.onChange so the
											// REST/MCP container fetch fires just
											// like a manual selection.
											handlePMToolChange({
												mcpConfigId:
													gitlabOption.mcpConfigId,
												mcpServerId:
													gitlabOption.mcpServerId,
												isDefault:
													gitlabOption.isDefault,
												isConfigured:
													gitlabOption.isConfigured,
												transport:
													gitlabOption.transport,
											});
										}}
									/>
								);
							})()}
							<PMToolSelect
								organizationId={project.organizationId ?? null}
								organizationName={organizationName ?? null}
								selectedMcpConfigId={selectedMcpConfigId}
								selectedMcpServerId={selectedMcpServerId}
								onChange={handlePMToolChange}
								mcpSettingsUrl={mcpSettingsUrl}
								// Initial-load detection: PMToolSelect resolves the
								// persisted server id to its option (incl. transport).
								// When that resolves to GitLab REST, flip into the
								// REST flow and load projects so opening Settings on
								// an already-REST project shows the picker without a
								// manual re-select.
								onResolvedSelection={(info) => {
									if (info.transport === "rest") {
										setIsRestGitLab(true);
										// Only auto-load on initial resolve; skip if a
										// manual selection is already fetching, to avoid
										// a redundant double request.
										if (
											containers.length === 0 &&
											!isLoadingContainers
										) {
											fetchGitLabRestContainers(true);
										}
									} else if (info.transport === "mcp") {
										setIsRestGitLab(false);
									}
								}}
							/>

							{/* Error */}
							{error && (
								<div
									className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg"
									role="alert"
								>
									<p className="text-sm text-destructive/80">
										{error}
									</p>
								</div>
							)}

							{/* Loading */}
							{isLoadingContainers && (
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Loader2Icon className="w-4 h-4 animate-spin" />
									Loading boards/projects...
								</div>
							)}

							{/* Container Selector */}
							{(selectedMcpConfigId || isRestGitLab) &&
								!isLoadingContainers &&
								containers.length > 0 && (
									<div className="space-y-2">
										<Label>Select Board/Project</Label>
										<Select
											value={
												selectedContainerId ||
												"__none__"
											}
											onValueChange={(v) => {
												setUserTouchedContainer(true);
												setSelectedContainerId(
													v === "__none__" ? null : v,
												);
												// Reset team, area, iteration when container changes – old values
												// are invalid for a different container (per-project in ADO)
												setSelectedTeamId(null);
												setAreaPath("");
												setIterationPath("");
											}}
										>
											<SelectTrigger>
												<SelectValue placeholder="Select a board/project..." />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="__none__">
													Select...
												</SelectItem>
												{containers.map((container) => (
													<SelectItem
														key={container.id}
														value={container.id}
													>
														{container.name}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
								)}

							{/* Soft notice — informational only, does not disable save */}
							{notice && !error && (
								// biome-ignore lint/a11y/useSemanticElements: status text is not a form output; <p role="status"> is the WAI-ARIA recommendation for inline status messages, and the explicit role is required for JSDOM getAttribute in tests
								<p
									className="text-sm text-muted-foreground"
									data-testid="gitlab-pm-container-notice"
									role="status"
									aria-live="polite"
								>
									{notice}
								</p>
							)}

							{/* Azure DevOps: Board/team selection + area path + iteration */}
							{detectedPMType === "azure-devops" &&
								selectedContainerId && (
									<div className="space-y-2 rounded-lg border p-3">
										<p className="text-muted-foreground text-sm">
											Choose which board to push work
											items to
										</p>
										{isLoadingTeams ? (
											<div className="flex items-center gap-2 text-sm text-muted-foreground">
												<Loader2Icon className="h-4 w-4 animate-spin" />
												Loading boards...
											</div>
										) : teams.length > 0 ? (
											<div className="space-y-2">
												<Label>Board / Team</Label>
												<Select
													value={
														selectedTeamId ??
														"__none__"
													}
													onValueChange={(v) => {
														setSelectedTeamId(
															v === "__none__"
																? null
																: v,
														);
														if (v === "__none__") {
															setAreaPath("");
														}
													}}
												>
													<SelectTrigger>
														<SelectValue placeholder="Select a board to push to..." />
													</SelectTrigger>
													<SelectContent>
														<SelectItem value="__none__">
															Select...
														</SelectItem>
														{teams.map((team) => (
															<SelectItem
																key={team.id}
																value={team.id}
															>
																{team.name}
															</SelectItem>
														))}
													</SelectContent>
												</Select>
												{selectedTeamId &&
													!areaPath.trim() && (
														<p className="text-xs text-muted-foreground">
															Items will be
															created under{" "}
															<code className="font-mono">
																{teamDefaultArea ??
																	containers.find(
																		(c) =>
																			c.id ===
																			selectedContainerId,
																	)?.name ??
																	""}
															</code>
															{!teamDefaultArea &&
																" (project root — team default area not available)"}
														</p>
													)}
											</div>
										) : teamsError ? (
											<div className="space-y-2">
												<p className="text-sm text-amber-600 dark:text-amber-400">
													{teamsError} You can enter
													area path manually below.
												</p>
												<Label htmlFor="areaPath">
													Area Path
												</Label>
												<Input
													id="areaPath"
													placeholder="e.g. MyProject\\TeamName"
													value={areaPath}
													onChange={(e) =>
														setAreaPath(
															e.target.value,
														)
													}
												/>
											</div>
										) : (
											<div className="space-y-2">
												<Label htmlFor="areaPath">
													Area Path
												</Label>
												<Input
													id="areaPath"
													placeholder="e.g. MyProject\\TeamName"
													value={areaPath}
													onChange={(e) =>
														setAreaPath(
															e.target.value,
														)
													}
												/>
											</div>
										)}
										<div className="space-y-2">
											<Label>Work Item Type</Label>
											<Select
												value={
													workItemTypes.some(
														(w) =>
															w.name ===
															workItemType,
													)
														? workItemType
														: (workItemTypes[0]
																?.name ??
															workItemType)
												}
												onValueChange={setWorkItemType}
											>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
												<SelectContent>
													{workItemTypes.length >
													0 ? (
														workItemTypes.map(
															(w) => (
																<SelectItem
																	key={w.name}
																	value={
																		w.name
																	}
																>
																	{w.description
																		? `${w.name} (${w.description})`
																		: w.name}
																</SelectItem>
															),
														)
													) : (
														<>
															<SelectItem value="User Story">
																User Story
																(Agile)
															</SelectItem>
															<SelectItem value="Product Backlog Item">
																Product Backlog
																Item (Scrum)
															</SelectItem>
															<SelectItem value="Feature">
																Feature
															</SelectItem>
															<SelectItem value="Story">
																Story
															</SelectItem>
															<SelectItem value="Requirement">
																Requirement
																(CMMI)
															</SelectItem>
														</>
													)}
												</SelectContent>
											</Select>
											<p className="text-xs text-muted-foreground">
												{workItemTypesError
													? `${workItemTypesError} Using fallback options.`
													: workItemTypes.length > 0
														? "From your Azure DevOps project."
														: "Must match your project's process. Scrum = Product Backlog Item, Agile = User Story."}
											</p>
										</div>
										<div className="space-y-2">
											<Label htmlFor="iterationPath">
												Iteration Path (optional)
											</Label>
											<Input
												id="iterationPath"
												placeholder="e.g. MyProject\\Sprint 1"
												value={iterationPath}
												onChange={(e) =>
													setIterationPath(
														e.target.value,
													)
												}
											/>
										</div>
									</div>
								)}

							{/* GitLab: label → status mapping editor */}
							{isGitLab && selectedContainerId && (
								<div className="space-y-2 rounded-lg border p-3">
									<p className="text-muted-foreground text-sm">
										Map GitLab issue labels to Kanban
										statuses. When Fabric syncs issues from
										GitLab, the first matching label
										determines the story's status.
									</p>
									<GitLabLabelStatusMapEditor
										value={labelStatusMap}
										onChange={setLabelStatusMap}
										statuses={statuses}
									/>
								</div>
							)}

							{/* Save Button */}
							{(selectedMcpConfigId || isRestGitLab) && (
								<div className="pt-2">
									<Button
										onClick={handleSave}
										disabled={
											updateMutation.isPending ||
											!selectedContainerId
										}
									>
										{updateMutation.isPending ? (
											<>
												<Loader2Icon className="w-4 h-4 mr-2 animate-spin" />
												Saving...
											</>
										) : (
											"Save Settings"
										)}
									</Button>
								</div>
							)}
						</>
					)}

				{/* PM-tool config controls — auto-push / auto-close / terminal
				    statuses. Rendered AFTER the tool-selection/edit form so the
				    tool dropdown keeps the connected card's top slot on edit and
				    these settings sit below it. */}
				{/* Auto-push toggle — visible when PM is configured */}
				{isPMConfigured && isProjectOwner && (
					<div className="flex items-center justify-between py-2 border-t">
						<div className="flex-1 pr-4">
							<Label htmlFor="auto-push-pm-sync">
								Auto-push status changes to PM tool
							</Label>
							<p className="text-muted-foreground text-sm mt-0.5">
								When enabled, moving a feature to a new column
								pushes the change to the linked PM issue
								automatically. Conflicts pause auto-push until
								resolved.
							</p>
						</div>
						<Switch
							id="auto-push-pm-sync"
							checked={autoPushChecked}
							onCheckedChange={(checked) => {
								// Re-entrancy guard: ignore clicks while a write is
								// in flight so concurrent PATCHes can't resolve out
								// of order (backend is last-write-wins, which would
								// otherwise diverge the persisted value from the
								// override the user sees).
								if (updateProjectMutation.isPending) {
									return;
								}
								// Flip the switch instantly; the prop catches up
								// after the refetch and clears the override.
								setAutoPushOverride(checked);
								updateProjectMutation.mutate({
									autoPushPmSync: checked,
								});
							}}
						/>
					</div>
				)}

				{/* Auto-close toggle (card #1360 Phase A) */}
				{isPMConfigured && isProjectOwner && (
					<div className="flex items-center justify-between py-2 border-t">
						<div className="flex-1 pr-4">
							<Label htmlFor="pm-auto-close">
								Automatically close work items that have reached
								a terminal state in {pmProviderName}
							</Label>
							<p className="text-muted-foreground text-sm mt-0.5">
								When enabled, items whose linked PM ticket
								reaches a terminal status are hidden from the
								roadmap on the next sync. The checkmark always
								shows regardless of this setting.
							</p>
						</div>
						<Switch
							id="pm-auto-close"
							checked={autoCloseChecked}
							onCheckedChange={(checked) => {
								// Re-entrancy guard: ignore clicks while a write is
								// in flight so concurrent PATCHes can't resolve out
								// of order (backend is last-write-wins, which would
								// otherwise diverge the persisted value from the
								// override the user sees).
								if (updateAutoCloseMutation.isPending) {
									return;
								}
								// Flip the switch instantly; the prop catches up
								// after the refetch and clears the override.
								setAutoCloseOverride(checked);
								updateAutoCloseMutation.mutate(checked);
							}}
						/>
					</div>
				)}

				{/* Attachment-sync toggle (Fizzy #1745/#1746).
				    The push half shipped behind this flag (Fizzy #1745): the GitLab
				    REST push path (`gitlab-rest-story-sync.ts`) is the ONLY reader
				    of `Project.syncAttachments` — every other PM tool's sync path
				    ignores the column, so the toggle would be a silent no-op there.
				    Gate the render on `isGitLabConnected` in addition to the flag.
				    The pull/import half shipped in the same card: a pull now
				    imports attachments the GitLab issue carries, subject to
				    #1702's size/type/count limits. */}
				{isPMConfigured &&
					isGitLabConnected &&
					canEditProjectManagementSettings &&
					process.env
						.NEXT_PUBLIC_FABRIC_FEATURE_PM_ATTACHMENT_SYNC ===
						"true" && (
						<div className="flex items-center justify-between py-2 border-t">
							<div className="flex-1 pr-4">
								<Label htmlFor="pm-sync-attachments">
									Sync attachments with {pmProviderName}
								</Label>
								<p className="text-muted-foreground text-sm mt-0.5">
									Push this feature's unlocked attachments to
									the linked {pmProviderName} issue, and
									import attachments added there back into
									Fabric. Locked attachments are never pushed,
									and imported files arrive unlocked.
									Configure terminal statuses first —
									attachments are never pushed to a closed
									item.
								</p>
							</div>
							<Switch
								id="pm-sync-attachments"
								checked={syncAttachmentsChecked}
								onCheckedChange={(checked) => {
									// Same re-entrancy guard as pm-auto-close: the
									// backend is last-write-wins, so concurrent
									// PATCHes would diverge the persisted value from
									// the override the user is looking at.
									if (
										updateSyncAttachmentsMutation.isPending
									) {
										return;
									}
									setSyncAttachmentsOverride(checked);
									updateSyncAttachmentsMutation.mutate(
										checked,
									);
								}}
							/>
						</div>
					)}

				{/* Terminal-status chip editor (card #1360 Phase A) */}
				{isPMConfigured && isProjectOwner && (
					<div className="py-2 border-t">
						<TerminalStatusEditor
							value={terminalStatuses}
							onChange={persistTerminalStatuses}
							onSuggest={handleSuggestStatuses}
							isSuggesting={isSuggesting}
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
