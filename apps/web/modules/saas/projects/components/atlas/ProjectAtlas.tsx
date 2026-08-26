"use client";

import type { GraphMode, GraphNode, SystemGraphNode } from "@repo/atlas/types";
/**
 * Project "Atlas" tab — container / orchestrator.
 *
 * Loads the analysis `status` (polling ONLY while a run is in flight), the list
 * of analysable repositories (the selector shows only when there's more than
 * one), and the dependency / capability `graph` for the active mode. Drives the
 * empty / analyzing / failed / ready states and lays the graph out as the main
 * canvas with a persistent full-height chat column. Node details float over
 * the graph canvas itself (same docking pattern as the canvas's search and
 * node-list controls), so selecting a node never shrinks the chat.
 *
 * Changes from original:
 * - Default mode is BUSINESS (AC#2)
 * - Chat is always-on (AC#3)
 * - History panel, tech-stack panel, and business tour wired in (AC#8, #10, #11)
 * - Shared node-position save on drag end (AC#6)
 */
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { FocusModeToggle } from "@saas/shared/components/FocusModeToggle";
import { useFocusMode } from "@saas/shared/contexts/FocusModeContext";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	EmptyState,
	EmptyStateDescription,
	EmptyStateIcon,
	EmptyStateTitle,
} from "@ui/components/empty-state";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	FileJsonIcon,
	FileTextIcon,
	LayoutDashboardIcon,
	Loader2Icon,
	NetworkIcon,
	RefreshCwIcon,
	Share2Icon,
	SparklesIcon,
	XCircleIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { navigateToProjectSettingsTab } from "../settings-tab-navigation";
import { AtlasAboutDialog } from "./AtlasAboutDialog";
import { AtlasAnalyzingState } from "./AtlasAnalyzingState";
import { AtlasChatPanel } from "./AtlasChatPanel";
import { AtlasEdgePanel } from "./AtlasEdgePanel";
import { AtlasGraph, type SelectedSoloEdge } from "./AtlasGraph";
import { AtlasModeToggle } from "./AtlasModeToggle";
import { AtlasNodePanel } from "./AtlasNodePanel";
import { AtlasOverview } from "./AtlasOverview";
import { AtlasRemapMenu } from "./AtlasRemapMenu";
import { AtlasRepoMultiSelect } from "./AtlasRepoMultiSelect";
import { AtlasRepoSelector } from "./AtlasRepoSelector";
import { AtlasStatusBar } from "./AtlasStatusBar";
import { AtlasSystemMap, type SelectedSystemEdge } from "./AtlasSystemMap";
import { AtlasSystemRemapHistoryPanel } from "./AtlasSystemRemapHistoryPanel";
import {
	type EdgeEndpoints,
	SOLO_EDGE_KINDS,
	SYSTEM_EDGE_KINDS,
	soloEdgeKindKey,
} from "./atlas-edges";
import {
	type AtlasExportInput,
	atlasExportFilename,
	buildAtlasExport,
	buildAtlasMarkdown,
	downloadTextFile,
} from "./atlas-export";
import { isAnalysisInFlight } from "./atlas-utils";
import { useStagedGraphEdits } from "./use-staged-graph-edits";

interface ProjectAtlasProps {
	projectId: string;
	organizationSlug?: string;
}

