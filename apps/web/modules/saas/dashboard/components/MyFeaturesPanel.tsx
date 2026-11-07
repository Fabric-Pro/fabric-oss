"use client";

import type { MyWorkBucket, MyWorkDeliveryStage } from "@repo/database";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Skeleton } from "@ui/components/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { formatDistanceToNow } from "date-fns";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";

const STAGE_LABELS: Record<MyWorkDeliveryStage, string> = {
	drafting: "Drafting",
	sanityCheck: "Sanity check",
	readyForDev: "Ready for dev",
	implementing: "Implementing",
	review: "Review",
	blocked: "Blocked",
};

const STAGE_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "drafting", label: "Drafting" },
	{ value: "sanityCheck", label: "Sanity check" },
	{ value: "readyForDev", label: "Ready for dev" },
	{ value: "implementing", label: "Implementing" },
	{ value: "review", label: "Review" },
	{ value: "blocked", label: "Blocked" },
] as const;

type FeatureStageFilter = (typeof STAGE_FILTERS)[number]["value"];

interface MyFeaturesPanelProps {
	features?: MyWorkBucket;
	loading: boolean;
	basePath: string;
	stage: FeatureStageFilter;
	onStageChange: (stage: FeatureStageFilter) => void;
}

export function MyFeaturesPanel({
	features,
	loading,
	basePath,
	stage,
	onStageChange,
}: MyFeaturesPanelProps) {
	const items = features?.items ?? [];
	return (
		<Card>
			<CardHeader className="gap-3 px-5 pb-3 pt-4">
				<div className="flex items-center justify-between gap-3">
					<CardTitle
						id="my-features-title"
						tabIndex={-1}
						className="text-base"
					>
						My features
						{features?.total ? ` (${features.total})` : ""}
					</CardTitle>
					<Link
						href={`${basePath}/projects`}
						className="text-xs font-medium text-primary-ink hover:underline"
					>
						View projects
					</Link>
				</div>
				<fieldset className="flex flex-wrap gap-2">
					<legend className="sr-only">
						Filter features by stage
					</legend>
					{STAGE_FILTERS.map((filter) => (
						<Button
							key={filter.value}
							variant={
								stage === filter.value ? "secondary" : "ghost"
							}
							size="xs"
							aria-pressed={stage === filter.value}
							onClick={() => onStageChange(filter.value)}
						>
							{filter.label}
						</Button>
					))}
				</fieldset>
			</CardHeader>
			<CardContent className="p-0">
				{loading ? (
					<div className="space-y-3 px-5 pb-5">
						{Array.from({ length: 4 }, (_, index) => (
							<Skeleton key={index} className="h-10 w-full" />
						))}
					</div>
				) : items.length === 0 ? (
					<div className="px-5 py-8 text-center">
						<p className="text-sm font-medium">
							No assigned features in this stage
						</p>
						<p className="mt-1 text-xs text-muted-foreground">
							Features assigned to you will appear here.
						</p>
					</div>
				) : (
					<div className="overflow-x-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Feature</TableHead>
									<TableHead>Project</TableHead>
									<TableHead>Stage</TableHead>
									<TableHead>Updated</TableHead>
									<TableHead className="w-10">
										<span className="sr-only">Open</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((feature) => (
									<TableRow key={feature.id}>
										<TableCell>
											<Link
												href={feature.href}
												className="block min-w-48 font-medium hover:text-primary-ink"
											>
												<span className="mr-2 font-mono text-xs text-muted-foreground">
													{feature.identifier}
												</span>
												{feature.title}
											</Link>
										</TableCell>
										<TableCell className="min-w-36 text-muted-foreground">
											{feature.projectName}
										</TableCell>
										<TableCell>
											<Badge variant="secondary">
												{
													STAGE_LABELS[
														feature.deliveryStage ??
															"drafting"
													]
												}
											</Badge>
										</TableCell>
										<TableCell className="whitespace-nowrap text-muted-foreground">
											{formatDistanceToNow(
												feature.updatedAt,
												{ addSuffix: true },
											)}
										</TableCell>
										<TableCell>
											<Link
												href={feature.href}
												aria-label={`Open ${feature.title}`}
												className="inline-flex text-primary-ink"
											>
												<ArrowRightIcon
													className="size-4"
													aria-hidden
												/>
											</Link>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
