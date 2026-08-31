"use client";

/**
 * Fabric Loom Agent Page
 *
 * Fullscreen dedicated page with:
 * - Breadcrumb navigation back to agents list
 * - Left sidebar for history/settings/tools
 * - Main chat area (Direct mode or Orchestrator mode)
 * - Direct MCP tool execution (no CopilotKit dependency)
 *
 * This page completely removes CopilotKit and uses custom streaming
 * implementations for both direct and orchestrator modes.
 *
 * Performance optimizations:
 * - Dynamic imports for heavy chat components (54KB+ each)
 * - CSS containment for sidebar to prevent CLS
 * - Fixed minimum widths to prevent layout shifts
 */

import { AgentErrorBoundary } from "@saas/agents/components/AgentErrorBoundary";
import type { TemporalOrchestratorActivityState } from "@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat";
import { useOrchestratorConfig } from "@saas/agents/components/OrchestratorConfigPanel";
import type { MentionableTemplate } from "@saas/agents/hooks/useTemplateMention";
import { getInterfaceModeChrome } from "@saas/agents/lib/interface-mode-chrome";
import dynamic from "next/dynamic";

// Dynamic imports for heavy components to improve initial load time
const FabricDirectChat = dynamic(
	() =>
		import("@saas/agents/components/FabricChat/FabricDirectChat").then(
			(mod) => ({ default: mod.FabricDirectChat }),
		),
	{
		loading: () => <ChatLoadingSkeleton />,
		ssr: false,
	},
);

const FabricTemporalOrchestratorChat = dynamic(
	() =>
		import(
			"@saas/agents/components/FabricChat/FabricTemporalOrchestratorChat"
		).then((mod) => ({ default: mod.FabricTemporalOrchestratorChat })),
	{
		loading: () => <ChatLoadingSkeleton />,
		ssr: false,
	},
);

const OrchestratorConfigPanel = dynamic(
	() =>
		import("@saas/agents/components/OrchestratorConfigPanel").then(
			(mod) => ({ default: mod.OrchestratorConfigPanel }),
		),
	{
		loading: () => <ConfigPanelSkeleton />,
		ssr: false,
	},
);

const WorkflowProgressPanel = dynamic(
	() =>
		import(
			"@saas/agents/components/WorkflowTemplateChat/WorkflowProgressPanel"
		).then((mod) => ({ default: mod.WorkflowProgressPanel })),
	{ ssr: false },
);

const WorkflowResultViewer = dynamic(
	() =>
		import(
			"@saas/agents/components/WorkflowTemplateChat/WorkflowResultViewer"
		).then((mod) => ({ default: mod.WorkflowResultViewer })),
	{ ssr: false },
);

import { buildInstanceSystemPrompt } from "@saas/agent-templates/lib/build-instance-system-prompt";
import { ProjectAttachmentPanel } from "@saas/agents/components/FabricChat/ProjectAttachmentPanel";
import { ChatInput } from "@saas/agents/components/FabricChat/shared/ChatInput";
import {
	type WorkspaceFile,
	WorkspacePanel,
} from "@saas/agents/components/WorkspacePanel";
import { useConversationHistory } from "@saas/agents/hooks/useConversationHistory";
import { useWorkflowTemplateStream } from "@saas/agents/hooks/useWorkflowTemplateStream";
import { useWorkspaceFiles } from "@saas/agents/hooks/useWorkspaceFiles";
import {
	useContextPath,
	useEffectiveOrganizationId,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { SidebarEdgeHandle } from "@saas/shared/components/SidebarEdgeHandle";
import { useFullscreen } from "@saas/shared/contexts/FullscreenContext";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Switch } from "@ui/components/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import type { LucideIcon } from "lucide-react";
import {
	Brain,
	CheckCircle2,
	ChevronLeft,
	File as FileIcon,
	FolderKanban,
	FolderOpen,
	Globe,
	GripVertical,
	History,
	Layers,
	LayoutGrid,
	Plus,
	Scale,
	ScanSearch,
	Settings2,
	Sparkles,
	Wrench,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Context,
	ContextContent,
	ContextContentBody,
	ContextContentFooter,
	ContextContentHeader,
	ContextInputUsage,
	ContextOutputUsage,
	ContextReasoningUsage,
	ContextTrigger,
} from "../../../../../components/ai-elements/context";
import { FramesPanel, HistoryTabContent } from "./components";

// Loading skeleton for chat components - prevents CLS during dynamic import
function ChatLoadingSkeleton() {
	return (
		<div className="flex-1 flex flex-col items-center justify-center p-8 animate-pulse">
			<div className="w-16 h-16 rounded-full bg-muted mb-4" />
			<div className="h-6 w-48 bg-muted rounded mb-2" />
			<div className="h-4 w-64 bg-muted/70 rounded" />
			<div className="mt-8 w-full max-w-2xl space-y-3">
				<div className="h-12 bg-muted rounded-lg" />
				<div className="h-12 bg-muted/70 rounded-lg" />
				<div className="h-12 bg-muted/50 rounded-lg" />
			</div>
		</div>
	);
}

// Loading skeleton for config panel - matches panel structure
function ConfigPanelSkeleton() {
	return (
		<div className="p-4 space-y-4 animate-pulse">
			<div className="h-5 w-32 bg-muted rounded" />
			<div className="space-y-2">
				{[1, 2, 3, 4].map((i) => (
					<div key={i} className="h-10 bg-muted/60 rounded-md" />
				))}
			</div>
			<div className="h-5 w-24 bg-muted rounded mt-6" />
			<div className="space-y-2">
				{[1, 2].map((i) => (
					<div key={i} className="h-10 bg-muted/60 rounded-md" />
				))}
			</div>
		</div>
	);
}

type ReasoningMode = "lite" | "balanced" | "deep" | "planner";
type TabType =
	| "history"
	| "agents"
	| "tools"
	| "workspace"
	| "projects"
	| "frames";

// Task step for plan display
interface TaskStepDisplay {
	id: string;
	description: string;
	status:
		| "pending"
		| "in_progress"
		| "complete"
		| "error"
		| "skipped"
		| "awaiting_approval";
	order: number;
	riskLevel?: string;
}

// Task plan for plan display
interface TaskPlanDisplay {
	id: string;
	description: string;
	steps: TaskStepDisplay[];
	riskLevel: string;
}

// Orchestrator state for sidebar display
export interface OrchestratorActivityState {
	isActive: boolean;
	currentStage: string;
	routingDecision?: {
		primaryAgent: string;
		agentName: string;
		confidence: number;
		riskLevel?: string;
	};
	plan?: TaskPlanDisplay;
	completedSteps?: number;
	totalSteps?: number;
	currentStep?: TaskStepDisplay;
	toolCalls: Array<{
		id: string;
		name: string;
		displayName?: string;
		serverName?: string;
		status: "pending" | "running" | "complete" | "error";
		timestamp: Date;
	}>;
	pendingApproval?: {
		stepId: string;
		reason: string;
	};
}

const BUILT_IN_TO_FABRIC_TOOLS: Record<string, string[]> = {
	"agent-memory": [],
	"create-frames": [
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_share_frame",
		"fabric_create_slideshow",
	],
	"create-images": ["fabric_generate_image"],
	"run-agent": [],
	"speech-generator": ["fabric_text_to_speech"],
	"web-search-browse": [
		"fabric_web_search",
		"fabric_search_and_analyze",
		"fabric_scrape_url",
		"fabric_scrape_and_analyze",
	],
	"web-search": [
		"fabric_web_search",
		"fabric_search_and_analyze",
		"fabric_scrape_url",
		"fabric_scrape_and_analyze",
	],
	search: ["workspace_rag_query", "workspace_rag_summarize"],
	"code-interpreter": ["fabric_code_interpreter"],
	"image-generation": ["fabric_generate_image"],
	"project-context": ["project_rag_query"],
	"create-story": ["fabric_create_story"],
};

// Completed plan for history display
interface CompletedPlanDisplay {
	id: string;
	description: string;
	plan: TaskPlanDisplay;
	routingDecision?: OrchestratorActivityState["routingDecision"];
	completedAt: Date;
}

/**
 * SSR `initialData` for the Loom orchestrator-preferences query. Same shape
 * as the GET endpoint returns. Passed from the wrapping server component
 * (`page.tsx`) so the mode tabs render the user's saved mode + reasoning on
 * the very first paint instead of flashing the default → persisted value.
 *
 * `null` means SSR couldn't fetch (unauthenticated render path) — the
 * client falls back to the existing query path.
 */
interface FabricAIClientProps {
	initialPreferences: {
		exists: boolean;
		enabledMcpConfigIds: string[];
		enabledAgentIds: string[];
		enabledWorkspaceIds: string[];
		autonomyLevel: "CONSERVATIVE" | "BALANCED" | "AUTONOMOUS";
		chatMode: "direct" | "orchestrator" | "research";
		reasoningMode: "lite" | "balanced" | "deep" | "planner";
		uiMode: "simple" | "advanced";
	} | null;
}

