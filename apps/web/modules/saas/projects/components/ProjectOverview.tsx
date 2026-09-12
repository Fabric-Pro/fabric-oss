"use client";

import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import type { TabId } from "@saas/projects/lib/project-tabs";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	PencilIcon,
	PlusIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
	getDocumentMeta,
	getDocumentStatusView,
	getPipelineDocuments,
	isActiveDocument,
	isDocumentInFlight,
} from "../lib/document-pipeline";
import {
	type EditSection,
	ProjectSectionEditDialog,
} from "./ProjectSectionEditDialog";

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

/**
 * Small pencil that opens one section of the edit dialog. Quiet until hovered;
 * the label is for the accessibility tree.
 */
function EditButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			className="-m-1 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
		>
			<PencilIcon className="size-3.5" />
		</button>
	);
}

/** A labelled block inside a surface. Hairlines separate blocks, not boxes. */
function Block({
	label,
	action,
	children,
	className,
	...rest
}: {
	label: string;
	action?: ReactNode;
	children: ReactNode;
	className?: string;
	"data-onboarding-target"?: string;
}) {
	return (
		<div className={cn("py-4", className)} {...rest}>
			<div className="mb-2.5 flex items-center justify-between gap-3">
				<p className="text-sm font-medium text-foreground">{label}</p>
				{action}
			</div>
			{children}
		</div>
	);
}

/**
 * Chips with a cap. Past the cap a "+N more" chip expands the list; the same
 * information, a third of the height of a bulleted list.
 */
function Chips({
	items,
	empty,
	limit = 8,
}: {
	items: string[];
	empty: string;
	limit?: number;
}) {
	const [expanded, setExpanded] = useState(false);
	if (items.length === 0) {
		return <p className="text-sm text-muted-foreground/70">{empty}</p>;
	}
	const shown = expanded ? items : items.slice(0, limit);
	const hidden = items.length - shown.length;
	return (
		<div className="flex flex-wrap gap-1.5">
			{shown.map((item, index) => (
				<span
					key={`${item}-${index}`}
					className="app-soft-badge rounded-full px-2.5 py-1 text-xs text-foreground/80"
				>
					{item}
				</span>
			))}
			{hidden > 0 || expanded ? (
				<button
					type="button"
					onClick={() => setExpanded((open) => !open)}
					className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					{expanded ? "Show fewer" : `+${hidden} more`}
				</button>
			) : null}
		</div>
	);
}

