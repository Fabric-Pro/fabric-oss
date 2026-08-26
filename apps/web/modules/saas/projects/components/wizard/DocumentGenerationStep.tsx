"use client";

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
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
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { Progress } from "@ui/components/progress";
import { Textarea } from "@ui/components/textarea";
import confetti from "canvas-confetti";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	CodeIcon,
	FileTextIcon,
	LayoutIcon,
	Loader2Icon,
	RefreshCwIcon,
	SettingsIcon,
	SparklesIcon,
	UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PromptSelector } from "../../../prompts/components/PromptSelector";
import { DocumentsList } from "../DocumentsList";
import {
	type DocumentSelection,
	makePreloadedDocs,
	mergeSelectedWithRecommendations,
	type ProjectDocumentType,
} from "./documents";

/**
 * Trigger a celebration confetti burst for successful document generation
 */
function triggerConfetti() {
	const duration = 3000;
	const end = Date.now() + duration;
	const colors = ["#6366f1", "#8b5cf6", "#a855f7", "#22c55e", "#10b981"];

	// Fire confetti from the left
	confetti({
		particleCount: 50,
		angle: 60,
		spread: 55,
		origin: { x: 0, y: 0.6 },
		colors,
	});

	// Fire confetti from the right
	confetti({
		particleCount: 50,
		angle: 120,
		spread: 55,
		origin: { x: 1, y: 0.6 },
		colors,
	});

	// Continue with smaller bursts
	const interval = setInterval(() => {
		if (Date.now() > end) {
			clearInterval(interval);
			return;
		}

		confetti({
			particleCount: 20,
			angle: 60,
			spread: 45,
			origin: { x: 0, y: 0.6 },
			colors,
		});
		confetti({
			particleCount: 20,
			angle: 120,
			spread: 45,
			origin: { x: 1, y: 0.6 },
			colors,
		});
	}, 250);
}

interface DocumentGenerationStepProps {
	projectId: string;
	selectedDocumentIds: string[]; // Document IDs selected in Step 4
	onComplete: () => void;
	onBack?: () => void; // Optional back handler
}

const DOCUMENT_TYPE_ICONS: Record<string, any> = {
	PRD: FileTextIcon,
	PROPOSAL: LayoutIcon,
	BUSINESS_CASE: FileTextIcon,
	ARCHITECTURE: CodeIcon,
	TECHNICAL_SPEC: CodeIcon,
	USER_STORY: UsersIcon,
	API_SPEC: CodeIcon,
	GENERAL: FileTextIcon,
};

const DOCUMENT_TYPE_COLORS: Record<string, { text: string; bg: string }> = {
	PRD: {
		text: "text-blue-600 dark:text-blue-400",
		bg: "bg-blue-100 dark:bg-blue-900/20",
	},
	PROPOSAL: {
		text: "text-success dark:text-green-400",
		bg: "bg-green-100 dark:bg-green-900/20",
	},
	BUSINESS_CASE: {
		text: "text-amber-600 dark:text-amber-400",
		bg: "bg-amber-100 dark:bg-amber-900/20",
	},
	ARCHITECTURE: {
		text: "text-purple-600 dark:text-purple-400",
		bg: "bg-purple-100 dark:bg-purple-900/20",
	},
	TECHNICAL_SPEC: {
		text: "text-highlight dark:text-orange-400",
		bg: "bg-orange-100 dark:bg-orange-900/20",
	},
	USER_STORY: {
		text: "text-pink-600 dark:text-pink-400",
		bg: "bg-pink-100 dark:bg-pink-900/20",
	},
	API_SPEC: {
		text: "text-cyan-600 dark:text-cyan-400",
		bg: "bg-cyan-100 dark:bg-cyan-900/20",
	},
	GENERAL: {
		text: "text-gray-600 dark:text-gray-400",
		bg: "bg-gray-100 dark:bg-gray-900/20",
	},
};

