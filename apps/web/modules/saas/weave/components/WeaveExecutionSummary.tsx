"use client";

/**
 * WeaveExecutionSummary - Completion view for finished Weave executions
 *
 * Shows:
 * - Duration and step completion stats
 * - Pull request link (prominent)
 * - Collected artifacts grouped by type
 * - Re-run action
 */

import { Badge } from "@ui/components/badge";
import { Card } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { cn } from "@ui/lib";
import {
	CheckCircleIcon,
	ChevronDownIcon,
	CodeIcon,
	ExternalLinkIcon,
	FileIcon,
	FileTextIcon,
	GitPullRequestIcon,
	PackageIcon,
	ShieldAlertIcon,
	XCircleIcon,
} from "lucide-react";

interface Artifact {
	id: string;
	type:
		| "document"
		| "code"
		| "data"
		| "tool_result"
		| "file"
		| "error"
		| "chart";
	name?: string;
	content?: string;
	stepId: string;
	createdAt: string;
	metadata?: Record<string, unknown>;
}

interface ImplementationSession {
	id: string;
	status: string;
	pullRequestUrl?: string | null;
	externalUrl?: string | null;
	externalStatus?: string | null;
	targetBranch?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
}

interface WeaveExecutionSummaryProps {
	status: "COMPLETED" | "FAILED" | "CANCELLED" | "TERMINATED_STALE";
	artifacts: unknown;
	startedAt?: string | Date | null;
	completedAt?: string | Date | null;
	stepsCompleted: number;
	stepsTotal: number;
	error?: string | null;
	implementationSession?: ImplementationSession | null;
}

const ARTIFACT_ICONS: Record<string, React.ReactNode> = {
	code: <CodeIcon className="size-4" />,
	document: <FileTextIcon className="size-4" />,
	file: <FileIcon className="size-4" />,
	data: <PackageIcon className="size-4" />,
	tool_result: <PackageIcon className="size-4" />,
	error: <ShieldAlertIcon className="size-4" />,
	chart: <PackageIcon className="size-4" />,
};

function formatDuration(startedAt: Date, completedAt: Date): string {
	const ms = completedAt.getTime() - startedAt.getTime();
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${remainingSeconds > 0 ? `${remainingSeconds}s` : ""}`.trim();
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return `${hours}h ${remainingMinutes}m`;
}

function parseArtifacts(raw: unknown): Artifact[] {
	if (!raw) {
		return [];
	}
	if (Array.isArray(raw)) {
		return raw as Artifact[];
	}
	return [];
}

function extractPRNumber(url: string): string | null {
	const match = url.match(/\/pull\/(\d+)/);
	return match ? `#${match[1]}` : null;
}