export default function FabricAIPage({
	initialPreferences,
}: FabricAIClientProps) {
	const { organizationId, organizationSlug, organizationName, basePath } =
		useOrganizationContext();
	const { setIsFullscreen } = useFullscreen();

	// URL state — declared early so initial useState calls can read search params
	const searchParams = useSearchParams();
	const router = useRouter();
	const conversationIdFromUrl = searchParams.get("c");
	const instanceIdFromUrl = searchParams.get("instanceId");
	const modeFromUrl = searchParams.get("mode");

	const [reasoningMode, setReasoningMode] =
		useState<ReasoningMode>("balanced");
	const [deepResearchEnabled, setDeepResearchEnabled] = useState(
		modeFromUrl === "research",
	);
	const [sidebarOpen, setSidebarOpen] = useState(false);
	// Open sidebar by default on desktop only
	useEffect(() => {
		if (typeof window !== "undefined" && window.innerWidth >= 768) {
			setSidebarOpen(true);
		}
	}, []);
	// Default to history so the page lands on prior runs first.
	const [activeTab, setActiveTab] = useState<TabType>("tools");
	const contextProjectId = searchParams.get("projectId");
	const contextProjectName = searchParams.get("projectName");
	const contextStoryId = searchParams.get("storyId");
	const contextStoryIdentifier = searchParams.get("storyIdentifier");
	const contextStoryTitle = searchParams.get("storyTitle");
	const contextTaskId = searchParams.get("taskId");
	const contextTaskIdentifier = searchParams.get("taskIdentifier");
	const contextTaskTitle = searchParams.get("taskTitle");
	const contextPrompt = searchParams.get("prompt");

	// Restored instanceId from conversation metadata (when loading an existing conversation
	// that was originally created from an agent template instance)
	const [restoredInstanceId, setRestoredInstanceId] = useState<string | null>(
		null,
	);

	// Effective instanceId: URL param takes precedence, then restored from conversation metadata
	const effectiveInstanceId = instanceIdFromUrl || restoredInstanceId;

	// Fetch agent template instance when instanceId is provided (from URL or restored from conversation)
	const { data: instanceData } = useQuery({
		queryKey: ["agentTemplates", "instances", "get", effectiveInstanceId],
		queryFn: async () => {
			if (!effectiveInstanceId) {
				return null;
			}
			return await orpcClient.agentTemplates.instances.get({
				id: effectiveInstanceId,
			});
		},
		enabled: !!effectiveInstanceId,
	});

	// Extract instance details for display and system prompt
	const agentInstance = instanceData?.instance;
	// The template is included via the API query with include: { template: true }
	const agentTemplate = (agentInstance as any)?.template as
		| {
				instructionSections?: unknown;
				description?: string;
		  }
		| undefined;
	const agentCustomInstructions = ((agentInstance as any)
		?.customInstructions ?? {}) as Record<string, unknown>;
	const _agentStarterMessages = useMemo(() => {
		const value = agentCustomInstructions.starterMessages;
		return Array.isArray(value)
			? (value as Array<{
					label: string;
					emoji: string;
					prompt: string;
				}>)
			: [];
	}, [agentCustomInstructions]);
	const agentKnowledgeFilters = useMemo(() => {
		const value = agentCustomInstructions.knowledgeFilters;
		return Array.isArray(value)
			? (value as Array<{
					workspaceId: string;
					documentIds?: string[];
				}>)
			: [];
	}, [agentCustomInstructions]);
	const _agentWorkspaceIds = useMemo(
		() =>
			Array.isArray((agentInstance as any)?.workspaceIds)
				? (((agentInstance as any)?.workspaceIds as string[]) ?? [])
				: [],
		[agentInstance],
	);
	const _agentDocumentIds = useMemo(
		() =>
			Array.from(
				new Set(
					agentKnowledgeFilters.flatMap((filter) =>
						Array.isArray(filter.documentIds)
							? filter.documentIds
							: [],
					),
				),
			),
		[agentKnowledgeFilters],
	);

	// Build system prompt from template + instance customizations
	const instanceSystemPrompt = useMemo(() => {
		if (!agentInstance) {
			return undefined;
		}
		return buildInstanceSystemPrompt(
			{
				customInstructions: (agentInstance as any)?.customInstructions,
				goal: (agentInstance as any)?.goal,
				description: (agentInstance as any)?.description,
				memoryFiles: (agentInstance as any)?.memoryFiles,
			},
			agentTemplate,
		);
	}, [agentInstance, agentTemplate]);

	// Extract MCP config IDs and built-in tool IDs from agent instance's toolConnections
	const instanceToolConfig = useMemo(() => {
		if (!agentInstance) {
			return undefined;
		}
		const toolConnections = (agentInstance as any)?.toolConnections as
			| Record<string, unknown>
			| undefined;
		if (
			!toolConnections ||
			typeof toolConnections !== "object" ||
			Object.keys(toolConnections).length === 0
		) {
			return undefined;
		}

		const mcpConfigIds: string[] = [];
		const enabledFabricToolIds: string[] = [];
		let boundProjectId: string | null = null;

		for (const [key, value] of Object.entries(toolConnections)) {
			// Check if entry is enabled
			const isEnabled =
				value &&
				typeof value === "object" &&
				(value as Record<string, unknown>).enabled !== false;
			if (!isEnabled) {
				continue;
			}

			if (key.startsWith("mcp:")) {
				// New format: "mcp:<configId>" key with { enabled: true }
				mcpConfigIds.push(key.slice(4));
			} else if (
				value &&
				typeof value === "object" &&
				"connectionId" in value
			) {
				// Legacy format: { "tool-name": { connectionId: "<mcp-config-id>" } }
				const connectionId = (value as { connectionId: unknown })
					.connectionId;
				if (
					typeof connectionId === "string" &&
					connectionId.length > 0
				) {
					mcpConfigIds.push(connectionId);
				}
			} else {
				const mappedToolIds = BUILT_IN_TO_FABRIC_TOOLS[key];
				if (mappedToolIds) {
					enabledFabricToolIds.push(...mappedToolIds);
				}
				if (key === "project-context") {
					const pid = (value as Record<string, unknown>).projectId;
					if (typeof pid === "string" && pid.length > 0) {
						boundProjectId = pid;
					}
				}
			}
		}

		return {
			mcpConfigIds,
			enabledFabricToolIds: [...new Set(enabledFabricToolIds)],
			boundProjectId,
		};
	}, [agentInstance]);

	// Set fullscreen mode on mount, reset on unmount
	useEffect(() => {
		setIsFullscreen(true);
		return () => {
			setIsFullscreen(false);
		};
	}, [setIsFullscreen]);

	// Track whether the current chat should use orchestrator or direct execution.
	// Instance-backed agent chats now default to direct execution so the agent's
	// own instructions drive tool selection from the first model call.
	const [useOrchestrator, setUseOrchestrator] = useState(
		modeFromUrl === "research"
			? false
			: !(modeFromUrl === "agent" && Boolean(instanceIdFromUrl)),
	);

	// Keep state in sync when navigating between generic Fabric AI and instance-backed agent chats
	useEffect(() => {
		if (modeFromUrl === "agent" && instanceIdFromUrl) {
			setUseOrchestrator(false);
			setDeepResearchEnabled(false);
		} else if (modeFromUrl === "research") {
			setDeepResearchEnabled(true);
			setUseOrchestrator(false);
		}
	}, [modeFromUrl, instanceIdFromUrl]);

	// Persistent Loom UI prefs — `chatMode` (Direct / Orchestrator / Research)
	// and `reasoningMode` (lite / balanced / deep / planner) survive page
	// reload via `user_orchestrator_preferences`. Mirrors the Nexus
	// persist-on-pick contract from PR #820: hydrate exactly once on mount,
	// then fire-and-forget update on every user-initiated change. Ordering
	// rules:
	//   1. URL `?mode=` deep links always win on initial load (existing
	//      behavior — useEffect above runs after this hook and overrides).
	//   2. Instance-backed chats (`?mode=agent&instanceId=...`) skip
	//      hydration entirely — they need a known boot state.
	//   3. Otherwise hydrate from the persisted value once the query
	//      resolves; if the user has clicked something else in the meantime,
	//      respect their choice and skip the seed (race-window guard).
	const persistedPrefsQuery = useQuery({
		// Shared cache key with `OrchestratorConfigPanel` (the Loom settings
		// drawer) — both observers want the SAME procedure response, so they
		// must share one cache entry. Without this, the panel's `useQuery`
		// fires its own `orchestratorPreferences.get` request on mount even
		// though the SSR `initialData` below already has the value. With a
		// shared key, the SSR-seeded entry is fresh for both observers and
		// no client-side fetch fires.
		// org in the key: preferences are per (user × org). Must match the
		// OrchestratorConfigPanel key exactly so both observers still share one
		// cache entry within an org, while a workspace switch (org changes) no
		// longer serves the previous org's settings.
		queryKey: ["orchestrator-preferences", organizationId ?? null],
		queryFn: async () => orpcClient.users.orchestratorPreferences.get(),
		// SSR `initialData` short-circuits the client-side fetch on first
		// mount. With `staleTime: Infinity` and `refetchOnMount: false`,
		// the query treats the SSR-provided value as fresh and never
		// fires a redundant round-trip. The hydration effect below sees
		// `persistedPrefsQuery.data` populated on the first render and
		// runs in the same commit as the `loomPrefsHydrated` flag flip
		// from PR #824 — so the very first render that paints any active
		// mode highlight already paints the correct persisted one. No
		// flash, no fetch wait.
		initialData: initialPreferences ?? undefined,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: 1,
	});

	// Simple / advanced interface mode (#2040). Orthogonal to `chatMode`:
	// simple hides the engine control and runs Direct, advanced restores the
	// full surface. Persisted per (user × org) alongside the Loom prefs above.
	const [uiMode, setUiMode] = useState<"simple" | "advanced">("simple");
	const lastPersistedUiModeRef = useRef<"simple" | "advanced" | null>(null);

	const loomPrefsHydratedRef = useRef(false);
	// Mirror of `loomPrefsHydratedRef` as React state so the mode-tab
	// renderer can gate its "active" highlight on it. Without this, the
	// initial paint shows the default (`Orchestrator`) highlighted, then
	// — after the persisted-prefs query resolves and the hydration effect
	// commits new state — the highlight snaps to the persisted mode. The
	// user-visible result is a brief "wrong → right" flash on every page
	// load. The fix is to render NO active highlight until hydration
	// completes, then commit the persisted state and the flag in the same
	// React batch so the first render that paints any active highlight
	// already paints the correct one (no transitional wrong state).
	//
	// We keep the ref too: the persist effects below read hydration
	// status synchronously without needing to re-fire on every state
	// change, and the userTouched guard does the same.
	const [loomPrefsHydrated, setLoomPrefsHydrated] = useState(false);
	// Race-window guard: if the user clicks a mode tab BEFORE the hydration
	// query resolves, we MUST NOT then overwrite their choice with the
	// persisted value. The persist effects below flip this true on the
	// first user interaction (any mode / reasoning change) and the
	// hydration effect treats it as a hard skip — same shape as the Nexus
	// `selectedAgents.length === 0` race-window guard in CopilotPage, just
	// expressed as an explicit ref because Loom modes have non-empty
	// defaults and we cannot infer "untouched" from value alone.
	const userTouchedLoomPrefsRef = useRef(false);
	useEffect(() => {
		if (loomPrefsHydratedRef.current) {
			return;
		}
		const data = persistedPrefsQuery.data;
		if (!data) {
			return;
		}
		// Deep link / instance-backed chat overrides persisted prefs — see
		// the comment block above and the matching useEffect below.
		const hasModeOverride =
			modeFromUrl === "research" ||
			(modeFromUrl === "agent" && Boolean(instanceIdFromUrl));
		if (
			!hasModeOverride &&
			data.exists &&
			!userTouchedLoomPrefsRef.current
		) {
			// Closed-set check — coercion already happened in the query
			// layer, but defending against a future schema drift here is
			// cheap and keeps the picker from landing on `undefined`.
			if (data.chatMode === "direct") {
				setUseOrchestrator(false);
				setDeepResearchEnabled(false);
			} else if (data.chatMode === "research") {
				setUseOrchestrator(false);
				setDeepResearchEnabled(true);
			} else if (data.chatMode === "orchestrator") {
				setUseOrchestrator(true);
				setDeepResearchEnabled(false);
			}
			if (
				data.reasoningMode === "lite" ||
				data.reasoningMode === "balanced" ||
				data.reasoningMode === "deep" ||
				data.reasoningMode === "planner"
			) {
				setReasoningMode(data.reasoningMode);
			}
			// Seed the "last persisted" refs so the persist effects (which
			// will fire next render because we just changed state) treat the
			// hydrated value as already-persisted and skip the round-trip.
			lastPersistedChatModeRef.current = data.chatMode;
			lastPersistedReasoningModeRef.current = data.reasoningMode;
		}
		// `uiMode` hydrates independently of the `hasModeOverride` guard above.
		// That guard exists because a `?mode=` deep link names a *chat* mode,
		// which says nothing about whether the user wants the simple or the
		// advanced surface — their saved interface preference should still be
		// honoured when they follow one.
		//
		// One exception: `?mode=research` names a mode that only EXISTS in the
		// advanced surface. Honouring a saved `simple` there would force the
		// chat back to Direct and the link would silently do nothing, with no
		// way for the user to tell why. So a research deep link implies
		// advanced. It is not persisted — this is a per-visit override, so the
		// user's saved preference is intact next time they open Loom normally.
		if (data.exists && !userTouchedLoomPrefsRef.current) {
			if (modeFromUrl === "research") {
				setUiMode("advanced");
				lastPersistedUiModeRef.current = data.uiMode;
			} else if (data.uiMode === "simple" || data.uiMode === "advanced") {
				setUiMode(data.uiMode);
				lastPersistedUiModeRef.current = data.uiMode;
			}
		}
		loomPrefsHydratedRef.current = true;
		// React batches setState calls inside the same effect into one
		// render, so this state flip commits in the SAME render that
		// applies the chatMode / reasoning state above. The mode-tab UI
		// reads `loomPrefsHydrated` to decide whether to paint an active
		// highlight at all — so the first render with any active
		// highlight is always already the correct one. No flash.
		setLoomPrefsHydrated(true);
	}, [persistedPrefsQuery.data, modeFromUrl, instanceIdFromUrl]);

	const persistLoomPrefsMutation = useMutation({
		mutationFn: async (input: {
			chatMode?: "direct" | "orchestrator" | "research";
			reasoningMode?: "lite" | "balanced" | "deep" | "planner";
		}) => orpcClient.users.orchestratorPreferences.update(input),
		// Fire-and-forget — write failures must NEVER surface to the user
		// (matches Nexus chat-agent-selection persistence in CopilotPage and
		// the existing `OrchestratorConfigPanel` sync behavior). The user's
		// click already updated the local React state; if the server write
		// fails, the next reload simply rehydrates the previous persisted
		// value.
		onError: (err) => {
			// eslint-disable-next-line no-console -- intentional dev signal
			console.warn("[FabricAI] Loom prefs persist failed", err);
		},
	});

	// Interface-mode persistence is deliberately NOT fire-and-forget like the
	// prefs above. Those recover invisibly: a failed `chatMode` write just
	// rehydrates the old value next reload, and the user is unlikely to notice
	// or care. The interface mode is a deliberate, visible choice about how
	// much of the product is on screen — silently losing it means the surface
	// reverts on next load with no explanation. So the write failure is
	// surfaced, non-blockingly: the local switch still stands for this session.
	const persistUiModeMutation = useMutation({
		mutationFn: async (next: "simple" | "advanced") =>
			orpcClient.users.orchestratorPreferences.update({ uiMode: next }),
		onError: (err) => {
			// eslint-disable-next-line no-console -- intentional dev signal
			console.warn("[FabricAI] Interface mode persist failed", err);
			toast.message("Couldn't save your interface mode.", {
				description:
					"The change applies for now, but may not survive a reload.",
			});
		},
	});

	// Simple mode runs Direct — but as a *view* over the user's choice, not by
	// resetting it. Calling `setUseOrchestrator(false)` here would fire the
	// persist effect below and overwrite the saved `chatMode`, so switching
	// back to advanced would land on Direct instead of whatever the user had.
	// Deriving the effective value leaves the stored preference untouched.
	const effectiveUseOrchestrator =
		uiMode === "simple" ? false : useOrchestrator;
	const effectiveDeepResearchEnabled =
		uiMode === "simple" ? false : deepResearchEnabled;

	const handleUiModeChange = useCallback(
		(next: "simple" | "advanced") => {
			userTouchedLoomPrefsRef.current = true;
			setUiMode(next);
			if (lastPersistedUiModeRef.current === next) {
				return;
			}
			lastPersistedUiModeRef.current = next;
			persistUiModeMutation.mutate(next);
		},
		[persistUiModeMutation],
	);

	// Orchestrator activity state for sidebar display
	const [orchestratorActivity, setOrchestratorActivity] =
		useState<OrchestratorActivityState>({
			isActive: false,
			currentStage: "idle",
			toolCalls: [],
		});

	// Persist mode + reasoning to `user_orchestrator_preferences` AFTER
	// hydration is complete. Watching the resolved state (vs. wrapping the
	// individual setters) is the only race-free option here: every mode-tab
	// click in `FabricChatContent` calls BOTH `setUseOrchestrator` AND
	// `setDeepResearchEnabled` in sequence, so wrapped setters would fire
	// two mutations per click and the second one's chatMode would clobber
	// the first. React batches both setState calls into one render, so this
	// effect runs ONCE per click with the final state — and a single
	// `mutate()` call persists the canonical chatMode.
	//
	// The `?mode=agent&instanceId=...` path bypasses persistence (instance-
	// backed chats are not a persistable user choice — they're per-launch),
	// so we skip the write while in that mode. Instance state already
	// flips `useOrchestrator=false`, so without this guard a launch from a
	// template instance would silently overwrite the user's persisted
	// "orchestrator" preference with "direct".
	const isInstanceBackedChat =
		modeFromUrl === "agent" && Boolean(instanceIdFromUrl);
	// Last-persisted snapshot: set on hydration to whatever was just
	// hydrated, then to whatever we just wrote. A persist effect that
	// observes the current state matches this snapshot is a no-op echo
	// (the hydration setState triggered the effect; we don't need to
	// round-trip the same value back to the server).
	const lastPersistedChatModeRef = useRef<
		"direct" | "orchestrator" | "research" | null
	>(null);
	const lastPersistedReasoningModeRef = useRef<ReasoningMode | null>(null);
	// Conversation-restore handshake.
	//
	// When the child loads an existing conversation, it calls this with the
	// conversation's stored mode + reasoning so we can update the
	// "last persisted" snapshot in the same render that the child applies
	// the values via setUseOrchestrator / setDeepResearchEnabled /
	// setReasoningMode. Without this, the persist effects below would fire
	// on the next render (state changed) and write the conversation's mode
	// back to the user's persistent default — turning "I clicked an old
	// chat to look at it" into "I changed my default mode."
	//
	// The semantic invariant: opening a chat shows that chat's mode but
	// leaves the user's persistent default untouched. Same shape as the
	// Nexus side, where `activateChatFromHistory` calls `setSelectedAgents`
	// directly (bypassing `handleToggleAgent` which is the only path that
	// fires `chatAgentSelection.set`).
	const onConversationRestoredMode = useCallback(
		(restored: {
			chatMode: "direct" | "orchestrator" | "research" | null;
			reasoningMode: ReasoningMode | null;
		}) => {
			if (restored.chatMode) {
				lastPersistedChatModeRef.current = restored.chatMode;
			}
			if (restored.reasoningMode) {
				lastPersistedReasoningModeRef.current = restored.reasoningMode;
			}
		},
		[],
	);
	useEffect(() => {
		if (!loomPrefsHydratedRef.current) {
			return;
		}
		if (isInstanceBackedChat) {
			return;
		}
		const chatMode: "direct" | "orchestrator" | "research" =
			deepResearchEnabled
				? "research"
				: useOrchestrator
					? "orchestrator"
					: "direct";
		if (lastPersistedChatModeRef.current === chatMode) {
			return;
		}
		lastPersistedChatModeRef.current = chatMode;
		userTouchedLoomPrefsRef.current = true;
		persistLoomPrefsMutation.mutate({ chatMode });
		// Mutation reference is stable from useMutation; including it in
		// deps would cause unnecessary re-runs on render. eslint-disable
		// is intentional here and matches the same pattern used for the
		// `useDirectStream` reset effect elsewhere in this file.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [useOrchestrator, deepResearchEnabled, isInstanceBackedChat]);

	useEffect(() => {
		if (!loomPrefsHydratedRef.current) {
			return;
		}
		if (isInstanceBackedChat) {
			return;
		}
		if (lastPersistedReasoningModeRef.current === reasoningMode) {
			return;
		}
		lastPersistedReasoningModeRef.current = reasoningMode;
		userTouchedLoomPrefsRef.current = true;
		persistLoomPrefsMutation.mutate({ reasoningMode });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- see above
	}, [reasoningMode, isInstanceBackedChat]);

	// "New run" reset → snap mode + reasoning back to the user's persistent
	// default. Without this, clicking New after viewing an existing
	// conversation kept the conversation's mode (because the chat-restore
	// effect from PR #826 sets the page state to match the loaded chat),
	// which surprises the user — fresh page load goes to the persisted
	// default, so New should too. We update the lastPersisted refs in
	// lockstep so the persist effects see no diff and skip the round-trip
	// (the user didn't *set* a default — they're just *resetting* to it).
	const resetLoomModeToUserDefault = useCallback(() => {
		const data = persistedPrefsQuery.data;
		const targetChatMode: "direct" | "orchestrator" | "research" =
			data?.exists && data.chatMode ? data.chatMode : "orchestrator";
		const targetReasoning: ReasoningMode =
			data?.exists && data.reasoningMode
				? data.reasoningMode
				: "balanced";

		if (targetChatMode === "direct") {
			setUseOrchestrator(false);
			setDeepResearchEnabled(false);
		} else if (targetChatMode === "research") {
			setUseOrchestrator(false);
			setDeepResearchEnabled(true);
		} else {
			setUseOrchestrator(true);
			setDeepResearchEnabled(false);
		}
		setReasoningMode(targetReasoning);
		lastPersistedChatModeRef.current = targetChatMode;
		lastPersistedReasoningModeRef.current = targetReasoning;
	}, [persistedPrefsQuery.data]);

	// Update URL when conversation changes
	const updateUrlWithConversation = useCallback(
		(convId: string | null) => {
			const params = new URLSearchParams(searchParams.toString());
			if (convId) {
				params.set("c", convId);
			} else {
				params.delete("c");
			}
			// Use organization path if in org context, otherwise personal path
			const agentPath = `${basePath}/agents/fabric-ai`;
			router.replace(`${agentPath}?${params.toString()}`, {
				scroll: false,
			});
		},
		[searchParams, router, basePath],
	);

	const breadcrumbItems = [
		...(organizationSlug
			? [
					{
						label: organizationName ?? "Organization",
						href: basePath,
					},
				]
			: []),
		{
			label: "AI Agents",
			href: `${basePath}/agents`,
		},
		...(agentInstance
			? [
					{
						label: "My Agents",
						href: `${basePath}/agent-templates/agents`,
					},
					{ label: agentInstance.name },
				]
			: [{ label: "Fabric Loom" }]),
	];

	return (
		<div className="fixed inset-y-0 right-0 top-16 left-0 md:top-0 md:left-[72px] bg-[radial-gradient(farthest-corner_at_0%_0%,color-mix(in_oklch,var(--color-primary),transparent_95%)_0%,var(--color-background)_50%)] dark:bg-[radial-gradient(farthest-corner_at_0%_0%,color-mix(in_oklch,var(--color-primary),transparent_90%)_0%,var(--color-background)_50%)]">
			{/* Breadcrumbs - hidden on mobile, shown from sm up */}
			<div className="hidden sm:flex items-center justify-between border-b bg-transparent px-4 py-3 md:px-6 md:py-4">
				<PageBreadcrumbs items={breadcrumbItems} />
				<div className="flex items-center gap-2">
					<Badge
						variant="secondary"
						className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
					>
						Active
					</Badge>
				</div>
			</div>

			{/* Content - Full height */}
			<div className="h-[calc(100vh-65px)]">
				<AgentErrorBoundary>
					<FabricChatContent
						organizationId={organizationId ?? undefined}
						basePath={basePath}
						reasoningMode={reasoningMode}
						setReasoningMode={setReasoningMode}
						deepResearchEnabled={effectiveDeepResearchEnabled}
						setDeepResearchEnabled={setDeepResearchEnabled}
						// Simple mode keeps the control deck — MCP servers,
						// Fabric tools, integrations, frames — off screen. Held
						// closed rather than reset, so returning to advanced
						// restores whatever the user had open (#2040).
						sidebarOpen={uiMode === "simple" ? false : sidebarOpen}
						setSidebarOpen={setSidebarOpen}
						activeTab={activeTab}
						setActiveTab={setActiveTab}
						useOrchestrator={effectiveUseOrchestrator}
						setUseOrchestrator={setUseOrchestrator}
						uiMode={uiMode}
						onUiModeChange={handleUiModeChange}
						loomPrefsHydrated={loomPrefsHydrated}
						onConversationRestoredMode={onConversationRestoredMode}
						resetLoomModeToUserDefault={resetLoomModeToUserDefault}
						conversationIdFromUrl={conversationIdFromUrl}
						onConversationChange={updateUrlWithConversation}
						orchestratorActivity={orchestratorActivity}
						setOrchestratorActivity={setOrchestratorActivity}
						systemPrompt={instanceSystemPrompt}
						instanceId={effectiveInstanceId ?? undefined}
						agentInstanceName={agentInstance?.name}
						agentInstanceDescription={
							agentInstance?.description ?? undefined
						}
						instanceToolConfig={instanceToolConfig}
						contextLaunch={{
							projectId: contextProjectId,
							projectName: contextProjectName,
							storyId: contextStoryId,
							storyIdentifier: contextStoryIdentifier,
							storyTitle: contextStoryTitle,
							taskId: contextTaskId,
							taskIdentifier: contextTaskIdentifier,
							taskTitle: contextTaskTitle,
							prompt: contextPrompt,
						}}
						onInstanceIdRestored={setRestoredInstanceId}
					/>
				</AgentErrorBoundary>
			</div>
		</div>
	);
}

interface FabricChatContentProps {
	organizationId?: string;
	basePath: string;
	reasoningMode: ReasoningMode;
	setReasoningMode: (mode: ReasoningMode) => void;
	deepResearchEnabled: boolean;
	setDeepResearchEnabled: (enabled: boolean) => void;
	sidebarOpen: boolean;
	setSidebarOpen: (open: boolean) => void;
	activeTab: TabType;
	setActiveTab: (tab: TabType) => void;
	useOrchestrator: boolean;
	setUseOrchestrator: (use: boolean) => void;
	/**
	 * Interface mode. Simple hides the engine control, the reasoning control
	 * and the agent picker, and runs Direct; advanced restores the full
	 * surface. Orthogonal to `chatMode` — see the parent's derivation.
	 */
	uiMode: "simple" | "advanced";
	onUiModeChange: (next: "simple" | "advanced") => void;
	/**
	 * `true` once the persisted-prefs query has resolved AND the hydration
	 * effect has applied its values. Until then, the mode and reasoning-mode
	 * pills render with NO active highlight (instead of the default
	 * Orchestrator/balanced) so we never paint a "wrong" mode that the user
	 * sees flip after the network round-trip. See the matching comment on
	 * `loomPrefsHydrated` in the parent component.
	 */
	loomPrefsHydrated: boolean;
	/**
	 * Invoked when an existing conversation loads, so the parent can update
	 * its `lastPersisted*` snapshot refs in lockstep with the mode setters
	 * called below. This prevents the persist effects from echoing the
	 * loaded conversation's mode/reasoning back to the server (i.e.,
	 * silently overwriting the user's persistent default with the mode of
	 * a chat they just opened to look at). Both refs must be updated in
	 * the same render the setters fire so the persist effect's lookup
	 * sees no diff.
	 */
	onConversationRestoredMode: (restored: {
		chatMode: "direct" | "orchestrator" | "research" | null;
		reasoningMode: ReasoningMode | null;
	}) => void;
	/**
	 * Resets the page-level mode + reasoning back to the user's persistent
	 * default. Called by the "New" button so clicking New after viewing an
	 * existing conversation snaps back to the user's default (consistent
	 * with fresh page load), instead of keeping the conversation's
	 * mode/reasoning that the chat-restore effect installed.
	 */
	resetLoomModeToUserDefault: () => void;
	conversationIdFromUrl: string | null;
	onConversationChange: (convId: string | null) => void;
	orchestratorActivity: OrchestratorActivityState;
	setOrchestratorActivity: (activity: OrchestratorActivityState) => void;
	// Agent template instance props
	systemPrompt?: string;
	instanceId?: string;
	agentInstanceName?: string;
	agentInstanceDescription?: string;
	instanceToolConfig?: {
		mcpConfigIds: string[];
		enabledFabricToolIds: string[];
		boundProjectId?: string | null;
	};
	contextLaunch?: {
		projectId: string | null;
		projectName: string | null;
		storyId: string | null;
		storyIdentifier: string | null;
		storyTitle: string | null;
		taskId: string | null;
		taskIdentifier: string | null;
		taskTitle: string | null;
		prompt: string | null;
	};
	/** Callback to restore instanceId from conversation metadata */
	onInstanceIdRestored?: (instanceId: string | null) => void;
}

function FabricChatContent({
	organizationId,
	basePath,
	reasoningMode,
	setReasoningMode,
	deepResearchEnabled,
	setDeepResearchEnabled,
	sidebarOpen,
	setSidebarOpen,
	activeTab,
	setActiveTab,
	useOrchestrator,
	setUseOrchestrator,
	uiMode,
	onUiModeChange,
	loomPrefsHydrated,
	onConversationRestoredMode,
	resetLoomModeToUserDefault,
	conversationIdFromUrl,
	onConversationChange,
	orchestratorActivity: _orchestratorActivity,
	setOrchestratorActivity,
	systemPrompt,
	instanceId,
	agentInstanceName,
	agentInstanceDescription,
	instanceToolConfig,
	contextLaunch,
	onInstanceIdRestored,
}: FabricChatContentProps) {
	// Key to force remount of chat component when starting new chat
	// This ensures all state is completely reset
	const [chatInstanceKey, setChatInstanceKey] = useState(0);
	const isAgentInstanceMode = Boolean(instanceId);

	// Map UI reasoning mode to workflow reasoning effort
	const researchReasoningEffort = useMemo(():
		| "none"
		| "light"
		| "medium"
		| "high" => {
		switch (reasoningMode) {
			case "lite":
				return "none";
			case "balanced":
				return "medium";
			case "deep":
			case "planner":
				return "high";
		}
	}, [reasoningMode]);

	// Deep Research workflow stream
	const [deepResearchQuery, setDeepResearchQuery] = useState("");
	const [deepResearchHasInteracted, setDeepResearchHasInteracted] =
		useState(false);
	const deepResearchStream = useWorkflowTemplateStream({
		templateSlug: "deep-researcher",
		organizationId: organizationId ?? undefined,
		reasoningEffort: researchReasoningEffort,
	});

	// Reset deep research state when toggling off or starting new chat
	const resetDeepResearch = useCallback(() => {
		deepResearchStream.reset();
		setDeepResearchHasInteracted(false);
		setDeepResearchQuery("");
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset is stable from useCallback
	}, [deepResearchStream.reset]);

	// Handle sending a deep research query
	const handleDeepResearchSend = useCallback(
		async (queryText: string) => {
			if (!queryText.trim() || deepResearchStream.isLoading) {
				return;
			}
			setDeepResearchHasInteracted(true);
			setDeepResearchQuery(queryText);
			await deepResearchStream.sendQuery(queryText);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps -- sendQuery/isLoading are stable
		[deepResearchStream.sendQuery, deepResearchStream.isLoading],
	);

	// Session-level selected templates that persist across new conversations (remounts)
	const [sessionTemplates, setSessionTemplates] = useState<
		MentionableTemplate[]
	>([]);

	// Token usage state for Context component in header
	const [tokenUsage, setTokenUsage] = useState<{
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		reasoningTokens?: number;
		cachedInputTokens?: number;
		maxTokens: number;
	}>({
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		maxTokens: 128000,
	});

	// State for completed plans (shown collapsed in sidebar)
	const [_completedPlans, setCompletedPlans] = useState<
		CompletedPlanDisplay[]
	>([]);
	const [_collapsedPlans, setCollapsedPlans] = useState<Set<string>>(
		new Set(),
	);
	const lastActivityStateRef = useRef<{
		wasActive: boolean;
		planId?: string;
	}>({ wasActive: false });

	// Toggle plan collapse state
	const _togglePlanCollapse = useCallback((planId: string) => {
		setCollapsedPlans((prev) => {
			const next = new Set(prev);
			if (next.has(planId)) {
				next.delete(planId);
			} else {
				next.add(planId);
			}
			return next;
		});
	}, []);

	// Memoized callback for activity changes from Temporal orchestrator
	const handleTemporalActivityChange = useCallback(
		(activity: TemporalOrchestratorActivityState) => {
			const wasActive = lastActivityStateRef.current.wasActive;
			const lastPlanId = lastActivityStateRef.current.planId;

			// Convert TemporalOrchestratorActivityState to OrchestratorActivityState
			const planDisplay = activity.plan
				? {
						id: activity.plan.id,
						description: activity.plan.description,
						riskLevel: activity.plan.riskLevel,
						steps: activity.plan.steps.map((step) => ({
							id: step.id,
							description: step.description,
							status: step.status,
							order: step.order,
							riskLevel: step.riskLevel,
						})),
					}
				: undefined;

			// Detect transition from active to inactive (execution completed)
			// Save the completed plan to the history
			if (
				wasActive &&
				!activity.isActive &&
				planDisplay &&
				planDisplay.id !== lastPlanId
			) {
				const completedPlan: CompletedPlanDisplay = {
					id: planDisplay.id,
					description: planDisplay.description,
					plan: planDisplay,
					routingDecision: activity.routingDecision,
					completedAt: new Date(),
				};

				setCompletedPlans((prev) => {
					// Don't add duplicates
					if (prev.some((p) => p.id === planDisplay.id)) {
						return prev;
					}
					return [...prev, completedPlan];
				});

				// Auto-collapse the completed plan
				setCollapsedPlans((prev) => new Set([...prev, planDisplay.id]));
			}

			// Update tracking state
			lastActivityStateRef.current = {
				wasActive: activity.isActive,
				planId: planDisplay?.id,
			};

			setOrchestratorActivity({
				isActive: activity.isActive,
				currentStage: activity.currentPhase,
				routingDecision: activity.routingDecision,
				plan: planDisplay,
				completedSteps: activity.completedSteps,
				totalSteps: activity.totalSteps,
				currentStep: activity.currentStep
					? {
							id: activity.currentStep.id,
							description: activity.currentStep.description,
							status: activity.currentStep.status,
							order: activity.currentStep.order,
							riskLevel: activity.currentStep.riskLevel,
						}
					: undefined,
				toolCalls: [], // Temporal component manages tool calls internally
				pendingApproval: activity.pendingApproval,
			});
		},
		[setOrchestratorActivity, useOrchestrator],
	);

	// Conversation history
	const {
		conversations,
		isLoadingList: isLoadingConversations,
		isLoadingDetail,
		activeConversationId,
		activeConversation,
		selectConversation: selectConversationInternal,
		deleteConversation,
		togglePin,
		isDeleting,
		refetchList,
	} = useConversationHistory({
		organizationId,
		// Canonical RegisteredAgent.agentId. Migrated from legacy
		// "fabric-ai" alias — the Prisma migration in this PR also
		// updates existing AgentConversation rows so the filter
		// continues to surface the same history.
		agentId: "fabric-workspace-assistant",
	});

	// Restore mode + reasoning from a loaded conversation's metadata.
	//
	// When the user opens an existing conversation (sidebar click, URL deep
	// link, or refresh on a `?c=...` URL), the page should reflect the mode
	// and reasoning that conversation was conducted in — not the user's
	// global default. The conversation's metadata holds:
	//
	//   metadata.mode          → "direct" | "orchestrator" | "research"
	//   metadata.executionMode → "lite" | "balanced" | "deep" | "planner"
	//
	// Without this effect, opening (e.g.) a Direct conversation while the
	// user's persisted default is Orchestrator would render the Orchestrator
	// chat component trying to load a Direct conversation — visibly the
	// wrong UI for the chat the user just clicked.
	//
	// Critical: we MUST notify the parent via `onConversationRestoredMode`
	// so the parent can sync its `lastPersisted*` snapshot refs in the
	// same render. Otherwise the parent's persist effects would observe
	// the state change, see a diff vs. last-persisted, and silently
	// overwrite the user's persistent default with the conversation's
	// mode — i.e. "I clicked an old chat" would change my default.
	const restoredConversationIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!activeConversation || !activeConversationId) {
			return;
		}
		if (restoredConversationIdRef.current === activeConversationId) {
			return;
		}
		const metadata = (activeConversation as { metadata?: unknown })
			?.metadata;
		if (!metadata || typeof metadata !== "object") {
			restoredConversationIdRef.current = activeConversationId;
			return;
		}
		const m = metadata as { mode?: unknown; executionMode?: unknown };
		const restoredMode: "direct" | "orchestrator" | "research" | null =
			m.mode === "direct" ||
			m.mode === "orchestrator" ||
			m.mode === "research"
				? m.mode
				: null;
		const restoredReasoning: ReasoningMode | null =
			m.executionMode === "lite" ||
			m.executionMode === "balanced" ||
			m.executionMode === "deep" ||
			m.executionMode === "planner"
				? m.executionMode
				: null;

		if (restoredMode === "direct") {
			setUseOrchestrator(false);
			setDeepResearchEnabled(false);
		} else if (restoredMode === "research") {
			setUseOrchestrator(false);
			setDeepResearchEnabled(true);
		} else if (restoredMode === "orchestrator") {
			setUseOrchestrator(true);
			setDeepResearchEnabled(false);
		}
		if (restoredReasoning) {
			setReasoningMode(restoredReasoning);
		}

		// Hand off to the parent so it can suppress the persist echo this
		// state change would otherwise trigger.
		if (restoredMode || restoredReasoning) {
			onConversationRestoredMode({
				chatMode: restoredMode,
				reasoningMode: restoredReasoning,
			});
		}
		restoredConversationIdRef.current = activeConversationId;
	}, [
		activeConversation,
		activeConversationId,
		setUseOrchestrator,
		setDeepResearchEnabled,
		setReasoningMode,
		onConversationRestoredMode,
	]);

	// Sync conversation selection with URL
	useEffect(() => {
		if (
			conversationIdFromUrl &&
			conversationIdFromUrl !== activeConversationId
		) {
			selectConversationInternal(conversationIdFromUrl);
		} else if (!conversationIdFromUrl && activeConversationId) {
			// URL was cleared, clear selection
			selectConversationInternal(null);
		}
	}, [
		conversationIdFromUrl,
		activeConversationId,
		selectConversationInternal,
	]);

	// Clear URL if conversation doesn't exist (e.g., stale bookmark, deleted conversation)
	useEffect(() => {
		// If URL has a conversation ID, selection was made, but conversation is null
		// (after loading completes), then the conversation doesn't exist
		if (
			conversationIdFromUrl &&
			activeConversationId === conversationIdFromUrl &&
			activeConversation === null &&
			!isLoadingDetail
		) {
			console.warn(
				`[FabricChat] Conversation not found, clearing URL: ${conversationIdFromUrl}`,
			);
			onConversationChange(null);
			selectConversationInternal(null);
		}
	}, [
		conversationIdFromUrl,
		activeConversationId,
		activeConversation,
		isLoadingDetail,
		onConversationChange,
		selectConversationInternal,
	]);

	// Auto-switch mode based on conversation metadata when loading from history
	// Also restore documentChatId for uploaded documents
	useEffect(() => {
		if (activeConversation) {
			const metadata = activeConversation.metadata as any;
			if (metadata?.mode === "research") {
				setDeepResearchEnabled(true);
				setUseOrchestrator(false);
			} else if (metadata?.mode === "orchestrator" && !useOrchestrator) {
				setDeepResearchEnabled(false);
				setUseOrchestrator(true);
				setActiveTab("agents");
			} else if (
				(metadata?.mode === "direct" || !metadata?.mode) &&
				useOrchestrator
			) {
				// Switch to direct mode for direct conversations or legacy conversations without mode metadata
				setDeepResearchEnabled(false);
				setUseOrchestrator(false);
				setActiveTab("history");
			}
			// Restore documentChatId if it was saved with the conversation
			if (metadata?.documentChatId) {
				setDocumentChatId(metadata.documentChatId);
			}
			// Restore or clear instanceId based on conversation metadata.
			// Always sync so switching between conversations (including two
			// different instance-backed ones) never leaves a stale value.
			// Safe to call unconditionally: onInstanceIdRestored sets
			// restoredInstanceId, and effectiveInstanceId = instanceIdFromUrl ||
			// restoredInstanceId, so a URL param always takes precedence.
			if (metadata?.instanceId) {
				onInstanceIdRestored?.(metadata.instanceId);
			} else {
				onInstanceIdRestored?.(null);
			}
		} else {
			// No active conversation at all — clear restored instanceId
			onInstanceIdRestored?.(null);
		}
	}, [activeConversation, useOrchestrator, onInstanceIdRestored]);

	// Wrapper that also updates URL
	const selectConversation = useCallback(
		(convId: string | null) => {
			selectConversationInternal(convId);
			onConversationChange(convId);
		},
		[selectConversationInternal, onConversationChange],
	);

	const chrome = getInterfaceModeChrome(uiMode);

	// A conversation is bound to the engine it was created on: the effect above
	// restores that engine from the conversation's metadata whenever one is
	// active, so a click on another engine pill is set and then immediately
	// reverted — the send still goes to the original engine's endpoint. The
	// binding is deliberate; answering the click by doing nothing is not, so
	// the pills say so instead of pretending to be live (Fizzy #2040).
	const engineLockedToConversation = Boolean(activeConversationId);
	const engineLockNote =
		"This chat runs on the engine it was started with — use New to pick a different one.";

	// The Agents tab configures which specialists the orchestrator may plan
	// with and delegate to, so Direct has nothing to put in it — and the panel
	// rendered a blank deck there rather than saying so. Offer the tab only
	// where it means something.
	const tabs: { id: TabType; icon: LucideIcon; label: string }[] = [
		{ id: "history", icon: History, label: "History" },
		...(useOrchestrator
			? [
					{
						id: "agents" as TabType,
						icon: Settings2,
						label: "Agents",
					},
				]
			: []),
		{ id: "tools", icon: Wrench, label: "Tools" },
		{ id: "workspace", icon: FolderOpen, label: "Files" },
		{ id: "projects", icon: FolderKanban, label: "Projects" },
		{ id: "frames", icon: LayoutGrid, label: "Frames" },
	];

	// Leaving Orchestrator while the (now hidden) Agents tab is active would
	// otherwise leave the deck showing nothing at all.
	useEffect(() => {
		if (!useOrchestrator && activeTab === "agents") {
			setActiveTab("tools");
		}
	}, [useOrchestrator, activeTab]);

	// Workspace files hook
	const {
		files: workspaceFiles,
		isLoading: isLoadingWorkspace,
		refetch: refetchWorkspace,
		createFile: createWorkspaceFile,
		deleteFile: deleteWorkspaceFile,
	} = useWorkspaceFiles({
		conversationId: activeConversationId,
		organizationId,
	});

	// Orchestrator config hook - for agent, MCP, workspace, Fabric tool, and integration toggles
	const {
		enabledAgentIds,
		enabledMcpConfigIds,
		enabledWorkspaceIds,
		enabledFabricToolIds,
		enabledIntegrationIds,
		prioritizedToolIds,
		prioritizedAgentIds,
		prioritizedMcpConfigIds,
		prioritizedIntegrationIds,
		handleAgentToggle,
		handleMcpToggle,
		handleWorkspaceToggle,
		handleFabricToolToggle,
		handleIntegrationToggle,
		handleAgentPrioritize,
		handleMcpPrioritize,
		handleToolPrioritize,
		handleIntegrationPrioritize,
		handleEnableAllAgents,
		handleDisableAllAgents,
		handleEnableAllMcp,
		handleDisableAllMcp,
		handleEnableAllFabricTools,
		handleDisableAllFabricTools,
		handleEnableAllIntegrations,
		handleDisableAllIntegrations,
		handleClearAllPrioritized,
	} = useOrchestratorConfig(organizationId);

	// When an agent template instance has toolConnections with MCP configs,
	// override the orchestrator's MCP config IDs with the instance's configured MCP servers.
	// IMPORTANT: Only override if the instance actually has MCP configs.
	// An empty array [] means "explicitly disabled" downstream, so we must fall through
	// to the user's sidebar selection (null = all tools) when the template has none.
	const effectiveMcpConfigIds =
		instanceToolConfig && instanceToolConfig.mcpConfigIds.length > 0
			? instanceToolConfig.mcpConfigIds
			: enabledMcpConfigIds;
	const effectivePrioritizedMcpConfigIds =
		instanceToolConfig && instanceToolConfig.mcpConfigIds.length > 0
			? instanceToolConfig.mcpConfigIds
			: prioritizedMcpConfigIds;
	const effectiveFabricToolIds =
		instanceToolConfig && instanceToolConfig.enabledFabricToolIds.length > 0
			? instanceToolConfig.enabledFabricToolIds
			: enabledFabricToolIds;

	const [selectedWorkspaceFile, setSelectedWorkspaceFile] =
		useState<WorkspaceFile | null>(null);

	// Document chat ID state - tracks the AiChat where uploaded documents are stored
	// This is separate from the AgentConversation ID
	const [documentChatId, setDocumentChatId] = useState<string | null>(null);

	// Pending project ID — selected before or after conversation creation
	// Works like workspace IDs: stored client-side and passed to the stream request.
	// Falls back to the agent's bound project (toolConnections["project-context"])
	// so opening an agent with a configured project pre-attaches it.
	const [pendingProjectId, setPendingProjectId] = useState<string | null>(
		contextLaunch?.projectId ?? instanceToolConfig?.boundProjectId ?? null,
	);

	// Apply the agent's bound project once it loads — agentInstance is fetched
	// async, so the useState initializer above usually misses it on first render.
	// Only fill in when the user hasn't selected a project and there's no URL override.
	const boundProjectId = instanceToolConfig?.boundProjectId ?? null;
	useEffect(() => {
		if (boundProjectId && !contextLaunch?.projectId && !pendingProjectId) {
			setPendingProjectId(boundProjectId);
		}
		// Intentionally only react to boundProjectId changes — re-running on
		// pendingProjectId would clobber the user's own project selection.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [boundProjectId]);

	// Convert enabledWorkspaceIds array to Set for compatibility with existing components
	const pendingWorkspaceIds = useMemo(
		() => new Set(enabledWorkspaceIds),
		[enabledWorkspaceIds],
	);
	const setPendingWorkspaceIds = useCallback(
		(idsOrUpdater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
			// Handle both direct Set and updater function
			const newIds =
				typeof idsOrUpdater === "function"
					? idsOrUpdater(new Set(enabledWorkspaceIds))
					: idsOrUpdater;

			// Sync changes with the persisted hook
			const currentSet = new Set(enabledWorkspaceIds);

			// Find added IDs
			for (const id of newIds) {
				if (!currentSet.has(id)) {
					handleWorkspaceToggle(id, true);
				}
			}

			// Find removed IDs
			for (const id of currentSet) {
				if (!newIds.has(id)) {
					handleWorkspaceToggle(id, false);
				}
			}
		},
		[enabledWorkspaceIds, handleWorkspaceToggle],
	);

	const queryClient = useQueryClient();
	const instanceIdForWorkspaceContext =
		typeof window !== "undefined"
			? new URLSearchParams(window.location.search).get("instanceId")
			: null;
	const { data: currentInstanceData } = useQuery({
		queryKey: [
			"agentTemplates",
			"instances",
			"get",
			instanceIdForWorkspaceContext,
			"workspace-context",
		],
		queryFn: async () => {
			if (!instanceIdForWorkspaceContext) {
				return null;
			}
			return await orpcClient.agentTemplates.instances.get({
				id: instanceIdForWorkspaceContext,
			});
		},
		enabled: !!instanceIdForWorkspaceContext,
	});
	const resolvedAgentStarterMessages = useMemo(() => {
		const value = (currentInstanceData?.instance as any)?.customInstructions
			?.starterMessages;
		return Array.isArray(value)
			? (
					value as Array<{
						label: string;
						emoji?: string;
						prompt: string;
					}>
				).map((message) => ({
					...message,
					emoji: message.emoji ?? "",
				}))
			: [];
	}, [currentInstanceData]);
	const resolvedAgentWorkspaceIds = useMemo(
		() =>
			Array.isArray((currentInstanceData?.instance as any)?.workspaceIds)
				? (((currentInstanceData?.instance as any)
						?.workspaceIds as string[]) ?? [])
				: [],
		[currentInstanceData],
	);
	const resolvedAgentDocumentIds = useMemo(() => {
		const filters = (
			(currentInstanceData?.instance as any)?.customInstructions as
				| Record<string, unknown>
				| undefined
		)?.knowledgeFilters;
		if (!Array.isArray(filters)) {
			return [];
		}
		return Array.from(
			new Set(
				filters.flatMap((filter) =>
					Array.isArray(
						(filter as { documentIds?: unknown }).documentIds,
					)
						? ((filter as { documentIds: string[] }).documentIds ??
							[])
						: [],
				),
			),
		);
	}, [currentInstanceData]);

	// Compute effective workspace IDs for RAG retrieval
	// Always use user's global workspace preferences (like MCP/agents/tools)
	// This ensures workspace settings persist across all threads consistently
	const effectiveWorkspaceIds = useMemo(() => {
		if (resolvedAgentWorkspaceIds.length > 0) {
			return resolvedAgentWorkspaceIds;
		}
		return Array.from(pendingWorkspaceIds);
	}, [resolvedAgentWorkspaceIds, pendingWorkspaceIds]);

	// Query for uploaded documents with optimized polling
	// Uses exponential backoff: 2s -> 3s -> 5s to reduce network overhead
	const documentsQuery = useQuery({
		queryKey: ["ai", "documents", "list", { chatId: documentChatId }],
		queryFn: async () => {
			if (!documentChatId) {
				return { documents: [] };
			}
			return await orpcClient.ai.documents.list({
				chatId: documentChatId,
			});
		},
		enabled: !!documentChatId,
		// Optimized polling with backoff based on fetch count
		refetchInterval: (query) => {
			const data = query.state.data;
			if (!data?.documents) {
				return false;
			}
			const hasPending = data.documents.some(
				(d) => d.status === "PENDING" || d.status === "PROCESSING",
			);
			if (!hasPending) {
				return false;
			}
			// Exponential backoff: 2s for first 3 polls, then 5s
			const fetchCount = query.state.dataUpdateCount;
			return fetchCount < 3 ? 2000 : 5000;
		},
	});

	// Convert uploaded documents to WorkspaceFile format and combine with workspace files
	// This makes documents appear as a folder INSIDE the workspace, not as a separate section above it
	const combinedWorkspaceFiles = useMemo((): WorkspaceFile[] => {
		const documents = documentsQuery.data?.documents || [];

		// If there are no documents, just return workspace files
		if (documents.length === 0) {
			return workspaceFiles;
		}

		// Convert documents to WorkspaceFile format
		const documentFiles: WorkspaceFile[] = documents.map((doc) => ({
			id: `doc-${doc.id}`,
			name: doc.filename,
			path: `uploads/${doc.filename}`,
			type: "file" as const,
			extension: doc.filename.split(".").pop() || "",
			fileType: "DOCUMENT",
			size: doc.size,
			// Add status indicator to the name if processing
			...(doc.status !== "READY" && {
				name: `${doc.filename} (${doc.status === "PROCESSING" ? "Processing..." : doc.status === "PENDING" ? "Queued" : "Failed"})`,
			}),
		}));

		// Create an "Uploaded Documents" folder containing the documents
		const uploadsFolder: WorkspaceFile = {
			id: "uploads-folder",
			name: "Uploaded Documents",
			path: "uploads",
			type: "folder",
			children: documentFiles,
		};

		// Return uploads folder first, then workspace files
		return [uploadsFolder, ...workspaceFiles];
	}, [documentsQuery.data?.documents, workspaceFiles]);

	// Handle document chat creation - auto-switch to Files tab
	const handleDocumentChatCreated = useCallback(
		(chatId: string) => {
			setDocumentChatId(chatId);
			setActiveTab("workspace"); // Switch to Files tab
			// Invalidate documents query to refresh
			queryClient.invalidateQueries({
				queryKey: ["ai", "documents", "list", { chatId }],
			});
		},
		[setActiveTab, queryClient],
	);

	// Reset document chat ID and deep research state when starting a new conversation
	useEffect(() => {
		if (activeConversationId === null) {
			setDocumentChatId(null);
			resetDeepResearch();
		}
	}, [activeConversationId, resetDeepResearch]);

	// Note: We no longer attach workspaces per-conversation.
	// Workspace settings are now global user preferences (like MCP/agents/tools)
	// that persist across all threads.

	// Resizable sidebar state
	const MIN_SIDEBAR_WIDTH = 240;
	const MAX_SIDEBAR_WIDTH = 468;
	const DEFAULT_SIDEBAR_WIDTH = 350;

	// Start with default width to avoid hydration mismatch
	const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
	const [isResizing, setIsResizing] = useState(false);
	const [viewportWidth, setViewportWidth] = useState(1440);
	const sidebarRef = useRef<HTMLDivElement>(null);

	// Load saved width from localStorage after hydration
	useEffect(() => {
		setViewportWidth(window.innerWidth);

		const saved = localStorage.getItem("fabric-ai-sidebar-width");
		if (saved) {
			const width = Number.parseInt(saved, 10);
			if (width >= MIN_SIDEBAR_WIDTH && width <= MAX_SIDEBAR_WIDTH) {
				setSidebarWidth(Math.max(width, DEFAULT_SIDEBAR_WIDTH));
			}
		}
	}, []);

	useEffect(() => {
		const handleResize = () => {
			setViewportWidth(window.innerWidth);
		};

		window.addEventListener("resize", handleResize);
		return () => {
			window.removeEventListener("resize", handleResize);
		};
	}, []);

	const isCompactViewport = viewportWidth < 1180;
	const isMobileViewport = viewportWidth < 768;
	const effectiveSidebarWidth = useMemo(() => {
		if (!sidebarOpen) {
			return 48;
		}

		if (isMobileViewport) {
			return Math.min(
				sidebarWidth,
				Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - 24),
			);
		}

		if (isCompactViewport) {
			return Math.min(
				sidebarWidth,
				Math.max(340, Math.floor(viewportWidth * 0.43)),
			);
		}

		return sidebarWidth;
	}, [
		isCompactViewport,
		isMobileViewport,
		sidebarOpen,
		sidebarWidth,
		viewportWidth,
	]);

	// Handle resize drag
	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			if (isCompactViewport) {
				return;
			}
			setIsResizing(true);
		},
		[isCompactViewport],
	);

	useEffect(() => {
		const handleMouseMove = (e: MouseEvent) => {
			if (!isResizing) {
				return;
			}

			const newWidth = e.clientX;
			const resizeMaxWidth = Math.min(
				MAX_SIDEBAR_WIDTH,
				Math.max(MIN_SIDEBAR_WIDTH, viewportWidth - 320),
			);
			if (newWidth >= MIN_SIDEBAR_WIDTH && newWidth <= resizeMaxWidth) {
				setSidebarWidth(newWidth);
			}
		};

		const handleMouseUp = () => {
			if (isResizing) {
				setIsResizing(false);
				// Save to localStorage
				localStorage.setItem(
					"fabric-ai-sidebar-width",
					sidebarWidth.toString(),
				);
			}
		};

		if (isResizing) {
			document.addEventListener("mousemove", handleMouseMove);
			document.addEventListener("mouseup", handleMouseUp);
			// Prevent text selection while dragging
			document.body.style.userSelect = "none";
			document.body.style.cursor = "col-resize";
		}

		return () => {
			document.removeEventListener("mousemove", handleMouseMove);
			document.removeEventListener("mouseup", handleMouseUp);
			document.body.style.userSelect = "";
			document.body.style.cursor = "";
		};
	}, [isResizing, sidebarWidth, viewportWidth]);

	const modeConfig = {
		lite: {
			label: "Fast",
			icon: Zap,
			color: "text-highlight",
			bgColor: "bg-highlight/10",
		},
		balanced: {
			label: "Balanced",
			icon: Scale,
			color: "text-muted-foreground",
			bgColor: "bg-muted",
		},
		deep: {
			label: "Thorough",
			icon: ScanSearch,
			color: "text-primary",
			bgColor: "bg-primary/10",
		},
		planner: {
			label: "Planner",
			icon: Layers,
			color: "text-secondary",
			bgColor: "bg-secondary/10",
		},
	};

	return (
		<div className="flex h-full bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.10),transparent_24%),radial-gradient(circle_at_bottom_left,rgba(59,130,246,0.06),transparent_24%),linear-gradient(180deg,rgba(255,255,255,0.01),rgba(255,255,255,0))]">
			{sidebarOpen && isCompactViewport && (
				<button
					type="button"
					aria-label="Close control deck"
					className="absolute inset-0 z-10 bg-background/55 backdrop-blur-[2px]"
					onClick={() => setSidebarOpen(false)}
				/>
			)}

			{/* Left Sidebar - use CSS containment to prevent layout shifts.
			    Simple mode drops it entirely rather than leaving the collapsed
			    icon rail behind: `sidebarOpen` is held false for the whole mode,
			    so every rail button would move its own highlight and open
			    nothing — a control that answers a click by doing nothing reads
			    as broken, not as hidden (Fizzy #2040). */}
			{chrome.showControlDeck && (
				<div
					ref={sidebarRef}
					style={
						sidebarOpen
							? {
									width: effectiveSidebarWidth,
									minWidth: effectiveSidebarWidth,
									maxWidth: effectiveSidebarWidth,
								}
							: { width: 48, minWidth: 48, maxWidth: 48 }
					}
					className={cn(
						"relative flex flex-shrink-0",
						sidebarOpen ? "overflow-visible" : "overflow-hidden",
						isCompactViewport &&
							sidebarOpen &&
							"absolute inset-y-0 left-0 z-20 shadow-[0_24px_80px_rgba(0,0,0,0.45)]",
						!isCompactViewport && !sidebarOpen && "border-r-0",
						"transition-[width,min-width,max-width] duration-200 ease-out",
					)}
				>
					{sidebarOpen ? (
						<div className="flex h-full min-w-0 flex-1 flex-col border-r border-border/60 bg-background/45 backdrop-blur-sm">
							<div className="border-b border-border/60 px-3 py-3">
								<div className="rounded-lg border border-border/60 bg-card/40 p-3">
									<div className="flex items-start justify-between gap-3">
										<div className="min-w-0">
											<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
												Control Deck
											</p>
											<p className="mt-2 text-[11px] leading-5 text-muted-foreground">
												Configure agents, tools, and
												files for the next run.
											</p>
										</div>

										{isCompactViewport ? (
											<Button
												variant="ghost"
												size="icon"
												className="h-9 w-9 rounded-md border border-border/50 bg-background/45 text-muted-foreground hover:bg-background/65 hover:text-foreground"
												onClick={() =>
													setSidebarOpen(false)
												}
											>
												<ChevronLeft className="h-4 w-4" />
											</Button>
										) : null}
									</div>

									<div className="mt-3 grid grid-cols-2 gap-2">
										{tabs.map((tab) => (
											<button
												key={tab.id}
												type="button"
												onClick={() =>
													setActiveTab(tab.id)
												}
												className={cn(
													"flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-left transition-all",
													activeTab === tab.id
														? "border-primary/25 bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_rgba(236,72,153,0.18)]"
														: "border-border/55 bg-background/40 text-muted-foreground hover:bg-background/60 hover:text-foreground",
												)}
											>
												<tab.icon className="h-4 w-4 shrink-0" />
												<div className="min-w-0">
													<div className="text-sm font-medium">
														{tab.label}
													</div>
												</div>
											</button>
										))}
									</div>
								</div>
							</div>

							{/* Tab Content */}
							<div className="flex-1 overflow-y-auto overflow-x-hidden">
								{activeTab === "history" && (
									<HistoryTabContent
										conversations={conversations.map(
											(conv) => ({
												id: conv.id,
												title: conv.title,
												lastMessage: conv.lastMessage,
												createdAt: conv.createdAt,
												pinned: conv.pinned,
												metadata: (conv as any)
													.metadata,
											}),
										)}
										activeConversationId={
											activeConversationId
										}
										isLoading={isLoadingConversations}
										isDeleting={isDeleting}
										onSelectConversation={
											selectConversation
										}
										onTogglePin={togglePin}
										onDeleteConversation={
											deleteConversation
										}
									/>
								)}

								{activeTab === "agents" && (
									<div className="p-3">
										<OrchestratorConfigPanel
											organizationId={organizationId}
											enabledAgentIds={enabledAgentIds}
											enabledMcpConfigIds={
												enabledMcpConfigIds
											}
											enabledFabricToolIds={
												enabledFabricToolIds
											}
											enabledIntegrationIds={
												enabledIntegrationIds
											}
											prioritizedToolIds={
												prioritizedToolIds
											}
											prioritizedAgentIds={
												prioritizedAgentIds
											}
											prioritizedMcpConfigIds={
												prioritizedMcpConfigIds
											}
											prioritizedIntegrationIds={
												prioritizedIntegrationIds
											}
											onAgentToggle={handleAgentToggle}
											onMcpToggle={handleMcpToggle}
											onFabricToolToggle={
												handleFabricToolToggle
											}
											onIntegrationToggle={
												handleIntegrationToggle
											}
											onAgentPrioritize={
												handleAgentPrioritize
											}
											onMcpPrioritize={
												handleMcpPrioritize
											}
											onToolPrioritize={
												handleToolPrioritize
											}
											onIntegrationPrioritize={
												handleIntegrationPrioritize
											}
											onEnableAllAgents={
												handleEnableAllAgents
											}
											onDisableAllAgents={
												handleDisableAllAgents
											}
											onEnableAllMcp={handleEnableAllMcp}
											onDisableAllMcp={
												handleDisableAllMcp
											}
											onEnableAllFabricTools={
												handleEnableAllFabricTools
											}
											onDisableAllFabricTools={
												handleDisableAllFabricTools
											}
											onEnableAllIntegrations={
												handleEnableAllIntegrations
											}
											onDisableAllIntegrations={
												handleDisableAllIntegrations
											}
											showAgents={useOrchestrator}
											sectionMode="agents"
										/>
									</div>
								)}

								{activeTab === "tools" && (
									<div className="p-3">
										<OrchestratorConfigPanel
											organizationId={organizationId}
											enabledAgentIds={enabledAgentIds}
											enabledMcpConfigIds={
												enabledMcpConfigIds
											}
											enabledFabricToolIds={
												enabledFabricToolIds
											}
											enabledIntegrationIds={
												enabledIntegrationIds
											}
											prioritizedToolIds={
												prioritizedToolIds
											}
											prioritizedAgentIds={
												prioritizedAgentIds
											}
											prioritizedMcpConfigIds={
												prioritizedMcpConfigIds
											}
											prioritizedIntegrationIds={
												prioritizedIntegrationIds
											}
											onAgentToggle={handleAgentToggle}
											onMcpToggle={handleMcpToggle}
											onFabricToolToggle={
												handleFabricToolToggle
											}
											onIntegrationToggle={
												handleIntegrationToggle
											}
											onAgentPrioritize={
												handleAgentPrioritize
											}
											onMcpPrioritize={
												handleMcpPrioritize
											}
											onToolPrioritize={
												handleToolPrioritize
											}
											onIntegrationPrioritize={
												handleIntegrationPrioritize
											}
											onEnableAllAgents={
												handleEnableAllAgents
											}
											onDisableAllAgents={
												handleDisableAllAgents
											}
											onEnableAllMcp={handleEnableAllMcp}
											onDisableAllMcp={
												handleDisableAllMcp
											}
											onEnableAllFabricTools={
												handleEnableAllFabricTools
											}
											onDisableAllFabricTools={
												handleDisableAllFabricTools
											}
											onEnableAllIntegrations={
												handleEnableAllIntegrations
											}
											onDisableAllIntegrations={
												handleDisableAllIntegrations
											}
											showAgents={false}
											sectionMode="tools"
										/>
									</div>
								)}

								{activeTab === "workspace" && (
									<div className="h-full flex flex-col">
										{/* Document Workspaces Section */}
										<DocumentWorkspacesSection
											conversationId={
												activeConversationId
											}
											organizationId={organizationId}
											pendingWorkspaceIds={
												pendingWorkspaceIds
											}
											onPendingChange={
												setPendingWorkspaceIds
											}
										/>

										{/* Divider */}
										<div className="border-t mx-3" />

										{/* Workspace Panel with uploaded documents integrated as a folder */}
										<div className="flex-1 min-h-0">
											<WorkspacePanel
												files={combinedWorkspaceFiles}
												isLoading={isLoadingWorkspace}
												selectedFileId={
													selectedWorkspaceFile?.id
												}
												onSelectFile={
													setSelectedWorkspaceFile
												}
												onCreateFile={(
													parentPath,
													name,
												) => {
													createWorkspaceFile({
														path: parentPath
															? `${parentPath}/${name}`
															: name,
														name,
														content: "",
														fileType: "DOCUMENT",
													});
												}}
												onDeleteFile={(fileId) => {
													// Don't allow deleting uploaded documents from workspace
													if (
														fileId.startsWith(
															"doc-",
														)
													) {
														return;
													}
													deleteWorkspaceFile(fileId);
													if (
														selectedWorkspaceFile?.id ===
														fileId
													) {
														setSelectedWorkspaceFile(
															null,
														);
													}
												}}
												onRefresh={refetchWorkspace}
												className="h-full border-0 rounded-none"
											/>
										</div>
									</div>
								)}

								{activeTab === "projects" && (
									<ProjectAttachmentPanel
										conversationId={
											activeConversationId || null
										}
										organizationId={organizationId}
										onProjectChange={setPendingProjectId}
										selectedProjectId={pendingProjectId}
									/>
								)}

								{activeTab === "frames" && (
									<FramesPanel
										organizationId={organizationId}
										conversationId={
											activeConversationId || null
										}
									/>
								)}
							</div>
						</div>
					) : (
						<div className="flex h-full w-full flex-col items-center gap-2 border-r border-border/60 bg-background/45 px-1 py-2.5 backdrop-blur-sm">
							{tabs.map((tab) => (
								<Button
									key={tab.id}
									variant={
										activeTab === tab.id
											? "secondary"
											: "ghost"
									}
									size="icon-sm"
									onClick={() => {
										setActiveTab(tab.id);
										setSidebarOpen(true);
									}}
									className="h-9 w-9 rounded-md"
									title={tab.label}
								>
									<tab.icon className="h-4 w-4" />
								</Button>
							))}
						</div>
					)}

					{!isMobileViewport ? (
						<SidebarEdgeHandle
							isExpanded={sidebarOpen}
							onClick={() => setSidebarOpen(!sidebarOpen)}
							expandLabel="Expand control deck"
							collapseLabel="Collapse control deck"
						/>
					) : null}

					{/* Resize Handle - only when sidebar is open */}
					{sidebarOpen && !isCompactViewport && (
						<button
							type="button"
							aria-label="Resize sidebar"
							className={cn(
								"absolute right-0 top-0 bottom-0 w-1 cursor-col-resize group",
								"hover:bg-primary/20 transition-colors",
								isResizing && "bg-primary/30",
							)}
							onMouseDown={handleMouseDown}
						>
							{/* Visual grip indicator */}
							<div
								className={cn(
									"absolute top-1/2 -translate-y-1/2 -right-1.5 w-4 h-8 flex items-center justify-center",
									"rounded-md opacity-0 group-hover:opacity-100 transition-opacity",
									"bg-muted border shadow-sm",
									isResizing && "opacity-100",
								)}
							>
								<GripVertical className="h-3 w-3 text-muted-foreground" />
							</div>
						</button>
					)}
				</div>
			)}

			{/* Main Chat Area - fixed minimum width to prevent CLS */}
			<div
				className="flex-1 flex flex-col min-w-0"
				style={{ minWidth: isCompactViewport ? 0 : 400 }}
			>
				{/* Header */}
				<header className="flex items-center gap-2 border-b border-border/60 bg-background/30 px-3 py-2 backdrop-blur-sm sm:gap-3 sm:px-4 sm:py-3 md:px-6 lg:h-16 lg:gap-4 lg:py-0 overflow-x-auto overflow-y-hidden">
					<div className="flex shrink-0 items-center gap-3">
						<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-primary/20 bg-gradient-to-br from-primary/18 to-primary/5 p-1.5 sm:h-10 sm:w-10 sm:p-2">
							<FabricLogo size={20} className="text-primary" />
						</div>
						<h1
							className="hidden leading-[1] text-foreground/85 lg:block"
							style={{
								fontFamily:
									"var(--font-sans, 'EB Garamond', Georgia, serif)",
								fontWeight: 400,
							}}
						>
							Fabric Loom
						</h1>
					</div>
					<div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2.5">
						{/* New run button */}
						<Button
							variant="outline"
							size="sm"
							className="h-9 rounded-md border-primary/20 bg-primary/10 px-2.5 text-primary hover:bg-primary/16"
							title="New run"
							onClick={() => {
								selectConversation(null);
								setOrchestratorActivity({
									isActive: false,
									currentStage: "idle",
									toolCalls: [],
								});
								setCompletedPlans([]);
								setCollapsedPlans(new Set());
								// Reset mode + reasoning back to the user's
								// persistent default (matches fresh-page-load
								// behavior). Replaces the previous hardcoded
								// `setUseOrchestrator(true) +
								// setDeepResearchEnabled(false)` which forced
								// Orchestrator regardless of the user's
								// preference and surprised users whose default
								// was Direct or Research.
								resetLoomModeToUserDefault();
								resetDeepResearch();
								setActiveTab("history");
								handleClearAllPrioritized();
								setChatInstanceKey((prev) => prev + 1);
							}}
						>
							<Plus className="h-4 w-4" />
							<span className="hidden lg:inline ml-1">New</span>
						</Button>

						{/*
						 * Interface mode (#2040). Simple is the reduced surface:
						 * the engine control and the reasoning control come off
						 * screen and the chat runs Direct. Advanced restores
						 * everything. The two are orthogonal — the engine choice
						 * is preserved while hidden, so returning to advanced
						 * lands back on whatever was set, not on Direct.
						 */}
						<TooltipProvider>
							<div className="flex items-center gap-1 rounded-md border border-border/60 bg-card/35 p-1">
								{(["simple", "advanced"] as const).map(
									(mode) => (
										<Tooltip key={mode}>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={() =>
														onUiModeChange(mode)
													}
													aria-pressed={
														uiMode === mode
													}
													className={cn(
														"flex h-9 items-center justify-center rounded-md px-2.5 gap-1.5 transition-colors",
														uiMode === mode
															? "bg-background shadow-sm text-foreground"
															: "hover:bg-background/50 text-muted-foreground",
													)}
												>
													<span className="text-xs font-medium capitalize">
														{mode}
													</span>
												</button>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{mode === "simple"
														? "Simple — just the chat, running Direct"
														: "Advanced — engine, reasoning and agent controls"}
												</p>
											</TooltipContent>
										</Tooltip>
									),
								)}
							</div>
						</TooltipProvider>

						{uiMode === "advanced" && (
							<>
								{/* Agent Mode Toggle — with visible label */}
								<TooltipProvider>
									<div className="flex items-center gap-1 rounded-md border border-border/60 bg-card/35 p-1">
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													disabled={
														engineLockedToConversation
													}
													onClick={() => {
														setUseOrchestrator(
															false,
														);
														setDeepResearchEnabled(
															false,
														);
													}}
													className={cn(
														"flex h-9 items-center justify-center rounded-md px-2.5 gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
														// Suppress active highlight until persisted prefs
														// hydrate, otherwise the tab paints "Orchestrator
														// is active" on first render and visibly snaps to
														// the correct mode after the network round-trip.
														// See `loomPrefsHydrated` comment in the parent.
														loomPrefsHydrated &&
															!useOrchestrator &&
															!deepResearchEnabled
															? "bg-background shadow-sm text-foreground"
															: "hover:bg-background/50 text-muted-foreground",
													)}
												>
													<Wrench className="h-4 w-4" />
													<span className="hidden text-xs font-medium sm:inline">
														Direct
													</span>
												</button>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{engineLockedToConversation
														? engineLockNote
														: "Direct mode — tools execute inline"}
												</p>
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													disabled={
														engineLockedToConversation
													}
													onClick={() => {
														setUseOrchestrator(
															true,
														);
														setDeepResearchEnabled(
															false,
														);
														// Switch to config tab when entering orchestrator mode in a new chat
														if (
															!activeConversationId
														) {
															setActiveTab(
																"agents",
															);
														}
													}}
													className={cn(
														"flex h-9 items-center justify-center rounded-md px-2.5 gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
														// See "Direct" branch above — same hydration gate.
														loomPrefsHydrated &&
															useOrchestrator &&
															!deepResearchEnabled
															? "bg-background shadow-sm text-primary"
															: "hover:bg-background/50 text-muted-foreground",
													)}
												>
													<Brain className="h-4 w-4" />
													<span className="hidden text-xs font-medium sm:inline">
														Orchestrator
													</span>
												</button>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{engineLockedToConversation
														? engineLockNote
														: "Orchestrator mode — plans and executes multi-step tasks"}
												</p>
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													disabled={
														engineLockedToConversation
													}
													onClick={() => {
														setDeepResearchEnabled(
															true,
														);
														setUseOrchestrator(
															false,
														);
													}}
													className={cn(
														"flex h-9 items-center justify-center rounded-md px-2.5 gap-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
														// See "Direct" branch above — same hydration gate.
														loomPrefsHydrated &&
															deepResearchEnabled
															? "bg-background shadow-sm text-secondary"
															: "hover:bg-background/50 text-muted-foreground",
													)}
												>
													<Globe className="h-4 w-4" />
													<span className="hidden text-xs font-medium sm:inline">
														Research
													</span>
												</button>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{engineLockedToConversation
														? engineLockNote
														: "Deep Research — parallel sub-agent investigation"}
												</p>
											</TooltipContent>
										</Tooltip>
									</div>
								</TooltipProvider>

								{/* Divider */}
								<div className="hidden h-8 w-px bg-border/70 md:block" />

								{/* Reasoning Mode Selector — hidden below md */}
								<TooltipProvider>
									<div className="hidden md:flex items-center gap-1 rounded-md border border-border/60 bg-card/35 p-1">
										{(
											[
												"lite",
												"balanced",
												"deep",
												"planner",
											] as const
										).map((mode) => {
											const config = modeConfig[mode];
											const Icon = config.icon;
											return (
												<Tooltip key={mode}>
													<TooltipTrigger asChild>
														<button
															type="button"
															onClick={() =>
																setReasoningMode(
																	mode,
																)
															}
															className={cn(
																"flex h-9 w-9 items-center justify-center rounded-md transition-colors",
																// Same hydration gate as the chat-mode tabs.
																loomPrefsHydrated &&
																	reasoningMode ===
																		mode
																	? "bg-background shadow-sm"
																	: "hover:bg-background/50",
															)}
														>
															<Icon
																className={cn(
																	"h-4 w-4",
																	config.color,
																)}
															/>
														</button>
													</TooltipTrigger>
													<TooltipContent>
														<p>{config.label}</p>
													</TooltipContent>
												</Tooltip>
											);
										})}
									</div>
								</TooltipProvider>
							</>
						)}

						{/* Context Usage Indicator — hidden below md */}
						<div className="hidden md:block">
							<Context
								maxTokens={tokenUsage.maxTokens}
								usedTokens={tokenUsage.totalTokens}
								usage={
									tokenUsage.totalTokens > 0
										? {
												inputTokens:
													tokenUsage.inputTokens,
												outputTokens:
													tokenUsage.outputTokens,
												totalTokens:
													tokenUsage.totalTokens,
												reasoningTokens:
													tokenUsage.reasoningTokens,
												cachedInputTokens:
													tokenUsage.cachedInputTokens,
											}
										: undefined
								}
								modelId="openai:gpt-4o"
							>
								<ContextTrigger />
								<ContextContent>
									<ContextContentHeader />
									<ContextContentBody>
										<ContextInputUsage />
										<ContextOutputUsage />
										<ContextReasoningUsage />
									</ContextContentBody>
									<ContextContentFooter />
								</ContextContent>
							</Context>
						</div>
					</div>
				</header>

				{contextLaunch?.projectId && !activeConversationId && (
					<div className="border-b border-border/60 bg-primary/[0.04] px-4 py-3">
						<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
							<div className="space-y-1">
								<p className="text-sm font-medium text-foreground">
									Context ready for Fabric Agent
								</p>
								<p className="text-sm text-muted-foreground">
									{contextLaunch.taskIdentifier
										? `Task ${contextLaunch.taskIdentifier} · ${contextLaunch.taskTitle}`
										: contextLaunch.storyIdentifier
											? `Feature ${contextLaunch.storyIdentifier} · ${contextLaunch.storyTitle}`
											: (contextLaunch.projectName ??
												"Project context")}
									{contextLaunch.projectName
										? ` from ${contextLaunch.projectName}`
										: ""}
									. The suggested prompt is loaded into the
									draft below.
								</p>
							</div>
							<div className="flex flex-wrap items-center gap-2">
								<Button variant="outline" size="sm" asChild>
									<Link
										href={
											contextLaunch.storyId
												? `${basePath}/projects/${contextLaunch.projectId}/stories/${contextLaunch.storyId}`
												: `${basePath}/projects/${contextLaunch.projectId}`
										}
									>
										Open source context
									</Link>
								</Button>
								<Button variant="ghost" size="sm" asChild>
									<Link href={`${basePath}/agents/fabric-ai`}>
										Clear context
									</Link>
								</Button>
							</div>
						</div>
					</div>
				)}
				{/* Chat Area */}
				<div className="flex-1 min-h-0">
					{deepResearchEnabled ? (
						/* Deep Research Mode: Temporal workflow with parallel sub-agents
						   - Decomposes query into sub-tasks
						   - Runs sub-agents in parallel
						   - Aggregates findings into structured report
						*/
						<DeepResearchInlineChat
							hasInteracted={deepResearchHasInteracted}
							query={deepResearchQuery}
							stream={deepResearchStream}
							onSend={handleDeepResearchSend}
							onReset={resetDeepResearch}
							organizationId={organizationId}
							reasoningMode={reasoningMode}
						/>
					) : isAgentInstanceMode ? (
						/* Agent Instance Mode: single-agent direct execution
						   - Agent instance instructions are the top-level system prompt
						   - Uses the instance's attached MCP servers directly
						   - Avoids generic orchestrator routing/planning
						*/
						<FabricDirectChat
							key={`agent-direct-${instanceId}-${chatInstanceKey}`}
							organizationId={organizationId}
							reasoningMode={reasoningMode}
							activeConversation={activeConversation}
							activeConversationId={activeConversationId}
							onConversationSaved={refetchList}
							onConversationCreated={(convId) => {
								onConversationChange(convId);
								refetchList();
							}}
							onUsageChange={setTokenUsage}
							enabledMcpConfigIds={effectiveMcpConfigIds}
							enabledFabricToolIds={effectiveFabricToolIds}
							showAgentPicker={chrome.showAgentPicker}
							showToolPicker={chrome.showToolPicker}
							onDocumentChatCreated={handleDocumentChatCreated}
							documentChatId={documentChatId}
							attachedWorkspaceIds={effectiveWorkspaceIds}
							attachedDocumentIds={resolvedAgentDocumentIds}
							systemPrompt={systemPrompt}
							instanceId={instanceId}
							initialInput={
								!activeConversationId
									? (contextLaunch?.prompt ?? undefined)
									: undefined
							}
						/>
					) : useOrchestrator ? (
						/* Orchestrator Mode: Temporal-based durable orchestration
						   - Multi-agent routing with CUGA-inspired architecture
						   - HITL approval for high-risk operations
						   - Task plan visualization with progress tracking
						   - Durable execution via Temporal workflows

						   Key uses chatInstanceKey to force remount when "New Chat" is clicked,
						   ensuring all state is completely reset
						*/
						<FabricTemporalOrchestratorChat
							key={`orchestrator-${chatInstanceKey}`}
							organizationId={organizationId}
							reasoningMode={reasoningMode}
							activeConversation={activeConversation}
							activeConversationId={activeConversationId}
							onConversationSaved={refetchList}
							onConversationCreated={(convId) => {
								onConversationChange(convId);
								refetchList();
							}}
							onActivityChange={handleTemporalActivityChange}
							onUsageChange={setTokenUsage}
							showAgentPicker={chrome.showAgentPicker}
							// Pass empty array when all disabled to explicitly disable all MCP/agents
							// null means "no filter, use all" whereas [] means "use none"
							enabledToolIds={effectiveMcpConfigIds}
							enabledAgentIds={enabledAgentIds}
							enabledFabricToolIds={effectiveFabricToolIds}
							prioritizedToolIds={prioritizedToolIds}
							prioritizedAgentIds={prioritizedAgentIds}
							prioritizedMcpConfigIds={
								effectivePrioritizedMcpConfigIds
							}
							onToolPrioritize={handleToolPrioritize}
							onAgentPrioritize={handleAgentPrioritize}
							onMcpPrioritize={handleMcpPrioritize}
							enabledIntegrationIds={enabledIntegrationIds}
							prioritizedIntegrationIds={
								prioritizedIntegrationIds
							}
							onIntegrationPrioritize={
								handleIntegrationPrioritize
							}
							attachedWorkspaceIds={effectiveWorkspaceIds}
							attachedDocumentIds={resolvedAgentDocumentIds}
							attachedProjectId={pendingProjectId}
							// Agent template instance props
							systemPrompt={systemPrompt}
							instanceId={instanceId}
							starterMessages={resolvedAgentStarterMessages}
							agentName={agentInstanceName || "Fabric Loom"}
							agentDescription={
								agentInstanceDescription ||
								"Durable multi-agent orchestration powered by Temporal."
							}
							sessionTemplates={sessionTemplates}
							onSessionTemplatesChange={setSessionTemplates}
							initialInput={
								!activeConversationId
									? (contextLaunch?.prompt ?? undefined)
									: undefined
							}
						/>
					) : (
						/* Direct MCP Mode: Custom streaming implementation
						   - Direct access to MCP tools
						   - Real-time tool call visualization
						   - Streaming responses with tool results

						   Key uses chatInstanceKey to force remount when "New Chat" is clicked,
						   ensuring all state is completely reset
						*/
						<FabricDirectChat
							key={`direct-${chatInstanceKey}`}
							organizationId={organizationId}
							reasoningMode={reasoningMode}
							activeConversation={activeConversation}
							activeConversationId={activeConversationId}
							onConversationSaved={refetchList}
							onConversationCreated={(convId) => {
								onConversationChange(convId);
								refetchList();
							}}
							onUsageChange={setTokenUsage}
							// Pass empty array when all disabled to explicitly disable all MCP servers
							enabledMcpConfigIds={effectiveMcpConfigIds}
							enabledFabricToolIds={effectiveFabricToolIds}
							showAgentPicker={chrome.showAgentPicker}
							showToolPicker={chrome.showToolPicker}
							onDocumentChatCreated={handleDocumentChatCreated}
							documentChatId={documentChatId}
							attachedWorkspaceIds={effectiveWorkspaceIds}
							attachedDocumentIds={resolvedAgentDocumentIds}
							attachedProjectId={pendingProjectId}
							initialInput={
								!activeConversationId
									? (contextLaunch?.prompt ?? undefined)
									: undefined
							}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * DeepResearchInlineChat - Inline deep research UI for the Fabric Loom page
 *
 * Uses the same shared ChatInput component as Direct/Orchestrator modes.
 * Renders research progress and results as chat-style messages in the
 * scrollable area above the input.
 */
const DEEP_RESEARCH_SUGGESTIONS = [
	{
		label: "AI agents & autonomous systems",
		emoji: "🤖",
		prompt: "What are the latest developments in AI agents and autonomous systems?",
	},
	{
		label: "RAG application approaches",
		emoji: "🔍",
		prompt: "Compare different approaches to building RAG applications",
	},
	{
		label: "Open source vs proprietary LLMs",
		emoji: "⚖️",
		prompt: "Analyze the current state of open source LLMs vs proprietary models",
	},
	{
		label: "Prompt engineering best practices",
		emoji: "✍️",
		prompt: "Research best practices for prompt engineering in production systems",
	},
];

interface DeepResearchInlineChatProps {
	hasInteracted: boolean;
	query: string;
	stream: ReturnType<typeof useWorkflowTemplateStream>;
	onSend: (query: string) => void;
	onReset: () => void;
	organizationId?: string;
	reasoningMode?: ReasoningMode;
}

function DeepResearchInlineChat({
	hasInteracted,
	query,
	stream,
	onSend,
	onReset,
	organizationId,
	reasoningMode,
}: DeepResearchInlineChatProps) {
	const [inputValue, setInputValue] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);

	const handleSend = useCallback(() => {
		const text = inputValue.trim();
		if (!text || stream.isLoading) {
			return;
		}
		setInputValue("");
		onSend(text);
	}, [inputValue, stream.isLoading, onSend]);

	// Auto-scroll to bottom when new content appears
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [
		stream.state.phase,
		stream.state.subAgentResults.length,
		stream.hasResults,
	]);

	return (
		<div className="flex flex-col h-full">
			{/* Scrollable message area — same structure as Direct/Orchestrator */}
			<div className="flex-1 overflow-y-auto">
				<div className="mx-auto max-w-3xl px-4 py-6">
					{/* Welcome state — matching Orchestrator's hero layout */}
					{!hasInteracted && (
						<div className="flex flex-col items-center justify-center pt-12 pb-8">
							<div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-secondary/10 mb-5">
								<Globe className="h-8 w-8 text-secondary" />
							</div>
							<h2
								className="text-2xl text-foreground/85 mb-2"
								style={{
									fontFamily:
										"var(--font-serif, 'EB Garamond', Georgia, serif)",
									fontWeight: 400,
								}}
							>
								Deep Research
							</h2>
							<p className="text-sm text-muted-foreground max-w-md text-center mb-8">
								Ask a research question. It will be decomposed,
								investigated in parallel, and synthesized into a
								structured report.
							</p>

							{/* Starter messages — same pattern as Orchestrator */}
							<div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2">
								{DEEP_RESEARCH_SUGGESTIONS.map((s) => (
									<button
										key={s.prompt}
										type="button"
										onClick={() => {
											setInputValue("");
											onSend(s.prompt);
										}}
										className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/40 p-3 text-left text-sm transition-colors hover:bg-muted/60"
									>
										<span className="text-lg shrink-0">
											{s.emoji}
										</span>
										<span className="text-muted-foreground leading-snug">
											{s.label}
										</span>
									</button>
								))}
							</div>
						</div>
					)}

					{/* Chat-style messages once research starts */}
					{hasInteracted && (
						<div className="space-y-4">
							{/* User query — styled like a user message bubble */}
							{query && (
								<div className="flex justify-end">
									<div className="max-w-[80%] rounded-2xl rounded-tr-md bg-primary/10 px-4 py-3">
										<p className="text-sm whitespace-pre-wrap">
											{query}
										</p>
									</div>
								</div>
							)}

							{/* Assistant response area */}
							<div className="flex gap-3">
								<div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary/10 mt-1">
									<Globe className="h-4 w-4 text-secondary" />
								</div>
								<div className="min-w-0 flex-1 space-y-4">
									{/* Progress panel */}
									{!stream.isComplete && (
										<WorkflowProgressPanel
											state={stream.state}
											progressPercentage={
												stream.progress.percentage
											}
											onClarificationResponse={
												stream.sendClarificationResponse
											}
										/>
									)}

									{/* Error */}
									{stream.state.error && (
										<div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
											<p className="text-sm text-destructive">
												{stream.state.error}
											</p>
										</div>
									)}

									{/* Results */}
									{stream.hasResults &&
										stream.state.result && (
											<WorkflowResultViewer
												result={stream.state.result}
												instanceId="deep-research-inline"
												organizationId={organizationId}
											/>
										)}

									{/* New Research button after completion */}
									{stream.isComplete && (
										<Button
											variant="outline"
											size="sm"
											onClick={onReset}
											className="mt-2"
										>
											<Sparkles className="h-4 w-4 mr-2" />
											New Research
										</Button>
									)}
								</div>
							</div>
						</div>
					)}

					<div ref={messagesEndRef} />
				</div>
			</div>

			{/* Shared ChatInput — same component used by Direct/Orchestrator */}
			<div className="border-t border-border/60 bg-background/80 px-4 py-3">
				<div className="mx-auto max-w-3xl space-y-2">
					<ChatInput
						value={inputValue}
						onChange={setInputValue}
						onSend={handleSend}
						isLoading={stream.isLoading}
						disabled={stream.isRunning}
						placeholder={
							stream.isRunning
								? "Research in progress..."
								: "Ask a research question..."
						}
						showAttachButton={false}
					/>
					{reasoningMode && reasoningMode !== "balanced" && (
						<p className="text-[11px] text-muted-foreground text-center">
							{reasoningMode === "lite" &&
								"Fast mode — minimal reasoning"}
							{reasoningMode === "deep" &&
								"Thorough mode — deep reasoning enabled"}
							{reasoningMode === "planner" &&
								"Planner mode — high reasoning enabled"}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * DocumentWorkspacesSection - Section for attaching document workspaces to conversations
 *
 * Supports pre-selecting workspaces before conversation exists:
 * - pendingWorkspaceIds: IDs of workspaces selected before conversation created
 * - onPendingChange: Callback when pending selection changes
 */
interface DocumentWorkspacesSectionProps {
	conversationId: string | null;
	/**
	 * Organization ID for filtering workspaces.
	 * - `string`: Show workspaces for this organization
	 * - `null`: Show personal workspaces only (explicit personal context)
	 * - `undefined`: Use the current organization context
	 */
	organizationId?: string | null;
	/** Pre-selected workspace IDs (before conversation exists) */
	pendingWorkspaceIds: Set<string>;
	/** Callback when pending selection changes */
	onPendingChange: (workspaceIds: Set<string>) => void;
}

function DocumentWorkspacesSection({
	conversationId: _conversationId,
	organizationId: propOrgId,
	pendingWorkspaceIds,
	onPendingChange,
}: DocumentWorkspacesSectionProps) {
	const organizationId = useEffectiveOrganizationId(propOrgId);
	// Was built from the organization ID in a segment that resolves by SLUG,
	// so this link 404'd inside an organization. The hook builds it from the
	// slug the URL already carries. Kept with the other hooks rather than
	// beside its use: the loading branch below returns early, and a hook after
	// an early return changes hook order between renders.
	const workspacesUrl = useContextPath("workspaces");

	// Fetch available workspaces
	const { data: workspaces, isLoading: isLoadingWorkspaces } = useQuery(
		orpc.documentWorkspaces.list.queryOptions({
			input: { organizationId, status: "ACTIVE" },
		}),
	);

	// Note: We no longer use per-conversation workspace attachments.
	// Workspace settings are now global user preferences (like MCP/agents/tools)
	// that persist across all threads for consistent behavior.

	if (isLoadingWorkspaces) {
		return (
			<div className="p-3">
				<div className="flex items-center gap-2 mb-2">
					<FolderOpen className="h-4 w-4 text-muted-foreground" />
					<span className="text-xs font-medium">
						Document Workspaces
					</span>
				</div>
				<div className="space-y-2">
					{[1, 2].map((i) => (
						<div
							key={i}
							className="h-10 bg-muted/50 rounded-md animate-pulse"
						/>
					))}
				</div>
			</div>
		);
	}

	// Use user's global workspace preferences (consistent with MCP/agents/tools)
	const workspaceItems = (workspaces?.workspaces || []).map(
		(w: {
			id: string;
			name: string;
			type: string;
			documentCount?: number;
		}) => ({
			id: w.id,
			name: w.name,
			type: w.type,
			documentCount: w.documentCount || 0,
			// Always use global user preferences for consistency
			isSelected: pendingWorkspaceIds.has(w.id),
		}),
	);

	const handleToggleWorkspace = (workspace: {
		id: string;
		name: string;
		type: string;
		documentCount: number;
		isSelected: boolean;
	}) => {
		// Always update global user preferences (like MCP/agents/tools)
		const newPending = new Set(pendingWorkspaceIds);
		if (workspace.isSelected) {
			newPending.delete(workspace.id);
		} else {
			newPending.add(workspace.id);
		}
		onPendingChange(newPending);
	};

	return (
		<div className="p-3 space-y-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-2">
					<FolderOpen className="h-4 w-4 text-muted-foreground" />
					<span className="text-xs font-medium">
						Document Workspaces
					</span>
				</div>
				<Link
					href={workspacesUrl}
					className="text-xs text-primary hover:underline"
				>
					Manage
				</Link>
			</div>

			{workspaceItems.length === 0 ? (
				<div className="text-center py-3">
					<p className="text-xs text-muted-foreground">
						No workspaces yet
					</p>
					<Link href={workspacesUrl}>
						<Button
							variant="outline"
							size="sm"
							className="mt-2 h-7 text-xs"
						>
							<Plus className="h-3 w-3 mr-1" />
							Create Workspace
						</Button>
					</Link>
				</div>
			) : (
				<div className="space-y-1.5">
					{workspaceItems.map((workspace) => (
						<div
							key={workspace.id}
							className={cn(
								"flex items-center justify-between p-2 rounded-md transition-colors",
								workspace.isSelected
									? "bg-primary/5 ring-1 ring-primary/20"
									: "bg-muted/30",
								workspace.documentCount === 0 && "opacity-60",
							)}
						>
							<div className="min-w-0 flex-1 pr-2">
								<div className="flex items-center gap-1.5">
									<FolderOpen className="h-3 w-3 text-muted-foreground flex-shrink-0" />
									<span className="text-xs font-medium truncate">
										{workspace.name}
									</span>
									{workspace.type === "PERSONAL" && (
										<Badge
											variant="secondary"
											className="text-[8px] px-1 py-0 h-3"
										>
											Personal
										</Badge>
									)}
								</div>
								<div className="flex items-center gap-2 mt-0.5">
									<span className="text-[10px] text-muted-foreground flex items-center gap-1">
										<FileIcon className="h-2.5 w-2.5" />
										{workspace.documentCount} docs
									</span>
								</div>
							</div>
							<Switch
								checked={workspace.isSelected}
								onCheckedChange={() =>
									handleToggleWorkspace(workspace)
								}
								disabled={workspace.documentCount === 0}
								className="scale-75"
							/>
						</div>
					))}
				</div>
			)}

			{/* Summary of enabled workspaces */}
			{pendingWorkspaceIds.size > 0 && (
				<div className="pt-1">
					<p className="text-[10px] text-muted-foreground flex items-center gap-1">
						<CheckCircle2 className="h-3 w-3 text-green-500" />
						{pendingWorkspaceIds.size} workspace
						{pendingWorkspaceIds.size > 1 ? "s" : ""} enabled
					</p>
				</div>
			)}
		</div>
	);
}

/** Hook to get pending workspace IDs for attachment */
function _usePendingWorkspaces() {
	const [pendingWorkspaceIds, setPendingWorkspaceIds] = useState<Set<string>>(
		new Set(),
	);
	return { pendingWorkspaceIds, setPendingWorkspaceIds };
}
