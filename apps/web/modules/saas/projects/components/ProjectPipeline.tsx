"use client";

/**
 * Project Pipeline - PRD → Features → Tasks
 *
 * Simplified workflow:
 * 1. Display PRD at top with option to edit or open in TipTap editor
 * 2. Generate features from PRD
 * 3. Display features as expandable list with tasks
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
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
import { Checkbox } from "@ui/components/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { DestructiveTooltip } from "@ui/components/destructive-tooltip";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Progress } from "@ui/components/progress";
import { ScrollArea } from "@ui/components/scroll-area";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import DOMPurify from "isomorphic-dompurify";
import {
	ArrowRightIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CodeIcon,
	ExternalLinkIcon,
	FileTextIcon,
	KanbanIcon,
	ListTodoIcon,
	Loader2Icon,
	PencilIcon,
	PlayIcon,
	Settings2Icon,
	Sparkles,
	TrashIcon,
	UsersIcon,
	XCircleIcon,
} from "lucide-react";
import MarkdownIt from "markdown-it";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PromptSelector } from "../../prompts/components/PromptSelector";
import type { StoryTask, UserStory } from "../lib/stories/types";
import {
	getPriorityColor,
	getSizeLabel,
	transformStory,
} from "../lib/stories/types";
import type { PrdSourceType } from "./PrdSourceSelector";
import { ProjectSectionHero } from "./ProjectSectionHero";
import { TaskEditPopover } from "./TaskEditPopover";

const md = new MarkdownIt({ typographer: true, html: true });

function renderSanitizedMarkdown(content: string): string {
	return DOMPurify.sanitize(md.render(content), {
		USE_PROFILES: { html: true },
	});
}

// Reuse document type icons/colors from wizard step 5 (DocumentGenerationStep.tsx)
const DOCUMENT_TYPE_ICONS: Record<string, any> = {
	TECHNICAL_SPEC: CodeIcon,
	API_SPEC: CodeIcon,
	ARCHITECTURE: CodeIcon,
	USER_STORY: UsersIcon,
};

const DOCUMENT_TYPE_COLORS: Record<string, { text: string; bg: string }> = {
	TECHNICAL_SPEC: {
		text: "text-highlight",
		bg: "bg-highlight/10",
	},
	API_SPEC: {
		text: "text-primary",
		bg: "bg-primary/10",
	},
	ARCHITECTURE: {
		text: "text-secondary",
		bg: "bg-secondary/10",
	},
	USER_STORY: {
		text: "text-muted-foreground",
		bg: "bg-muted",
	},
};

const PIPELINE_DOC_DEFINITIONS = [
	{
		type: "PRD" as const,
		title: "Product Requirements Document",
		description:
			"High-level product vision, goals, target users, and feature requirements",
	},
	{
		type: "TECHNICAL_SPEC" as const,
		title: "Technical Specification",
		description:
			"Detailed technical requirements, system architecture, and implementation guidelines",
	},
	{
		type: "API_SPEC" as const,
		title: "API Specification",
		description:
			"API endpoints, request/response schemas, authentication, and integration details",
	},
	{
		type: "ARCHITECTURE" as const,
		title: "Technical Architecture",
		description:
			"System design, infrastructure, scalability, and deployment architecture",
	},
	{
		type: "USER_STORY" as const,
		title: "Features",
		description:
			"Epic → Feature → Feature Item breakdown with acceptance criteria",
	},
];

type TabId =
	| "overview"
	| "documents"
	| "context"
	| "pipeline"
	| "stories"
	| "reports"
	| "settings";

interface ProjectPipelineProps {
	projectId: string;
	project: {
		id: string;
		name: string;
		description: string | null;
		techStack?: string[];
		features?: string[];
		goals?: string | null;
		organizationId?: string | null;
	};
	onNavigateToTab?: (tabId: TabId) => void;
}

type StageStatus =
	| "PENDING"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "CANCELLED"
	| "SKIPPED";

interface Stage {
	stage: string;
	status: StageStatus;
	output?: unknown;
	error?: string;
	startedAt?: string;
	completedAt?: string;
	duration?: number;
}

export function ProjectPipeline({
	projectId,
	project,
	onNavigateToTab,
}: ProjectPipelineProps) {
	// Organization context
	const { organizationId, basePath } = useOrganizationContext();

	const t = useTranslations("tooltips.pipeline");

	// Pipeline state
	const [pipelineId, setPipelineId] = useState<string | null>(null);
	const [status, setStatus] = useState<
		"idle" | "running" | "completed" | "failed"
	>("idle");
	const [_progress, setProgress] = useState(0);
	const [_stages, setStages] = useState<Stage[]>([]);
	const [_currentStage, setCurrentStage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Document selection
	const [selectedPrdId, setSelectedPrdId] = useState<string | null>(null);
	// PRD source selection (fabric or notion) - setPrdSource unused while PRD section is commented out
	const [prdSource, _setPrdSource] = useState<PrdSourceType>("fabric");

	// UI state
	const [isStarting, setIsStarting] = useState(false);
	const pollingRef = useRef<NodeJS.Timeout | null>(null);

	// Push to Kanban state
	const [showPushToKanbanDialog, setShowPushToKanbanDialog] = useState(false);
	const [pushToKanbanClearExisting, setPushToKanbanClearExisting] =
		useState(false);
	const [isPushingToKanban, setIsPushingToKanban] = useState(false);
	const queryClient = useQueryClient();

	// Per-document generation config with prompt support (wizard step 5 pattern)
	const [pipelineDocuments, setPipelineDocuments] = useState<
		Array<{
			type:
				| "PRD"
				| "TECHNICAL_SPEC"
				| "API_SPEC"
				| "ARCHITECTURE"
				| "USER_STORY";
			title: string;
			description: string;
			selected: boolean;
			prompt: string;
			promptId?: string;
			hasExisting: boolean;
			existingDocId?: string;
		}>
	>([]);

	// PRD section collapse state (commented out with PRD section)
	// const [isPrdExpanded, setIsPrdExpanded] = useState(false);

	// Document generation section collapse state
	const [isDocGenExpanded, setIsDocGenExpanded] = useState(true);

	// Feature document collapse state
	const [isUserStoryDocExpanded, setIsUserStoryDocExpanded] = useState(true);

	// Clear stories state
	const [showClearStoriesDialog, setShowClearStoriesDialog] = useState(false);
	const [isClearingStories, setIsClearingStories] = useState(false);

	// Track whether docs are generating for polling (state triggers re-render for refetchInterval)
	const [isGenerating, setIsGenerating] = useState(false);

	// Fetch project documents (poll every 3s while any doc is generating or pipeline running)
	const { data: documentsData, isLoading: isLoadingDocs } = useQuery({
		...orpc.projects.documents.list.queryOptions({
			input: { projectId, organizationId },
		}),
		refetchInterval: isGenerating || status === "running" ? 3000 : false,
	});

	// Fetch existing stories
	const { data: storiesData, refetch: refetchStories } = useQuery(
		orpc.projects.stories.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);

	// Fetch Notion PRD content (only when using Notion as source)
	const { data: notionPrdContent } = useQuery({
		queryKey: ["prd-source-content", projectId, organizationId],
		queryFn: async () => {
			return await orpcClient.projects.prdSource.content({
				projectId,
				organizationId: organizationId ?? null,
			});
		},
		enabled: prdSource === "notion",
	});

	// Filter PRD documents
	const documents = documentsData?.documents || [];
	const prdDocuments = documents.filter((d: any) => d.type === "PRD");
	const selectedPrd = prdDocuments.find((d: any) => d.id === selectedPrdId);
	const isSelectedPrdReady = selectedPrd?.status === "COMPLETE";

	// Build map of existing active documents for pipeline types
	const existingPipelineDocs = new Map<
		string,
		{ id: string; source: string }
	>();
	for (const doc of documents) {
		if (
			[
				"PRD",
				"TECHNICAL_SPEC",
				"API_SPEC",
				"ARCHITECTURE",
				"USER_STORY",
			].includes(doc.type) &&
			doc.status === "COMPLETE" &&
			doc.isActive
		) {
			existingPipelineDocs.set(doc.type, {
				id: doc.id,
				source: doc.source ?? "GENERATED",
			});
		}
	}

	// Build map of pipeline docs with their current generation status for progress tracking
	const pipelineDocStatuses = useMemo(() => {
		const PIPELINE_TYPES = [
			"PRD",
			"TECHNICAL_SPEC",
			"API_SPEC",
			"ARCHITECTURE",
			"USER_STORY",
		];
		const statuses = new Map<
			string,
			{
				status: string;
				progress: number;
				title: string;
				error?: string | null;
			}
		>();

		for (const doc of documents) {
			if (!PIPELINE_TYPES.includes(doc.type)) {
				continue;
			}
			// Keep the most relevant doc per type (GENERATING > COMPLETE > others)
			const existing = statuses.get(doc.type);
			if (
				!existing ||
				doc.status === "GENERATING" ||
				(doc.status === "COMPLETE" && existing.status !== "GENERATING")
			) {
				statuses.set(doc.type, {
					status: doc.status,
					progress: (doc as any).generationProgress ?? 0,
					title:
						PIPELINE_DOC_DEFINITIONS.find(
							(d) => d.type === doc.type,
						)?.title ?? doc.type,
					error: (doc as any).generationError ?? null,
				});
			}
		}
		return statuses;
	}, [documents]);

	const hasAnyGenerating = [...pipelineDocStatuses.values()].some(
		(d) => d.status === "GENERATING",
	);
	const completedPipelineDocs = [...pipelineDocStatuses.values()].filter(
		(d) => d.status === "COMPLETE",
	).length;
	const openPipelineDocs =
		PIPELINE_DOC_DEFINITIONS.length -
		completedPipelineDocs -
		(hasAnyGenerating ? 1 : 0);
	// "All done" = at least 1 pipeline doc exists AND none are still generating/draft
	const allPipelineDocsDone =
		pipelineDocStatuses.size > 0 &&
		[...pipelineDocStatuses.values()].every(
			(d) => d.status === "COMPLETE" || d.status === "FAILED",
		);

	// Keep state in sync for refetchInterval (state triggers re-render so useQuery picks up new interval)
	useEffect(() => {
		setIsGenerating(hasAnyGenerating);
	}, [hasAnyGenerating]);

	// Find USER_STORY document for Push to Roadmap
	const userStoryDocument = documents.find(
		(d: any) => d.type === "USER_STORY",
	);

	// Check if stories already exist
	const stories: UserStory[] = (storiesData?.stories ?? []).map((s) =>
		transformStory(s as Parameters<typeof transformStory>[0]),
	);
	const hasExistingStories = stories.length > 0;

	// Check if stories have already been pushed from this document
	const storiesAlreadyPushed =
		userStoryDocument?.status === "COMPLETE" && hasExistingStories;

	// Push to Kanban mutation
	const pushToKanbanMutation = useMutation({
		mutationFn: async ({ clearExisting }: { clearExisting: boolean }) => {
			if (!userStoryDocument) {
				throw new Error("No Features document found");
			}
			return await orpcClient.projects.stories.pushToKanban({
				projectId,
				documentId: userStoryDocument.id,
				clearExisting,
				organizationId: organizationId ?? null,
			});
		},
		onMutate: () => {
			setIsPushingToKanban(true);
		},
		onSuccess: async (data) => {
			toast.success("Successfully pushed to Roadmap", {
				description: `Created ${data.storiesCreated} stories with ${data.tasksCreated} tasks`,
			});
			setShowPushToKanbanDialog(false);
			setPushToKanbanClearExisting(false);
			// Collapse the document section after successful push
			setIsUserStoryDocExpanded(false);
			// Invalidate all related queries and wait for them to complete
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.list.queryKey({
						input: { projectId, organizationId },
					}),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				}),
			]);
			// Force refetch stories
			refetchStories();
			// Navigate to Roadmap tab so user sees the stories immediately
			onNavigateToTab?.("stories");
		},
		onError: (error: Error) => {
			toast.error("Failed to push to Roadmap", {
				description: error.message,
			});
		},
		onSettled: () => {
			setIsPushingToKanban(false);
		},
	});

	// Clear stories mutation
	const clearStoriesMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.clear({
				projectId,
			});
		},
		onMutate: () => {
			setIsClearingStories(true);
		},
		onSuccess: (data) => {
			toast.success("Features cleared", {
				description: `Deleted ${data.deletedCount} features${data.documentDeleted ? " and features document" : ""}`,
			});
			setShowClearStoriesDialog(false);
			refetchStories();
			// Invalidate both stories and documents queries
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.list.queryKey({
					input: { projectId, organizationId },
				}),
			});
			queryClient.invalidateQueries({
				queryKey: orpc.projects.documents.list.queryKey({
					input: { projectId, organizationId },
				}),
			});
		},
		onError: (error: Error) => {
			toast.error("Failed to clear stories", {
				description: error.message,
			});
		},
		onSettled: () => {
			setIsClearingStories(false);
		},
	});

	// Parse preview helper
	const parseStoriesPreview = useCallback((content: string) => {
		// Simple regex-based preview parsing (matches the backend parser).
		// Accepts the current F-XXX / FEAT-XXX feature identifiers as well as the
		// legacy US-XXX format so previously generated documents still preview.
		const stories: { title: string; tasksCount: number }[] = [];
		const usPattern = /### (?:US|F(?:EAT)?)-?\d+:\s*(.+)/gi;
		let match = usPattern.exec(content);
		while (match !== null) {
			const title = match[1].trim();
			// Count tasks in this section (rough estimate)
			const startIndex = match.index;
			const nextMatch = usPattern.exec(content);
			usPattern.lastIndex = match.index + match[0].length; // Reset for next iteration
			const endIndex = nextMatch ? nextMatch.index : content.length;
			const section = content.substring(startIndex, endIndex);
			const taskCount = (section.match(/- \[ \] TASK-\d+/gi) || [])
				.length;
			stories.push({ title, tasksCount: taskCount });
			match = usPattern.exec(content);
		}
		return stories;
	}, []);

	// Auto-select first complete PRD if available
	useEffect(() => {
		if (!selectedPrdId) {
			const firstComplete = prdDocuments.find(
				(d: any) => d.status === "COMPLETE",
			);
			if (firstComplete) {
				setSelectedPrdId(firstComplete.id);
			}
		}
	}, [prdDocuments, selectedPrdId]);

	// Initialize pipeline documents when existing docs load (only once to preserve user edits)
	const pipelineDocsInitializedRef = useRef(false);
	useEffect(() => {
		if (!documentsData) {
			return;
		}
		if (pipelineDocsInitializedRef.current) {
			return;
		}
		pipelineDocsInitializedRef.current = true;
		setPipelineDocuments(
			PIPELINE_DOC_DEFINITIONS.map((def) => {
				const existing = existingPipelineDocs.get(def.type);
				return {
					type: def.type,
					title: def.title,
					description: def.description,
					selected: true,
					prompt: "",
					promptId: undefined,
					hasExisting: !!existing,
					existingDocId: existing?.id,
				};
			}),
		);
	}, [documentsData]);

	// Update hasExisting/existingDocId when documents change (without wiping user selections/prompts)
	useEffect(() => {
		if (!documentsData || !pipelineDocsInitializedRef.current) {
			return;
		}
		setPipelineDocuments((prev) =>
			prev.map((doc) => {
				const existing = existingPipelineDocs.get(doc.type);
				return {
					...doc,
					hasExisting: !!existing,
					existingDocId: existing?.id,
				};
			}),
		);
	}, [documentsData]);

	// Auto-collapse document generation section when generating or pipeline running
	useEffect(() => {
		if (hasAnyGenerating || status === "running") {
			setIsDocGenExpanded(false);
		}
	}, [hasAnyGenerating, status]);

	// Auto-collapse after pipeline completes
	useEffect(() => {
		if (status === "completed") {
			setIsDocGenExpanded(false);
		}
	}, [status]);

	// Auto-collapse on initial load if all pipeline docs are already complete
	useEffect(() => {
		if (allPipelineDocsDone && status === "idle") {
			setIsDocGenExpanded(false);
		}
	}, [allPipelineDocsDone, status]);

	// Expand the document section when new document is available
	useEffect(() => {
		if (userStoryDocument?.content) {
			setIsUserStoryDocExpanded(true);
		}
	}, [userStoryDocument?.content]);

	// Poll for status updates
	const pollStatus = useCallback(async () => {
		if (!pipelineId) {
			return;
		}

		try {
			const result = await orpcClient.pipeline.status({ pipelineId });

			setProgress(result.progress);
			setStages(result.stages as Stage[]);
			setCurrentStage(result.currentStage ?? null);
			if (result.error) {
				setError(result.error);
			}

			// Check if completed or failed
			if (result.status === "COMPLETED") {
				setStatus("completed");
				toast.success("Pipeline completed! Documents generated.");
				refetchStories();
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
				if (pollingRef.current) {
					clearInterval(pollingRef.current);
					pollingRef.current = null;
				}
			} else if (result.status === "FAILED") {
				setStatus("failed");
				toast.error(`Pipeline failed: ${result.error}`);
				if (pollingRef.current) {
					clearInterval(pollingRef.current);
					pollingRef.current = null;
				}
			}
		} catch (err) {
			console.error("Failed to poll status:", err);
		}
	}, [pipelineId, projectId, queryClient, refetchStories]);

	// Start polling when pipeline starts
	useEffect(() => {
		if (status === "running" && pipelineId && !pollingRef.current) {
			pollStatus();
			pollingRef.current = setInterval(pollStatus, 2000);
		}

		return () => {
			if (pollingRef.current) {
				clearInterval(pollingRef.current);
				pollingRef.current = null;
			}
		};
	}, [status, pipelineId, pollStatus]);

	// Start the pipeline
	const handleStart = async (
		overrideDocs?: typeof pipelineDocuments,
		overridePrdId?: string,
	) => {
		setIsStarting(true);
		setError(null);

		try {
			let existingPRD: string | undefined;

			const docsToUse = overrideDocs ?? pipelineDocuments;
			const prdIdToUse = overridePrdId ?? selectedPrdId;

			const isPrdSelected = docsToUse.find(
				(d) => d.type === "PRD",
			)?.selected;
			const nonPrdDocs = docsToUse.filter((d) => d.type !== "PRD");

			if (isPrdSelected) {
				// Batch-generate PRD first (it gets saved as a ProjectDocument)
				const prdDocDef = docsToUse.find((d) => d.type === "PRD");
				const batchResult =
					await orpcClient.projects.documents.batchGenerate({
						projectId,
						timeZone:
							Intl.DateTimeFormat().resolvedOptions().timeZone,
						documents: [
							{
								type: "PRD",
								title: "Product Requirements Document",
								prompt: prdDocDef?.prompt || "",
								promptId: prdDocDef?.promptId || undefined,
							},
						],
					});

				// If only PRD was selected, we're done — progress tracked via polling
				if (!nonPrdDocs.some((d) => d.selected)) {
					toast.success("PRD generation started");
					setIsStarting(false);
					return;
				}

				// Otherwise poll until PRD completes, then start pipeline for remaining docs
				toast.info(
					"Generating PRD… pipeline will start automatically when complete.",
				);
				const prdDocId = batchResult.documents[0].id;
				for (let i = 0; i < 150; i++) {
					await new Promise((r) => setTimeout(r, 2000));
					const docResult = await orpcClient.projects.documents.get({
						projectId,
						id: prdDocId,
					});
					if (docResult.document.status === "COMPLETE") {
						existingPRD = docResult.document.content ?? undefined;
						break;
					}
					if (docResult.document.status === "FAILED") {
						toast.error(
							"PRD generation failed — pipeline cannot continue.",
						);
						setIsStarting(false);
						return;
					}
				}
				if (!existingPRD) {
					toast.error("PRD generation timed out");
					setIsStarting(false);
					return;
				}
			} else if (prdSource === "notion") {
				// Use Notion PRD
				if (
					!notionPrdContent?.hasContent ||
					!notionPrdContent.content
				) {
					toast.error(
						"Notion PRD has no content. Please sync it first in Settings.",
					);
					setIsStarting(false);
					return;
				}
				existingPRD = notionPrdContent.content;
			} else {
				// Use existing Fabric PRD
				if (!prdIdToUse) {
					toast.error("Please select a PRD document first");
					setIsStarting(false);
					return;
				}
				const prdDoc = documents.find((d: any) => d.id === prdIdToUse);
				if (prdDoc?.status !== "COMPLETE") {
					toast.error(
						"Selected PRD is not complete yet. Please wait for it to finish generating.",
					);
					setIsStarting(false);
					return;
				}

				const doc = await orpcClient.projects.documents.get({
					projectId,
					id: prdIdToUse,
				});
				existingPRD = doc.document?.content ?? undefined;

				if (!existingPRD) {
					toast.error("Selected PRD has no content");
					setIsStarting(false);
					return;
				}
			}

			// Parse goals
			const goalsArray = project.goals
				? project.goals
						.split(/[\n,]/)
						.map((g) => g.trim())
						.filter(Boolean)
				: [];

			// Build description
			// Fallback to project name or PRD excerpt if description is too short (min 10 chars required)
			let description = project.description || "";
			if (description.length < 10) {
				description =
					project.name.length >= 10
						? project.name
						: `Project: ${project.name} - ${existingPRD ? existingPRD.substring(0, 100) : ""}`;
			}

			// Build document config from pipeline documents state (PRD excluded — handled separately)
			const docConfigToSend = nonPrdDocs.map((doc) => ({
				type: doc.type as
					| "TECHNICAL_SPEC"
					| "API_SPEC"
					| "ARCHITECTURE"
					| "USER_STORY",
				action: doc.selected
					? ("generate" as const)
					: ("use_existing" as const),
				existingDocumentId: !doc.selected
					? doc.existingDocId
					: undefined,
				prompt: doc.selected && doc.prompt ? doc.prompt : undefined,
				promptId:
					doc.selected && doc.promptId ? doc.promptId : undefined,
			}));

			const result = await orpcClient.pipeline.start({
				projectName: project.name,
				projectDescription: description,
				goals: goalsArray,
				techStack: project.techStack || [],
				features: project.features || [],
				projectId,
				organizationId: organizationId ?? null,
				existingPRD,
				skipStoryBreakdown: false,
				skipTaskPlanning: false,
				documentConfig: docConfigToSend,
			});

			setPipelineId(result.pipelineId);
			setStatus("running");

			toast.success(
				hasExistingStories
					? "Regenerating project documents..."
					: "Generating project documents from PRD...",
			);
		} catch (err) {
			console.error("Failed to start pipeline:", err);
			toast.error(
				`Failed to start: ${err instanceof Error ? err.message : "Unknown error"}`,
			);
			setStatus("failed");
			setError(err instanceof Error ? err.message : "Unknown error");
		} finally {
			setIsStarting(false);
		}
	};

	// Get document URL
	const getDocumentUrl = (documentId: string) => {
		return `${basePath}/projects/${projectId}/documents/${documentId}`;
	};

	if (isLoadingDocs) {
		return (
			<div className="flex items-center justify-center h-48">
				<Loader2Icon className="w-8 h-8 animate-spin" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Project Pipeline"
				title="From product intent into documents and roadmap execution"
				description="Move from the PRD into generated technical artifacts, then push the resulting feature structure into the roadmap when the project is ready."
				getStartedPageId="pipeline"
				badges={
					<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
						<FileTextIcon className="mr-1 inline size-3.5 text-primary" />
						PRD
						<ArrowRightIcon className="mx-2 inline size-3 text-muted-foreground" />
						<ListTodoIcon className="mr-1 inline size-3.5 text-primary" />
						Documents
						<ArrowRightIcon className="mx-2 inline size-3 text-muted-foreground" />
						<KanbanIcon className="mr-1 inline size-3.5 text-primary" />
						Roadmap
					</div>
				}
				aside={
					<div className="flex h-full flex-col justify-between">
						<div>
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Pipeline Status
							</p>
							<div className="mt-4 grid grid-cols-3 gap-3">
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground">
										{completedPipelineDocs}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Ready
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-primary">
										{hasAnyGenerating ? 1 : 0}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Active
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground/75">
										{Math.max(openPipelineDocs, 0)}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Open
									</p>
								</div>
							</div>
						</div>
						<div className="mt-6 rounded-2xl border border-border/60 bg-card/40 p-4">
							<p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
								Quick Focus
							</p>
							<p className="mt-2 text-sm text-foreground/85">
								Generate the core technical set first, then push
								the features document into the roadmap once the
								structure looks right.
							</p>
						</div>
					</div>
				}
			/>

			{/* PRD Section - Commented out for now
			<Collapsible open={isPrdExpanded} onOpenChange={setIsPrdExpanded}>
				<Card>
					<CollapsibleTrigger asChild>
						<CardHeader className="pb-3 cursor-pointer hover:bg-muted/50 transition-colors">
							...
						</CardHeader>
					</CollapsibleTrigger>
					<CollapsibleContent>
						...
					</CollapsibleContent>
				</Card>
			</Collapsible>
			*/}

			{/* Generate Project Documents — collapsible with per-document progress */}
			<Card
				className="bg-card"
				data-onboarding-target="pipeline-generate-docs"
			>
				<CardContent className="pt-6">
					{/* Header — always visible, clickable to expand/collapse */}
					<button
						type="button"
						className="flex items-center justify-between w-full text-left"
						onClick={() => setIsDocGenExpanded((prev) => !prev)}
					>
						<div className="flex items-center gap-3">
							{hasAnyGenerating ? (
								<Loader2Icon className="w-5 h-5 animate-spin text-primary" />
							) : allPipelineDocsDone ? (
								<CheckCircle2Icon className="w-5 h-5 text-success" />
							) : (
								<Sparkles className="w-5 h-5 text-primary" />
							)}
							<div>
								<p className="font-medium">
									{hasAnyGenerating
										? "Generating Documents..."
										: allPipelineDocsDone
											? "Documents Generated"
											: pipelineDocuments.some(
														(d) => d.hasExisting,
													)
												? "Regenerate Project Documents"
												: "Generate Project Documents"}
								</p>
								<p className="text-sm text-muted-foreground">
									{hasAnyGenerating
										? "Documents are being generated"
										: allPipelineDocsDone
											? `${pipelineDocStatuses.size} documents ready`
											: "Select which documents to generate and optionally customize prompts"}
								</p>
							</div>
						</div>
						<ChevronDownIcon
							className={cn(
								"w-5 h-5 text-muted-foreground transition-transform",
								isDocGenExpanded && "rotate-180",
							)}
						/>
					</button>

					{/* Pipeline error display */}
					{status !== "idle" && error && (
						<div className="mt-4 pt-4 border-t">
							<div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
								<p className="text-sm text-destructive/80">
									{error}
								</p>
							</div>
						</div>
					)}

					{/* Per-document status rows (when collapsed and docs exist) */}
					{!isDocGenExpanded && pipelineDocStatuses.size > 0 && (
						<div className="space-y-2 mt-4 pt-4 border-t">
							{PIPELINE_DOC_DEFINITIONS.map((def) => {
								const docStatus = pipelineDocStatuses.get(
									def.type,
								);
								if (!docStatus) {
									return null;
								}
								const Icon =
									DOCUMENT_TYPE_ICONS[def.type] ||
									FileTextIcon;
								const colors = DOCUMENT_TYPE_COLORS[
									def.type
								] || {
									text: "text-gray-600",
									bg: "bg-gray-100",
								};

								return (
									<div
										key={def.type}
										className="flex items-center gap-3 py-1.5"
									>
										<div
											className={`p-1.5 rounded-md ${colors.bg}`}
										>
											<Icon
												className={`h-4 w-4 ${colors.text}`}
											/>
										</div>
										<span className="text-sm font-medium min-w-[140px]">
											{def.title}
										</span>
										{docStatus.status === "GENERATING" ? (
											<div className="flex items-center gap-2 flex-1">
												<Progress
													value={docStatus.progress}
													className="h-1.5 flex-1"
												/>
												<span className="text-xs text-muted-foreground w-8 text-right">
													{docStatus.progress}%
												</span>
											</div>
										) : (
											<div className="flex-1" />
										)}
										{docStatus.status === "GENERATING" && (
											<Badge
												variant="outline"
												className="text-xs border-primary/30 text-primary animate-pulse"
											>
												Generating
											</Badge>
										)}
										{docStatus.status === "COMPLETE" && (
											<Badge
												variant="outline"
												className="text-xs border-success/30 text-success"
											>
												<CheckIcon className="w-3 h-3 mr-1" />
												Complete
											</Badge>
										)}
										{docStatus.status === "FAILED" && (
											<Badge
												variant="outline"
												className="text-xs border-red-200 text-destructive"
											>
												<XCircleIcon className="w-3 h-3 mr-1" />
												Failed
											</Badge>
										)}
										{docStatus.status === "DRAFT" && (
											<Badge
												variant="outline"
												className="text-xs"
											>
												Draft
											</Badge>
										)}
									</div>
								);
							})}

							{/* Edit Configuration button (only when not actively running) */}
							{status !== "running" && (
								<div className="pt-2">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												onClick={(e) => {
													e.stopPropagation();
													setIsDocGenExpanded(true);
												}}
												className="gap-1.5 text-muted-foreground hover:text-foreground"
											>
												<Settings2Icon className="w-4 h-4" />
												Edit Configuration
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("editConfiguration")}
										</TooltipContent>
									</Tooltip>
								</div>
							)}
						</div>
					)}

					{/* Full configuration UI (when expanded and pipeline not actively running) */}
					{isDocGenExpanded && status !== "running" && (
						<div className="space-y-4 mt-4 pt-4 border-t">
							{/* Document Selection Cards (wizard step 5 pattern) */}
							<div className="space-y-3">
								{pipelineDocuments.map((doc, index) => {
									const Icon =
										DOCUMENT_TYPE_ICONS[doc.type] ||
										FileTextIcon;
									const colors = DOCUMENT_TYPE_COLORS[
										doc.type
									] || {
										text: "text-gray-600",
										bg: "bg-gray-100",
									};
									const existing = existingPipelineDocs.get(
										doc.type,
									);

									return (
										<Card
											key={doc.type}
											className={cn(
												"transition-all",
												doc.selected
													? "border-primary bg-primary/5"
													: "hover:border-primary/50",
											)}
										>
											<CardHeader className="pb-2">
												<div className="flex items-start justify-between">
													<div className="flex items-start gap-3 flex-1">
														<div
															className={`p-2 rounded-lg ${colors.bg}`}
														>
															<Icon
																className={`h-5 w-5 ${colors.text}`}
															/>
														</div>
														<div className="flex-1">
															<CardTitle className="text-base">
																{doc.title}
															</CardTitle>
															<CardDescription className="text-sm mt-1">
																{
																	doc.description
																}
															</CardDescription>
															{existing && (
																<Badge
																	variant="outline"
																	className="text-xs mt-1.5"
																>
																	{existing.source ===
																	"IMPORTED"
																		? "Existing (Imported)"
																		: "Existing (Generated)"}
																</Badge>
															)}
														</div>
													</div>
													<Checkbox
														checked={doc.selected}
														onCheckedChange={() =>
															setPipelineDocuments(
																(prev) =>
																	prev.map(
																		(
																			d,
																			i,
																		) =>
																			i ===
																			index
																				? {
																						...d,
																						selected:
																							!d.selected,
																					}
																				: d,
																	),
															)
														}
													/>
												</div>
											</CardHeader>
											{doc.selected && (
												<CardContent className="space-y-4 pt-0">
													{/* Prompt Selector */}
													<div>
														<Label className="text-sm font-medium mb-2 block">
															AI Prompt Template
														</Label>
														<PromptSelector
															agentName="project_document_generator"
															documentType={
																doc.type
															}
															value={doc.promptId}
															onValueChange={(
																promptId,
															) =>
																setPipelineDocuments(
																	(prev) =>
																		prev.map(
																			(
																				d,
																				i,
																			) =>
																				i ===
																				index
																					? {
																							...d,
																							promptId,
																						}
																					: d,
																		),
																)
															}
															disabled={
																isStarting
															}
															placeholder="Use default prompt"
															showBindAction={
																true
															}
														/>
													</div>

													{/* Custom Instructions */}
													<div>
														<Label className="text-sm font-medium">
															Custom Instructions
															(Optional)
														</Label>
														<Textarea
															value={doc.prompt}
															onChange={(e) =>
																setPipelineDocuments(
																	(prev) =>
																		prev.map(
																			(
																				d,
																				i,
																			) =>
																				i ===
																				index
																					? {
																							...d,
																							prompt: e
																								.target
																								.value,
																						}
																					: d,
																		),
																)
															}
															placeholder="Add any specific requirements or focus areas..."
															className="mt-2 min-h-20"
														/>
													</div>
												</CardContent>
											)}
										</Card>
									);
								})}
							</div>

							{/* Generate Button */}
							<div className="flex justify-end">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											onClick={() => handleStart()}
											disabled={
												isStarting ||
												(prdSource === "fabric" &&
													!selectedPrdId &&
													!pipelineDocuments.find(
														(d) => d.type === "PRD",
													)?.selected) ||
												(prdSource === "notion" &&
													!notionPrdContent?.hasContent) ||
												!pipelineDocuments.some(
													(d) => d.selected,
												)
											}
											className="gap-2"
										>
											{isStarting ? (
												<>
													<Loader2Icon className="w-4 h-4 animate-spin" />
													Starting...
												</>
											) : (
												<>
													<PlayIcon className="w-4 h-4" />
													{pipelineDocuments.some(
														(d) => d.hasExisting,
													)
														? "Regenerate"
														: "Generate"}{" "}
													(
													{
														pipelineDocuments.filter(
															(d) => d.selected,
														).length
													}
													)
												</>
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("generateDocuments")}
									</TooltipContent>
								</Tooltip>
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Features Section - Collapsible document with parse preview */}
			<Card data-onboarding-target="pipeline-features">
				<CardHeader className="pb-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
								<ListTodoIcon className="w-5 h-5 text-success dark:text-green-400" />
							</div>
							<div>
								<CardTitle className="text-base">
									Features
								</CardTitle>
								<CardDescription>
									{isLoadingDocs
										? "Loading..."
										: userStoryDocument
											? stories.length
												? `${stories.length} features in Roadmap`
												: "Document generated - push to Roadmap to create features"
											: "Generate features from your PRD above"}
								</CardDescription>
							</div>
						</div>
						<div className="flex gap-2">
							{stories.length > 0 && (
								<>
									<DestructiveTooltip
										copy={
											t.raw("clearAllFeatures") as {
												label: string;
												warning: string;
											}
										}
									>
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												setShowClearStoriesDialog(true)
											}
											className="gap-2 text-destructive hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
										>
											<TrashIcon className="w-4 h-4" />
											Clear All
										</Button>
									</DestructiveTooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="outline"
												size="sm"
												className="gap-2"
												onClick={() =>
													onNavigateToTab?.("stories")
												}
											>
												<KanbanIcon className="w-4 h-4" />
												Open Roadmap
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{t("openRoadmap")}
										</TooltipContent>
									</Tooltip>
								</>
							)}
							{userStoryDocument && (
								<>
									<Tooltip>
										<TooltipTrigger asChild>
											<Link
												href={getDocumentUrl(
													userStoryDocument.id,
												)}
											>
												<Button
													variant="outline"
													size="sm"
													className="gap-2"
												>
													<ExternalLinkIcon className="w-4 h-4" />
													Edit
												</Button>
											</Link>
										</TooltipTrigger>
										<TooltipContent>
											{t("editFeaturesDocument")}
										</TooltipContent>
									</Tooltip>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												data-onboarding-target="pipeline-push-roadmap"
												variant={
													storiesAlreadyPushed
														? "outline"
														: "default"
												}
												size="sm"
												onClick={() =>
													setShowPushToKanbanDialog(
														true,
													)
												}
												disabled={storiesAlreadyPushed}
												className="gap-2"
											>
												<KanbanIcon className="w-4 h-4" />
												{storiesAlreadyPushed
													? "Already Pushed"
													: "Push to Roadmap"}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{storiesAlreadyPushed
												? t("alreadyPushed")
												: t("pushToRoadmap")}
										</TooltipContent>
									</Tooltip>
								</>
							)}
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{isLoadingDocs ? (
						<div className="py-8 text-center">
							<p className="text-muted-foreground">
								Loading documents...
							</p>
						</div>
					) : userStoryDocument ? (
						<div className="space-y-4">
							{/* Collapsible Document Preview */}
							<Collapsible
								open={isUserStoryDocExpanded}
								onOpenChange={setIsUserStoryDocExpanded}
							>
								<div className="border rounded-lg">
									<CollapsibleTrigger asChild>
										<button
											type="button"
											className="flex items-center justify-between w-full px-4 py-2 border-b bg-muted/30 hover:bg-muted/50 transition-colors"
										>
											<span className="text-sm font-medium">
												Generated Stories Document
											</span>
											<div className="flex items-center gap-2">
												<Badge
													variant="secondary"
													className="text-xs"
												>
													{userStoryDocument.status}
												</Badge>
												<ChevronDownIcon
													className={cn(
														"w-4 h-4 text-muted-foreground transition-transform",
														isUserStoryDocExpanded &&
															"rotate-180",
													)}
												/>
											</div>
										</button>
									</CollapsibleTrigger>
									<CollapsibleContent>
										<ScrollArea className="h-[300px]">
											{/* biome-ignore lint/security/noDangerouslySetInnerHtml: content is sanitized via renderSanitizedMarkdown before rendering */}
											<div
												className="prose prose-sm dark:prose-invert max-w-none p-4"
												dangerouslySetInnerHTML={{
													__html: renderSanitizedMarkdown(
														userStoryDocument.content ||
															"",
													),
												}}
											/>
										</ScrollArea>
									</CollapsibleContent>
								</div>
							</Collapsible>

							{/* Push to Roadmap action */}
							<div className="flex items-center justify-between p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
								<div>
									<p className="font-medium text-highlight/80">
										{stories.length
											? "Push updated features to Roadmap"
											: "Ready to create feature cards"}
									</p>
									<p className="text-sm text-amber-600 dark:text-amber-400">
										{stories.length
											? `You have ${stories.length} existing features. Choose to append new features or replace all.`
											: "Push this document to create individual feature cards on the Roadmap"}
									</p>
								</div>
								<div className="flex gap-2">
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												onClick={() =>
													setShowPushToKanbanDialog(
														true,
													)
												}
												disabled={storiesAlreadyPushed}
												className="gap-2"
											>
												<KanbanIcon className="w-4 h-4" />
												{storiesAlreadyPushed
													? "Already Pushed"
													: "Push to Roadmap"}
											</Button>
										</TooltipTrigger>
										<TooltipContent>
											{storiesAlreadyPushed
												? t("alreadyPushed")
												: t("pushToRoadmap")}
										</TooltipContent>
									</Tooltip>
								</div>
							</div>

							{/* Show existing stories if any */}
							{stories.length > 0 && (
								<Collapsible defaultOpen={false}>
									<div className="pt-4 border-t">
										<div className="flex items-center justify-between mb-3">
											<CollapsibleTrigger asChild>
												<button
													type="button"
													className="flex items-center gap-2 group"
												>
													<h4 className="text-sm font-medium text-muted-foreground">
														Existing Stories in
														Roadmap (
														{stories.length})
													</h4>
													<ChevronRightIcon className="w-4 h-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
												</button>
											</CollapsibleTrigger>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
														className="gap-2 text-xs"
														onClick={() =>
															onNavigateToTab?.(
																"stories",
															)
														}
													>
														Open Roadmap
														<ExternalLinkIcon className="w-3 h-3" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													{t("openRoadmap")}
												</TooltipContent>
											</Tooltip>
										</div>
										<CollapsibleContent>
											<div className="space-y-2">
												{stories.map(
													(story: UserStory) => (
														<StoryItem
															key={story.id}
															story={story}
															projectId={
																projectId
															}
															projectName={
																project.name
															}
															basePath={basePath}
															onTasksGenerated={
																refetchStories
															}
														/>
													),
												)}
											</div>
										</CollapsibleContent>
									</div>
								</Collapsible>
							)}
						</div>
					) : (
						<div className="space-y-4">
							{status === "completed" ? (
								<div className="py-8 text-center">
									<p className="text-muted-foreground">
										No features document was generated. Try
										regenerating.
									</p>
								</div>
							) : prdDocuments.length === 0 ? (
								<div className="py-8 text-center">
									<p className="text-muted-foreground">
										Generate a PRD first, then come back
										here to create features.
									</p>
								</div>
							) : (
								<>
									<div className="space-y-2">
										<p className="text-sm font-medium">
											Select a PRD to generate features
											from:
										</p>
										{prdDocuments.map((prd: any) => {
											const isComplete =
												prd.status === "COMPLETE";
											return (
												<button
													key={prd.id}
													type="button"
													onClick={() =>
														isComplete &&
														setSelectedPrdId(prd.id)
													}
													disabled={!isComplete}
													className={cn(
														"w-full text-left flex items-center gap-3 p-3 rounded-lg border transition-colors",
														!isComplete
															? "border-border opacity-50 cursor-not-allowed"
															: selectedPrdId ===
																	prd.id
																? "border-primary bg-primary/5"
																: "border-border hover:border-primary/50",
													)}
												>
													<div className="p-1.5 rounded-md bg-blue-100 dark:bg-blue-900/30">
														<FileTextIcon className="h-4 w-4 text-blue-600 dark:text-blue-400" />
													</div>
													<div className="flex-1 min-w-0">
														<p className="text-sm font-medium truncate">
															{prd.title ||
																"Product Requirements Document"}
														</p>
														{prd.createdAt && (
															<p className="text-xs text-muted-foreground">
																{new Date(
																	prd.createdAt,
																).toLocaleDateString()}
															</p>
														)}
													</div>
													{isComplete ? (
														selectedPrdId ===
															prd.id && (
															<CheckCircle2Icon className="w-4 h-4 text-primary shrink-0" />
														)
													) : (
														<Badge
															variant="outline"
															className="text-xs shrink-0"
														>
															{prd.status ===
															"GENERATING"
																? "Generating"
																: prd.status ===
																		"FAILED"
																	? "Failed"
																	: "Not ready"}
														</Badge>
													)}
												</button>
											);
										})}
									</div>
									<div className="flex justify-end">
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													onClick={() =>
														handleStart(
															pipelineDocuments.map(
																(d) => ({
																	...d,
																	selected:
																		d.type ===
																		"USER_STORY",
																}),
															),
															selectedPrdId ??
																undefined,
														)
													}
													disabled={
														!selectedPrdId ||
														!isSelectedPrdReady ||
														isStarting
													}
													className="gap-2"
												>
													{isStarting ? (
														<>
															<Loader2Icon className="w-4 h-4 animate-spin" />
															Generating...
														</>
													) : (
														<>
															<Sparkles className="w-4 h-4" />
															Generate Features
														</>
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												{t("generateFeatures")}
											</TooltipContent>
										</Tooltip>
									</div>
								</>
							)}
						</div>
					)}
				</CardContent>
			</Card>

			{/* Push to Roadmap Dialog */}
			<Dialog
				open={showPushToKanbanDialog}
				onOpenChange={setShowPushToKanbanDialog}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>Push to Roadmap</DialogTitle>
						<DialogDescription>
							Parse features from the document and create them on
							the Roadmap.
						</DialogDescription>
					</DialogHeader>

					<div className="py-4">
						<div className="flex items-start space-x-3">
							<Checkbox
								id="clear-existing-pipeline"
								checked={pushToKanbanClearExisting}
								onCheckedChange={(checked) =>
									setPushToKanbanClearExisting(
										checked === true,
									)
								}
							/>
							<div className="space-y-1">
								<Label
									htmlFor="clear-existing-pipeline"
									className="text-sm font-medium cursor-pointer"
								>
									Clear existing stories
								</Label>
								<p className="text-xs text-muted-foreground">
									Remove all existing stories before adding
									new ones.
								</p>
							</div>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setShowPushToKanbanDialog(false);
								setPushToKanbanClearExisting(false);
							}}
							disabled={isPushingToKanban}
						>
							Cancel
						</Button>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									onClick={() =>
										pushToKanbanMutation.mutate({
											clearExisting:
												pushToKanbanClearExisting,
										})
									}
									disabled={isPushingToKanban}
								>
									{isPushingToKanban ? (
										<>
											<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
											Pushing...
										</>
									) : (
										<>
											<KanbanIcon className="mr-2 h-4 w-4" />
											Push to Roadmap
										</>
									)}
								</Button>
							</TooltipTrigger>
							<TooltipContent>{t("confirmPush")}</TooltipContent>
						</Tooltip>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Clear Stories Dialog */}
			<Dialog
				open={showClearStoriesDialog}
				onOpenChange={setShowClearStoriesDialog}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle className="text-destructive">
							Clear All Stories
						</DialogTitle>
						<DialogDescription>
							This will permanently delete all{" "}
							{stories.length ?? 0} stories and their tasks from
							the Roadmap. This action cannot be undone.
						</DialogDescription>
					</DialogHeader>

					<div className="py-4">
						<div className="p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg">
							<p className="text-sm text-destructive/80">
								You will lose all feature data including:
							</p>
							<ul className="mt-2 text-sm text-destructive list-disc list-inside space-y-1">
								<li>All features and their details</li>
								<li>All tasks and subtasks</li>
								<li>Any progress tracking information</li>
							</ul>
						</div>
					</div>

					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => setShowClearStoriesDialog(false)}
							disabled={isClearingStories}
						>
							Cancel
						</Button>
						<DestructiveTooltip
							copy={
								t.raw("clearAllFeatures") as {
									label: string;
									warning: string;
								}
							}
						>
							<Button
								variant="destructive"
								onClick={() => clearStoriesMutation.mutate()}
								disabled={isClearingStories}
							>
								{isClearingStories ? (
									<>
										<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
										Clearing...
									</>
								) : (
									<>
										<TrashIcon className="mr-2 h-4 w-4" />
										Clear All Stories
									</>
								)}
							</Button>
						</DestructiveTooltip>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/**
 * Expandable story item with tasks
 */