export function WeaveExecutionSummary({
	status,
	artifacts: rawArtifacts,
	startedAt,
	completedAt,
	stepsCompleted,
	stepsTotal,
	error,
	implementationSession,
}: WeaveExecutionSummaryProps) {
	const artifacts = parseArtifacts(rawArtifacts);
	const duration =
		startedAt && completedAt
			? formatDuration(new Date(startedAt), new Date(completedAt))
			: null;

	const isSuccess = status === "COMPLETED";
	const isFailed = status === "FAILED" || status === "TERMINATED_STALE";
	const prUrl = implementationSession?.pullRequestUrl;

	// Group artifacts by type
	const artifactsByType = artifacts.reduce(
		(acc, a) => {
			const type = a.type || "file";
			if (!acc[type]) {
				acc[type] = [];
			}
			acc[type].push(a);
			return acc;
		},
		{} as Record<string, Artifact[]>,
	);

	return (
		<Card
			className={cn(
				"p-5 space-y-4",
				isSuccess && "border-secondary/30",
				isFailed && "border-destructive/30",
			)}
		>
			{/* Header */}
			<div className="flex items-start justify-between">
				<div className="flex items-center gap-3">
					<div
						className={cn(
							"size-10 rounded-full flex items-center justify-center",
							isSuccess && "bg-secondary/10 text-secondary",
							isFailed && "bg-destructive/10 text-destructive",
							!isSuccess &&
								!isFailed &&
								"bg-muted text-muted-foreground",
						)}
					>
						{isSuccess ? (
							<CheckCircleIcon className="size-5" />
						) : (
							<XCircleIcon className="size-5" />
						)}
					</div>
					<div>
						<h3 className="font-semibold text-base">
							{isSuccess
								? "Execution Complete"
								: isFailed
									? "Execution Failed"
									: "Execution Cancelled"}
						</h3>
						<div className="flex items-center gap-3 text-sm text-muted-foreground mt-0.5">
							{duration && <span>{duration}</span>}
							<span>
								{stepsCompleted}/{stepsTotal} steps
							</span>
						</div>
					</div>
				</div>
			</div>

			{/* Error message */}
			{error && (
				<div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
					{error}
				</div>
			)}

			{/* Pull Request — prominent card */}
			{prUrl ? (
				<a
					href={prUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="flex items-center gap-3 rounded-lg border border-secondary/30 bg-secondary/5 px-4 py-3 transition-colors hover:bg-secondary/10"
				>
					<div className="flex size-9 items-center justify-center rounded-full bg-secondary/10">
						<GitPullRequestIcon className="size-4 text-secondary" />
					</div>
					<div className="flex-1 min-w-0">
						<p className="font-medium text-sm text-foreground">
							Pull Request{" "}
							{extractPRNumber(prUrl) && (
								<span className="text-muted-foreground">
									{extractPRNumber(prUrl)}
								</span>
							)}
						</p>
						<p className="text-xs text-muted-foreground truncate">
							{implementationSession?.repositoryOwner &&
							implementationSession?.repositoryName
								? `${implementationSession.repositoryOwner}/${implementationSession.repositoryName}`
								: prUrl}
							{implementationSession?.targetBranch &&
								` → ${implementationSession.targetBranch}`}
						</p>
					</div>
					<ExternalLinkIcon className="size-4 text-muted-foreground shrink-0" />
				</a>
			) : (
				isSuccess && (
					<div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
						<div className="flex items-center gap-2">
							<GitPullRequestIcon className="size-4" />
							No pull request was created for this execution.
						</div>
					</div>
				)
			)}

			{/* Implementation session link */}
			{implementationSession?.externalUrl && (
				<a
					href={implementationSession.externalUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
				>
					View implementation runtime
					<ExternalLinkIcon className="size-3" />
				</a>
			)}

			{/* Artifacts */}
			{artifacts.length > 0 && (
				<div className="space-y-2">
					<p className="text-[11px] font-medium uppercase tracking-[0.24em] text-muted-foreground">
						Artifacts
					</p>
					<div className="space-y-1.5">
						{Object.entries(artifactsByType).map(
							([type, typeArtifacts]) => (
								<Collapsible key={type}>
									<CollapsibleTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted/50 transition-colors group">
										<span className="text-muted-foreground">
											{ARTIFACT_ICONS[type] || (
												<FileIcon className="size-4" />
											)}
										</span>
										<span className="flex-1 text-left font-medium capitalize">
											{type.replace("_", " ")}
										</span>
										<Badge
											variant="secondary"
											className="text-xs"
										>
											{typeArtifacts.length}
										</Badge>
										<ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
									</CollapsibleTrigger>
									<CollapsibleContent>
										<div className="ml-6 mt-1 space-y-1">
											{typeArtifacts.map((artifact) => (
												<div
													key={artifact.id}
													className="rounded-md border border-border/60 bg-card/50"
												>
													<div className="flex items-center gap-2 px-3 py-2 text-sm">
														<span className="font-medium truncate flex-1">
															{artifact.name ||
																`${type} artifact`}
														</span>
													</div>
													{artifact.content && (
														<div
															className={cn(
																"border-t border-border/60 px-3 py-2 text-xs max-h-48 overflow-y-auto",
																type === "code"
																	? "font-mono bg-muted/30 whitespace-pre-wrap"
																	: "text-muted-foreground whitespace-pre-wrap",
																type ===
																	"error" &&
																	"text-destructive bg-destructive/5",
															)}
														>
															{artifact.content.slice(
																0,
																2000,
															)}
															{(artifact.content
																.length ?? 0) >
																2000 && (
																<span className="text-muted-foreground italic">
																	{" "}
																	...
																	(truncated)
																</span>
															)}
														</div>
													)}
												</div>
											))}
										</div>
									</CollapsibleContent>
								</Collapsible>
							),
						)}
					</div>
				</div>
			)}
		</Card>
	);
}
