"use client";

import {
	canCreateReportTemplate,
	canManageReportTemplate,
	listedReportTemplates,
	type ReportSuiteCapabilities,
	type ReportTemplateScope,
	withProjectContext,
} from "@saas/reports/lib/project-report-suite";
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
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	FileTextIcon,
	PencilIcon,
	PlusIcon,
	SlidersHorizontalIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { ReportTemplateDefaultsDialog } from "./ReportTemplateDefaultsDialog";

export type ProjectReportTemplate = {
	id: string;
	name: string;
	description: string | null;
	heroEmojis: string[];
	category: string | null;
	tags: string[];
	scope: ReportTemplateScope;
	userId: string | null;
	archivedAt: Date | string | null;
};

const SCOPE_LABEL: Record<ReportTemplateScope, string> = {
	SYSTEM: "System",
	ORGANIZATION: "Organization",
	USER: "Personal",
};

type Props<T extends ProjectReportTemplate> = {
	templates: T[];
	capabilities: ReportSuiteCapabilities;
	viewerUserId: string | undefined;
	/** Where template pages live (`…/report-templates`). */
	reportTemplatesPath: string;
	/** Template pages opened from here lead back to this project. */
	projectId: string;
	showArchived: boolean;
	onShowArchivedChange: (show: boolean) => void;
	onUseTemplate: (template: T) => void;
};

/**
 * The templates a project can start a report from, with the controls the
 * viewer's role allows: anyone who may edit the project's reports starts one,
 * and template owners (platform admins for System templates, organization
 * admins for Organization templates) edit, archive and restore them.
 */
export function ProjectReportTemplatesList<T extends ProjectReportTemplate>({
	templates,
	capabilities,
	viewerUserId,
	reportTemplatesPath,
	projectId,
	showArchived,
	onShowArchivedChange,
	onUseTemplate,
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
	const canSetDefaults = canStartReports || capabilities.isOrganizationAdmin;
	const [defaultsFor, setDefaultsFor] = useState<T | null>(null);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
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
											onClick={() =>
												onUseTemplate(template)
											}
										>
											<SparklesIcon className="mr-2 h-4 w-4" />
											Use template
										</Button>
									)}
									{canSetDefaults && !archived && (
										<Button
											size="sm"
											variant="ghost"
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
								</CardFooter>
							</Card>
						);
					})}
				</div>
			)}
			{defaultsFor && (
				<ReportTemplateDefaultsDialog
					template={defaultsFor}
					projectId={projectId}
					onClose={() => setDefaultsFor(null)}
				/>
			)}
		</div>
	);
}
