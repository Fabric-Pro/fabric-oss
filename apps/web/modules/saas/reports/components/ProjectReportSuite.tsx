"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ProjectSectionHero } from "@saas/projects/components/ProjectSectionHero";
import {
	type ProjectReportsTab,
	pickDefaultProjectReportsTab,
} from "@saas/reports/lib/project-report-suite";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { ProjectReportInstancesList } from "./ProjectReportInstancesList";
import { ProjectReportTemplatesList } from "./ProjectReportTemplatesList";

const NO_CAPABILITIES = {
	isPlatformAdmin: false,
	isOrganizationAdmin: false,
	canEditProjectReports: false,
};

function isProjectReportsTab(value: string): value is ProjectReportsTab {
	return value === "instances" || value === "templates";
}

/**
 * A project's Reports tab with the report suite on: the project's reports,
 * and the templates they start from, managed in one place.
 */
export function ProjectReportSuite({ projectId }: { projectId: string }) {
	const { basePath, organizationId } = useOrganizationContext();
	const { user } = useSession();
	const reportTemplatesPath = `${basePath}/report-templates`;
	const [chosenTab, setChosenTab] = useState<ProjectReportsTab | null>(null);
	const [showArchived, setShowArchived] = useState(false);

	const { data: capabilities } = useQuery(
		orpc.reports.capabilities.queryOptions({ input: { projectId } }),
	);
	const { data: instancesData, isError: instancesFailed } = useQuery(
		orpc.reports.instances.list.queryOptions({
			input: { organizationId, projectId, limit: 50, offset: 0 },
		}),
	);
	const { data: templatesData, isLoading: isLoadingTemplates } = useQuery(
		orpc.reports.templates.list.queryOptions({
			input: {
				organizationId,
				includeArchived: showArchived,
				limit: 100,
				offset: 0,
			},
		}),
	);
	type TemplateRow = NonNullable<typeof templatesData>["templates"][number];
	const [startingFrom, setStartingFrom] = useState<TemplateRow | null>(null);

	const instances = instancesData?.instances ?? [];
	const templates = templatesData?.templates ?? [];
	const activeInstances = instances.filter((i) => i.isActive).length;
	// The default waits for the project's report count, so the tab never
	// flashes from Templates to My Instances once the list arrives. A failed
	// count opens on Templates rather than spinning forever.
	const activeTab =
		chosenTab ??
		pickDefaultProjectReportsTab(
			instancesFailed ? 0 : instancesData?.total,
		);
	const canEdit = capabilities?.canEditProjectReports !== false;

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Project Reports"
				title="Recurring analysis, snapshots, and decision support"
				description="Start reports for this project from templates, then tune their prompts, cadence and data so project activity turns into summaries the team can revisit."
				getStartedPageId="reports"
				badges={
					<>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-wide text-muted-foreground">
							{instancesData?.total ?? 0} reports
						</div>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-wide text-muted-foreground">
							{activeInstances} active
						</div>
					</>
				}
				aside={
					<div className="flex h-full flex-col justify-between">
						<div>
							<p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
								Quick Focus
							</p>
							<p className="mt-2 text-sm text-foreground/85">
								Start from a template, then tune the prompt,
								cadence and output so reports become part of the
								project's operating rhythm instead of one-off
								exports.
							</p>
						</div>
						<Button
							data-onboarding-target="reports-browse-templates"
							className="mt-4 gap-2 self-start"
							variant="outline"
							onClick={() => setChosenTab("templates")}
						>
							<SparklesIcon className="h-4 w-4" />
							Browse templates
						</Button>
					</div>
				}
			/>

			{activeTab === null ? (
				<div className="flex justify-center py-12">
					<Spinner className="h-8 w-8" />
				</div>
			) : (
				<Tabs
					value={activeTab}
					onValueChange={(value) => {
						if (isProjectReportsTab(value)) {
							setChosenTab(value);
						}
					}}
					className="w-full"
				>
					<TabsList data-onboarding-target="reports-tabs">
						<TabsTrigger value="instances">
							My Instances
						</TabsTrigger>
						<TabsTrigger value="templates">Templates</TabsTrigger>
					</TabsList>

					<TabsContent value="instances" className="mt-4">
						<ProjectReportInstancesList
							instances={instances}
							organizationId={organizationId}
							reportTemplatesPath={reportTemplatesPath}
							onBrowseTemplates={
								canEdit
									? () => setChosenTab("templates")
									: undefined
							}
						/>
					</TabsContent>

					<TabsContent value="templates" className="mt-4">
						{isLoadingTemplates ? (
							<div className="flex justify-center py-12">
								<Spinner className="h-8 w-8" />
							</div>
						) : (
							<ProjectReportTemplatesList
								templates={templates}
								capabilities={capabilities ?? NO_CAPABILITIES}
								viewerUserId={user?.id}
								reportTemplatesPath={reportTemplatesPath}
								showArchived={showArchived}
								onShowArchivedChange={setShowArchived}
								onUseTemplate={setStartingFrom}
							/>
						)}
					</TabsContent>
				</Tabs>
			)}

			{startingFrom && (
				<CreateInstanceDialog
					template={startingFrom}
					organizationId={organizationId}
					projectId={projectId}
					basePath={reportTemplatesPath}
					onClose={() => setStartingFrom(null)}
				/>
			)}
		</div>
	);
}
