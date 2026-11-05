"use client";

import { useDialogFocusReturn } from "@saas/reports/hooks/use-dialog-focus-return";
import {
	canCreateReportTemplate,
	canManageReportTemplate,
	listedReportTemplates,
	type ReportSuiteCapabilities,
	type ReportTemplateScope,
	withProjectContext,
} from "@saas/reports/lib/project-report-suite";
import {
	isUnprovenCatalogTemplate,
	reportTemplatePublishTargets,
} from "@saas/reports/lib/report-template-publishing";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	EyeIcon,
	FileTextIcon,
	Loader2Icon,
	PencilIcon,
	PlusIcon,
	Share2Icon,
	SlidersHorizontalIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	PUBLISH_ACTION_LABEL,
	PublishReportTemplateDialog,
	type PublishReportTemplateRequest,
} from "./PublishReportTemplateDialog";
import { ReportTemplateDefaultsDialog } from "./ReportTemplateDefaultsDialog";
import { ReportTemplatePreview } from "./ReportTemplatePreview";
import { TemplatePromptPreview } from "./TemplatePromptPreview";

export type ProjectReportTemplate = {
	id: string;
	name: string;
	description: string | null;
	heroEmojis: string[];
	category: string | null;
	tags: string[];
	scope: ReportTemplateScope;
	userId: string | null;
	organizationId: string | null;
	archivedAt: Date | string | null;
	isPublic: boolean;
	isGeneric: boolean;
	/** A report made from it has completed, in any organization. */
	proven: boolean;
	/** Holds its AI task prompts, shown in the preview. */
	definition?: unknown;
	/** Holds its system prompt, shown in the preview. */
	fabricConfig?: unknown;
};

const SCOPE_LABEL: Record<ReportTemplateScope, string> = {
	SYSTEM: "System",
	ORGANIZATION: "Organization",
	USER: "Only me",
};

type Props<T extends ProjectReportTemplate> = {
	templates: T[];
	capabilities: ReportSuiteCapabilities;
	/** False until the viewer's role has loaded: nothing is said about it yet. */
	capabilitiesKnown: boolean;
	viewerUserId: string | undefined;
	/** Where template pages live (`…/report-templates`). */
	reportTemplatesPath: string;
	/** Template pages opened from here lead back to this project. */
	projectId: string;
	organizationId: string | null;
	showArchived: boolean;
	onShowArchivedChange: (show: boolean) => void;
	/** Platform admins list the templates the catalog leaves out too. */
	showUnproven: boolean;
	onShowUnprovenChange: (show: boolean) => void;
	/** "Generate report": one click when nothing is missing, otherwise the dialog. */
	onGenerate: (template: T) => void;
	/** The template a one-click generation is running for. */
	generatingTemplateId: string | null;
};

/**
 * The templates a project can start a report from, with the controls the
 * viewer's role allows: anyone who may read them previews one, anyone who may
 * edit the project's reports generates one, and template owners (platform admins for System templates, organization
 * admins for Organization templates) edit, archive and restore them.
 */