/** Per-project memory for the About section's open state. */
function aboutStorageKey(projectId: string) {
	return `fabric-project-about-open-${projectId}`;
}

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

	// The brief, goals, features and stack were gathered once, at creation.
	// Once the project has documents it has moved past that moment, and this
	// detail folds up by default; the viewer's own choice, once made, wins.
	// Read after mount so the server and first client render agree.
	const [aboutOpen, setAboutOpen] = useState(activeDocs.length === 0);
	useEffect(() => {
		try {
			const stored = window.localStorage.getItem(
				aboutStorageKey(project.id),
			);
			if (stored === "1" || stored === "0") {
				setAboutOpen(stored === "1");
			}
		} catch {
			// Storage can be unavailable; the default stands.
		}
	}, [project.id]);
	const toggleAbout = () => {
		setAboutOpen((open) => {
			try {
				window.localStorage.setItem(
					aboutStorageKey(project.id),
					open ? "0" : "1",
				);
			} catch {
				// Storage can be unavailable; the toggle still works for now.
			}
			return !open;
		});
	};

	// Document Pipeline: derive cards from the project's actual documents,
	// stably ordered and capped so the section never overflows.
	const { visible: pipelineDocs, hasMore: hasMoreDocs } =
		getPipelineDocuments(project.documents);

	// Count documents by status
	const completedDocs = activeDocs.filter(
		(doc) => doc.status === "COMPLETE",
	).length;
	/*
	 * One "Active" count rather than two summed at the point of display. It has
	 * to include QUEUED: a document whose generation has been accepted and is
	 * waiting on the project's own context work is neither ready nor untouched,
	 * and counting it under "Open" said the run had never been requested.
	 */
	const inFlightDocs = activeDocs.filter((doc) =>
		isDocumentInFlight(doc.status),
	).length;

	// Total strictly matches the number of active documents
	const totalDocs = activeDocs.length > 0 ? activeDocs.length : 1;
	const coveragePercent = Math.round((completedDocs / totalDocs) * 100);

	// The four counts the AI works from. Said once, here — the header already
	// carries documents and contexts, so this row is the only other place.
	const metrics = [
		{
			label: "Documents ready",
			value: `${completedDocs}/${totalDocs}`,
		},
		{ label: "Tech stack", value: project.techStack?.length || 0 },
		{ label: "Features", value: project.features?.length || 0 },
		{ label: "Context", value: project._count?.contexts || 0 },
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
			{/* Status band: what the project has to work with, in one surface,
			    with the pipeline beside it. Coverage, the four counts and the
			    document list used to sit in a hero, an aside, four icon cards
			    and a column; they now share two panels above the fold. */}
			<div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.9fr)]">
				<section
					data-onboarding-target="overview-readiness"
					className="app-surface rounded-xl px-5 py-4 sm:px-6"
				>
					<div className="flex items-center gap-1.5">
						<p className="app-editorial-label">Document coverage</p>
						<PageTourButton pageId="overview" />
					</div>
					<div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<p className="text-2xl tabular-nums text-foreground">
							{coveragePercent}%
						</p>
						<p className="text-sm text-muted-foreground">
							{completedDocs === totalDocs
								? "Core planning documents are complete. The AI and the Pipeline have enough to build from."
								: `${completedDocs} of ${totalDocs} core planning documents complete, ${inFlightDocs} in progress.`}
						</p>
					</div>
					<div
						role="progressbar"
						aria-label="Document coverage"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={coveragePercent}
						className="mt-3 h-1 overflow-hidden rounded-full bg-muted"
					>
						<div
							className="h-full rounded-full bg-foreground"
							style={{ width: `${coveragePercent}%` }}
						/>
					</div>
					{/* The four counts the AI works from, on the same surface. */}
					<dl
						data-onboarding-target="overview-metrics"
						className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-4"
					>
						{metrics.map((metric) => (
							<div key={metric.label}>
								<dd className="text-lg tabular-nums text-foreground">
									{metric.value}
								</dd>
								<dt className="text-xs text-muted-foreground">
									{metric.label}
								</dt>
							</div>
						))}
					</dl>
				</section>

				{/* Document pipeline */}
				<section
					className="app-surface rounded-xl px-5 py-5 sm:px-6"
					data-onboarding-target="overview-pipeline"
				>
					<p className="app-editorial-label mb-4">
						Document pipeline
					</p>
					{pipelineDocs.length === 0 ? (
						<div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
							<p className="text-sm font-medium text-foreground">
								No documents yet
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								Generate or add planning documents to track
								readiness here.
							</p>
						</div>
					) : (
						<ul className="divide-y divide-border">
							{pipelineDocs.map((doc) => {
								const meta = getDocumentMeta(doc.type);
								const DocIcon = meta.icon;
								const statusView = getDocumentStatusView(
									doc.status,
								);
								const isComplete =
									statusView.tone === "complete";
								const isActive = statusView.tone === "active";

								return (
									<li
										key={doc.id}
										className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
									>
										<div
											className={cn(
												"flex size-8 shrink-0 items-center justify-center rounded-lg border",
												isComplete
													? meta.tileColor
													: "border-border bg-muted",
											)}
										>
											<DocIcon
												className={cn(
													"size-4",
													isComplete
														? meta.iconColor
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
										<span
											className={cn(
												"shrink-0 text-xs",
												isComplete
													? "text-success"
													: isActive
														? "text-foreground"
														: "text-muted-foreground",
											)}
										>
											{statusView.label}
										</span>
									</li>
								);
							})}
						</ul>
					)}
					{hasMoreDocs && (
						<button
							type="button"
							onClick={() => onNavigateToTab?.("documents")}
							className="mt-4 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
						>
							View more
						</button>
					)}
				</section>
			</div>

			{/* About this project: the facts gathered at creation. A summary
			    row is always on screen; the detail opens on demand and the
			    choice is remembered per project. */}
			<section className="app-surface rounded-xl">
				<div className="flex items-start gap-3 px-5 py-4 sm:px-6">
					<button
						type="button"
						onClick={toggleAbout}
						aria-expanded={aboutOpen}
						aria-controls="project-about-detail"
						className="flex min-w-0 flex-1 flex-col gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
					>
						<span className="flex items-center gap-2">
							<span className="app-editorial-label">
								About this project
							</span>
							<ChevronDownIcon
								aria-hidden="true"
								className={cn(
									"size-3.5 text-muted-foreground transition-transform",
									aboutOpen && "rotate-180",
								)}
							/>
						</span>
						<span
							className={cn(
								"text-sm leading-6 text-foreground/85",
								!aboutOpen && "line-clamp-1",
								!project.description &&
									"text-muted-foreground/70",
							)}
						>
							{project.description || "No description yet."}
						</span>
					</button>
					<EditButton
						label="Edit project brief"
						onClick={() => setEditSection("description")}
					/>
				</div>
				{!aboutOpen ? (
					<div className="flex flex-wrap items-center gap-1.5 border-t border-border px-5 py-3 sm:px-6">
						{project.projectTypes.map((type) => (
							<span
								key={type}
								className="app-soft-badge rounded-full px-2.5 py-1 text-xs text-foreground/80"
							>
								{type}
							</span>
						))}
						{/* These two carry the onboarding anchors while the
						    detail is folded, so a "Show me" still lands on the
						    right fact and opening it takes one click. */}
						<button
							type="button"
							onClick={toggleAbout}
							data-onboarding-target="overview-tech-stack"
							className="rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							{project.techStack?.length || 0} technologies
						</button>
						<span
							aria-hidden="true"
							className="text-muted-foreground/50"
						>
							·
						</span>
						<button
							type="button"
							onClick={toggleAbout}
							data-onboarding-target="overview-feature-snapshot"
							className="rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							{project.features?.length || 0} features
						</button>
						{!project.goals ? (
							<>
								<span
									aria-hidden="true"
									className="text-muted-foreground/50"
								>
									·
								</span>
								<button
									type="button"
									onClick={() => setEditSection("goals")}
									className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
								>
									<PlusIcon className="size-3" />
									Add goals
								</button>
							</>
						) : null}
					</div>
				) : (
					<div
						id="project-about-detail"
						className="divide-y divide-border border-t border-border px-5 sm:px-6"
					>
						{project.description &&
						project.description.length > 220 ? (
							<div className="py-3">
								<button
									type="button"
									onClick={() =>
										setIsDescriptionExpanded(
											!isDescriptionExpanded,
										)
									}
									className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
								>
									{isDescriptionExpanded ? (
										<>
											<ChevronUpIcon className="size-4" />
											Show less of the description
										</>
									) : (
										<>
											<ChevronDownIcon className="size-4" />
											Show the full description
										</>
									)}
								</button>
								{isDescriptionExpanded ? (
									<p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-foreground/85">
										{project.description}
									</p>
								) : null}
							</div>
						) : null}

						<Block
							label="Goals"
							action={
								<EditButton
									label="Edit goals"
									onClick={() => setEditSection("goals")}
								/>
							}
						>
							{project.goals ? (
								<p className="text-sm leading-6 text-foreground/85">
									{project.goals}
								</p>
							) : (
								<button
									type="button"
									onClick={() => setEditSection("goals")}
									className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
								>
									<PlusIcon className="size-3.5" />
									Add goals to anchor the delivery outcome
								</button>
							)}
						</Block>

						<Block
							label="Features"
							data-onboarding-target="overview-feature-snapshot"
							action={
								<EditButton
									label="Edit features"
									onClick={() => setEditSection("features")}
								/>
							}
						>
							<Chips
								items={project.features ?? []}
								empty="No features planned yet."
								limit={6}
							/>
						</Block>

						<div className="grid gap-x-8 sm:grid-cols-[200px_minmax(0,1fr)]">
							<Block
								label="Project types"
								action={
									<EditButton
										label="Edit project types"
										onClick={() => setEditSection("types")}
									/>
								}
							>
								<Chips
									items={project.projectTypes}
									empty="No project types selected yet."
								/>
							</Block>
							<Block
								label="Tech stack"
								className="border-t border-border sm:border-t-0"
								data-onboarding-target="overview-tech-stack"
								action={
									<EditButton
										label="Edit tech stack"
										onClick={() =>
											setEditSection("techStack")
										}
									/>
								}
							>
								<Chips
									items={project.techStack ?? []}
									empty="No tech stack recorded yet."
								/>
							</Block>
						</div>
					</div>
				)}
			</section>

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
