"use client";

import {
	getProjectReportSetupReason,
	type ReportEvidenceConfig,
	reportEvidenceConfigSchema,
} from "@repo/database/prisma/queries/lib/report-evidence";
import { TIME_ZONES } from "@saas/shared/lib/time-zones";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@ui/components/accordion";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { useId } from "react";

type Props = {
	value?: ReportEvidenceConfig;
	onChange: (value: ReportEvidenceConfig) => void;
	organizationId?: string | null;
	sourceDefinition?: unknown;
	sourceConnections?: unknown;
	requireProject?: boolean;
	lockedProjectId?: string;
	lockAudience?: boolean;
};

/** Shared by create and existing report settings. Cadence remains in its existing control. */
export function ReportEvidenceSettings({
	value,
	onChange,
	organizationId,
	lockedProjectId,
	lockAudience,
	sourceDefinition,
	sourceConnections,
	requireProject,
}: Props) {
	const id = useId();
	const { data, isError, isPending } = useQuery({
		...orpc.projects.list.queryOptions({
			input: { organizationId, limit: 100, includeDraft: false },
		}),
		enabled: !!organizationId && !!value,
	});
	const update = (changes: Partial<ReportEvidenceConfig>) =>
		onChange(reportEvidenceConfigSchema.parse({ ...value, ...changes }));
	if (!value) {
		return (
			<div className="space-y-3">
				<p className="text-sm text-muted-foreground">
					Choose the completed period this report should cover. This
					is separate from when the report runs.
				</p>
				<Button
					type="button"
					variant="outline"
					onClick={() =>
						onChange(
							reportEvidenceConfigSchema.parse({
								version: 1,
								period: "weekly",
							}),
						)
					}
				>
					Set reporting period
				</Button>
			</div>
		);
	}
	return (
		<div className="space-y-4">
			<p className="text-sm text-muted-foreground">
				Each run covers the last completed period in the selected
				timezone. Changing the period leaves the run schedule unchanged.
			</p>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="space-y-2">
					<Label htmlFor={`${id}-period`}>Period to report on</Label>
					<Select
						value={value.period}
						onValueChange={(period) =>
							update({
								period: period as ReportEvidenceConfig["period"],
							})
						}
					>
						<SelectTrigger id={`${id}-period`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(
								[
									["daily", "Day"],
									["weekly", "Week"],
									["monthly", "Month"],
									["quarterly", "Quarter"],
									["yearly", "Year"],
								] as const
							).map(([key, label]) => (
								<SelectItem key={key} value={key}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-2">
					<Label htmlFor={`${id}-timezone`}>Reporting timezone</Label>
					<Select
						value={value.timezone}
						onValueChange={(timezone) => update({ timezone })}
					>
						<SelectTrigger
							id={`${id}-timezone`}
							aria-describedby={`${id}-timezone-help`}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{Array.from(
								new Set([value.timezone, "UTC", ...TIME_ZONES]),
							).map((zone) => (
								<SelectItem key={zone} value={zone}>
									{zone}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p
						id={`${id}-timezone-help`}
						className="text-xs text-muted-foreground"
					>
						Use an IANA timezone, such as Europe/London.
					</p>
				</div>
			</div>
			<Accordion
				type="single"
				collapsible
				defaultValue={requireProject ? "advanced" : undefined}
			>
				<AccordionItem value="advanced">
					<AccordionTrigger>
						Calendar, comparisons and audience
					</AccordionTrigger>
					<AccordionContent className="space-y-4">
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor={`${id}-calendar`}>
									Calendar
								</Label>
								<Select
									value={value.calendar}
									onValueChange={(calendar) =>
										update({
											calendar: calendar as
												| "calendar"
												| "fiscal",
										})
									}
								>
									<SelectTrigger id={`${id}-calendar`}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="calendar">
											Calendar year
										</SelectItem>
										<SelectItem value="fiscal">
											Fiscal year
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							{value.calendar === "fiscal" && (
								<div className="space-y-2">
									<Label htmlFor={`${id}-fiscal`}>
										Fiscal year starts in
									</Label>
									<Select
										value={String(
											value.fiscalYearStartMonth,
										)}
										onValueChange={(month) =>
											update({
												fiscalYearStartMonth:
													Number(month),
											})
										}
									>
										<SelectTrigger id={`${id}-fiscal`}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{Array.from(
												{ length: 12 },
												(_, index) => (
													<SelectItem
														key={index + 1}
														value={String(
															index + 1,
														)}
													>
														{new Intl.DateTimeFormat(
															"en",
															{
																month: "long",
																timeZone: "UTC",
															},
														).format(
															new Date(
																Date.UTC(
																	2024,
																	index,
																	1,
																),
															),
														)}
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
								</div>
							)}
							<div className="space-y-2">
								<Label htmlFor={`${id}-comparison`}>
									Compare with
								</Label>
								<Select
									value={value.comparison}
									onValueChange={(comparison) =>
										update({
											comparison:
												comparison as ReportEvidenceConfig["comparison"],
										})
									}
								>
									<SelectTrigger id={`${id}-comparison`}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">
											No comparison
										</SelectItem>
										<SelectItem value="previous_period">
											Previous period
										</SelectItem>
										<SelectItem value="previous_year">
											Same period last year
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
							<div className="space-y-2">
								<Label htmlFor={`${id}-project`}>
									Report audience
								</Label>
								<Select
									value={value.projectId ?? "organization"}
									disabled={
										!!lockedProjectId ||
										lockAudience ||
										isPending ||
										isError
									}
									onValueChange={(projectId) =>
										update({
											projectId:
												projectId === "organization"
													? undefined
													: projectId,
										})
									}
								>
									<SelectTrigger id={`${id}-project`}>
										<SelectValue
											placeholder={
												isPending
													? "Loading projects…"
													: "Select audience"
											}
										/>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="organization">
											{requireProject
												? "Choose a project"
												: "Organization report access"}
										</SelectItem>
										{data?.projects.map((project) => (
											<SelectItem
												key={project.id}
												value={project.id}
											>
												{project.name}
											</SelectItem>
										))}
										{lockedProjectId &&
											!data?.projects.some(
												(project) =>
													project.id ===
													lockedProjectId,
											) && (
												<SelectItem
													value={lockedProjectId}
												>
													Assigned project
												</SelectItem>
											)}
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">
									{isError
										? "Projects could not be loaded. Try again before choosing a project."
										: lockAudience && !lockedProjectId
											? "Create a new report to choose a different audience."
											: lockedProjectId
												? "This report keeps its original project audience. Create a separate report for another audience."
												: "Project reports require organization report permission and current project access."}
								</p>
							</div>
						</div>
					</AccordionContent>
				</AccordionItem>
			</Accordion>
			{value.projectId && (
				<output className="block text-sm text-muted-foreground">
					{getProjectReportSetupReason(
						{ reporting: value },
						sourceDefinition,
						sourceConnections,
					) ??
						"Project knowledge is read using current project access. Results remain available only to the project report audience."}
				</output>
			)}
			<p className="text-sm text-muted-foreground">
				Generated reports are drafts for review. Missing or unverified
				historical evidence is identified in the result.
			</p>
		</div>
	);
}
