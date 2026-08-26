"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import type { LucideIcon } from "lucide-react";
import {
	AlertTriangleIcon,
	CheckCircleIcon,
	ClipboardListIcon,
	CodeIcon,
	EyeIcon,
	FileTextIcon,
	LayoutIcon,
	ListChecksIcon,
	Loader2Icon,
	PlusIcon,
	RefreshCwIcon,
	SparklesIcon,
	Trash2Icon,
	UsersIcon,
	WrenchIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { CreateDocumentDialog } from "./CreateDocumentDialog";
import { DocumentDownloadDropdown } from "./DocumentDownloadDropdown";
import { DocumentTitleInlineEdit } from "./DocumentTitleInlineEdit";
import { ProjectSectionHero } from "./ProjectSectionHero";

type Props = {
	projectId: string;
	enableDelete?: boolean;
	canEdit?: boolean;
	onDeletedAll?: () => void;
	onDeleted?: (id: string) => void;
};

const documentTypeStyles: Record<
	string,
	{
		icon: LucideIcon;
		iconClassName: string;
		panelClassName: string;
		haloClassName: string;
	}
> = {
	GENERAL: {
		icon: FileTextIcon,
		iconClassName:
			"border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300",
		panelClassName:
			"border-slate-500/20 bg-slate-500/[0.06] dark:border-slate-500/15 dark:bg-slate-500/[0.04]",
		haloClassName: "from-slate-500/10 via-slate-500/5 to-transparent",
	},
	PRD: {
		icon: ClipboardListIcon,
		iconClassName:
			"border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300",
		panelClassName:
			"border-sky-500/20 bg-sky-500/[0.06] dark:border-sky-500/15 dark:bg-sky-500/[0.04]",
		haloClassName: "from-sky-500/10 via-sky-500/5 to-transparent",
	},
	PROPOSAL: {
		icon: LayoutIcon,
		iconClassName:
			"border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
		panelClassName:
			"border-violet-500/20 bg-violet-500/[0.06] dark:border-violet-500/15 dark:bg-violet-500/[0.04]",
		haloClassName: "from-violet-500/10 via-violet-500/5 to-transparent",
	},
	ARCHITECTURE: {
		icon: CodeIcon,
		iconClassName:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
		panelClassName:
			"border-emerald-500/20 bg-emerald-500/[0.06] dark:border-emerald-500/15 dark:bg-emerald-500/[0.04]",
		haloClassName: "from-emerald-500/10 via-emerald-500/5 to-transparent",
	},
	TECHNICAL_SPEC: {
		icon: WrenchIcon,
		iconClassName:
			"border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
		panelClassName:
			"border-amber-500/20 bg-amber-500/[0.06] dark:border-amber-500/15 dark:bg-amber-500/[0.04]",
		haloClassName: "from-amber-500/10 via-amber-500/5 to-transparent",
	},
	USER_STORY: {
		icon: UsersIcon,
		iconClassName:
			"border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300",
		panelClassName:
			"border-rose-500/20 bg-rose-500/[0.06] dark:border-rose-500/15 dark:bg-rose-500/[0.04]",
		haloClassName: "from-rose-500/10 via-rose-500/5 to-transparent",
	},
	API_SPEC: {
		icon: CodeIcon,
		iconClassName:
			"border-cyan-500/30 bg-cyan-500/10 text-cyan-600 dark:text-cyan-300",
		panelClassName:
			"border-cyan-500/20 bg-cyan-500/[0.06] dark:border-cyan-500/15 dark:bg-cyan-500/[0.04]",
		haloClassName: "from-cyan-500/10 via-cyan-500/5 to-transparent",
	},
	BUSINESS_CASE: {
		icon: ClipboardListIcon,
		iconClassName:
			"border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300",
		panelClassName:
			"border-fuchsia-500/20 bg-fuchsia-500/[0.06] dark:border-fuchsia-500/15 dark:bg-fuchsia-500/[0.04]",
		haloClassName: "from-fuchsia-500/10 via-fuchsia-500/5 to-transparent",
	},
	TEST_PLAN: {
		icon: WrenchIcon,
		iconClassName:
			"border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300",
		panelClassName:
			"border-teal-500/20 bg-teal-500/[0.06] dark:border-teal-500/15 dark:bg-teal-500/[0.04]",
		haloClassName: "from-teal-500/10 via-teal-500/5 to-transparent",
	},
	TEST_REPORT: {
		icon: WrenchIcon,
		iconClassName:
			"border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300",
		panelClassName:
			"border-teal-500/20 bg-teal-500/[0.06] dark:border-teal-500/15 dark:bg-teal-500/[0.04]",
		haloClassName: "from-teal-500/10 via-teal-500/5 to-transparent",
	},
	TRACEABILITY_MATRIX: {
		icon: WrenchIcon,
		iconClassName:
			"border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300",
		panelClassName:
			"border-teal-500/20 bg-teal-500/[0.06] dark:border-teal-500/15 dark:bg-teal-500/[0.04]",
		haloClassName: "from-teal-500/10 via-teal-500/5 to-transparent",
	},
	QA_STRATEGY: {
		icon: WrenchIcon,
		iconClassName:
			"border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-300",
		panelClassName:
			"border-teal-500/20 bg-teal-500/[0.06] dark:border-teal-500/15 dark:bg-teal-500/[0.04]",
		haloClassName: "from-teal-500/10 via-teal-500/5 to-transparent",
	},
	SRS: {
		icon: ListChecksIcon,
		iconClassName:
			"border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
		panelClassName:
			"border-indigo-500/20 bg-indigo-500/[0.06] dark:border-indigo-500/15 dark:bg-indigo-500/[0.04]",
		haloClassName: "from-indigo-500/10 via-indigo-500/5 to-transparent",
	},
};

const statusConfig: Record<
	string,
	{ label: string; className: string; dotClassName: string }
> = {
	DRAFT: {
		label: "Draft",
		className: "border-border/70 bg-muted/60 text-muted-foreground",
		dotClassName: "bg-muted-foreground/70",
	},
	GENERATING: {
		label: "Generating",
		className:
			"border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300",
		dotClassName: "bg-sky-500 dark:bg-sky-400",
	},
	IN_PROGRESS: {
		label: "In Progress",
		className:
			"border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300",
		dotClassName: "bg-amber-500 dark:bg-amber-400",
	},
	REVIEW: {
		label: "Review",
		className:
			"border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-300",
		dotClassName: "bg-violet-500 dark:bg-violet-400",
	},
	COMPLETE: {
		label: "Complete",
		className:
			"border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
		dotClassName: "bg-emerald-500 dark:bg-emerald-400",
	},
	FAILED: {
		label: "Failed",
		className: "border-destructive/20 bg-destructive/10 text-destructive",
		dotClassName: "bg-destructive",
	},
};

const documentTypeLabels: Record<string, string> = {
	PRD: "PRD",
	PROPOSAL: "Proposal",
	BUSINESS_CASE: "Business Case",
	ARCHITECTURE: "Architecture",
	TECHNICAL_SPEC: "Tech Spec",
	USER_STORY: "Features",
	API_SPEC: "API Spec",
	QA_STRATEGY: "Testing Strategy",
	TEST_PLAN: "Test Plan",
	TEST_REPORT: "Test Report",
	TRACEABILITY_MATRIX: "Traceability Matrix",
	SRS: "SRS",
	GENERAL: "General",
};

const documentTypeDescriptions: Record<string, string> = {
	PRD: "Benefit hypothesis, requirements, success metrics, and key flows",
	PROPOSAL:
		"Benefit hypothesis, scope, deliverables, phases, and success metrics",
	BUSINESS_CASE:
		"Decision ask, options considered, recommendation, value, and risks",
	ARCHITECTURE: "System design, components, data flow, and infrastructure",
	TECHNICAL_SPEC:
		"Detailed technical requirements and implementation details",
	USER_STORY:
		"Actionable features with acceptance criteria (Given/When/Then)",
	API_SPEC: "API endpoints, request/response formats, and authentication",
	QA_STRATEGY:
		"Testing overview: risks, scope, tools, environments, and ramp-up — depth scaled to QA maturity",
	TEST_PLAN:
		"Scope, rigor, environments and entry/exit criteria for testing a feature",
	TEST_REPORT:
		"What a test run covered and what it found, versioned alongside the feature",
	TRACEABILITY_MATRIX:
		"Point-in-time export of acceptance criteria against the cases covering them",
	SRS: "Formal requirements baseline: scope, functional and non-functional requirements, interfaces, and acceptance criteria",
	GENERAL: "General purpose document",
};

const actionButtonClassName =
	"size-8 border border-border bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

/**
 * The document status pill. When the document failed generation we have a
 * reason worth surfacing, so the pill becomes a tooltip trigger; otherwise it
 * stays a plain `<span>` and no tooltip renders at all.
 */
function StatusBadge({
	className,
	failureCopy,
	children,
}: {
	className?: string;
	failureCopy: string | null;
	children: ReactNode;
}) {
	if (!failureCopy) {
		return <span className={className}>{children}</span>;
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className={className}>
					{children}
					<span className="sr-only">{failureCopy}</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>{failureCopy}</TooltipContent>
		</Tooltip>
	);
}

function _toSlug(input: string): string {
	return (
		input
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "document"
	);
}

/**
 * Whether a stood-down document can be made canonical again.
 *
 * The rule has to be at least as wide as whatever stands documents down. A
 * document lands inactive whenever one of its type is already active, and that
 * happens at any status — so anything that can end up inactive must be
 * restorable. What is excluded is only what has no body to be canonical with:
 * a run still writing, and a run that failed.
 *
 * This was COMPLETE-only, which left an inactive draft with no way back at all.
 * Found on a deployed environment, where two drafts were inactive and neither
 * card offered the action.
 */
export function canBeMadeActive(status: string | null | undefined): boolean {
	return status !== "GENERATING" && status !== "FAILED";
}

export function DocumentsList({
	projectId,
	enableDelete,
	canEdit = true,
	onDeletedAll,
	onDeleted,
}: Props) {
	const tTooltips = useTranslations("tooltips.documentEditor");
	const router = useRouter();
	const { basePath: orgBasePath, organizationId } = useOrganizationContext();
	const basePath = `${orgBasePath}/projects`;
	const queryClient = useQueryClient();
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [regeneratingDocId, setRegeneratingDocId] = useState<string | null>(
		null,
	);
	const [confirmRegenDoc, setConfirmRegenDoc] = useState<{
		id: string;
		title: string;
		source: string | null;
	} | null>(null);
	const [togglingActiveDocId, setTogglingActiveDocId] = useState<
		string | null
	>(null);
	const [editingDocId, setEditingDocId] = useState<string | null>(null);

	const { data, isLoading, error } = useQuery(
		orpc.projects.documents.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);

	const deleteMutation = useMutation(
		orpc.projects.documents.delete.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
			},
		}),
	);
	const deleteAllMutation = useMutation(
		orpc.projects.documents.deleteAll.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
			},
		}),
	);

	const regenerateMutation = useMutation(
		orpc.projects.documents.generate.mutationOptions({
			onSuccess: () => {
				toast.success("Document regeneration started");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
			},
			onError: (error) => {
				toast.error(`Failed to regenerate: ${error.message}`);
			},
			onSettled: () => {
				setRegeneratingDocId(null);
			},
		}),
	);

	const setActiveMutation = useMutation(
		orpc.projects.documents.setActive.mutationOptions({
			onSuccess: () => {
				toast.success("Active document updated");
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.list.queryKey({
						input: { projectId, organizationId },
					}),
				});
			},
			onError: (error) => {
				toast.error(
					`Failed to update active document: ${error.message}`,
				);
			},
			onSettled: () => {
				setTogglingActiveDocId(null);
			},
		}),
	);

	const handleSetActive = (e: React.MouseEvent, docId: string) => {
		e.stopPropagation();
		setTogglingActiveDocId(docId);
		setActiveMutation.mutate({
			projectId,
			id: docId,
			organizationId,
		});
	};

	const handleRegenerateClick = (
		e: React.MouseEvent,
		doc: { id: string; title: string; source?: string | null },
	) => {
		e.stopPropagation();
		// Always confirm before regenerating: regen replaces the live content
		// with a fresh AI generation. The current content is preserved in
		// version history, but the user should know that's about to happen.
		setConfirmRegenDoc({
			id: doc.id,
			title: doc.title,
			source: doc.source ?? null,
		});
	};

	const handleConfirmRegenerate = () => {
		if (!confirmRegenDoc) {
			return;
		}
		setRegeneratingDocId(confirmRegenDoc.id);
		regenerateMutation.mutate({ id: confirmRegenDoc.id });
		setConfirmRegenDoc(null);
	};

	const handleDocumentClick = (documentId: string) => {
		router.push(`${basePath}/${projectId}/documents/${documentId}`);
	};

	const handleViewClick = (e: React.MouseEvent, documentId: string) => {
		e.stopPropagation();
		handleDocumentClick(documentId);
	};

	if (isLoading) {
		return (
			<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
				{[1, 2, 3, 4].map((i) => (
					<Skeleton key={i} className="h-40 w-full rounded-xl" />
				))}
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-xl border bg-card/50 p-6 backdrop-blur-sm">
				<p className="text-destructive">
					Failed to load documents: {error.message}
				</p>
			</div>
		);
	}

	const documents = Array.isArray(data?.documents) ? data.documents : [];
	const completeCount = documents.filter(
		(doc) => doc.status === "COMPLETE",
	).length;
	const activeCount = documents.filter((doc) =>
		["GENERATING", "IN_PROGRESS", "REVIEW"].includes(doc.status),
	).length;
	const openCount = Math.max(
		documents.length - completeCount - activeCount,
		0,
	);

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Project Documents"
				title="Planning artifacts, working docs, and generated outputs"
				description="Keep the project’s source documents, generated specifications, and editable working artifacts in one place so the team always knows what is current."
				getStartedPageId="documents"
				badges={
					<>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							{documents.length} document
							{documents.length !== 1 ? "s" : ""}
						</div>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							Generated and manual artifacts
						</div>
					</>
				}
				aside={
					<div className="flex h-full flex-col justify-between">
						<div>
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Document State
							</p>
							<div className="mt-4 grid grid-cols-3 gap-3">
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground">
										{completeCount}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Ready
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-primary">
										{activeCount}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Active
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground/75">
										{openCount}
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
								Use this tab to manage the core artifacts the
								rest of the project experience depends on.
							</p>
							<div className="mt-4 flex flex-wrap gap-2">
								{enableDelete && documents.length > 0 && (
									<Button
										variant="outline"
										className="border-destructive/25 bg-destructive/5 text-destructive hover:border-destructive/40 hover:bg-destructive/10"
										onClick={async () => {
											if (
												!window.confirm(
													"Delete all documents? This cannot be undone.",
												)
											) {
												return;
											}
											await deleteAllMutation.mutateAsync(
												{
													projectId,
												},
											);
											onDeletedAll?.();
										}}
									>
										<Trash2Icon className="mr-2 size-4" />
										Delete All
									</Button>
								)}
								<Button
									onClick={() => setCreateDialogOpen(true)}
									variant="outline"
									className="gap-2 border-primary/25 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/[0.14]"
									data-onboarding-target="documents-create"
								>
									<PlusIcon className="size-4" />
									Create Document
								</Button>
							</div>
						</div>
					</div>
				}
			/>

			{/* Documents list */}
			{documents.length === 0 ? (
				<div className="flex flex-col items-center justify-center rounded-2xl border border-border/60 bg-card/40 py-16 backdrop-blur-sm">
					<div className="mb-4 rounded-2xl border border-primary/15 bg-primary/10 p-4 text-primary">
						<FileTextIcon className="size-8" />
					</div>
					<p className="mb-2 font-medium text-foreground">
						No documents yet
					</p>
					<p className="mb-6 max-w-sm text-center text-muted-foreground text-sm">
						Create your first document to start building your
						project documentation
					</p>
					<Button
						onClick={() => setCreateDialogOpen(true)}
						variant="outline"
						className="gap-2 border-primary/25 bg-primary/10 text-primary hover:border-primary/40 hover:bg-primary/[0.14]"
					>
						<SparklesIcon className="size-4" />
						Create First Document
					</Button>
				</div>
			) : (
				<div
					className="grid grid-cols-1 gap-4 md:grid-cols-2"
					data-onboarding-target="documents-list"
				>
					{documents.map((doc, index) => {
						const style =
							documentTypeStyles[doc.type] ||
							documentTypeStyles.GENERAL;
						const Icon = style.icon;
						const status =
							statusConfig[doc.status] || statusConfig.DRAFT;

						// Check if document has content (failed docs with 0 words have no content)
						const hasContent =
							doc.status !== "FAILED" ||
							(doc.wordCount && doc.wordCount > 0);
						const isClickable = hasContent;
						const isActive = (doc as any).isActive !== false;

						return (
							<div
								key={doc.id}
								className={cn(
									"group relative overflow-hidden rounded-2xl border border-border bg-card transition-all duration-200 shadow-sm",
									isClickable &&
										"cursor-pointer hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md",
									!isClickable && "opacity-75",
									!isActive && "opacity-60",
									`animate-stagger-${Math.min(index + 1, 5)}`,
								)}
							>
								{isClickable && (
									<button
										type="button"
										aria-label={`Open ${doc.title}`}
										className="absolute inset-0 z-0 rounded-2xl"
										onClick={() => {
											if (editingDocId === doc.id) {
												return;
											}
											handleDocumentClick(doc.id);
										}}
									/>
								)}

								{/* Gradient background on hover */}
								<div
									className={cn(
										"absolute inset-0 bg-gradient-to-br opacity-0 transition-opacity duration-200 group-hover:opacity-100",
										style.haloClassName,
									)}
								/>
								<div
									className={cn(
										"absolute inset-x-3 inset-y-3 rounded-[1.1rem] border opacity-80 transition-colors duration-200 group-hover:opacity-100",
										style.panelClassName,
									)}
								/>

								<div className="pointer-events-none relative z-10 p-5">
									{/* Active badge - top right, hides on hover so action buttons are accessible */}
									{isActive && (
										<div className="absolute top-[1.15rem] right-5 z-10 transition-opacity group-hover:opacity-0 pointer-events-none">
											<Badge className="border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 text-xs font-medium">
												Active
											</Badge>
										</div>
									)}

									{/* Header */}
									<div className="flex items-start gap-3">
										{/* Icon with gradient */}
										<div
											className={cn(
												"shrink-0 rounded-xl border p-2.5 transition-transform duration-200 group-hover:scale-[1.03]",
												style.iconClassName,
											)}
										>
											<Icon className="size-5" />
										</div>
										<div
											className="pointer-events-auto min-w-0 flex-1 pr-16"
											onMouseDownCapture={
												canEdit
													? (e) => e.stopPropagation()
													: undefined
											}
										>
											<h3 className="font-semibold text-base leading-tight">
												<DocumentTitleInlineEdit
													projectId={projectId}
													documentId={doc.id}
													organizationId={
														organizationId
													}
													title={doc.title}
													canEdit={canEdit}
													inputClassName="h-8 text-base font-semibold"
													onEditingChange={(
														editing,
													) =>
														setEditingDocId(
															editing
																? doc.id
																: null,
														)
													}
												/>
											</h3>
											<p className="mt-0.5 text-foreground/50 text-xs leading-normal">
												{documentTypeDescriptions[
													doc.type
												] ||
													documentTypeDescriptions.GENERAL}
											</p>
										</div>

										{/* Actions - visible on hover */}
										<div className="pointer-events-auto flex shrink-0 items-start gap-1 pt-0.5 opacity-0 transition-opacity group-hover:opacity-100">
											{/* Only show View/Download for documents with content */}
											{isClickable && (
												<>
													<Button
														variant="ghost"
														size="icon"
														title="View"
														className={
															actionButtonClassName
														}
														onClick={(e) =>
															handleViewClick(
																e,
																doc.id,
															)
														}
													>
														<EyeIcon className="size-4" />
													</Button>
													<DocumentDownloadDropdown
														documentId={doc.id}
														title={doc.title}
														projectId={projectId}
														className={
															actionButtonClassName
														}
													/>
												</>
											)}
											{/* Show regenerate button for failed or complete documents */}
											{(doc.status === "FAILED" ||
												doc.status === "COMPLETE") && (
												<Button
													variant="ghost"
													size="icon"
													title="Regenerate"
													className={
														actionButtonClassName
													}
													disabled={
														regeneratingDocId ===
														doc.id
													}
													onClick={(e) =>
														handleRegenerateClick(
															e,
															doc,
														)
													}
												>
													{regeneratingDocId ===
													doc.id ? (
														<Loader2Icon className="size-4 animate-spin text-primary" />
													) : (
														<RefreshCwIcon className="size-4 text-primary" />
													)}
												</Button>
											)}
											{/*
											 * The way back from being stood down.
											 *
											 * Offered for anything that has a
											 * body to be canonical with — which
											 * is every status except the two
											 * that have none: one still being
											 * written, and one whose run failed.
											 * It used to require COMPLETE, and
											 * that was narrower than the rule it
											 * has to undo: creating a document
											 * displaces whatever is active
											 * regardless of status, so a DRAFT
											 * could be stood down with no way
											 * back. Found on a deployed
											 * environment, where two drafts were
											 * demoted and neither card offered
											 * this.
											 */}
											{!isActive &&
												canBeMadeActive(doc.status) && (
													<Button
														variant="ghost"
														size="icon"
														title="Set as active"
														className={
															actionButtonClassName
														}
														disabled={
															togglingActiveDocId ===
															doc.id
														}
														onClick={(e) =>
															handleSetActive(
																e,
																doc.id,
															)
														}
													>
														{togglingActiveDocId ===
														doc.id ? (
															<Loader2Icon className="size-4 animate-spin text-highlight" />
														) : (
															<CheckCircleIcon className="size-4 text-emerald-500" />
														)}
													</Button>
												)}
											{/* Always show delete option */}
											{enableDelete && (
												<Button
													variant="ghost"
													size="icon"
													title="Delete"
													className={
														actionButtonClassName
													}
													onClick={async (e) => {
														e.stopPropagation();
														if (
															!window.confirm(
																`Delete "${doc.title}"? This cannot be undone.`,
															)
														) {
															return;
														}
														await deleteMutation.mutateAsync(
															{
																id: doc.id,
																projectId,
															},
														);
														onDeleted?.(doc.id);
													}}
												>
													<Trash2Icon className="size-4 text-destructive" />
												</Button>
											)}
										</div>
									</div>

									{/* Footer */}
									<div className="mt-4 flex flex-wrap items-center gap-2">
										{/* Status badge with gradient. The failure reason is
											only attached when the document actually failed —
											otherwise there is nothing to say and no tooltip
											renders. The badge is not focusable, so the copy
											also lives in an `sr-only` child; `aria-label`
											would replace the visible status label. */}
										<StatusBadge
											className={cn(
												"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-xs",
												status.className,
											)}
											failureCopy={
												doc.status === "FAILED" &&
												doc.generationError
													? tTooltips(
															"generationError",
															{
																error: doc.generationError,
															},
														)
													: null
											}
										>
											<span
												className={cn(
													"size-1.5 rounded-full",
													doc.status === "GENERATING"
														? "animate-pulse"
														: undefined,
													status.dotClassName,
												)}
											/>
											{status.label}
										</StatusBadge>

										{/* Show error message for failed documents */}
										{doc.status === "FAILED" &&
											doc.generationError && (
												<span
													className="text-xs text-destructive max-w-[200px] truncate"
													title={doc.generationError}
												>
													{doc.generationError}
												</span>
											)}

										{/* Type badge */}
										<Badge
											variant="outline"
											className="border-border/70 bg-background/40 text-xs text-muted-foreground"
										>
											{documentTypeLabels[doc.type] ??
												doc.type.replace(/_/g, " ")}
										</Badge>

										{/* Source badge for imported/external docs */}
										{doc.source === "IMPORTED" && (
											<Badge
												variant="outline"
												className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 text-xs"
											>
												Imported
											</Badge>
										)}
										{doc.source === "EXTERNAL" && (
											<Badge
												variant="outline"
												className="border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300 text-xs"
											>
												External
											</Badge>
										)}

										{/* Inactive badge */}
										{!isActive && (
											<Badge
												variant="outline"
												className="border-border/70 bg-background/40 text-muted-foreground text-xs"
											>
												Inactive
											</Badge>
										)}

										{/* Meta info */}
										<div className="flex items-center gap-2 text-muted-foreground/80 text-xs">
											<span>v{doc.version}</span>
											<span>•</span>
											<span>
												{doc.wordCount || 0} words
											</span>
											{doc.updatedAt && (
												<>
													<span>•</span>
													<span>
														{formatDistanceToNow(
															typeof doc.updatedAt ===
																"string"
																? new Date(
																		doc.updatedAt,
																	)
																: doc.updatedAt,
														)}{" "}
														ago
													</span>
												</>
											)}
										</div>
									</div>
								</div>
							</div>
						);
					})}
				</div>
			)}

			{/* Regenerate confirmation dialog */}
			<Dialog
				open={!!confirmRegenDoc}
				onOpenChange={(open) => {
					if (!open) {
						setConfirmRegenDoc(null);
					}
				}}
			>
				<DialogContent className="max-w-md">
					{(() => {
						const isImported =
							confirmRegenDoc?.source === "IMPORTED" ||
							confirmRegenDoc?.source === "EXTERNAL";
						return (
							<>
								<DialogHeader>
									<DialogTitle className="flex items-center gap-2">
										<AlertTriangleIcon className="h-5 w-5 text-highlight" />
										{isImported
											? "Regenerate Imported Document?"
											: "Regenerate this document?"}
									</DialogTitle>
									{isImported && (
										<DialogDescription>
											{confirmRegenDoc?.source ===
											"EXTERNAL"
												? "This document was imported from an external source."
												: "This document was imported from an uploaded file."}
										</DialogDescription>
									)}
								</DialogHeader>

								<div className="py-2 space-y-3">
									<p className="text-sm">
										Regenerating will replace the current
										content with a new AI-generated version
										using all your project context.
									</p>
									<div className="p-3 bg-muted rounded-lg">
										<p className="text-sm text-muted-foreground">
											{isImported
												? "Your imported version will be preserved in version history."
												: "Your current content will be saved to version history before being replaced."}
										</p>
									</div>
								</div>

								<DialogFooter>
									<Button
										variant="outline"
										onClick={() => setConfirmRegenDoc(null)}
									>
										Cancel
									</Button>
									<Button onClick={handleConfirmRegenerate}>
										<RefreshCwIcon className="mr-2 h-4 w-4" />
										Regenerate
									</Button>
								</DialogFooter>
							</>
						);
					})()}
				</DialogContent>
			</Dialog>

			{/* Create document dialog */}
			<CreateDocumentDialog
				projectId={projectId}
				open={createDialogOpen}
				onOpenChange={setCreateDialogOpen}
			/>
		</div>
	);
}
