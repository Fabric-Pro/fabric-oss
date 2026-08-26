"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { formatDistanceToNow } from "date-fns";
import { FileTextIcon, PlayIcon, PlusIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { ProjectSectionHero } from "./ProjectSectionHero";

type Props = {
	projectId: string;
};

export function ProjectReports({ projectId: _projectId }: Props) {
	const { basePath, organizationId } = useOrganizationContext();
	const reportTemplatesPath = `${basePath}/report-templates`;

	// Fetch available system templates
	const { data: templatesData, isLoading: isLoadingTemplates } = useQuery(
		orpc.reports.templates.list.queryOptions({
			input: {
				scope: "SYSTEM",
				limit: 50,
				offset: 0,
			},
		}),
	);

	// Fetch the active workspace's template instances. organizationId scopes
	// both the server query and the React Query cache key, so instances from a
	// previously-viewed workspace can't leak after a switch.
	const { data: instancesData, isLoading: isLoadingInstances } = useQuery(
		orpc.reports.instances.list.queryOptions({
			input: {
				organizationId,
				limit: 20,
				offset: 0,
			},
		}),
	);

	const templates = templatesData?.templates ?? [];
	const instances = instancesData?.instances ?? [];
	const activeInstances = instances.filter(
		(instance) => instance.isActive,
	).length;
	const pausedInstances = instances.length - activeInstances;

	return (
		<div className="space-y-6">
			<ProjectSectionHero
				eyebrow="Project Reports"
				title="Recurring analysis, snapshots, and decision support"
				description="Use report templates to turn project activity into summaries, check-ins, and AI-assisted reporting rhythms that the team can revisit over time."
				getStartedPageId="reports"
				badges={
					<>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							{templates.length} templates available
						</div>
						<div className="rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-muted-foreground">
							{instances.length} configured instances
						</div>
					</>
				}
				aside={
					<div className="flex h-full flex-col justify-between">
						<div>
							<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
								Reporting Rhythm
							</p>
							<div className="mt-4 grid grid-cols-3 gap-3">
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground">
										{instances.length}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Total
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-primary">
										{activeInstances}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Active
									</p>
								</div>
								<div className="rounded-2xl border border-border/60 bg-background/50 p-3 text-center">
									<p className="text-2xl font-semibold tabular-nums text-foreground/75">
										{pausedInstances}
									</p>
									<p className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
										Paused
									</p>
								</div>
							</div>
						</div>
						<div className="mt-6 rounded-2xl border border-border/60 bg-card/40 p-4">
							<p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
								Quick Focus
							</p>
							<p className="mt-2 text-sm text-foreground/85">
								Start from a template, then tune the cadence and
								output so reports become part of the project
								operating rhythm instead of one-off exports.
							</p>
							<Button
								data-onboarding-target="reports-browse-templates"
								asChild
								className="mt-4 gap-2"
								variant="outline"
							>
								<Link href={reportTemplatesPath}>
									<SparklesIcon className="h-4 w-4" />
									Browse Templates
								</Link>
							</Button>
						</div>
					</div>
				}
			/>

			<Tabs defaultValue="instances" className="w-full">
				<TabsList data-onboarding-target="reports-tabs">
					<TabsTrigger value="instances">
						My Report Instances
					</TabsTrigger>
					<TabsTrigger value="templates">
						Available Templates
					</TabsTrigger>
				</TabsList>

				{/* User's Instances Tab */}
				<TabsContent value="instances" className="mt-4">
					{isLoadingInstances ? (
						<div className="flex justify-center py-12">
							<Spinner className="h-8 w-8" />
						</div>
					) : instances.length === 0 ? (
						<div className="text-center py-12">
							<FileTextIcon className="mx-auto h-12 w-12 text-muted-foreground" />
							<h3 className="mt-4 text-lg font-semibold">
								No report instances yet
							</h3>
							<p className="text-muted-foreground mb-4">
								Create an instance from a template to generate
								reports.
							</p>
							<Button asChild>
								<Link href={reportTemplatesPath}>
									<PlusIcon className="mr-2 h-4 w-4" />
									Browse Templates
								</Link>
							</Button>
						</div>
					) : (
						<div className="space-y-4">
							{instances.map((instance) => (
								<Card key={instance.id}>
									<CardHeader className="pb-2">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-3">
												<div className="text-2xl">
													📊
												</div>
												<div>
													<CardTitle className="text-base">
														{instance.name}
													</CardTitle>
													<CardDescription>
														Based on{" "}
														{instance.templateName}
														{instance.lastRunAt && (
															<>
																{" "}
																· Last run{" "}
																{formatDistanceToNow(
																	new Date(
																		instance.lastRunAt,
																	),
																	{
																		addSuffix: true,
																	},
																)}
															</>
														)}
													</CardDescription>
												</div>
											</div>
											<Badge
												variant={
													instance.isActive
														? "default"
														: "secondary"
												}
											>
												{instance.isActive
													? "Active"
													: "Paused"}
											</Badge>
										</div>
									</CardHeader>
									<CardFooter className="pt-2">
										<div className="flex gap-2">
											<Button
												variant="outline"
												size="sm"
												asChild
											>
												<Link
													href={`${reportTemplatesPath}/instances/${instance.id}`}
												>
													Configure
												</Link>
											</Button>
											<Button
												variant="default"
												size="sm"
												asChild
											>
												<Link
													href={`${reportTemplatesPath}/instances/${instance.id}`}
												>
													<PlayIcon className="mr-1 h-3 w-3" />
													Execute
												</Link>
											</Button>
										</div>
									</CardFooter>
								</Card>
							))}
						</div>
					)}
				</TabsContent>

				{/* Available Templates Tab */}
				<TabsContent value="templates" className="mt-4">
					{isLoadingTemplates ? (
						<div className="flex justify-center py-12">
							<Spinner className="h-8 w-8" />
						</div>
					) : templates.length === 0 ? (
						<div className="text-center py-12">
							<FileTextIcon className="mx-auto h-12 w-12 text-muted-foreground" />
							<h3 className="mt-4 text-lg font-semibold">
								No templates available
							</h3>
							<p className="text-muted-foreground">
								System templates will appear here once
								configured.
							</p>
						</div>
					) : (
						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							{templates.map((template) => (
								<Card
									key={template.id}
									className="hover:shadow-md transition-shadow"
								>
									<CardHeader className="pb-2">
										<div className="flex items-start gap-3">
											<div className="text-3xl">
												{template.heroEmojis?.[0] ||
													"📊"}
											</div>
											<div className="flex-1">
												<CardTitle className="text-base">
													{template.name}
												</CardTitle>
												<div className="flex items-center gap-2 mt-1">
													{template.category && (
														<Badge
															variant="secondary"
															className="text-xs"
														>
															{template.category}
														</Badge>
													)}
													{template.tags
														?.slice(0, 2)
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
										<p className="text-sm text-muted-foreground line-clamp-2">
											{template.description}
										</p>
									</CardContent>
									<CardFooter className="pt-0">
										<Button
											variant="outline"
											size="sm"
											asChild
										>
											<Link
												href={`${reportTemplatesPath}/${template.id}`}
											>
												<SparklesIcon className="mr-2 h-4 w-4" />
												Use Template
											</Link>
										</Button>
									</CardFooter>
								</Card>
							))}
						</div>
					)}
				</TabsContent>
			</Tabs>

			{/* Link to full Report Templates page */}
			<div className="pt-4 border-t">
				<p className="text-sm text-muted-foreground">
					Need custom templates?{" "}
					<Link
						href={reportTemplatesPath}
						className="text-primary hover:underline"
					>
						Browse all templates
					</Link>{" "}
					or{" "}
					<Link
						href={`${reportTemplatesPath}/new`}
						className="text-primary hover:underline"
					>
						create your own
					</Link>
					.
				</p>
			</div>
		</div>
	);
}
