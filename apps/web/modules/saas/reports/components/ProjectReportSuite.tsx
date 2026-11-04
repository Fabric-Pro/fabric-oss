"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { ProjectSectionHero } from "@saas/projects/components/ProjectSectionHero";
import {
	type ProjectReportsTab,
	pickDefaultProjectReportsTab,
} from "@saas/reports/lib/project-report-suite";
import { Pagination } from "@saas/shared/components/Pagination";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { cn } from "@ui/lib";
import { SparklesIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { ProjectReportInstancesList } from "./ProjectReportInstancesList";
import { ProjectReportTemplatesList } from "./ProjectReportTemplatesList";

const REPORTS_PER_PAGE = 20;

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
	const [reportsPage, setReportsPage] = useState(1);
	const reportsTopRef = useRef<HTMLDivElement>(null);

	const { data: capabilities } = useQuery(
		orpc.reports.capabilities.queryOptions({ input: { projectId } }),
	);
	const {
		data: instancesData,
		isError: instancesFailed,
		isPlaceholderData: isPreviousReportsPage,
	} = useQuery({
		...orpc.reports.instances.list.queryOptions({
			input: {
				organizationId,
				projectId,
				limit: REPORTS_PER_PAGE,
				offset: (reportsPage - 1) * REPORTS_PER_PAGE,
				countActive: true,
			},
		}),
		placeholderData: keepPreviousData,
	});
	const { data: templatesData, isLoading: isLoadingTemplates } = useQuery(
		orpc.reports.templates.list.queryOptions({
			input: {
				organizationId,
				// The list hides archived templates until asked, and offers
				// to show them only to someone who may restore one.
				includeArchived: true,
				limit: 100,
				offset: 0,
			},
		}),
	);
	type TemplateRow = NonNullable<typeof templatesData>["templates"][number];
	const [startingFrom, setStartingFrom] = useState<TemplateRow | null>(null);

	const instances = instancesData?.instances ?? [];
	const templates = templatesData?.templates ?? [];
	const reportsTotal = instancesData?.total ?? 0;
	const lastReportsPage = Math.max(
		1,
		Math.ceil(reportsTotal / REPORTS_PER_PAGE),
	);
	// A deleted report can leave the current page past the end.
	useEffect(() => {
		if (
			instancesData &&
			!isPreviousReportsPage &&
			reportsPage > lastReportsPage
		) {
			setReportsPage(lastReportsPage);
		}
	}, [instancesData, isPreviousReportsPage, reportsPage, lastReportsPage]);
	// The default waits for the project's report count, so the tab never
	// flashes from Templates to Reports once the list arrives. A failed
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
							{reportsTotal}{" "}
							{reportsTotal === 1 ? "report" : "reports"}
						</div>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-wide text-muted-foreground">
							{instancesData?.activeTotal ?? 0} active
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
						<TabsTrigger value="instances">Reports</TabsTrigger>
						<TabsTrigger value="templates">Templates</TabsTrigger>
					</TabsList>

					<TabsContent value="instances" className="mt-4">
						{/* The previous page stays on screen, dimmed, until the next one arrives. */}
						<div
							ref={reportsTopRef}
							aria-busy={isPreviousReportsPage || undefined}
							className={cn(
								"scroll-mt-4 motion-safe:transition-opacity",
								isPreviousReportsPage && "opacity-60",
							)}
						>
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
						</div>
						{reportsTotal > REPORTS_PER_PAGE && (
							<Pagination
								className="mt-4"
								totalItems={reportsTotal}
								itemsPerPage={REPORTS_PER_PAGE}
								currentPage={reportsPage}
								onChangeCurrentPage={(page) => {
									setReportsPage(page);
									reportsTopRef.current?.scrollIntoView({
										block: "start",
									});
								}}
								navigationLabel="Project reports pages"
							/>
						)}
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
								projectId={projectId}
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
