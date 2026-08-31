"use client";

import type { TabId } from "@saas/projects/lib/project-tabs";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	FileTextIcon,
	FolderIcon,
	PencilIcon,
	SparklesIcon,
	WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import {
	getDocumentMeta,
	getDocumentStatusView,
	getPipelineDocuments,
	isActiveDocument,
} from "../lib/document-pipeline";
import {
	type EditSection,
	ProjectSectionEditDialog,
} from "./ProjectSectionEditDialog";
import { ProjectSectionHero } from "./ProjectSectionHero";

type Project = {
	id: string;
	name: string;
	description: string | null;
	projectTypes: string[];
	techStack: string[] | null;
	features: string[] | null;
	goals: string | null;
	documents: Array<{
		id: string;
		type: string;
		title: string;
		status: string;
		isActive?: boolean;
	}>;
	_count?: {
		documents: number;
		contexts: number;
	};
};

type Props = {
	project: Project;
	projectId: string;
	organizationId?: string | null;
	onProjectUpdated?: () => void;
	onNavigateToTab?: (tabId: TabId) => void;
};

export function ProjectOverview({
	project,
	projectId,
	organizationId,
	onProjectUpdated,
	onNavigateToTab,
}: Props) {
	const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
	const [editSection, setEditSection] = useState<EditSection | null>(null);

	const activeDocs = (project.documents ?? []).filter(isActiveDocument);

	// Document Pipeline: derive cards from the project's actual documents,
	// stably ordered and capped so the section never overflows.
	const { visible: pipelineDocs, hasMore: hasMoreDocs } =
		getPipelineDocuments(project.documents);

	// Count documents by status
	const completedDocs = activeDocs.filter(
		(doc) => doc.status === "COMPLETE",
	).length;
	const generatingDocs = activeDocs.filter(
		(doc) => doc.status === "GENERATING",
	).length;
	const inProgressDocs = activeDocs.filter(
		(doc) => doc.status === "IN_PROGRESS",
	).length;

	// Total strictly matches the number of active documents
	const totalDocs = activeDocs.length > 0 ? activeDocs.length : 1;
	const remainingDocs =
		totalDocs - completedDocs - generatingDocs - inProgressDocs;
	const topFeatures = project.features?.slice(0, 6) ?? [];
	const metrics = [
		{
			label: "Documents ready",
			value: `${completedDocs}/${totalDocs}`,
			description: `${Math.round((completedDocs / totalDocs) * 100)}% complete`,
			icon: FileTextIcon,
		},
		{
			label: "Tech stack",
			value: project.techStack?.length || 0,
			description: "Core technologies captured",
			icon: WrenchIcon,
		},
		{
			label: "Features",
			value: project.features?.length || 0,
			description: "Planned product capabilities",
			icon: SparklesIcon,
		},
		{
			label: "Context",
			value: project._count?.contexts || 0,
			description: "Research and reference assets",
			icon: FolderIcon,
		},
	];

	const currentValues = {
		description: project.description ?? "",
		goals: project.goals ?? "",
		types: project.projectTypes,
		techStack: project.techStack ?? [],
		features: project.features ?? [],
	};

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Project Overview"
				title="Project signal, scope, and delivery state"
				description="A concise view of what this project is, what it is aiming for, and how prepared the team is to move from planning into execution."
				getStartedPageId="overview"
				badges={
					<>
						<div className="app-soft-badge rounded-full px-3 py-1.5 text-xs">
							{project.projectTypes.length || 0} project types
						</div>
						<div className="app-soft-badge rounded-full px-3 py-1.5 text-xs">
							{project.techStack?.length || 0} stack items
						</div>
						<div className="app-soft-badge rounded-full px-3 py-1.5 text-xs">
							{project.features?.length || 0} planned features
						</div>
					</>
				}
				aside={
					<div
						className="flex h-full flex-col justify-between"
						data-onboarding-target="overview-readiness"
					>
						<div>
							{/* Renamed from "Delivery Readiness" (Fizzy #2165). This widget counts
							    core planning documents and nothing else, so the old name
							    overstated it — and it collided head-on with the new project
							    readiness indicator now sitting in the header of this same
							    page. Folding it into the readiness rollup entirely is the
							    follow-up; this removes the collision now. */}
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Document Coverage
							</p>
							<div className="mt-4 grid grid-cols-3 gap-3">
								<div className="rounded-2xl border border-border/60 bg-card/70 p-3 text-center shadow-sm shadow-foreground/5">
									<p className="text-2xl font-semibold tabular-nums text-foreground">
										{completedDocs}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Ready
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-card/70 p-3 text-center shadow-sm shadow-foreground/5">
									<p className="text-2xl font-semibold tabular-nums text-primary">
										{generatingDocs + inProgressDocs}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Active
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-card/70 p-3 text-center shadow-sm shadow-foreground/5">
									<p className="text-2xl font-semibold tabular-nums text-foreground/75">
										{remainingDocs}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										Open
									</p>
								</div>
							</div>
						</div>
						<div className="mt-6 rounded-2xl border border-border/60 bg-card/75 p-4 shadow-sm shadow-foreground/5">
							<div className="mb-2 flex items-center justify-between">
								<p className="text-sm font-medium text-foreground">
									Document coverage
								</p>
								<p className="text-xs text-muted-foreground">
									{Math.round(
										(completedDocs / totalDocs) * 100,
									)}
									%
								</p>
							</div>
							<div className="h-2 overflow-hidden rounded-full bg-background/80">
								<div
									className="h-full rounded-full bg-primary"
									style={{
										width: `${Math.round((completedDocs / totalDocs) * 100)}%`,
									}}
								/>
							</div>
							<p className="mt-3 text-sm text-muted-foreground">
								Core planning documents are{" "}
								{completedDocs === totalDocs
									? "fully prepared."
									: "still being assembled."}
							</p>
						</div>
					</div>
				}
			/>

			<div
				className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
				data-onboarding-target="overview-metrics"
			>
				{metrics.map((metric) => {
					const Icon = metric.icon;
					return (
						<div
							key={metric.label}
							className="app-surface min-h-[148px] rounded-2xl p-5"
						>
							<div className="flex h-full flex-col justify-between gap-6">
								<div className="flex items-start justify-between gap-4">
									<div>
										<p className="text-3xl font-semibold tabular-nums text-foreground">
											{metric.value}
										</p>
										<p className="mt-2 text-sm font-medium text-foreground/80">
											{metric.label}
										</p>
									</div>
									<div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10">
										<Icon className="size-5 text-primary" />
									</div>
								</div>
								<p className="text-sm leading-5 text-muted-foreground">
									{metric.description}
								</p>
							</div>
						</div>
					);
				})}
			</div>

			<div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.95fr)]">
				<div className="space-y-6">
					<div className="app-surface rounded-2xl p-6">
						<div className="mb-4 flex items-start justify-between gap-4">
							<div>
								<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
									Project Brief
								</p>
								<h3 className="mt-2 text-xl font-semibold text-foreground">
									Narrative and intent
								</h3>
							</div>
							<button
								type="button"
								onClick={() => setEditSection("description")}
								className="-m-1 rounded-lg border border-border/60 bg-background/50 p-2 text-foreground/40 transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
								aria-label="Edit project brief"
							>
								<PencilIcon className="size-3.5" />
							</button>
						</div>
						<div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(220px,0.85fr)]">
							<div className="space-y-4">
								<div>
									<p className="text-sm font-medium text-muted-foreground">
										Description
									</p>
									{project.description ? (
										<div className="mt-2">
											<p
												className={cn(
													"text-sm leading-7 text-foreground/85 whitespace-pre-wrap sm:text-[15px]",
													!isDescriptionExpanded &&
														"line-clamp-4",
												)}
											>
												{project.description}
											</p>
											{project.description.length >
												220 && (
												<button
													type="button"
													onClick={() =>
														setIsDescriptionExpanded(
															!isDescriptionExpanded,
														)
													}
													className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:text-primary/80"
												>
													{isDescriptionExpanded ? (
														<>
															<ChevronUpIcon className="size-4" />
															Show less
														</>
													) : (
														<>
															<ChevronDownIcon className="size-4" />
															Show more
														</>
													)}
												</button>
											)}
										</div>
									) : (
										<p className="mt-2 text-sm italic text-foreground/40">
											No description yet.
										</p>
									)}
								</div>
								<div className="rounded-2xl border border-border/70 bg-muted/25 p-4">
									<div className="mb-2 flex items-start justify-between gap-3">
										<div>
											<p className="text-sm font-medium text-muted-foreground">
												Goals
											</p>
											<p className="mt-2 text-sm leading-6 text-foreground/80">
												{project.goals ||
													"No goals defined yet. Use this space to anchor the delivery outcome and success criteria."}
											</p>
										</div>
										<button
											type="button"
											onClick={() =>
												setEditSection("goals")
											}
											className="-m-1 rounded-lg border border-border/60 bg-background/50 p-2 text-foreground/40 transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
											aria-label="Edit goals"
										>
											<PencilIcon className="size-3.5" />
										</button>
									</div>
								</div>
							</div>

							<div
								data-onboarding-target="overview-feature-snapshot"
								className="rounded-2xl border border-border/70 bg-muted/20 p-4"
							>
								<div className="mb-4 flex items-start justify-between gap-3">
									<div>
										<p className="text-sm font-medium text-muted-foreground">
											Feature snapshot
										</p>
										<p className="mt-1 text-xs leading-5 text-muted-foreground">
											Representative capabilities from the
											current plan.
										</p>
									</div>
									<button
										type="button"
										onClick={() =>
											setEditSection("features")
										}
										className="-m-1 rounded-lg border border-border/60 bg-background/50 p-2 text-foreground/40 transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
										aria-label="Edit features"
									>
										<PencilIcon className="size-3.5" />
									</button>
								</div>
								{topFeatures.length > 0 ? (
									<div className="space-y-2">
										{topFeatures.map((feature, index) => (
											<div
												key={index}
												className="flex items-start gap-2 rounded-xl border border-border/55 bg-card/60 px-3 py-2.5"
											>
												<span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-secondary" />
												<span className="text-sm text-foreground/80">
													{feature}
												</span>
											</div>
										))}
										{(project.features?.length || 0) >
											topFeatures.length && (
											<div className="pt-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
												+
												{(project.features?.length ||
													0) -
													topFeatures.length}{" "}
												more in backlog
											</div>
										)}
									</div>
								) : (
									<p className="text-sm italic text-foreground/40">
										No features planned yet.
									</p>
								)}
							</div>
						</div>
					</div>

					<div className="app-surface rounded-2xl p-6">
						<div className="mb-5 flex items-start justify-between gap-4">
							<div>
								<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
									Build Profile
								</p>
								<h3 className="mt-2 text-xl font-semibold text-foreground">
									Platform and implementation shape
								</h3>
							</div>
						</div>
						<div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
							<div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
								<div className="flex items-center justify-between gap-2">
									<p className="text-sm font-medium text-muted-foreground">
										Project types
									</p>
									<button
										type="button"
										onClick={() => setEditSection("types")}
										className="-m-1 rounded-lg border border-border/60 bg-background/50 p-2 text-foreground/40 transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
										aria-label="Edit project types"
									>
										<PencilIcon className="size-3.5" />
									</button>
								</div>
								<div className="mt-4 flex flex-wrap gap-2">
									{project.projectTypes.length > 0 ? (
										project.projectTypes.map((type) => (
											<span
												key={type}
												className="rounded-full border border-border/70 bg-background/60 px-3 py-1.5 text-sm text-foreground"
											>
												{type}
											</span>
										))
									) : (
										<p className="text-sm italic text-foreground/40">
											No project types selected yet.
										</p>
									)}
								</div>
							</div>
							<div
								data-onboarding-target="overview-tech-stack"
								className="rounded-2xl border border-border/70 bg-muted/20 p-4"
							>
								<div className="flex items-center justify-between gap-2">
									<p className="text-sm font-medium text-muted-foreground">
										Tech stack
									</p>
									<button
										type="button"
										onClick={() =>
											setEditSection("techStack")
										}
										className="-m-1 rounded-lg border border-border/60 bg-background/50 p-2 text-foreground/40 transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
										aria-label="Edit tech stack"
									>
										<PencilIcon className="size-3.5" />
									</button>
								</div>
								<div className="mt-4 flex flex-wrap gap-2">
									{project.techStack &&
									project.techStack.length > 0 ? (
										project.techStack.map((tech) => (
											<span
												key={tech}
												className="rounded-full border border-border/70 bg-background/60 px-3 py-1.5 text-sm text-foreground"
											>
												{tech}
											</span>
										))
									) : (
										<p className="text-sm italic text-foreground/40">
											No tech stack recorded yet.
										</p>
									)}
								</div>
							</div>
						</div>
					</div>
				</div>

				<div className="space-y-6">
					<div
						className="app-surface rounded-2xl p-6"
						data-onboarding-target="overview-pipeline"
					>
						<div className="mb-5">
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Document Pipeline
							</p>
							<h3 className="mt-2 text-xl font-semibold text-foreground">
								Planning assets and readiness
							</h3>
						</div>
						{pipelineDocs.length === 0 ? (
							<div className="rounded-2xl border border-dashed border-border/60 bg-card/40 px-4 py-8 text-center">
								<p className="text-sm font-medium text-foreground">
									No documents yet
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Generate or add planning documents to track
									readiness here.
								</p>
							</div>
						) : (
							<div className="space-y-3">
								{pipelineDocs.map((doc) => {
									const meta = getDocumentMeta(doc.type);
									const DocIcon = meta.icon;
									const statusView = getDocumentStatusView(
										doc.status,
									);
									const isComplete =
										statusView.tone === "complete";
									const isActive =
										statusView.tone === "active";

									return (
										<div
											key={doc.id}
											className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/55 px-4 py-3"
										>
											<div
												className={cn(
													"flex h-11 w-11 items-center justify-center rounded-2xl border",
													isComplete
														? meta.tileColor
														: isActive
															? "border-primary/30 bg-primary/[0.08]"
															: "border-border/60 bg-background/55",
												)}
											>
												<DocIcon
													className={cn(
														"size-4",
														isComplete
															? meta.iconColor
															: isActive
																? "text-primary"
																: "text-muted-foreground",
													)}
												/>
											</div>
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium text-foreground">
													{doc.title}
												</p>
												<p className="text-xs text-muted-foreground">
													{meta.label}
												</p>
											</div>
											<div
												className={cn(
													"rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em]",
													isComplete
														? "border-success/25 bg-success/10 text-success"
														: isActive
															? "border-primary/20 bg-primary/10 text-primary"
															: "border-border/60 bg-background/55 text-muted-foreground",
												)}
											>
												{statusView.label}
											</div>
										</div>
									);
								})}
								{hasMoreDocs && (
									<button
										type="button"
										onClick={() =>
											onNavigateToTab?.("documents")
										}
										className="w-full pt-2 text-left text-xs uppercase tracking-[0.18em] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
									>
										View more
									</button>
								)}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Edit dialogs */}
			<ProjectSectionEditDialog
				projectId={projectId}
				organizationId={organizationId}
				section={editSection}
				currentValues={currentValues}
				onClose={() => setEditSection(null)}
				onSaved={() => onProjectUpdated?.()}
			/>
		</div>
	);
}