export function ProjectAtlas({ projectId }: ProjectAtlasProps) {
	const t = useTranslations("projects.atlas");
	const { organizationId } = useOrganizationContext();
	const { isFocusMode, registerFocusModeAvailable } = useFocusMode();
	const queryClient = useQueryClient();

	// Business is the default mode (AC#2)
	const [mode, setMode] = useState<GraphMode>("BUSINESS");
	const [repositoryIntegrationId, setRepositoryIntegrationId] = useState<
		string | null
	>(null);
	const [selectedKey, setSelectedKey] = useState<string | null>(null);
	// Selected CONNECTION (edge) — opens the edge panel over the canvas. The solo
	// graph and System map each track their own selected edge (different id
	// spaces); selecting an edge clears the node selection and vice-versa.
	const [selectedEdge, setSelectedEdge] = useState<SelectedSoloEdge | null>(
		null,
	);
	const [selectedSystemEdge, setSelectedSystemEdge] =
		useState<SelectedSystemEdge | null>(null);
	// Lifted "show soft-deleted connections" toggle — threaded into the graph +
	// systemGraph query inputs so the reads include (and mark) removed edges.
	const [includeDeleted, setIncludeDeleted] = useState(false);
	// System map (multi-repo) state.
	const [selectedSystemNode, setSelectedSystemNode] =
		useState<SystemGraphNode | null>(null);
	const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
	const [seededPrompt, setSeededPrompt] = useState<{
		value: string;
		nonce: number;
	} | null>(null);
	const [showHistory, setShowHistory] = useState(false);
	// Top-level view: the repo dashboard ("OVERVIEW", the landing), the per-repo
	// interactive "GRAPH", or the multi-repo "SYSTEM" map. The Business/Technical
	// mode toggle lives inside GRAPH and SYSTEM.
	const [view, setView] = useState<"OVERVIEW" | "GRAPH" | "SYSTEM">(
		"OVERVIEW",
	);

	// --- Repositories (R11) -------------------------------------------------
	const reposQuery = useQuery(
		orpc.atlas.listRepositories.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
	);
	const repositories = reposQuery.data?.repositories ?? [];

	// Restore the repository the user last opened for this project (persisted in
	// localStorage), so returning to Atlas reopens the same repo — not the
	// default. Runs once after the repo list loads, and only if the saved repo
	// still exists.
	const repoRestoredRef = useRef(false);
	useEffect(() => {
		if (repoRestoredRef.current || !reposQuery.isSuccess) {
			return;
		}
		repoRestoredRef.current = true;
		let restored: string | null = null;
		try {
			const saved = localStorage.getItem(`atlas-repo-${projectId}`);
			if (
				saved &&
				repositories.some(
					(repo) => repo.repositoryIntegrationId === saved,
				)
			) {
				restored = saved;
			}
		} catch {
			// localStorage unavailable — fall back to the default repo.
		}
		// Pin the selection to the served/default repo's REAL integration id
		// (mirrors the backend's `resolveRepoOption`) rather than leaving it null.
		// Edge overrides + layouts are keyed by the repo integration id, and the
		// graph reads resolve to this id — so writing them under a raw `null`
		// (when the repo actually HAS an integration id) would store them under a
		// scope the reads never match, silently dropping the user's edits. `null`
		// stays reserved for a true legacy repo whose analysis has no integration.
		const fallback =
			repositories.find((repo) => repo.isDefault) ?? repositories[0];
		setRepositoryIntegrationId(
			restored ?? fallback?.repositoryIntegrationId ?? null,
		);
	}, [reposQuery.isSuccess, projectId, repositories]);

	// Restore (or default to all) the System-map repo selection once repos load.
	const systemReposRestoredRef = useRef(false);
	useEffect(() => {
		if (systemReposRestoredRef.current || !reposQuery.isSuccess) {
			return;
		}
		systemReposRestoredRef.current = true;
		const allIds = repositories
			.map((r) => r.repositoryIntegrationId)
			.filter((id): id is string => Boolean(id));
		let restored: string[] | null = null;
		try {
			const saved = localStorage.getItem(
				`atlas-system-repos-${projectId}`,
			);
			if (saved) {
				const parsed = JSON.parse(saved) as string[];
				restored = parsed.filter((id) => allIds.includes(id));
			}
		} catch {
			// localStorage unavailable — default to all.
		}
		setSelectedRepoIds(restored && restored.length > 0 ? restored : allIds);
	}, [reposQuery.isSuccess, repositories, projectId]);

	// --- Status (poll while a run is in flight) -----------------------------
	const statusQuery = useQuery({
		...orpc.atlas.status.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
			},
		}),
		refetchInterval: (query) => {
			const data = query.state.data;
			// Poll for a first-build run (status PENDING/ANALYZING) AND for a
			// background re-run of an already-READY analysis (status stays READY
			// while `activeRun` is set), so the bar can switch when it clears.
			return isAnalysisInFlight(data?.status) || data?.activeRun != null
				? 4000
				: false;
		},
	});
	const status = statusQuery.data;
	const analysisId = status?.analysisId ?? null;
	const isReady = status?.status === "READY" && !!analysisId;
	const canRenderControls =
		!statusQuery.isLoading &&
		!reposQuery.isLoading &&
		(Boolean(status?.hasRepository) || Boolean(analysisId));

	// Register Focus Mode availability only when Atlas renders the controlsRow toolbar
	useEffect(() => {
		if (!canRenderControls) {
			return;
		}
		return registerFocusModeAvailable();
	}, [canRenderControls, registerFocusModeAvailable]);

	// --- Graph (only once an analysis is READY) -----------------------------
	const graphQuery = useQuery({
		...orpc.atlas.graph.queryOptions({
			input: {
				projectId,
				mode,
				includeDeleted,
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: isReady,
		placeholderData: (prev) => prev,
	});

	// --- System map (multi-repo) --------------------------------------------
	const systemGraphQuery = useQuery({
		...orpc.atlas.systemGraph.queryOptions({
			input: {
				projectId,
				mode,
				includeDeleted,
				repositoryIntegrationIds: selectedRepoIds,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: view === "SYSTEM" && selectedRepoIds.length > 0,
		placeholderData: (prev) => prev,
	});

	const linkMutation = useMutation(
		orpc.atlas.linkRepositories.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.systemGraph.key(),
				});
			},
		}),
	);

	// --- Staged structural edits (Save / Discard) ----------------------------
	// Structural graph edits — node position moves, connection creates, connection
	// deletes — are DRAFTED locally and only persisted on an explicit Save. Each
	// canvas has its own staged-edits draft, keyed by the active context (view +
	// lens + repo selection); switching context or unmounting discards the draft.
	const soloStaged = useStagedGraphEdits(
		`solo:${view}:${mode}:${repositoryIntegrationId ?? "_"}`,
	);
	const systemStaged = useStagedGraphEdits(
		`system:${view}:${mode}:${[...selectedRepoIds].sort().join(",")}`,
	);
	const [isSavingSolo, setIsSavingSolo] = useState(false);
	const [isSavingSystem, setIsSavingSystem] = useState(false);

	// Bare mutations used by Save (no per-call toasts — the save handler owns the
	// success/error toast + invalidation after awaiting the whole batch).
	const saveLayoutMutation = useMutation(
		orpc.atlas.saveLayout.mutationOptions(),
	);
	const saveSystemLayoutMutation = useMutation(
		orpc.atlas.saveSystemLayout.mutationOptions(),
	);
	const createEdgeMutation = useMutation(
		orpc.atlas.createEdge.mutationOptions(),
	);
	const deleteEdgeMutation = useMutation(
		orpc.atlas.deleteEdge.mutationOptions(),
	);

	// Persist the solo graph's staged edits: positions (saveLayout), creates
	// (createEdge), deletes (deleteEdge). Await all; on success invalidate the
	// solo graph + analysis history, clear the draft, toast. On error keep the
	// draft so the user can retry without losing work.
	const handleSaveSolo = useCallback(async () => {
		const count = soloStaged.count;
		if (count === 0) {
			return;
		}
		setIsSavingSolo(true);
		try {
			const tasks: Promise<unknown>[] = [];
			if (soloStaged.positions.size > 0) {
				tasks.push(
					saveLayoutMutation.mutateAsync({
						projectId,
						mode,
						positions: [...soloStaged.positions.entries()].map(
							([key, pos]) => ({ key, x: pos.x, y: pos.y }),
						),
						repositoryIntegrationId:
							repositoryIntegrationId ?? undefined,
						organizationId: organizationId ?? null,
					}),
				);
			}
			for (const create of soloStaged.creates) {
				tasks.push(
					createEdgeMutation.mutateAsync({
						projectId,
						mode,
						sourceRepositoryIntegrationId:
							create.endpoints.sourceRepositoryIntegrationId,
						sourceKey: create.endpoints.sourceKey,
						targetRepositoryIntegrationId:
							create.endpoints.targetRepositoryIntegrationId,
						targetKey: create.endpoints.targetKey,
						kind: create.kind,
						userDescription: create.description || undefined,
						organizationId: organizationId ?? null,
					}),
				);
			}
			for (const [, ep] of soloStaged.deletes) {
				tasks.push(
					deleteEdgeMutation.mutateAsync({
						projectId,
						mode,
						sourceRepositoryIntegrationId:
							ep.sourceRepositoryIntegrationId,
						sourceKey: ep.sourceKey,
						targetRepositoryIntegrationId:
							ep.targetRepositoryIntegrationId,
						targetKey: ep.targetKey,
						organizationId: organizationId ?? null,
					}),
				);
			}
			await Promise.all(tasks);
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.graph.key(),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.history.key(),
			});
			soloStaged.discard();
			toast.success(t("staged.saveSuccess", { count }));
		} catch (error) {
			toast.error(t("staged.saveError"), {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setIsSavingSolo(false);
		}
	}, [
		soloStaged,
		saveLayoutMutation,
		createEdgeMutation,
		deleteEdgeMutation,
		projectId,
		mode,
		repositoryIntegrationId,
		organizationId,
		queryClient,
		t,
	]);

	// Persist the System map's staged edits: positions (saveSystemLayout), creates
	// + deletes (createEdge / deleteEdge). Await all; invalidate the system graph +
	// relationship history; clear the draft; toast. Keep the draft on error.
	const handleSaveSystem = useCallback(async () => {
		const count = systemStaged.count;
		if (count === 0) {
			return;
		}
		setIsSavingSystem(true);
		try {
			const tasks: Promise<unknown>[] = [];
			if (systemStaged.positions.size > 0) {
				tasks.push(
					saveSystemLayoutMutation.mutateAsync({
						projectId,
						mode,
						positions: [...systemStaged.positions.entries()].map(
							([id, pos]) => ({ id, x: pos.x, y: pos.y }),
						),
						organizationId: organizationId ?? null,
					}),
				);
			}
			for (const create of systemStaged.creates) {
				tasks.push(
					createEdgeMutation.mutateAsync({
						projectId,
						mode,
						sourceRepositoryIntegrationId:
							create.endpoints.sourceRepositoryIntegrationId,
						sourceKey: create.endpoints.sourceKey,
						targetRepositoryIntegrationId:
							create.endpoints.targetRepositoryIntegrationId,
						targetKey: create.endpoints.targetKey,
						kind: create.kind,
						userDescription: create.description || undefined,
						organizationId: organizationId ?? null,
					}),
				);
			}
			for (const [, ep] of systemStaged.deletes) {
				tasks.push(
					deleteEdgeMutation.mutateAsync({
						projectId,
						mode,
						sourceRepositoryIntegrationId:
							ep.sourceRepositoryIntegrationId,
						sourceKey: ep.sourceKey,
						targetRepositoryIntegrationId:
							ep.targetRepositoryIntegrationId,
						targetKey: ep.targetKey,
						organizationId: organizationId ?? null,
					}),
				);
			}
			await Promise.all(tasks);
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.systemGraph.key(),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.systemRemapHistory.key(),
			});
			systemStaged.discard();
			toast.success(t("staged.saveSuccess", { count }));
		} catch (error) {
			toast.error(t("staged.saveError"), {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setIsSavingSystem(false);
		}
	}, [
		systemStaged,
		saveSystemLayoutMutation,
		createEdgeMutation,
		deleteEdgeMutation,
		projectId,
		mode,
		organizationId,
		queryClient,
		t,
	]);

	// When the System map is open and its cross-repo edges are stale (a repo was
	// (re-)analysed, or the selection changed), compute them once for this
	// selection. The ref de-dupes so a successful link doesn't re-fire.
	const linkedKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (view !== "SYSTEM") {
			return;
		}
		const data = systemGraphQuery.data;
		if (!data || !data.crossLink.stale || linkMutation.isPending) {
			return;
		}
		const key = [...selectedRepoIds].sort().join(",");
		if (linkedKeyRef.current === key) {
			return;
		}
		linkedKeyRef.current = key;
		linkMutation.mutate({
			projectId,
			repositoryIntegrationIds: selectedRepoIds,
			organizationId: organizationId ?? null,
		});
	}, [
		view,
		systemGraphQuery.data,
		selectedRepoIds,
		linkMutation,
		projectId,
		organizationId,
	]);

	// --- Atlas export (Overview only) ---------------------------------------
	// The Export actions sit on the top controls row beside the Overview/Graph
	// toggle, so the orchestrator owns them. Export needs BOTH graphs; these two
	// queries reuse the Overview dashboard's exact query keys, so they share a
	// cache (no extra round-trips). Gated to the Overview view so the graph view
	// never triggers the off-mode fetch.
	const exportEnabled = isReady && view === "OVERVIEW";
	const exportTechnicalQuery = useQuery({
		...orpc.atlas.graph.queryOptions({
			input: {
				projectId,
				mode: "TECHNICAL",
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: exportEnabled,
		placeholderData: (prev) => prev,
	});
	const exportBusinessQuery = useQuery({
		...orpc.atlas.graph.queryOptions({
			input: {
				projectId,
				mode: "BUSINESS",
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: exportEnabled,
		placeholderData: (prev) => prev,
	});

	const exportInput: AtlasExportInput | null = useMemo(() => {
		if (!status) {
			return null;
		}
		return {
			repositoryName: status.repository?.repositoryName ?? "repository",
			status,
			technical: exportTechnicalQuery.data
				? {
						nodes: exportTechnicalQuery.data.nodes,
						edges: exportTechnicalQuery.data.edges,
					}
				: null,
			business: exportBusinessQuery.data
				? {
						nodes: exportBusinessQuery.data.nodes,
						edges: exportBusinessQuery.data.edges,
					}
				: null,
		};
	}, [status, exportTechnicalQuery.data, exportBusinessQuery.data]);

	const canExport =
		exportEnabled &&
		exportTechnicalQuery.data !== undefined &&
		!!exportInput;

	const handleExportJson = useCallback(() => {
		if (!exportInput) {
			return;
		}
		const data = buildAtlasExport(exportInput);
		downloadTextFile(
			atlasExportFilename(
				exportInput.repositoryName,
				exportInput.status.analyzedShortSha,
				"json",
			),
			JSON.stringify(data, null, 2),
			"application/json",
		);
		toast.success(t("overview.exportDone"));
	}, [exportInput, t]);

	const handleExportMarkdown = useCallback(() => {
		if (!exportInput) {
			return;
		}
		downloadTextFile(
			atlasExportFilename(
				exportInput.repositoryName,
				exportInput.status.analyzedShortSha,
				"md",
			),
			buildAtlasMarkdown(exportInput),
			"text/markdown",
		);
		toast.success(t("overview.exportDone"));
	}, [exportInput, t]);

	// --- Analyse / Re-analyse -----------------------------------------------
	const analyzeMutation = useMutation(
		orpc.atlas.analyze.mutationOptions({
			onSuccess: (next) => {
				queryClient.setQueryData(
					orpc.atlas.status.queryKey({
						input: {
							projectId,
							repositoryIntegrationId:
								repositoryIntegrationId ?? undefined,
							organizationId: organizationId ?? null,
						},
					}),
					next,
				);
				toast.success(t("status.analysisStarted"));
			},
			onError: (error) => {
				toast.error(t("status.analysisError"), {
					description:
						error instanceof Error ? error.message : String(error),
				});
			},
		}),
	);

	const handleAnalyze = useCallback(
		(options?: { fresh?: boolean }) => {
			analyzeMutation.mutate({
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
				// `fresh: true` ignores the user's manual node edits and rebuilds
				// from scratch; the default respects them as high-priority context.
				fresh: options?.fresh ?? false,
			});
		},
		[analyzeMutation, projectId, repositoryIntegrationId, organizationId],
	);

	// --- Re-map relationships (AI link regeneration) ------------------------
	// Solo: regenerate THIS repo's intra-repo references. `fresh` first wipes
	// the user's edge edits/manual edges/deletions (both lenses); otherwise they
	// are preserved. On success invalidate the per-repo graph + analysis history
	// (a solo re-map shows there with a "Re-map" badge).
	const remapSoloMutation = useMutation(
		orpc.atlas.remapSolo.mutationOptions({
			onSuccess: (result) => {
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.graph.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.history.key(),
				});
				toast.success(
					t("remap.soloSuccess", {
						count: result.referencesGenerated,
					}),
				);
			},
			onError: (error) => {
				toast.error(t("remap.error"), {
					description:
						error instanceof Error ? error.message : String(error),
				});
			},
		}),
	);

	// System: regenerate the cross-repo relationships for the current selection.
	// On success invalidate the System graph + the relationship (re-map) history.
	const remapSystemMutation = useMutation(
		orpc.atlas.remapSystem.mutationOptions({
			onSuccess: () => {
				// A fresh recompute is now authoritative for this selection — let
				// the auto-link effect re-run if the next read still reads stale.
				linkedKeyRef.current = null;
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.systemGraph.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.systemRemapHistory.key(),
				});
				toast.success(t("remap.systemSuccess"));
			},
			onError: (error) => {
				toast.error(t("remap.error"), {
					description:
						error instanceof Error ? error.message : String(error),
				});
			},
		}),
	);

	const handleRemapSolo = useCallback(
		(fresh: boolean) => {
			remapSoloMutation.mutate({
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
				fresh,
			});
		},
		[remapSoloMutation, projectId, repositoryIntegrationId, organizationId],
	);

	const handleRemapSystem = useCallback(
		(fresh: boolean) => {
			remapSystemMutation.mutate({
				projectId,
				repositoryIntegrationIds: selectedRepoIds,
				organizationId: organizationId ?? null,
				fresh,
			});
		},
		[remapSystemMutation, projectId, selectedRepoIds, organizationId],
	);

	// When a background re-run completes, the served analysis advances (commit
	// moves, or a fresh re-run changes `analyzedAt`) but the graph / node /
	// overview queries are keyed by project·mode·repo — not the analysis — so
	// they won't refetch on their own. Invalidate them once the analysed
	// snapshot moves so the fresh nodes swap in (placeholderData keeps the old
	// graph visible meanwhile — no blank, no lost selection). The ref skips the
	// initial value so a first load never triggers a redundant refetch.
	const analyzedSignatureRef = useRef<string | null>(null);
	useEffect(() => {
		const signature =
			status?.analyzedCommitSha ?? status?.analyzedAt ?? null;
		if (analyzedSignatureRef.current === null) {
			analyzedSignatureRef.current = signature;
			return;
		}
		if (signature !== null && signature !== analyzedSignatureRef.current) {
			analyzedSignatureRef.current = signature;
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.graph.key(),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.node.key(),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.atlas.history.key(),
			});
		}
	}, [status?.analyzedCommitSha, status?.analyzedAt, queryClient]);

	// --- Cancel the in-flight analysis --------------------------------------
	const cancelMutation = useMutation(
		orpc.atlas.cancelAnalysis.mutationOptions({
			onSuccess: (next) => {
				// Adopt the server's refreshed status immediately, then refetch
				// so any follow-on reconciliation lands too.
				queryClient.setQueryData(
					orpc.atlas.status.queryKey({
						input: {
							projectId,
							repositoryIntegrationId:
								repositoryIntegrationId ?? undefined,
							organizationId: organizationId ?? null,
						},
					}),
					next,
				);
				queryClient.invalidateQueries({
					queryKey: orpc.atlas.status.queryKey({
						input: {
							projectId,
							repositoryIntegrationId:
								repositoryIntegrationId ?? undefined,
							organizationId: organizationId ?? null,
						},
					}),
				});
				toast.success(t("cancel.cancelled"));
			},
			onError: (error) => {
				toast.error(t("cancel.error"), {
					description:
						error instanceof Error ? error.message : String(error),
				});
			},
		}),
	);

	const handleCancel = useCallback(() => {
		cancelMutation.mutate({
			projectId,
			repositoryIntegrationId: repositoryIntegrationId ?? undefined,
			organizationId: organizationId ?? null,
		});
	}, [cancelMutation, projectId, repositoryIntegrationId, organizationId]);

	const handleSelectNode = useCallback((key: string) => {
		setSelectedKey(key);
		// A node and a connection panel never co-exist over the same canvas.
		setSelectedEdge(null);
	}, []);

	// Localised edge-kind labels for the edge panels. Solo kinds reuse the node
	// namespace's `edgeKind.*`; System (cross-repo) kinds use `system.edgeKind.*`.
	const soloEdgeKindLabel = useCallback(
		(kind: string) => {
			const key = soloEdgeKindKey(kind);
			return key ? t(`node.edgeKind.${key}`) : kind;
		},
		[t],
	);
	const systemEdgeKindLabel = useCallback(
		(kind: string) => {
			if (
				kind === "CALLS_API" ||
				kind === "DEPENDS_ON" ||
				kind === "SHARES_LIBRARY" ||
				kind === "RELATES_TO"
			) {
				return t(`system.edgeKind.${kind}`);
			}
			return kind;
		},
		[t],
	);

	// Selectable connection types for the edge panel's "Type" selector (re-typing
	// an existing connection), per scope + localised.
	const soloKindOptions = useMemo(
		() =>
			SOLO_EDGE_KINDS.map((k) => ({
				value: k,
				label: soloEdgeKindLabel(k),
			})),
		[soloEdgeKindLabel],
	);
	const systemKindOptions = useMemo(
		() =>
			SYSTEM_EDGE_KINDS.map((k) => ({
				value: k,
				label: systemEdgeKindLabel(k),
			})),
		[systemEdgeKindLabel],
	);

	// Solo-graph connection selection (canvas edge click or connections-list row).
	const handleSelectEdge = useCallback((edge: SelectedSoloEdge) => {
		setSelectedEdge(edge);
		setSelectedKey(null);
	}, []);
	const handleCloseEdgePanel = useCallback(() => {
		setSelectedEdge(null);
		canvasRef.current?.focus();
	}, []);
	// After any edge mutation: drop the selection when the edge was removed (the
	// panel for a now-missing edge would be stale); a description/restore edit
	// keeps it open (the invalidated query re-reads fresh values into the list).
	const handleEdgeChanged = useCallback(
		(event: { deleted?: boolean; restored?: boolean }) => {
			if (event.deleted && !includeDeleted) {
				setSelectedEdge(null);
			}
		},
		[includeDeleted],
	);
	// Stage a solo connection delete (from the edge panel) — the canvas hides the
	// edge until Save, so always close the panel for the now-hidden connection.
	const handleStageSoloDelete = useCallback(
		(endpoints: EdgeEndpoints) => {
			soloStaged.stageDelete(endpoints);
			setSelectedEdge(null);
		},
		[soloStaged],
	);

	// System-map connection selection.
	const handleSelectSystemEdge = useCallback((edge: SelectedSystemEdge) => {
		setSelectedSystemEdge(edge);
		setSelectedSystemNode(null);
	}, []);
	const handleSystemEdgeChanged = useCallback(
		(event: { deleted?: boolean; restored?: boolean }) => {
			if (event.deleted && !includeDeleted) {
				setSelectedSystemEdge(null);
			}
		},
		[includeDeleted],
	);
	// Stage a cross-repo connection delete (from the edge panel) — close the panel.
	const handleStageSystemDelete = useCallback(
		(endpoints: EdgeEndpoints) => {
			systemStaged.stageDelete(endpoints);
			setSelectedSystemEdge(null);
		},
		[systemStaged],
	);

	// The graph canvas container — focus returns here when the floating node
	// panel closes so keyboard users aren't dropped (`tabIndex={-1}` makes it
	// programmatically focusable without joining the tab order).
	const canvasRef = useRef<HTMLDivElement>(null);

	const handleCloseNodePanel = useCallback(() => {
		setSelectedKey(null);
		canvasRef.current?.focus();
	}, []);

	const handleFocusNode = useCallback((key: string) => {
		setSelectedKey(key);
		// Graph will auto-pan to the selected node via its effect.
	}, []);

	const handleAskAi = useCallback((nodeKey: string, nodeLabel: string) => {
		setSelectedKey(nodeKey);
		setSeededPrompt({
			value: `Tell me about "${nodeLabel}" — what it does, how it fits into the codebase, and what depends on it.`,
			nonce: Date.now(),
		});
	}, []);

	// --- System map node helpers (chat linkifier + node panel) -------------
	const systemNodeById = useMemo(
		() =>
			new Map((systemGraphQuery.data?.nodes ?? []).map((n) => [n.id, n])),
		[systemGraphQuery.data?.nodes],
	);
	const systemGraphNodes = useMemo(
		() =>
			(systemGraphQuery.data?.nodes ?? [])
				.filter((n) => n.kind !== "REPO_GROUP")
				.map((n) => ({ key: n.id, label: n.label })),
		[systemGraphQuery.data?.nodes],
	);
	const handleSelectSystemNode = useCallback(
		(node: SystemGraphNode | null) => setSelectedSystemNode(node),
		[],
	);
	const handleFocusSystemNode = useCallback(
		(id: string) => {
			const n = systemNodeById.get(id);
			if (n && n.kind !== "REPO_GROUP") {
				setSelectedSystemNode(n);
			}
		},
		[systemNodeById],
	);
	const handleSystemNeighborSelect = useCallback(
		(key: string) => {
			setSelectedSystemNode((cur) =>
				cur
					? (systemNodeById.get(`${cur.analysisId}::${key}`) ?? cur)
					: cur,
			);
		},
		[systemNodeById],
	);
	const handleSystemAskAi = useCallback(
		(_nodeKey: string, nodeLabel: string) => {
			setSeededPrompt({
				value: `Tell me about "${nodeLabel}" — what it does, how it fits into the system, and what other repositories relate to it.`,
				nonce: Date.now(),
			});
		},
		[],
	);

	const handleModeChange = useCallback((next: GraphMode) => {
		setMode(next);
		// A node/edge key from one mode's graph may not exist in the other.
		setSelectedKey(null);
		setSelectedSystemNode(null);
		setSelectedEdge(null);
		setSelectedSystemEdge(null);
	}, []);

	const handleRepoChange = useCallback(
		(next: string | null) => {
			setRepositoryIntegrationId(next);
			setSelectedKey(null);
			setSelectedEdge(null);
			// Remember the choice so the next Atlas visit reopens this repo.
			try {
				if (next) {
					localStorage.setItem(`atlas-repo-${projectId}`, next);
				} else {
					localStorage.removeItem(`atlas-repo-${projectId}`);
				}
			} catch {
				// localStorage unavailable — non-fatal.
			}
		},
		[projectId],
	);

	// Jump from the Overview dashboard into the interactive graph, focused on a
	// specific node in its mode (Technical for modules, Business for capabilities).
	const handleOpenNodeFromOverview = useCallback(
		(nextMode: GraphMode, key: string) => {
			setMode(nextMode);
			setSelectedKey(key);
			setView("GRAPH");
		},
		[],
	);

	const handleSystemReposChange = useCallback(
		(ids: string[]) => {
			setSelectedRepoIds(ids);
			setSelectedSystemNode(null);
			setSelectedSystemEdge(null);
			try {
				localStorage.setItem(
					`atlas-system-repos-${projectId}`,
					JSON.stringify(ids),
				);
			} catch {
				// localStorage unavailable — non-fatal.
			}
		},
		[projectId],
	);

	// Repos with a real integration id — the System map can combine these.
	const systemRepoCount = repositories.filter(
		(r) => r.repositoryIntegrationId,
	).length;
	const showSystemMap = systemRepoCount >= 2;

	const showRepoSelector = repositories.length > 1;

	// Flat node list for the chat linkifier (AC#4).
	const graphNodes: Pick<GraphNode, "key" | "label">[] = useMemo(
		() =>
			(graphQuery.data?.nodes ?? []).map((n) => ({
				key: n.key,
				label: n.label,
			})),
		[graphQuery.data?.nodes],
	);

	// The most-connected node on the active graph — seeds a dynamic starter chip
	// ("What does {capability} depend on?") in the chat's empty state.
	const topNodeLabel = useMemo(() => {
		const data = graphQuery.data;
		if (!data || data.nodes.length === 0) {
			return null;
		}
		const degree = new Map<string, number>();
		for (const edge of data.edges) {
			degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
			degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
		}
		let best = data.nodes[0];
		let bestDegree = degree.get(best.key) ?? 0;
		for (const node of data.nodes) {
			const nodeDegree = degree.get(node.key) ?? 0;
			if (nodeDegree > bestDegree) {
				best = node;
				bestDegree = nodeDegree;
			}
		}
		return best.label;
	}, [graphQuery.data]);

	// Top controls row reused across ready/empty(stale) states.
	const controlsRow = useMemo(
		() => (
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					{/* Top-level view switch: repo dashboard ⇄ interactive graph.
					    Two labelled toggle buttons (aria-pressed) — no group role
					    needed. */}
					<div
						data-onboarding-target="atlas-view-switch"
						className="inline-flex items-center gap-1 rounded-xl border border-border/60 bg-muted/60 p-1"
					>
						{(["OVERVIEW", "GRAPH", "SYSTEM"] as const).map(
							(option) => {
								const isActive = view === option;
								const Icon =
									option === "OVERVIEW"
										? LayoutDashboardIcon
										: option === "SYSTEM"
											? Share2Icon
											: NetworkIcon;
								const label =
									option === "OVERVIEW"
										? t("view.overview")
										: option === "SYSTEM"
											? t("view.system")
											: t("view.graph");
								// The System map stays VISIBLE even with <2 analysed
								// repos, but disabled with a hint to connect more —
								// so the capability is discoverable.
								const lockedSystem =
									option === "SYSTEM" && !showSystemMap;
								const disabled = !isReady || lockedSystem;
								const button = (
									<button
										type="button"
										aria-pressed={isActive}
										disabled={disabled}
										onClick={() => setView(option)}
										className={cn(
											"flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
											isActive
												? "bg-card text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground",
											disabled &&
												"cursor-not-allowed opacity-60",
										)}
									>
										<Icon
											aria-hidden="true"
											className={cn(
												"size-4",
												isActive && "text-primary",
											)}
										/>
										{label}
									</button>
								);
								// A disabled button doesn't emit hover events — wrap
								// it in a focusable span so the "add more repos" hint
								// still appears on hover/focus.
								if (isReady && lockedSystem) {
									return (
										<Tooltip key={option}>
											<TooltipTrigger asChild>
												<span className="inline-flex">
													{button}
												</span>
											</TooltipTrigger>
											<TooltipContent>
												{t("system.needMoreRepos")}
											</TooltipContent>
										</Tooltip>
									);
								}
								return (
									<span key={option} className="inline-flex">
										{button}
									</span>
								);
							},
						)}
					</div>
					{/* General "About Atlas" affordance — a click-to-open card
					    explaining the Atlas FEATURE (Analyse · Map · Explore ·
					    Ask), distinct from the per-mode Business/Technical
					    tooltip on the graph toggle. */}
					<AtlasAboutDialog />
					{(view === "GRAPH" || view === "SYSTEM") && (
						<AtlasModeToggle
							mode={mode}
							onChange={handleModeChange}
							disabled={!isReady}
						/>
					)}
					{/* Re-map relationships — regenerate the AI-derived
					    connections (keep edits / fresh reset). Solo scope re-maps
					    this repo's intra-repo references; System scope re-maps the
					    cross-repo relationships. */}
					{view === "GRAPH" && (
						<AtlasRemapMenu
							scope="solo"
							onRemap={handleRemapSolo}
							isPending={remapSoloMutation.isPending}
							disabled={!isReady}
						/>
					)}
					{view === "SYSTEM" && showSystemMap && (
						<AtlasRemapMenu
							scope="system"
							onRemap={handleRemapSystem}
							isPending={remapSystemMutation.isPending}
							disabled={!isReady || selectedRepoIds.length === 0}
						/>
					)}
				</div>
				<div className="flex items-center gap-2">
					<PageTourButton pageId="atlas" />
					{/* Export sits at the top level beside the view toggle and only
					    on the Overview view (the dashboard it snapshots). */}
					{isReady && view === "OVERVIEW" && (
						<>
							<span className="hidden text-[11px] uppercase tracking-[0.16em] text-muted-foreground/70 sm:inline">
								{t("overview.export")}
							</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={handleExportJson}
								disabled={!canExport}
								className="gap-1.5"
							>
								<FileJsonIcon
									aria-hidden="true"
									className="size-4"
								/>
								{t("overview.exportJson")}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={handleExportMarkdown}
								disabled={!canExport}
								className="gap-1.5"
							>
								<FileTextIcon
									aria-hidden="true"
									className="size-4"
								/>
								{t("overview.exportMarkdown")}
							</Button>
						</>
					)}
					{/* System map: choose which connected repos to combine. */}
					{view === "SYSTEM" && showSystemMap && (
						<AtlasRepoMultiSelect
							repositories={repositories}
							value={selectedRepoIds}
							onChange={handleSystemReposChange}
							disabled={linkMutation.isPending}
						/>
					)}
					{/* In the READY view the repository dropdown lives in the
					    status bar (first item). Keep a standalone selector here
					    only for the non-ready states (no status bar yet) so
					    multi-repo switching still works before the first analysis. */}
					{!isReady && showRepoSelector && (
						<AtlasRepoSelector
							repositories={repositories}
							value={repositoryIntegrationId}
							onChange={handleRepoChange}
							disabled={analyzeMutation.isPending}
						/>
					)}
					<FocusModeToggle />
				</div>
			</div>
		),
		[
			mode,
			handleModeChange,
			isReady,
			showRepoSelector,
			showSystemMap,
			repositories,
			repositoryIntegrationId,
			handleRepoChange,
			selectedRepoIds,
			handleSystemReposChange,
			linkMutation.isPending,
			analyzeMutation.isPending,
			view,
			t,
			canExport,
			handleExportJson,
			handleExportMarkdown,
			handleRemapSolo,
			handleRemapSystem,
			remapSoloMutation.isPending,
			remapSystemMutation.isPending,
		],
	);

	// --- Loading skeleton (initial status / repos) -------------------------
	if (statusQuery.isLoading || reposQuery.isLoading) {
		return (
			<div className="space-y-4">
				<Skeleton className="h-14 w-full rounded-xl" />
				<Skeleton className="h-[600px] w-full rounded-xl" />
			</div>
		);
	}

	// --- No repository connected -------------------------------------------
	// Only when the project truly has no repository AND has never been analysed.
	// A previously-analysed repo whose credential later lapsed (expired /
	// disconnected) still has `analysisId`, so its map stays viewable read-only
	// below — with Re-analyse gated until the repo is re-authenticated.
	if (!status?.hasRepository && !status?.analysisId) {
		return (
			<div className="rounded-2xl border border-border/60 bg-card/70 py-12">
				<EmptyState>
					<EmptyStateIcon>
						<NetworkIcon className="size-10" />
					</EmptyStateIcon>
					<EmptyStateTitle className="font-serif text-2xl font-normal">
						{t("empty.noRepoTitle")}
					</EmptyStateTitle>
					<EmptyStateDescription className="max-w-md">
						{t("empty.noRepoDescription")}
					</EmptyStateDescription>
				</EmptyState>
			</div>
		);
	}

	// --- Failed -------------------------------------------------------------
	if (status.status === "FAILED") {
		// A user-cancelled run reuses the FAILED terminal state (no CANCELLED
		// enum) but reads as a deliberate cancellation, not an error.
		const wasCancelled = status.error === "Cancelled by user";
		// A repository auth/connection failure (the analysis flips the repo to a
		// non-ACTIVE state and surfaces the reconnect guidance) gets a one-click
		// Reconnect CTA + the amber "recoverable" tone, not the red hard-error one
		// — "Try again" alone would just re-fail until the repository is
		// reconnected. Non-repo failures keep the plain retry.
		const needsReconnect =
			!wasCancelled &&
			status.repositoryStatus != null &&
			status.repositoryStatus !== "ACTIVE" &&
			status.repositoryStatus !== "REPO_UNAVAILABLE";
		// No-access rows get the amber recoverable tone too, but the copy and
		// CTA differ: reconnecting cannot grant access to this repository.
		const repoUnavailable =
			!wasCancelled && status.repositoryStatus === "REPO_UNAVAILABLE";
		return (
			<div className="space-y-4">
				{controlsRow}
				<div
					className={cn(
						"rounded-2xl border py-12",
						wasCancelled
							? "border-border/60 bg-muted/40"
							: needsReconnect || repoUnavailable
								? "border-highlight/40 bg-highlight/5"
								: "border-destructive/30 bg-destructive/5",
					)}
				>
					<EmptyState>
						<EmptyStateIcon>
							{wasCancelled ? (
								<XCircleIcon className="size-10 text-muted-foreground" />
							) : (
								<AlertTriangleIcon
									className={cn(
										"size-10",
										needsReconnect || repoUnavailable
											? "text-highlight"
											: "text-destructive",
									)}
								/>
							)}
						</EmptyStateIcon>
						<EmptyStateTitle className="font-serif text-2xl font-normal">
							{wasCancelled
								? t("cancel.cancelledTitle")
								: repoUnavailable
									? t("status.repoUnavailable")
									: needsReconnect
										? t("status.reconnectNeeded")
										: t("failed.title")}
						</EmptyStateTitle>
						<EmptyStateDescription className="max-w-md">
							{wasCancelled
								? t("cancel.cancelledBody")
								: repoUnavailable
									? t("status.repoUnavailableTooltip")
									: needsReconnect
										? t("status.reconnectNeededTooltip")
										: (status.error ??
											t("failed.description"))}
						</EmptyStateDescription>
						<div className="flex flex-wrap items-center justify-center gap-2">
							{(needsReconnect || repoUnavailable) && (
								<Button
									type="button"
									onClick={() =>
										navigateToProjectSettingsTab(
											projectId,
											"development",
										)
									}
									className="gap-1.5"
								>
									{repoUnavailable
										? t("status.manageRepository")
										: t("status.reconnect")}
								</Button>
							)}
							<Button
								type="button"
								variant={needsReconnect ? "outline" : "default"}
								onClick={() => handleAnalyze()}
								disabled={analyzeMutation.isPending}
								className="gap-1.5"
							>
								<RefreshCwIcon
									aria-hidden="true"
									className="size-4"
								/>
								{wasCancelled
									? t("cancel.startNew")
									: t("failed.retry")}
							</Button>
						</div>
					</EmptyState>
				</div>
			</div>
		);
	}

	// --- Analyzing / Pending -----------------------------------------------
	if (isAnalysisInFlight(status.status)) {
		return (
			<div className="space-y-4">
				{controlsRow}
				<AtlasAnalyzingState
					inFlightSince={status.inFlightSince}
					onCancel={handleCancel}
					isCancelling={cancelMutation.isPending}
				/>
			</div>
		);
	}

	// --- Not analysed yet (has repo, never run) ----------------------------
	if (status.status === "NOT_ANALYZED" || !isReady) {
		return (
			<div className="space-y-4">
				{controlsRow}
				<div className="rounded-2xl border border-border/60 bg-card/70 py-16">
					<EmptyState>
						<EmptyStateIcon>
							<NetworkIcon className="size-10" />
						</EmptyStateIcon>
						<EmptyStateTitle className="font-serif text-2xl font-normal">
							{t("empty.notAnalyzedTitle")}
						</EmptyStateTitle>
						<EmptyStateDescription className="max-w-md">
							{t("empty.notAnalyzedDescription")}
						</EmptyStateDescription>
						<Button
							data-onboarding-target="atlas-analyze"
							type="button"
							onClick={() => handleAnalyze()}
							disabled={analyzeMutation.isPending}
							className="gap-1.5"
						>
							{analyzeMutation.isPending ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
							) : (
								<SparklesIcon
									aria-hidden="true"
									className="size-4"
								/>
							)}
							{t("empty.analyzeCta")}
						</Button>
					</EmptyState>
				</div>
			</div>
		);
	}

	// --- Ready --------------------------------------------------------------
	return (
		<div className="space-y-4">
			<AtlasStatusBar
				projectId={projectId}
				status={status}
				onAnalyze={handleAnalyze}
				isAnalyzing={analyzeMutation.isPending}
				showHistory={showHistory}
				onToggleHistory={() => setShowHistory((v) => !v)}
				// In the System map view the History toggle surfaces the
				// cross-repo relationship (re-map) history instead of the
				// per-repo analysis history.
				historyPanel={
					view === "SYSTEM" ? (
						<AtlasSystemRemapHistoryPanel
							projectId={projectId}
							onClose={() => setShowHistory(false)}
						/>
					) : undefined
				}
				repositories={repositories}
				repositoryIntegrationId={repositoryIntegrationId}
				onRepoChange={handleRepoChange}
				repoChangeDisabled={analyzeMutation.isPending}
			/>
			{controlsRow}

			{view === "OVERVIEW" && (
				<AtlasOverview
					projectId={projectId}
					organizationId={organizationId}
					repositoryIntegrationId={repositoryIntegrationId}
					status={status}
					onOpenNode={handleOpenNodeFromOverview}
				/>
			)}

			{/* Graph + chat (Graph view only). On lg+ they sit side by side;
			    below lg the chat stacks beneath the graph. Node details float
			    OVER the canvas, so the chat column never changes with selection. */}
			{view === "GRAPH" && (
				<div className="flex flex-col gap-4 lg:flex-row">
					<div
						ref={canvasRef}
						tabIndex={-1}
						className={cn(
							"min-w-0 overflow-hidden rounded-2xl border border-border/60",
							"h-[520px] lg:h-[680px]",
							// `flex-1` only on lg+ (horizontal split). On mobile the
							// parent is a flex-col with no fixed height, where an
							// unconditional `flex-1` (basis-0) collapses the graph to
							// 0px — so the fixed h-[520px] must win there.
							"relative lg:flex-1",
							// Programmatic focus target on panel close — no ring.
							"focus-visible:outline-none",
						)}
					>
						{graphQuery.isLoading ? (
							<div className="flex h-full items-center justify-center">
								<Loader2Icon
									aria-label={t("graph.loading")}
									className="size-6 text-muted-foreground motion-safe:animate-spin"
								/>
							</div>
						) : graphQuery.isError ? (
							<div className="flex h-full items-center justify-center p-6 text-center">
								<p className="text-sm text-destructive">
									{t("graph.loadError")}
								</p>
							</div>
						) : graphQuery.data &&
							graphQuery.data.nodes.length > 0 ? (
							<AtlasGraph
								nodes={graphQuery.data.nodes}
								edges={graphQuery.data.edges}
								selectedKey={selectedKey}
								onSelectNode={handleSelectNode}
								onSelectEdge={handleSelectEdge}
								selectedEdgeKey={
									selectedEdge
										? `${selectedEdge.endpoints.sourceKey}__${selectedEdge.endpoints.targetKey}`
										: null
								}
								projectId={projectId}
								mode={mode}
								repositoryIntegrationId={
									repositoryIntegrationId
								}
								includeDeleted={includeDeleted}
								onIncludeDeletedChange={setIncludeDeleted}
								staged={soloStaged}
								onSaveStaged={handleSaveSolo}
								isSavingStaged={isSavingSolo}
							/>
						) : (
							<div className="flex h-full items-center justify-center p-6 text-center">
								<p className="text-sm text-muted-foreground">
									{t("graph.empty")}
								</p>
							</div>
						)}

						{/* Node details float over the canvas (same docking as the
						    search / node-list controls, above their z-10). Non-modal:
						    no focus trap, no backdrop — the uncovered canvas keeps
						    panning/zooming. Escape (from anywhere inside) closes and
						    returns focus to the canvas. Full-width overlay below lg. */}
						{selectedKey && analysisId && (
							// biome-ignore lint/a11y/noStaticElementInteractions: keyboard-dismiss container — Escape handling for the focusable controls inside; not an interactive element itself.
							<div
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.stopPropagation();
										handleCloseNodePanel();
									}
								}}
								className={cn(
									"absolute inset-x-3 top-3 bottom-3 z-20",
									"lg:left-auto lg:w-[22rem] lg:max-w-[calc(100%-1.5rem)]",
									"overflow-hidden rounded-xl border border-border/60 bg-background shadow-md",
									"motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2",
								)}
							>
								<AtlasNodePanel
									projectId={projectId}
									analysisId={analysisId}
									mode={mode}
									nodeKey={selectedKey}
									onClose={handleCloseNodePanel}
									onSelectNode={handleSelectNode}
									onAskAi={handleAskAi}
								/>
							</div>
						)}

						{/* Connection (edge) details float over the canvas with the
						    same docking/overlay pattern as the node panel. */}
						{selectedEdge && (
							// biome-ignore lint/a11y/noStaticElementInteractions: keyboard-dismiss container for the focusable controls inside.
							<div
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.stopPropagation();
										handleCloseEdgePanel();
									}
								}}
								className={cn(
									"absolute inset-x-3 top-3 bottom-3 z-20",
									"lg:left-auto lg:w-[22rem] lg:max-w-[calc(100%-1.5rem)]",
									"overflow-hidden rounded-xl border border-border/60 bg-background shadow-md",
									"motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2",
								)}
							>
								<AtlasEdgePanel
									projectId={projectId}
									mode={mode}
									endpoints={selectedEdge.endpoints}
									kind={selectedEdge.kind}
									kindLabel={soloEdgeKindLabel(
										selectedEdge.kind,
									)}
									kindOptions={soloKindOptions}
									sourceLabel={selectedEdge.sourceLabel}
									targetLabel={selectedEdge.targetLabel}
									description={selectedEdge.description}
									isManual={selectedEdge.isManual}
									isUserDescription={
										selectedEdge.isUserDescription
									}
									deleted={selectedEdge.deleted}
									onClose={handleCloseEdgePanel}
									onChanged={handleEdgeChanged}
									onStageDelete={handleStageSoloDelete}
								/>
							</div>
						)}
					</div>

					{/* Right column: always-on chat at full height (AC#3) — node
					    selection never resizes or remounts it. Kept mounted in
					    Focus Mode to preserve in-flight streams and drafts. */}
					<div
						className={cn(
							"flex w-full min-w-0 shrink-0 flex-col gap-4 lg:w-[26rem]",
							isFocusMode && "hidden",
						)}
						aria-hidden={isFocusMode}
						inert={isFocusMode ? true : undefined}
					>
						<div className="h-[420px] lg:h-[680px]">
							<AtlasChatPanel
								projectId={projectId}
								mode={mode}
								focusNodeKey={selectedKey}
								repositoryIntegrationId={
									repositoryIntegrationId
								}
								seededPrompt={seededPrompt}
								onSeededPromptConsumed={() =>
									setSeededPrompt(null)
								}
								graphNodes={graphNodes}
								onFocusNode={handleFocusNode}
								suggestedCapability={topNodeLabel}
							/>
						</div>
					</div>
				</div>
			)}
			{/* System map (multi-repo view): repos as group containers + the
				    cross-repo edges between them, with a chat that spans repos. */}
			{view === "SYSTEM" && (
				<div className="flex flex-col gap-4 lg:flex-row">
					<div
						className={cn(
							"relative min-w-0 overflow-hidden rounded-2xl border border-border/60",
							"h-[520px] lg:h-[680px] lg:flex-1",
							"focus-visible:outline-none",
						)}
					>
						{systemGraphQuery.isLoading ? (
							<div className="flex h-full items-center justify-center">
								<Loader2Icon
									aria-label={t("graph.loading")}
									className="size-6 text-muted-foreground motion-safe:animate-spin"
								/>
							</div>
						) : systemGraphQuery.isError ? (
							<div className="flex h-full items-center justify-center p-6 text-center">
								<p className="text-sm text-destructive">
									{t("graph.loadError")}
								</p>
							</div>
						) : systemGraphQuery.data &&
							systemGraphQuery.data.repos.length > 0 ? (
							<>
								<AtlasSystemMap
									systemGraph={systemGraphQuery.data}
									selectedNodeId={
										selectedSystemNode?.id ?? null
									}
									onSelectNode={handleSelectSystemNode}
									onSelectEdge={handleSelectSystemEdge}
									projectId={projectId}
									mode={mode}
									organizationId={organizationId ?? null}
									includeDeleted={includeDeleted}
									onIncludeDeletedChange={setIncludeDeleted}
									savedPositions={
										systemGraphQuery.data.layouts
									}
									staged={systemStaged}
									onSaveStaged={handleSaveSystem}
									isSavingStaged={isSavingSystem}
								/>
								{(linkMutation.isPending ||
									systemGraphQuery.data.crossLink.status ===
										"RUNNING") && (
									<div className="absolute top-3 right-3 z-10 flex items-center gap-2 rounded-lg border border-border/60 bg-background/90 px-3 py-1.5 text-muted-foreground text-xs shadow-sm">
										<Loader2Icon
											aria-hidden="true"
											className="size-3.5 motion-safe:animate-spin"
										/>
										{t("system.linking")}
									</div>
								)}
							</>
						) : (
							<div className="flex h-full items-center justify-center p-6 text-center">
								<p className="text-sm text-muted-foreground">
									{t("system.empty")}
								</p>
							</div>
						)}

						{selectedSystemNode?.originalKey && (
							// biome-ignore lint/a11y/noStaticElementInteractions: keyboard-dismiss container for the focusable controls inside.
							<div
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.stopPropagation();
										setSelectedSystemNode(null);
									}
								}}
								className={cn(
									"absolute inset-x-3 top-3 bottom-3 z-20",
									"lg:left-auto lg:w-[22rem] lg:max-w-[calc(100%-1.5rem)]",
									"overflow-hidden rounded-xl border border-border/60 bg-background shadow-md",
									"motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2",
								)}
							>
								<AtlasNodePanel
									projectId={projectId}
									analysisId={selectedSystemNode.analysisId}
									mode={mode}
									nodeKey={selectedSystemNode.originalKey}
									onClose={() => setSelectedSystemNode(null)}
									onSelectNode={handleSystemNeighborSelect}
									onAskAi={handleSystemAskAi}
								/>
							</div>
						)}

						{/* Cross-repo connection details float over the System
							    map canvas (replaces the old simple edge-detail card). */}
						{selectedSystemEdge && (
							// biome-ignore lint/a11y/noStaticElementInteractions: keyboard-dismiss container for the focusable controls inside.
							<div
								onKeyDown={(event) => {
									if (event.key === "Escape") {
										event.stopPropagation();
										setSelectedSystemEdge(null);
									}
								}}
								className={cn(
									"absolute inset-x-3 top-3 bottom-3 z-20",
									"lg:left-auto lg:w-[22rem] lg:max-w-[calc(100%-1.5rem)]",
									"overflow-hidden rounded-xl border border-border/60 bg-background shadow-md",
									"motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-2",
								)}
							>
								<AtlasEdgePanel
									projectId={projectId}
									mode={mode}
									endpoints={selectedSystemEdge.endpoints}
									kind={selectedSystemEdge.kind}
									kindLabel={systemEdgeKindLabel(
										selectedSystemEdge.kind,
									)}
									kindOptions={systemKindOptions}
									sourceLabel={selectedSystemEdge.sourceLabel}
									targetLabel={selectedSystemEdge.targetLabel}
									description={selectedSystemEdge.description}
									isManual={selectedSystemEdge.isManual}
									isUserDescription={
										selectedSystemEdge.isUserDescription
									}
									deleted={selectedSystemEdge.deleted}
									onClose={() => setSelectedSystemEdge(null)}
									onChanged={handleSystemEdgeChanged}
									onStageDelete={handleStageSystemDelete}
								/>
							</div>
						)}
					</div>

					<div
						className={cn(
							"flex w-full min-w-0 shrink-0 flex-col gap-4 lg:w-[26rem]",
							isFocusMode && "hidden",
						)}
						aria-hidden={isFocusMode}
						inert={isFocusMode ? true : undefined}
					>
						<div className="h-[420px] lg:h-[680px]">
							<AtlasChatPanel
								projectId={projectId}
								mode={mode}
								focusNodeKey={null}
								repositoryIntegrationId={null}
								systemScope={{
									repositoryIntegrationIds: selectedRepoIds,
								}}
								seededPrompt={seededPrompt}
								onSeededPromptConsumed={() =>
									setSeededPrompt(null)
								}
								graphNodes={systemGraphNodes}
								onFocusNode={handleFocusSystemNode}
								suggestedCapability={null}
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