export function ProjectReportTemplatesList<T extends ProjectReportTemplate>({
	templates,
	capabilities,
	capabilitiesKnown,
	viewerUserId,
	reportTemplatesPath,
	projectId,
	organizationId,
	showArchived,
	onShowArchivedChange,
	showUnproven,
	onShowUnprovenChange,
	onGenerate,
	generatingTemplateId,
}: Props<T>) {
	const queryClient = useQueryClient();
	const canStartReports = capabilities.canEditProjectReports !== false;
	const { templates: listedTemplates, hasRestorable } = listedReportTemplates(
		templates,
		capabilities,
		viewerUserId,
		showArchived,
	);

	const invalidateTemplates = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.reports.templates.list.key(),
		});
	const archiveMutation = useMutation(
		orpc.reports.templates.archive.mutationOptions({
			onSuccess: () => {
				toast.success("Template archived");
				invalidateTemplates();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to archive the template");
			},
		}),
	);
	const unarchiveMutation = useMutation(
		orpc.reports.templates.unarchive.mutationOptions({
			onSuccess: () => {
				toast.success("Template restored");
				invalidateTemplates();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to restore the template");
			},
		}),
	);
	const isChanging = archiveMutation.isPending || unarchiveMutation.isPending;
	// Project editors set this project's defaults, organization admins the
	// organization's; the dialog offers each only what the API allows.
	const canSetDefaults =
		canStartReports ||
		capabilities.canSetProjectDefaults === true ||
		capabilities.isOrganizationAdmin;
	const [defaultsFor, setDefaultsFor] = useState<T | null>(null);
	const [previewing, setPreviewing] = useState<T | null>(null);
	const [publishing, setPublishing] =
		useState<PublishReportTemplateRequest | null>(null);
	const previewFocusReturn = useDialogFocusReturn();
	const isGenerating = generatingTemplateId !== null;
	const generatingName = templates.find(
		(template) => template.id === generatingTemplateId,
	)?.name;

	return (
		<div className="space-y-4">
			<p role="status" className="sr-only">
				{generatingName
					? `Generating a report: ${generatingName}.`
					: ""}
			</p>
			<div className="flex flex-wrap items-center justify-between gap-3">
				{capabilities.isPlatformAdmin && (
					<div className="flex items-center gap-2">
						<Switch
							id="report-templates-show-unproven"
							checked={showUnproven}
							onCheckedChange={onShowUnprovenChange}
						/>
						<Label
							htmlFor="report-templates-show-unproven"
							className="text-sm text-muted-foreground"
						>
							Show all templates
						</Label>
					</div>
				)}
				{hasRestorable && (
					<div className="flex items-center gap-2">
						<Switch
							id="report-templates-show-archived"
							checked={showArchived}
							onCheckedChange={onShowArchivedChange}
						/>
						<Label
							htmlFor="report-templates-show-archived"
							className="text-sm text-muted-foreground"
						>
							Show archived templates
						</Label>
					</div>
				)}
				{canCreateReportTemplate(capabilities) && (
					<Button asChild size="sm" className="ml-auto">
						<Link
							href={withProjectContext(
								`${reportTemplatesPath}/new`,
								projectId,
							)}
						>
							<PlusIcon className="mr-1 h-4 w-4" />
							New template
						</Link>
					</Button>
				)}
			</div>

			{capabilitiesKnown &&
				capabilities.canEditProjectReports === false && (
					<p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
						{capabilities.canSetProjectDefaults === true
							? "Viewing only: your organization role cannot add reports to projects, whatever your role on this one. You can preview any template here."
							: "Viewing only: generating a report from a template needs the Editor role on this project. You can preview any template here."}
					</p>
				)}

			{listedTemplates.length === 0 ? (
				<div className="py-12 text-center">
					<FileTextIcon
						aria-hidden="true"
						className="mx-auto h-12 w-12 text-muted-foreground"
					/>
					<h3 className="mt-4 text-lg font-semibold">
						No templates available
					</h3>
					<p className="text-muted-foreground">
						System and organization templates will appear here.
					</p>
				</div>
			) : (
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					{listedTemplates.map((template) => {
						const archived = Boolean(template.archivedAt);
						const canManage = canManageReportTemplate(
							template,
							capabilities,
							viewerUserId,
						);
						const publishTargets = reportTemplatePublishTargets(
							template,
							capabilities,
							viewerUserId,
						);
						return (
							<Card
								key={template.id}
								className={archived ? "opacity-75" : undefined}
							>
								<CardHeader className="pb-2">
									<div className="flex items-start gap-3">
										<div
											aria-hidden="true"
											className="text-3xl"
										>
											{template.heroEmojis[0] || "📊"}
										</div>
										<div className="min-w-0 flex-1">
											<CardTitle className="text-base">
												{template.name}
											</CardTitle>
											<div className="mt-1 flex flex-wrap items-center gap-2">
												<Badge
													variant="outline"
													className="text-xs"
												>
													{
														SCOPE_LABEL[
															template.scope
														]
													}
												</Badge>
												{archived && (
													<Badge
														variant="secondary"
														className="text-xs"
													>
														Archived
													</Badge>
												)}
												{showUnproven &&
													isUnprovenCatalogTemplate(
														template,
													) && (
														<Badge
															variant="outline"
															className="text-xs text-muted-foreground"
														>
															Not yet proven
														</Badge>
													)}
												{template.category && (
													<Badge
														variant="secondary"
														className="text-xs"
													>
														{template.category}
													</Badge>
												)}
												{template.tags
													.slice(0, 2)
													.map((tag) => (
														<Badge
															key={tag}
															variant="outline"
															className="text-xs"
														>
															{tag}
														</Badge>
													))}
											</div>
										</div>
									</div>
								</CardHeader>
								<CardContent>
									<p className="line-clamp-2 text-sm text-muted-foreground">
										{template.description}
									</p>
								</CardContent>
								<CardFooter className="flex flex-wrap gap-2 pt-0">
									{canStartReports && !archived && (
										<Button
											size="sm"
											variant="outline"
											// Not `disabled`: that would drop focus from the
											// button just pressed.
											aria-disabled={
												isGenerating || undefined
											}
											className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
											onClick={() => {
												if (!isGenerating) {
													onGenerate(template);
												}
											}}
										>
											{generatingTemplateId ===
											template.id ? (
												<>
													<Loader2Icon
														aria-hidden="true"
														className="mr-2 h-4 w-4 motion-safe:animate-spin"
													/>
													Generating...
												</>
											) : (
												<>
													<SparklesIcon
														aria-hidden="true"
														className="mr-2 h-4 w-4"
													/>
													Generate report
												</>
											)}
										</Button>
									)}
									<Button
										size="sm"
										variant="ghost"
										// A dialog opening over a slow generation would stack
										// with the one its answer can open.
										disabled={isGenerating}
										onClick={() => setPreviewing(template)}
									>
										<EyeIcon
											aria-hidden="true"
											className="mr-2 h-4 w-4"
										/>
										Preview
									</Button>
									{canSetDefaults && !archived && (
										<Button
											size="sm"
											variant="ghost"
											disabled={isGenerating}
											onClick={() =>
												setDefaultsFor(template)
											}
										>
											<SlidersHorizontalIcon className="mr-2 h-4 w-4" />
											Defaults
										</Button>
									)}
									{canManage && (
										<Button
											size="sm"
											variant="ghost"
											asChild
										>
											<Link
												href={withProjectContext(
													`${reportTemplatesPath}/${template.id}`,
													projectId,
												)}
											>
												<PencilIcon className="mr-2 h-4 w-4" />
												Edit
											</Link>
										</Button>
									)}
									{canManage && (
										<Button
											size="sm"
											variant="ghost"
											disabled={isChanging}
											onClick={() =>
												archived
													? unarchiveMutation.mutate({
															id: template.id,
														})
													: archiveMutation.mutate({
															id: template.id,
														})
											}
										>
											{archived ? (
												<ArchiveRestoreIcon className="mr-2 h-4 w-4" />
											) : (
												<ArchiveIcon className="mr-2 h-4 w-4" />
											)}
											{archived ? "Restore" : "Archive"}
										</Button>
									)}
									{publishTargets.map((target) => (
										<Button
											key={target}
											size="sm"
											variant="ghost"
											onClick={() =>
												setPublishing({
													template,
													target,
												})
											}
										>
											<Share2Icon className="mr-2 h-4 w-4" />
											{PUBLISH_ACTION_LABEL[target]}
										</Button>
									))}
								</CardFooter>
							</Card>
						);
					})}
				</div>
			)}
			{previewing && (
				<Dialog open onOpenChange={() => setPreviewing(null)}>
					<DialogContent
						className="max-h-[90vh] max-w-2xl overflow-y-auto"
						{...previewFocusReturn}
					>
						<DialogHeader>
							<DialogTitle>
								Preview: {previewing.name}
							</DialogTitle>
							<DialogDescription>
								The latest report made from this template in
								this project, or a sample labelled as sample
								data.
							</DialogDescription>
						</DialogHeader>
						<ReportTemplatePreview
							templateId={previewing.id}
							projectId={projectId}
							organizationId={organizationId}
						/>
						<TemplatePromptPreview
							definition={previewing.definition}
							fabricConfig={previewing.fabricConfig}
						/>
					</DialogContent>
				</Dialog>
			)}
			{defaultsFor && (
				<ReportTemplateDefaultsDialog
					template={defaultsFor}
					projectId={projectId}
					onClose={() => setDefaultsFor(null)}
				/>
			)}
			<PublishReportTemplateDialog
				request={publishing}
				onClose={() => setPublishing(null)}
			/>
		</div>
	);
}
