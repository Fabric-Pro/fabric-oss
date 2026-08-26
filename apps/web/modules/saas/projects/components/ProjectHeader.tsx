"use client";

import { useBasePath } from "@saas/organizations/hooks";
import { ProjectFavoriteToggle } from "@saas/projects/components/ProjectFavoriteToggle";
import { ProjectReadinessIndicator } from "@saas/projects/components/readiness/ProjectReadinessIndicator";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	CheckCircleIcon,
	EditIcon,
	FileTextIcon,
	FolderIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ProjectPresenceBar } from "./ProjectPresenceBar";
import { ProjectTitleInlineEdit } from "./ProjectTitleInlineEdit";

type Project = {
	id: string;
	name: string;
	description: string | null;
	status: string;
	projectTypes: string[];
	icon: string | null;
	color: string | null;
	tags: string[] | null;
	techStack: string[] | null;
	features: string[] | null;
	goals: string | null;
	heroImageUrl?: string | null;
	heroEmojis?: string[];
	/** Caller-scoped favorite state (#1694). */
	isFavorite?: boolean;
	createdAt: Date | string;
	updatedAt: Date | string;
	_count?: {
		documents: number;
		contexts: number;
	};
};

type Props = {
	project: Project;
	currentUserId?: string;
	currentTab?: string;
	organizationId?: string | null;
	canEdit?: boolean;
};

export function ProjectHeader({
	project,
	currentUserId,
	currentTab,
	organizationId,
	canEdit,
}: Props) {
	const _t = useTranslations();
	const tTooltip = useTranslations("tooltips.projectHeader");
	const router = useRouter();
	const basePath = useBasePath() || "/app";

	function handleEditProject() {
		// For DRAFT projects, omit `step` so the wizard restores the user's
		// last step from server-side wizardState. For ACTIVE projects there's
		// no wizardState and editing always starts from the Brief step.
		const target =
			project.status === "DRAFT"
				? `${basePath}/projects/new?projectId=${project.id}`
				: `${basePath}/projects/new?step=1&projectId=${project.id}`;
		router.push(target);
	}

	return (
		<section className="space-y-2.5">
			{/* Identity row: title · status · meta · actions — one compact line
			    that lets the page below breathe (replaces the tall hero card). */}
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
				<h1 className="min-w-0 text-[1.6rem] font-normal tracking-tight text-foreground/90">
					<ProjectTitleInlineEdit
						projectId={project.id}
						organizationId={organizationId}
						name={project.name}
						canEdit={canEdit ?? false}
						renderDisplay={(name) => (
							<span className="text-foreground/90">{name}</span>
						)}
						inputClassName="h-9 bg-transparent text-[1.6rem] font-normal border-primary/40"
					/>
				</h1>

				<div className="flex flex-wrap items-center gap-2">
					{/* The status badge is gone. Active said nothing — every
					    project anyone opens is active — and beside the readiness
					    indicator a green pill next to a checklist read as "you're
					    fine". Draft, Completed and Archived were kept for a while
					    on the grounds that they carry information, but a badge
					    that appears only sometimes is a worse signal than none:
					    the header now has exactly one status, and it is
					    readiness. Project status still shows on the projects
					    list, where it is what you are scanning for. */}
					<ProjectReadinessIndicator />
				</div>

				{/* Meta: documents · contexts · type chips */}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
					{project._count && (
						<>
							<span className="flex items-center gap-1.5 text-muted-foreground text-sm">
								<FileTextIcon className="size-3.5" />
								{project._count.documents} document
								{project._count.documents !== 1 ? "s" : ""}
							</span>
							<span className="flex items-center gap-1.5 text-muted-foreground text-sm">
								<FolderIcon className="size-3.5" />
								{project._count.contexts} context
								{project._count.contexts !== 1 ? "s" : ""}
							</span>
						</>
					)}
					{project.projectTypes.map((type) => (
						<span
							key={type}
							className="app-soft-badge rounded-full px-2.5 py-0.5 text-xs"
						>
							{type}
						</span>
					))}
				</div>

				{/* Presence + actions */}
				<div className="ml-auto flex items-center gap-2">
					{/* Quick-access favorite (#1694). Not gated by `canEdit` —
					    favoriting is a per-user preference, not a project edit,
					    so a viewer must be able to do it. Always visible here
					    rather than hover-revealed: this cluster has no hover
					    group and the header is not a click target. */}
					<ProjectFavoriteToggle
						projectId={project.id}
						projectName={project.name}
						isFavorite={project.isFavorite ?? false}
						variant="inline"
					/>
					{currentUserId && (
						<ProjectPresenceBar
							projectId={project.id}
							currentUserId={currentUserId}
							currentTab={currentTab}
						/>
					)}
					{project.status !== "COMPLETED" && (
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className="gap-2 border-success/25 bg-success/10 text-success hover:border-success/45 hover:bg-success/15"
								>
									<CheckCircleIcon className="size-4" />
									Mark Complete
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tTooltip("markComplete")}
							</TooltipContent>
						</Tooltip>
					)}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="outline"
								size="sm"
								onClick={handleEditProject}
								className="gap-2"
							>
								<EditIcon className="size-4" />
								Edit Project
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{tTooltip("editProject")}
						</TooltipContent>
					</Tooltip>
				</div>
			</div>

			{/* Description — single truncated line, only when present */}
			{project.description && (
				<p className="line-clamp-1 max-w-3xl text-muted-foreground text-sm">
					{project.description}
				</p>
			)}

			{/* Tags */}
			{project.tags && project.tags.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{project.tags.map((tag) => (
						<span
							key={tag}
							className="app-soft-badge rounded-full px-2.5 py-0.5 text-xs"
						>
							{tag}
						</span>
					))}
				</div>
			)}
		</section>
	);
}