export function DocumentGenerationStep({
	projectId,
	selectedDocumentIds,
	onComplete,
	onBack,
}: DocumentGenerationStepProps) {
	const queryClient = useQueryClient();
	const [documents, setDocuments] = useState<DocumentSelection[]>([]);
	const [isGenerating, setIsGenerating] = useState(false);
	const [hasCompleted, setHasCompleted] = useState(false);
	// Tracks whether the last generation run fully succeeded, partially failed, or fully failed.
	const [completionOutcome, setCompletionOutcome] = useState<
		"success" | "partial" | "failed" | "existing" | null
	>(null);
	// Map of persisted documentId -> original selection metadata (title, type, etc.)
	const [docMetaById, setDocMetaById] = useState<
		Record<string, DocumentSelection>
	>({});
	const [generationProgress, setGenerationProgress] = useState<
		Record<
			string,
			{
				status: string;
				progress: number;
				error?: string;
				content?: string;
				wordCount?: number;
			}
		>
	>({});
	const _router = useRouter();
	const { basePath: orgBasePath, organizationId } = useOrganizationContext();
	const _basePath = `${orgBasePath}/projects`;
	const _settingsPathRaw = useContextPath("settings/ai-providers");
	const buildReturnUrl = useSettingsReturnUrl();
	const settingsPath = buildReturnUrl(_settingsPathRaw);
	const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

	// Check AI configuration status
	const { data: aiConfigStatus, isLoading: isLoadingAiConfig } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () => {
			return await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			});
		},
	});

	const isAiNotConfigured =
		!isLoadingAiConfig && !aiConfigStatus?.isConfigured;

	// Fetch AI-powered document recommendations
	const { data: recommendations, isLoading: isLoadingRecommendations } =
		useQuery(
			orpc.projects.documentRecommendations.queryOptions({
				input: { projectId },
			}),
		);

	// Fetch existing project documents; if any exist, prefer showing them over the generation UI
	const { data: existingDocsData, refetch: refetchExisting } = useQuery(
		orpc.projects.documents.list.queryOptions({
			input: { projectId },
		}),
	);
	const existingDocuments = Array.isArray(existingDocsData?.documents)
		? existingDocsData?.documents
		: [];

	// Detect which doc types have active imported documents
	const importedDocTypes = new Set<string>();
	for (const doc of existingDocuments) {
		if (
			(doc.source === "IMPORTED" || doc.source === "EXTERNAL") &&
			doc.isActive &&
			doc.status === "COMPLETE"
		) {
			importedDocTypes.add(doc.type);
		}
	}

	// Filter selected document IDs to exclude types that already have imports
	const docsToGenerate = selectedDocumentIds.filter(
		(id) => !importedDocTypes.has(id),
	);
	const allImported =
		selectedDocumentIds.length > 0 &&
		docsToGenerate.length === 0 &&
		importedDocTypes.size > 0;

	useEffect(() => {
		// Only check for existing documents on initial mount, not after generation completes
		// This prevents flickering when transitioning from generating to completed state
		if (!isGenerating && !hasCompleted) {
			const completed = existingDocuments.length > 0;
			if (completed) {
				setHasCompleted(true);
				// If documents already exist and we didn't just run a generation, mark as existing.
				if (completionOutcome === null) {
					setCompletionOutcome("existing");
				}
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [existingDocsData]);

	// Show selected docs immediately while recommendations load (exclude imported types)
	useEffect(() => {
		if (!docsToGenerate?.length) {
			return;
		}
		setDocuments((prev) =>
			prev.length > 0
				? prev
				: makePreloadedDocs(docsToGenerate as ProjectDocumentType[]),
		);
	}, [docsToGenerate.join(",")]);

	// Initialize documents ensuring all Step 4 selections are present (minus imported types).
	// Merge selected docs with AI recommendations (union), preferring recommendation metadata.
	useEffect(() => {
		const recs = (recommendations?.recommendations ?? []) as any;
		const merged = mergeSelectedWithRecommendations(
			docsToGenerate as ProjectDocumentType[],
			recs,
		);
		setDocuments(merged);
	}, [recommendations, docsToGenerate.join(",")]);

	// Embed contexts mutation
	const embedContextsMutation = useMutation(
		orpc.projects.contexts.embed.mutationOptions({
			onSuccess: () => {
				toast.success("Project contexts embedded successfully");
			},
			onError: (error) => {
				toast.error(`Failed to embed contexts: ${error.message}`);
			},
		}),
	);

	// Batch generate mutation
	const batchGenerateMutation = useMutation(
		orpc.projects.documents.batchGenerate.mutationOptions({
			onSuccess: (data) => {
				toast.success("Document generation started");
				setIsGenerating(true);
				// Build an ID -> metadata map by zipping the returned IDs with the
				// selected docs (server returns in the same order as requested)
				const selected = documents.filter((d) => d.selected);
				const idMap: Record<string, DocumentSelection> = {};
				data.documents.forEach((doc, idx) => {
					const meta = selected[idx];
					if (meta) {
						idMap[doc.id] = meta;
					}
				});
				setDocMetaById(idMap);
				// Start polling for progress - extract IDs from response
				const documentIds = data.documents.map((doc) => doc.id);
				startProgressPolling(documentIds);
			},
			onError: (error) => {
				toast.error(`Failed to start generation: ${error.message}`);
				setIsGenerating(false);
			},
		}),
	);

	const toggleDocument = (index: number) => {
		setDocuments((prev) =>
			prev.map((doc, i) =>
				i === index ? { ...doc, selected: !doc.selected } : doc,
			),
		);
	};

	const updatePrompt = (index: number, prompt: string) => {
		setDocuments((prev) =>
			prev.map((doc, i) => (i === index ? { ...doc, prompt } : doc)),
		);
	};

	const updatePromptId = (index: number, promptId: string | undefined) => {
		setDocuments((prev) =>
			prev.map((doc, i) => (i === index ? { ...doc, promptId } : doc)),
		);
	};

	// Bulk action: Apply first document's prompt to all documents
	const applyPromptToAll = () => {
		const firstDoc = documents[0];
		if (!firstDoc?.promptId) {
			toast.error("Please select a prompt for the first document first");
			return;
		}

		setDocuments((prev) =>
			prev.map((doc) => ({ ...doc, promptId: firstDoc.promptId })),
		);
		toast.success("Prompt applied to all documents");
	};

	const startProgressPolling = (documentIds: string[]) => {
		// Initialize progress tracking
		const initialProgress: Record<
			string,
			{
				status: string;
				progress: number;
				content?: string;
				wordCount?: number;
			}
		> = {};
		for (const docId of documentIds) {
			initialProgress[docId] = { status: "GENERATING", progress: 0 };
		}
		setGenerationProgress(initialProgress);

		// Clear any existing poll interval
		if (pollIntervalRef.current) {
			clearInterval(pollIntervalRef.current);
		}

		// Poll for progress every 2 seconds
		const pollInterval = setInterval(async () => {
			try {
				// Fetch document statuses with content
				const statuses = await Promise.all(
					documentIds.map(async (docId) => {
						const doc = await orpcClient.projects.documents.get({
							projectId,
							id: docId,
						});
						return {
							id: docId,
							status: doc.document.status,
							progress: doc.document.generationProgress || 0,
							error: doc.document.generationError,
							content: doc.document.content || undefined,
							wordCount: doc.document.wordCount || 0,
						};
					}),
				);

				// Update progress with content
				const newProgress: Record<
					string,
					{
						status: string;
						progress: number;
						error?: string;
						content?: string;
						wordCount?: number;
					}
				> = {};
				let allComplete = true;

				for (const status of statuses) {
					newProgress[status.id] = {
						status: status.status,
						progress: status.progress,
						error: status.error || undefined,
						content: status.content,
						wordCount: status.wordCount,
					};

					if (
						status.status !== "COMPLETE" &&
						status.status !== "FAILED"
					) {
						allComplete = false;
					}
				}

				setGenerationProgress(newProgress);

				// Stop polling if all complete
				if (allComplete) {
					clearInterval(pollInterval);
					pollIntervalRef.current = null;

					// Determine final outcome
					const failedCount = statuses.filter(
						(s) => s.status === "FAILED",
					).length;
					const successCount = statuses.filter(
						(s) => s.status === "COMPLETE",
					).length;

					// Use startTransition to batch state updates and prevent flickering
					startTransition(() => {
						setIsGenerating(false);
						setHasCompleted(true);

						if (failedCount === 0 && successCount > 0) {
							setCompletionOutcome("success");
						} else if (successCount > 0 && failedCount > 0) {
							setCompletionOutcome("partial");
						} else {
							setCompletionOutcome("failed");
						}
					});

					// Invalidate documents query to refresh the list
					queryClient.invalidateQueries({
						queryKey: orpc.projects.documents.list.queryKey({
							input: { projectId },
						}),
					});

					// Check for failures and show appropriate toast
					if (failedCount === 0) {
						toast.success("All documents generated successfully");
						triggerConfetti();
					} else if (successCount > 0) {
						toast.warning(
							`${successCount} document(s) generated, ${failedCount} failed`,
						);
					} else {
						toast.error("All documents failed to generate");
					}
				}
			} catch (error) {
				console.error("Failed to poll progress:", error);
			}
		}, 2000);

		pollIntervalRef.current = pollInterval;

		// Clean up on unmount
		return () => {
			clearInterval(pollInterval);
			pollIntervalRef.current = null;
		};
	};

	// Cleanup polling on unmount
	useEffect(() => {
		return () => {
			if (pollIntervalRef.current) {
				clearInterval(pollIntervalRef.current);
			}
		};
	}, []);

	const handleGenerate = async () => {
		const selectedDocs = documents.filter((doc) => doc.selected);

		if (selectedDocs.length === 0) {
			toast.error("Please select at least one document to generate");
			return;
		}

		try {
			// Step 1: Embed contexts
			await embedContextsMutation.mutateAsync({ projectId });

			// Step 2: Start batch generation
			await batchGenerateMutation.mutateAsync({
				projectId,
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				documents: selectedDocs.map((doc) => ({
					type: doc.type as
						| "PRD"
						| "PROPOSAL"
						| "ARCHITECTURE"
						| "TECHNICAL_SPEC"
						| "USER_STORY"
						| "API_SPEC"
						| "GENERAL",
					title: doc.title,
					prompt: doc.prompt,
					promptId: doc.promptId, // NEW: Pass custom prompt ID
				})),
			});
		} catch (error) {
			console.error("Generation failed:", error);
		}
	};

	const handleSkip = () => {
		onComplete();
	};

	const handleRegenerateAll = () => {
		setHasCompleted(false);
		setCompletionOutcome(null);
		setGenerationProgress({});
		// Re-select all documents that were originally selected or failed
		setDocuments((prev) => prev.map((doc) => ({ ...doc, selected: true })));
	};

	const handleRegenerateFailed = () => {
		setHasCompleted(false);
		setCompletionOutcome(null);
		// Get failed document types from progress state or existing documents
		const failedDocTypes = new Set<string>();
		const failedDocIds = new Set<string>();

		// Check generationProgress for failed documents
		for (const [docId, progress] of Object.entries(generationProgress)) {
			if (progress.status === "FAILED") {
				failedDocIds.add(docId);
				// Look up the document type from docMetaById
				const meta = docMetaById[docId];
				if (meta?.type) {
					failedDocTypes.add(meta.type);
				}
			}
		}

		// Also check existingDocuments for failed status
		for (const doc of existingDocuments) {
			if (doc.status === "FAILED") {
				failedDocIds.add(doc.id);
				failedDocTypes.add(doc.type);
			}
		}

		// Only reset progress for failed documents
		setGenerationProgress((prev) => {
			const newProgress = { ...prev };
			for (const docId of failedDocIds) {
				delete newProgress[docId];
			}
			return newProgress;
		});

		// Only select documents that failed (match by document type)
		setDocuments((prev) =>
			prev.map((doc) => ({
				...doc,
				selected: failedDocTypes.has(doc.type),
			})),
		);
	};

	// If all selected document types are already imported, show completion message
	if (allImported) {
		return (
			<div className="space-y-6">
				<div>
					<div className="flex items-center gap-2 mb-2">
						<CheckCircle2Icon className="h-6 w-6 text-success" />
						<h2 className="text-2xl font-bold">
							All Documents Imported
						</h2>
					</div>
					<p className="text-muted-foreground">
						All selected document types have been imported from your
						uploads. You can edit them from the Documents tab using
						the AI chat assistant.
					</p>
				</div>

				<DocumentsList projectId={projectId} />

				<div className="flex justify-end pt-4">
					<Button
						onClick={onComplete}
						size="lg"
						className="cursor-pointer"
					>
						Continue to Project
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<div className="flex items-center gap-2 mb-2">
					<SparklesIcon className="h-6 w-6 text-primary" />
					<h2 className="text-2xl font-bold">
						AI-Powered Document Generation
					</h2>
				</div>
				<p className="text-muted-foreground">
					Based on your project details, we recommend generating these
					documents
				</p>
			</div>

			{/* Imported documents info banner */}
			{importedDocTypes.size > 0 && docsToGenerate.length > 0 && (
				<div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
					<div className="flex items-center gap-2">
						<CheckCircle2Icon className="h-4 w-4 text-success" />
						<p className="text-sm text-green-700 dark:text-green-300">
							{importedDocTypes.size} document type
							{importedDocTypes.size !== 1 ? "s" : ""} already
							imported. Only generating the remaining{" "}
							{docsToGenerate.length} document
							{docsToGenerate.length !== 1 ? "s" : ""}.
						</p>
					</div>
				</div>
			)}

			{isLoadingRecommendations && (
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2Icon className="h-4 w-4 animate-spin" />
					Loading recommendations...
				</div>
			)}

			{/* AI Provider Warning */}
			{isAiNotConfigured && !isGenerating && !hasCompleted && (
				<Card className="border-amber-500/50 bg-amber-50/50 dark:bg-amber-950/20">
					<CardContent className="py-4">
						<div className="flex items-start gap-3">
							<AlertCircleIcon className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
							<div className="flex-1">
								<p className="font-medium text-amber-800 dark:text-amber-400">
									AI Provider Not Configured
								</p>
								<p className="text-sm text-amber-700 dark:text-highlight mt-1">
									Document generation requires an AI provider.
									Configure at least one provider (e.g.,
									OpenAI, Anthropic, Groq) to generate
									documents, or skip this step and configure
									later.
								</p>
								<div className="flex items-center gap-3 mt-3">
									<Button variant="outline" size="sm" asChild>
										<Link href={settingsPath}>
											<SettingsIcon className="mr-2 h-4 w-4" />
											Configure AI Provider
										</Link>
									</Button>
								</div>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Document Selection */}
			{!isGenerating && !hasCompleted && (
				<div className="space-y-4">
					{/* Bulk Actions */}
					{documents.length > 1 &&
						documents.some((d) => d.selected) && (
							<div className="flex items-center justify-between p-4 bg-muted/50 rounded-lg border">
								<div className="flex items-center gap-2">
									<SparklesIcon className="h-4 w-4 text-muted-foreground" />
									<span className="text-sm font-medium">
										Bulk Actions
									</span>
								</div>
								<Button
									variant="outline"
									size="sm"
									onClick={applyPromptToAll}
									disabled={!documents[0]?.promptId}
								>
									Apply First Prompt to All
								</Button>
							</div>
						)}

					{documents.map((doc, index) => {
						const Icon =
							DOCUMENT_TYPE_ICONS[doc.type] || FileTextIcon;
						const colors =
							DOCUMENT_TYPE_COLORS[doc.type] ||
							DOCUMENT_TYPE_COLORS.GENERAL;

						return (
							<Card
								key={index}
								className={`transition-all ${
									doc.selected
										? "border-primary bg-primary/5"
										: "hover:border-primary/50"
								}`}
							>
								<CardHeader>
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
													{doc.description}
												</CardDescription>
											</div>
										</div>
										<Checkbox
											checked={doc.selected}
											onCheckedChange={() =>
												toggleDocument(index)
											}
										/>
									</div>
								</CardHeader>
								{doc.selected && (
									<CardContent className="space-y-4">
										{/* Prompt Selector */}
										<div>
											<Label className="text-sm font-medium mb-2 block">
												AI Prompt Template
											</Label>
											<PromptSelector
												agentName="project_document_generator"
												documentType={doc.type}
												value={doc.promptId}
												onValueChange={(promptId) =>
													updatePromptId(
														index,
														promptId,
													)
												}
												disabled={isGenerating}
												placeholder="Use default prompt"
												showBindAction={true}
											/>
										</div>

										{/* Custom Instructions */}
										<div>
											<Label className="text-sm font-medium">
												Custom Instructions (Optional)
											</Label>
											<Textarea
												value={doc.prompt}
												onChange={(e) =>
													updatePrompt(
														index,
														e.target.value,
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
			)}

			{/* Completion: Show generated documents */}
			{hasCompleted && (
				<div className="space-y-4">
					{(() => {
						// Derive counts from local progress (when available) to show contextual banner text
						const progressValues =
							Object.values(generationProgress);
						let failedCount = progressValues.filter(
							(p) => p.status === "FAILED",
						).length;
						let successCount = progressValues.filter(
							(p) => p.status === "COMPLETE",
						).length;
						const outcome = completionOutcome;

						// For "existing" outcome, derive counts from actual document statuses
						if (
							outcome === "existing" &&
							existingDocuments.length > 0
						) {
							failedCount = existingDocuments.filter(
								(d) => d.status === "FAILED",
							).length;
							successCount = existingDocuments.filter(
								(d) => d.status === "COMPLETE",
							).length;
						}

						// All failed
						if (
							outcome === "failed" ||
							(outcome === "existing" &&
								failedCount > 0 &&
								successCount === 0) ||
							(successCount === 0 && failedCount > 0)
						) {
							return (
								<div className="p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
									<p className="text-sm font-medium text-destructive/80">
										Document generation failed
									</p>
									<p className="text-sm text-muted-foreground">
										All documents failed to generate. You
										can adjust inputs and try again.
									</p>
									<Button
										variant="outline"
										size="sm"
										className="mt-3"
										onClick={handleRegenerateAll}
									>
										<RefreshCwIcon className="mr-2 h-4 w-4" />
										Regenerate All
									</Button>
								</div>
							);
						}

						// Partial failure
						if (
							outcome === "partial" ||
							(outcome === "existing" &&
								successCount > 0 &&
								failedCount > 0) ||
							(successCount > 0 && failedCount > 0)
						) {
							return (
								<div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg">
									<p className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
										Some documents failed to generate
									</p>
									<p className="text-sm text-muted-foreground">
										{successCount} generated, {failedCount}{" "}
										failed. Review results below.
									</p>
									<Button
										variant="outline"
										size="sm"
										className="mt-3"
										onClick={handleRegenerateFailed}
									>
										<RefreshCwIcon className="mr-2 h-4 w-4" />
										Regenerate Failed
									</Button>
								</div>
							);
						}

						// All success
						if (
							outcome === "success" ||
							(outcome === "existing" &&
								successCount > 0 &&
								failedCount === 0)
						) {
							return (
								<div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
									<p className="text-sm font-medium text-green-700 dark:text-green-300">
										Documents generated successfully
									</p>
									<p className="text-sm text-muted-foreground">
										You can review and edit them below or
										continue to the project.
									</p>
								</div>
							);
						}

						// Existing docs with unknown status (fallback)
						return (
							<div className="p-4 bg-muted/30 rounded-lg">
								<p className="text-sm font-medium">
									Documents available
								</p>
								<p className="text-sm text-muted-foreground">
									You can review and edit them below or
									continue to the project.
								</p>
							</div>
						);
					})()}
					<DocumentsList
						projectId={projectId}
						enableDelete
						onDeletedAll={() => {
							setHasCompleted(false);
							setCompletionOutcome(null);
							// refresh list for consistency
							refetchExisting();
						}}
						onDeleted={() => {
							// Refetch — if this was the last doc, effect above will toggle hasCompleted to false
							refetchExisting();
						}}
					/>
				</div>
			)}

			{/* Generation Progress */}
			{isGenerating && (
				<div className="rounded-lg border bg-card overflow-hidden">
					{/* Header */}
					<div className="flex items-center gap-3 px-5 py-4 border-b">
						<Loader2Icon className="h-4 w-4 animate-spin text-primary shrink-0" />
						<div>
							<p className="text-sm font-medium">
								Generating Documents...
							</p>
							<p className="text-xs text-muted-foreground">
								Documents are being generated
							</p>
						</div>
					</div>

					{/* Document rows */}
					<div className="divide-y">
						{Object.entries(generationProgress).map(
							([docId, progress]) => {
								const doc = docMetaById[docId];
								const Icon =
									DOCUMENT_TYPE_ICONS[
										doc?.type || "GENERAL"
									] || FileTextIcon;
								const colors =
									DOCUMENT_TYPE_COLORS[
										doc?.type || "GENERAL"
									] || DOCUMENT_TYPE_COLORS.GENERAL;
								const isComplete =
									progress.status === "COMPLETE";
								const isFailed = progress.status === "FAILED";

								return (
									<div
										key={docId}
										className="flex items-center gap-4 px-5 py-3.5"
									>
										{/* Icon */}
										<div
											className={`p-1.5 rounded ${colors.bg} shrink-0`}
										>
											<Icon
												className={`h-4 w-4 ${colors.text}`}
											/>
										</div>

										{/* Title */}
										<span className="text-sm font-medium w-44 shrink-0 truncate">
											{doc?.title || "Document"}
										</span>

										{/* Progress bar */}
										<div className="flex-1">
											<Progress
												value={
													isComplete
														? 100
														: isFailed
															? progress.progress
															: progress.progress
												}
												className={`h-1.5 ${isFailed ? "[&>div]:bg-destructive" : isComplete ? "[&>div]:bg-success" : ""}`}
											/>
										</div>

										{/* Percentage */}
										<span className="text-sm text-muted-foreground w-10 text-right shrink-0">
											{isComplete
												? "100%"
												: `${progress.progress}%`}
										</span>

										{/* Status label */}
										<span
											className={`text-xs font-medium w-20 text-right shrink-0 ${
												isComplete
													? "text-success"
													: isFailed
														? "text-destructive"
														: "text-primary"
											}`}
										>
											{isComplete
												? "Complete"
												: isFailed
													? "Failed"
													: "Generating"}
										</span>
									</div>
								);
							},
						)}
					</div>
				</div>
			)}

			{/* Actions */}
			{!isGenerating && !hasCompleted && (
				<div className="flex items-center justify-between pt-4">
					<div className="flex items-center gap-2">
						{typeof onBack === "function" && (
							<Button
								variant="ghost"
								onClick={onBack}
								className="cursor-pointer"
							>
								Back
							</Button>
						)}
						<Button
							variant="ghost"
							onClick={handleSkip}
							className="cursor-pointer"
						>
							Skip for now
						</Button>
					</div>
					<Button
						onClick={handleGenerate}
						disabled={
							isAiNotConfigured ||
							documents.filter((d) => d.selected).length === 0 ||
							embedContextsMutation.isPending ||
							batchGenerateMutation.isPending
						}
						size="lg"
						className="cursor-pointer"
					>
						{embedContextsMutation.isPending ||
						batchGenerateMutation.isPending ? (
							<>
								<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
								Starting...
							</>
						) : (
							<>
								<SparklesIcon className="mr-2 h-4 w-4" />
								Generate Documents
							</>
						)}
					</Button>
				</div>
			)}

			{(isGenerating || hasCompleted) && (
				<div className="flex justify-end pt-4">
					<Button
						onClick={onComplete}
						size="lg"
						className="cursor-pointer"
					>
						Continue to Project
					</Button>
				</div>
			)}
		</div>
	);
}