function StoryItem({
	story,
	projectId,
	projectName,
	basePath,
	onTasksGenerated,
}: {
	story: UserStory;
	projectId: string;
	projectName?: string;
	basePath: string;
	onTasksGenerated?: () => void;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [isGenerating, setIsGenerating] = useState(false);
	const { organizationId } = useOrganizationContext();
	const t = useTranslations("tooltips.pipeline");
	const completedTasks =
		story.tasks?.filter((task) => task.isCompleted).length || 0;
	const totalTasks = story.tasks?.length || 0;

	const handleGenerateTasks = async () => {
		setIsGenerating(true);
		try {
			await orpcClient.projects.stories.generateTasks({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
			toast.success(`Generated tasks for ${story.identifier}`);
			onTasksGenerated?.();
		} catch (error) {
			toast.error("Failed to generate tasks", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		} finally {
			setIsGenerating(false);
		}
	};

	return (
		<Collapsible open={isOpen} onOpenChange={setIsOpen}>
			<div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors">
				{/* Expand icon - clickable */}
				<CollapsibleTrigger asChild>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground"
					>
						{isOpen ? (
							<ChevronDownIcon className="w-4 h-4" />
						) : (
							<ChevronRightIcon className="w-4 h-4" />
						)}
					</button>
				</CollapsibleTrigger>

				{/* Story info - clickable to expand */}
				<CollapsibleTrigger asChild>
					<div className="flex-1 min-w-0 cursor-pointer">
						<div className="flex items-center gap-2">
							<Badge
								variant="outline"
								className="text-xs font-mono"
							>
								{story.identifier}
							</Badge>
							<span className="font-medium truncate">
								{story.title}
							</span>
						</div>
						{story.description && (
							<p className="text-sm text-muted-foreground truncate mt-0.5">
								{story.description}
							</p>
						)}
					</div>
				</CollapsibleTrigger>

				{/* Priority & Size */}
				<div className="flex items-center gap-2">
					<Badge
						variant="secondary"
						className="text-xs"
						style={{
							backgroundColor: `${getPriorityColor(story.priority)}20`,
							color: getPriorityColor(story.priority),
						}}
					>
						{story.priority.replace("_", " ")}
					</Badge>
					{story.size && (
						<Badge variant="outline" className="text-xs">
							{getSizeLabel(story.size)}
						</Badge>
					)}
				</div>

				{/* Task count */}
				{totalTasks > 0 && (
					<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
						<CheckIcon className="w-4 h-4" />
						<span>
							{completedTasks}/{totalTasks}
						</span>
					</div>
				)}

				{/* Open in Editor link */}
				<Tooltip>
					<TooltipTrigger asChild>
						<Link
							href={`${basePath}/projects/${projectId}/stories/${story.id}`}
							className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-primary transition-colors"
							aria-label={t("openStoryEditor")}
							onClick={(e) => e.stopPropagation()}
						>
							<ExternalLinkIcon className="w-4 h-4" />
						</Link>
					</TooltipTrigger>
					<TooltipContent>{t("openStoryEditor")}</TooltipContent>
				</Tooltip>
			</div>

			<CollapsibleContent>
				<div className="ml-7 mt-1 mb-2 space-y-1">
					{story.tasks && story.tasks.length > 0 ? (
						story.tasks.map((task) => (
							<TaskItem
								key={task.id}
								task={task}
								projectId={projectId}
								projectName={projectName}
								storyId={story.id}
								storyTitle={story.title}
								onUpdate={onTasksGenerated}
							/>
						))
					) : (
						<div className="flex items-center justify-between p-3 rounded-md border border-dashed bg-muted/30">
							<span className="text-sm text-muted-foreground">
								No tasks for this story
							</span>
							<div className="flex items-center gap-2">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="outline"
											size="sm"
											onClick={handleGenerateTasks}
											disabled={isGenerating}
											className="gap-1.5 h-7 text-xs"
										>
											{isGenerating ? (
												<>
													<Loader2Icon className="w-3 h-3 animate-spin" />
													Generating...
												</>
											) : (
												<>
													<Sparkles className="w-3 h-3" />
													Generate Tasks
												</>
											)}
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{t("generateTasks")}
									</TooltipContent>
								</Tooltip>
								<Link
									href={`${basePath}/projects/${projectId}/stories/${story.id}`}
									className="text-primary hover:underline text-xs"
								>
									or add manually →
								</Link>
							</div>
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

/**
 * Task item within a story - with edit/delete capabilities using popover
 */
function TaskItem({
	task,
	projectId,
	projectName,
	storyId,
	storyTitle,
	onUpdate,
}: {
	task: StoryTask;
	projectId: string;
	projectName?: string;
	storyId: string;
	storyTitle?: string;
	onUpdate?: () => void;
}) {
	const [isDeleting, setIsDeleting] = useState(false);
	const [isToggling, setIsToggling] = useState(false);
	const t = useTranslations("tooltips.pipeline");
	const tC = useTranslations("tooltips.common");

	const handleToggle = async () => {
		setIsToggling(true);
		try {
			await orpcClient.projects.stories.tasks.toggle({
				projectId,
				storyId,
				taskId: task.id,
			});
			onUpdate?.();
		} catch (_error) {
			toast.error("Failed to toggle task");
		} finally {
			setIsToggling(false);
		}
	};

	const handleSave = async (data: {
		title: string;
		description: string | null;
		estimatedHours: number | null;
	}) => {
		try {
			await orpcClient.projects.stories.tasks.update({
				projectId,
				storyId,
				taskId: task.id,
				title: data.title,
				description: data.description,
				estimatedHours: data.estimatedHours,
			});
			toast.success("Task updated");
			onUpdate?.();
		} catch (error) {
			toast.error("Failed to update task");
			throw error;
		}
	};

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			await orpcClient.projects.stories.tasks.delete({
				projectId,
				storyId,
				taskId: task.id,
			});
			toast.success("Task deleted");
			onUpdate?.();
		} catch (_error) {
			toast.error("Failed to delete task");
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="group flex items-center gap-3 p-2 rounded-md border bg-muted/30 hover:bg-muted/50 transition-colors">
			{/* Toggle checkbox */}
			<button
				type="button"
				onClick={handleToggle}
				disabled={isToggling}
				className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
					task.isCompleted
						? "bg-green-500 border-green-500 text-white"
						: "border-muted-foreground/30 hover:border-green-500"
				}`}
			>
				{isToggling ? (
					<Loader2Icon className="w-3 h-3 animate-spin" />
				) : task.isCompleted ? (
					<CheckIcon className="w-3 h-3" />
				) : null}
			</button>

			{/* Task title and description */}
			<div className="flex-1 min-w-0">
				<span
					className={`text-sm ${task.isCompleted ? "line-through text-muted-foreground" : ""}`}
				>
					{task.title}
				</span>
				{task.description && (
					<p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
						{task.description}
					</p>
				)}
			</div>

			{/* Estimated hours */}
			{task.estimatedHours && (
				<Badge variant="outline" className="text-xs">
					{task.estimatedHours}h
				</Badge>
			)}

			{/* Edit/Delete buttons - show on hover */}
			<div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
				<Tooltip>
					<TooltipTrigger asChild>
						<TaskEditPopover
							task={task}
							projectName={projectName}
							storyTitle={storyTitle}
							onSave={handleSave}
							side="bottom"
							align="end"
						>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 w-6 p-0"
								aria-label={t("editTask")}
							>
								<PencilIcon className="w-3 h-3" />
							</Button>
						</TaskEditPopover>
					</TooltipTrigger>
					<TooltipContent>{t("editTask")}</TooltipContent>
				</Tooltip>
				<DestructiveTooltip
					copy={
						tC.raw("delete") as {
							label: string;
							warning: string;
						}
					}
				>
					<Button
						variant="ghost"
						size="sm"
						onClick={handleDelete}
						disabled={isDeleting}
						className="h-6 w-6 p-0 text-destructive hover:text-destructive hover:bg-red-50 dark:hover:bg-red-950/30"
						aria-label={
							(tC.raw("delete") as { label: string }).label
						}
					>
						{isDeleting ? (
							<Loader2Icon className="w-3 h-3 animate-spin" />
						) : (
							<TrashIcon className="w-3 h-3" />
						)}
					</Button>
				</DestructiveTooltip>
			</div>
		</div>
	);
}
