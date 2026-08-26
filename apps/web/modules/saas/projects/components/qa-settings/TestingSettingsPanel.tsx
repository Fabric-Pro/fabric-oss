"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import {
	GitPullRequestArrowIcon,
	GlobeIcon,
	InfoIcon,
	LayersIcon,
	type LucideIcon,
	MonitorSmartphoneIcon,
	RefreshCwIcon,
	ScrollTextIcon,
	SparklesIcon,
	TargetIcon,
	UserCheckIcon,
	UserSearchIcon,
} from "lucide-react";
import { useState } from "react";
import { ProjectEnvironmentsSettings } from "./ProjectEnvironmentsSettings";
import { ProjectQaSettingsForm } from "./ProjectQaSettingsForm";
import { ProjectTestCaseGenerationSettings } from "./ProjectTestCaseGenerationSettings";
import { QaCiSetupSection } from "./QaCiSetupSection";
import { QaPipelineSourcesSettings } from "./QaPipelineSourcesSettings";
import { QaWebhookSettings } from "./QaWebhookSettings";
import {
	STRATEGY_DEPTH_INFO,
	type StrategyDepth,
} from "./qa-settings-constants";
import {
	DEFAULT_TESTING_SECTION,
	TESTING_SECTIONS,
	type TestingSectionId,
} from "./testing-sections";

/** Icon per section — kept here so `testing-sections.ts` stays React-free. */
const SECTION_ICON: Record<TestingSectionId, LucideIcon> = {
	generation: SparklesIcon,
	depth: LayersIcon,
	coverage: TargetIcon,
	reviewLenses: GitPullRequestArrowIcon,
	environments: GlobeIcon,
	devices: MonitorSmartphoneIcon,
	rules: ScrollTextIcon,
	sync: RefreshCwIcon,
	signOff: UserCheckIcon,
	sceptics: UserSearchIcon,
};

type Props = {
	/**
	 * The generation toggles write project columns, so that section needs the
	 * project row rather than just its id — everything else is keyed by id.
	 */
	project: {
		id: string;
		organizationId?: string | null;
		generateManualTestCases?: boolean | null;
		applyTddApproach?: boolean | null;
		autoCreateBugsFromFailures?: boolean | null;
	};
	canEdit: boolean;
};

/**
 * Settings ▸ Testing.
 *
 * One section on screen at a time, chosen from a rail beside it. The page
 * previously stacked all nine into a single column: every control was reachable
 * and almost none was findable, and the sticky save bar could report an unsaved
 * change two thousand pixels above where the reader was looking.
 *
 * `ProjectQaSettingsForm` is rendered in a fixed position and handed the active
 * section, rather than being mounted per section. That is deliberate — it holds
 * ONE draft covering seven of the nine sections, and remounting it on every
 * section change would throw away unsaved edits the moment someone looked at a
 * neighbouring section.
 */
