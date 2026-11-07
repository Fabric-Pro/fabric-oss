"use client";

import { buildFabricAgentHref } from "@saas/agents/lib/fabric-agent-links";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { orpc } from "@shared/lib/orpc-query-utils";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	ArrowRightIcon,
	CheckCircle2Icon,
	CircleAlertIcon,
	FileTextIcon,
	FolderPlusIcon,
	GitBranchIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

interface HomeEmptyProject {
	id: string;
	name: string;
	organizationSlug: string | null;
}

interface HomeEmptyStateProps {
	basePath: string;
	organizationId: string;
	projects: HomeEmptyProject[];
	projectCount: number;
	project?: HomeEmptyProject;
	onDismiss?: () => void;
	dismissing?: boolean;
}

export function HomeEmptyState({
	basePath,
	organizationId,
	projects,
	projectCount,
	project,
	onDismiss,
	dismissing = false,
}: HomeEmptyStateProps) {
	const router = useRouter();
	const [selectedProjectId, setSelectedProjectId] = useState(
		project?.id ?? projects[0]?.id ?? "",
	);
	const [draft, setDraft] = useState("");
	const hasProject = projectCount > 0;
	const activeProjectId = selectedProjectId || project?.id || projects[0]?.id;
	const projectQuery = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: activeProjectId ?? "", organizationId },
		}),
		enabled: Boolean(activeProjectId),
	});
	const projectData = projectQuery.data?.project;
	const createFeatureMutation = useMutation({
		mutationFn: async () => {
			const result = await orpcClient.projects.stories.create({
				projectId: activeProjectId ?? "",
				organizationId,
				description: draft.trim(),
			});
			return result.story;
		},
		onSuccess: (story) => {
			router.push(
				`${basePath}/projects/${activeProjectId}/stories/${story.id}`,
			);
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not create the feature",
			);
		},
	});
	const primary = project
		? {
				label: `Open ${project.name}`,
				href: `${basePath}/projects/${project.id}`,
			}
		: hasProject
			? { label: "Choose a project", href: `${basePath}/projects` }
			: { label: "Create project", href: `${basePath}/projects/new` };
	const askFabricHref = buildFabricAgentHref({
		basePath,
		prompt:
			draft.trim() ||
			"Help me decide what to build first and how to turn it into a feature.",
	});
	const repository = projectData?.repositoryIntegrations?.[0];
	const contextSources = projectData?.contexts ?? [];
	const trimmedDraft = draft.trim();

	return (
		<div className="grid gap-4 xl:grid-cols-12">
			<Card className="xl:col-span-5">
				<CardHeader className="border-b border-border px-5 py-4">
					<div className="flex items-start justify-between gap-3">
						<div>
							<CardTitle className="text-base">
								Create your first feature
							</CardTitle>
							<p className="mt-1 text-sm text-muted-foreground">
								Start with a real requirement. Fabric will open
								the feature after it is created.
							</p>
						</div>
						{onDismiss ? (
							<Button
								variant="ghost"
								size="sm"
								onClick={onDismiss}
								disabled={dismissing}
							>
								{dismissing ? "Saving…" : "Hide"}
							</Button>
						) : null}
					</div>
				</CardHeader>
				<CardContent className="p-5">
					{hasProject && projects.length > 0 ? (
						<div>
							<Label htmlFor="welcome-project">Project</Label>
							<Select
								value={selectedProjectId}
								onValueChange={setSelectedProjectId}
							>
								<SelectTrigger
									id="welcome-project"
									className="mt-2 w-full"
								>
									<SelectValue placeholder="Choose a project" />
								</SelectTrigger>
								<SelectContent>
									{projects.map((item) => (
										<SelectItem
											key={item.id}
											value={item.id}
										>
											{item.name}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : (
						<div className="rounded-md border border-dashed border-border p-4">
							<FolderPlusIcon
								className="size-5 text-muted-foreground"
								aria-hidden
							/>
							<p className="mt-2 text-sm font-medium">
								You need a project first
							</p>
							<p className="mt-1 text-xs text-muted-foreground">
								A project holds the context, features,
								decisions, and coding runs for an initiative.
							</p>
							<Button asChild size="sm" className="mt-3">
								<Link href={primary.href}>
									{primary.label}
									<ArrowRightIcon
										className="size-3.5"
										aria-hidden
									/>
								</Link>
							</Button>
						</div>
					)}
					{hasProject ? (
						<div className="mt-4">
							<Label htmlFor="welcome-feature-idea">
								What do you want to build?
							</Label>
							<Textarea
								id="welcome-feature-idea"
								value={draft}
								onChange={(event) =>
									setDraft(event.target.value)
								}
								placeholder="Describe the requirement, problem, or feature."
								rows={5}
								className="mt-2"
							/>
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<Button
									onClick={() =>
										createFeatureMutation.mutate()
									}
									disabled={
										!trimmedDraft ||
										createFeatureMutation.isPending
									}
								>
									{createFeatureMutation.isPending
										? "Creating…"
										: "Create feature"}
									<ArrowRightIcon
										className="size-4"
										aria-hidden
									/>
								</Button>
								<Button asChild variant="outline">
									<Link href={askFabricHref}>
										<SparklesIcon
											className="size-4"
											aria-hidden
										/>
										Discuss with Fabric
									</Link>
								</Button>
							</div>
						</div>
					) : null}
				</CardContent>
			</Card>

			<Card className="xl:col-span-7">
				<CardHeader className="border-b border-border px-5 py-4">
					<div className="flex items-center justify-between gap-3">
						<div>
							<CardTitle className="text-base">
								Your project setup
							</CardTitle>
							<p className="mt-1 text-sm text-muted-foreground">
								Actual context and capabilities in the selected
								project.
							</p>
						</div>
						{projectData ? (
							<Badge variant="outline">{projectData.name}</Badge>
						) : null}
					</div>
				</CardHeader>
				<CardContent className="p-5">
					{projectQuery.isLoading ? (
						<div className="space-y-3">
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
							<Skeleton className="h-12 w-full" />
						</div>
					) : projectQuery.isError ? (
						<div role="alert" className="text-sm text-destructive">
							Could not load project setup.
						</div>
					) : projectData ? (
						<div className="grid gap-5 sm:grid-cols-2">
							<section aria-labelledby="welcome-project-context">
								<h3
									id="welcome-project-context"
									className="text-sm font-semibold"
								>
									Context
								</h3>
								<p className="mt-1 text-xs text-muted-foreground">
									{contextSources.length} source
									{contextSources.length === 1 ? "" : "s"}{" "}
									available to people and agents
								</p>
								<div className="mt-3 space-y-2">
									{contextSources.length === 0 ? (
										<p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
											No context sources yet. Add a
											repository, document, or meeting to
											ground the work.
										</p>
									) : (
										contextSources
											.slice(0, 4)
											.map((source) => (
												<div
													key={source.id}
													className="flex items-start gap-2 rounded-md border border-border p-3"
												>
													<FileTextIcon
														className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
														aria-hidden
													/>
													<p className="text-xs font-medium">
														{source.sourceTitle}
													</p>
												</div>
											))
									)}
								</div>
								<Button
									asChild
									variant="outline"
									size="sm"
									className="mt-3"
								>
									<Link
										href={`${basePath}/projects/${activeProjectId}?tab=context`}
									>
										{contextSources.length === 0
											? "Add context"
											: "Manage context"}
										<ArrowRightIcon
											className="size-3.5"
											aria-hidden
										/>
									</Link>
								</Button>
							</section>
							<section aria-labelledby="welcome-project-capabilities">
								<h3
									id="welcome-project-capabilities"
									className="text-sm font-semibold"
								>
									What you can do next
								</h3>
								<div className="mt-3 space-y-2 text-xs">
									<div className="rounded-md border border-border p-3">
										<p className="font-medium">
											{projectData._count.documents}{" "}
											document
											{projectData._count.documents === 1
												? ""
												: "s"}
										</p>
										<p className="mt-0.5 text-muted-foreground">
											Generated and imported project
											artifacts
										</p>
									</div>
									<div className="rounded-md border border-border p-3">
										<div className="flex items-center gap-2">
											{repository ? (
												<CheckCircle2Icon
													className="size-4 text-success"
													aria-hidden
												/>
											) : (
												<CircleAlertIcon
													className="size-4 text-highlight-ink"
													aria-hidden
												/>
											)}
											<p className="font-medium">
												{repository
													? "Repository connected"
													: "No repository connected"}
											</p>
										</div>
										<p className="mt-1 text-muted-foreground">
											{repository
												? `${repository.repositoryOwner}/${repository.repositoryName}`
												: "Connect one when you want coding runs to work from your codebase."}
										</p>
									</div>
									<div className="rounded-md border border-border p-3">
										<div className="flex items-center gap-2">
											<GitBranchIcon
												className="size-4 text-muted-foreground"
												aria-hidden
											/>
											<p className="font-medium">
												{projectData.canExecuteAgents
													? "Coding runs available"
													: "Coding runs need permission"}
											</p>
										</div>
										<p className="mt-1 text-muted-foreground">
											{projectData.canExecuteAgents
												? "Start work from a ready feature."
												: "Your current project role does not allow agent execution."}
										</p>
									</div>
								</div>
							</section>
						</div>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}
