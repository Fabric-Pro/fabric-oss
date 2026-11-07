"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import { formatDistanceToNow } from "date-fns";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import type { ProjectActivitySummary } from "../lib/home-model";

interface ProjectActivityPanelProps {
	activity: ProjectActivitySummary[];
	loading: boolean;
}

export function ProjectActivityPanel({
	activity,
	loading,
}: ProjectActivityPanelProps) {
	return (
		<Card>
			<CardHeader className="px-5 pb-3 pt-4">
				<CardTitle className="text-base">
					Since you opened your projects
				</CardTitle>
			</CardHeader>
			<CardContent className="p-0">
				{loading ? (
					<div className="space-y-3 px-5 pb-5">
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : activity.length === 0 ? (
					<p className="px-5 pb-5 text-sm text-muted-foreground">
						No new activity in your recent projects.
					</p>
				) : (
					<div className="divide-y divide-border">
						{activity.map((project) => (
							<Link
								key={project.projectId}
								href={project.href}
								className="group flex items-center gap-4 px-5 py-3 transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-hidden focus-visible:bg-muted/50"
							>
								<span className="min-w-0 flex-1">
									<span className="block text-sm font-medium group-hover:text-primary-ink">
										{project.projectName}
									</span>
									<span className="mt-0.5 block truncate text-xs text-muted-foreground">
										{project.summary}
									</span>
								</span>
								<span className="shrink-0 text-xs text-muted-foreground">
									{formatDistanceToNow(project.latestAt, {
										addSuffix: true,
									})}
								</span>
								<ArrowRightIcon
									className="size-4 shrink-0 text-primary-ink"
									aria-hidden
								/>
							</Link>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