export function TestingSettingsPanel({ project, canEdit }: Props) {
	const projectId = project.id;
	const [section, setSection] = useState<TestingSectionId>(
		DEFAULT_TESTING_SECTION,
	);
	const active =
		TESTING_SECTIONS.find((s) => s.id === section) ?? TESTING_SECTIONS[0];

	// Read-only, and only for the policy summary below the rail — so the whole
	// current policy reads at a glance without opening nine sections.
	const { data: settings } = useQuery({
		...orpc.projects.qaSettings.get.queryOptions({ input: { projectId } }),
		staleTime: 60_000,
	});

	return (
		<div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)]">
			<div className="min-w-0">
				<div className="lg:sticky lg:top-4 lg:space-y-3">
					<nav
						aria-label="Testing settings sections"
						// Wraps on narrow screens; a rail on wide ones. It was a
						// horizontal scroll strip, which hid four of the nine
						// sections off the right edge on a phone with nothing on
						// screen saying they were there — a reader could stop at
						// what fit and never find "Rules & evidence". Wrapping
						// costs two rows and hides nothing.
						className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap"
					>
						{TESTING_SECTIONS.map((s) => {
							const Icon = SECTION_ICON[s.id];
							const isActive = s.id === section;
							return (
								<button
									key={s.id}
									type="button"
									aria-current={isActive ? "true" : undefined}
									onClick={() => setSection(s.id)}
									className={cn(
										"inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:w-full",
										isActive
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
									)}
								>
									<Icon
										aria-hidden="true"
										className="size-4 shrink-0"
									/>
									<span className="truncate">{s.label}</span>
								</button>
							);
						})}
					</nav>

					{settings && (
						<div className="hidden rounded-lg border bg-card p-3 lg:block">
							<p className="app-editorial-label">
								Current policy
							</p>
							<p className="mt-2 text-muted-foreground text-xs leading-relaxed">
								Depth{" "}
								<b className="font-semibold text-foreground">
									{STRATEGY_DEPTH_INFO[
										settings.strategyDepth as StrategyDepth
									]?.label ?? settings.strategyDepth}
								</b>{" "}
								· confidence{" "}
								<b className="font-semibold text-foreground">
									{settings.confidenceThreshold}%
								</b>
								{settings.indexCoverageEnabled && (
									<>
										{" "}
										· target{" "}
										<b className="font-semibold text-foreground">
											{settings.coverageTarget}%
										</b>
									</>
								)}{" "}
								·{" "}
								<b className="font-semibold text-foreground">
									{settings.scepticRolesEnabled
										? settings.scepticRoles.length
										: 0}
								</b>{" "}
								sceptic roles ·{" "}
								{settings.pipelineSyncEnabled ? (
									<>
										sync every{" "}
										<b className="font-semibold text-foreground">
											{
												settings.pipelineSyncIntervalMinutes
											}{" "}
											min
										</b>
									</>
								) : (
									<b className="font-semibold text-foreground">
										sync off
									</b>
								)}
							</p>
						</div>
					)}
				</div>
			</div>

			<div className="min-w-0 space-y-5 pb-4">
				<div>
					<div className="flex items-center gap-1.5">
						<h3 className="font-serif text-2xl font-normal">
							{active.title}
						</h3>
						<SectionAbout
							title={active.title}
							blurb={active.blurb}
						/>
					</div>
					<p className="mt-1 max-w-2xl text-muted-foreground text-sm leading-relaxed">
						{active.blurb}
					</p>
				</div>

				{section === "generation" && (
					<ProjectTestCaseGenerationSettings
						project={project}
						canEdit={canEdit}
					/>
				)}

				{section === "environments" && (
					<ProjectEnvironmentsSettings
						projectId={projectId}
						canEdit={canEdit}
					/>
				)}

				{section === "sync" && (
					<>
						<QaPipelineSourcesSettings
							projectId={projectId}
							canEdit={canEdit}
						/>
						{/* Answers the question a team hits immediately after
						    choosing WHICH branch Fabric reads — "my pipeline
						    publishes nothing to read". Not gated on canEdit: it
						    generates text and changes nothing, so a viewer who
						    has to hand it to an admin can still get it. */}
						<QaCiSetupSection projectId={projectId} />
						<QaWebhookSettings
							projectId={projectId}
							canEdit={canEdit}
						/>
					</>
				)}

				{/*
				 * Always rendered, in a fixed position, so its single draft
				 * survives section changes. It decides internally which of its
				 * seven sections to show — and renders nothing at all for the
				 * two that are entirely other components.
				 */}
				<ProjectQaSettingsForm
					projectId={projectId}
					canEdit={canEdit}
					section={section}
					// "Manage environments" now has somewhere nearer to go: the
					// Environments section of this same page, rather than the
					// separate top-level settings tab it used to jump to.
					onManageEnvironments={() => setSection("environments")}
				/>
			</div>
		</div>
	);
}

/**
 * The section's own "what is this for", where the question is asked.
 *
 * The blurb is already on screen; this repeats it in a popover so the pattern
 * matches the Testing tab's per-section About, and so the copy has one home when
 * the blurb is truncated on a narrow screen.
 */
function SectionAbout({ title, blurb }: { title: string; blurb: string }) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7 shrink-0 text-muted-foreground"
					aria-label={`About ${title}`}
				>
					<InfoIcon className="size-4" aria-hidden="true" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 text-sm">
				<p className="font-medium">{title}</p>
				<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
					{blurb}
				</p>
			</PopoverContent>
		</Popover>
	);
}
