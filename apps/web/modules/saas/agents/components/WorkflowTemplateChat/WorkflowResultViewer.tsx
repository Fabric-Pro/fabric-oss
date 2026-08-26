"use client";

/**
 * WorkflowResultViewer Component
 *
 * Displays the final results of a workflow execution including:
 * - Executive summary
 * - Key findings with confidence scores
 * - All sources
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	BookOpen,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Copy,
	Download,
	ExternalLink,
	Lightbulb,
	Target,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import type {
	KeyFinding,
	StructuredResearchReport,
} from "../../hooks/useWorkflowTemplateStream";
import { ResearchReportCard } from "../FabricChat/cards/ResearchReportCard";

interface WorkflowResultViewerProps {
	result: {
		text: string | null;
		summary: string | null;
		keyFindings: KeyFinding[];
		sources: string[];
		iterations: number;
		goalAchieved: boolean;
		duration: number;
		structuredReport?: StructuredResearchReport | null;
	};
	instanceId?: string;
	organizationId?: string | null;
	projectId?: string;
}

function KeyFindingCard({
	finding,
	index,
}: {
	finding: KeyFinding;
	index: number;
}) {
	const [isOpen, setIsOpen] = useState(index === 0); // First one open by default

	const confidenceColor =
		finding.confidence >= 80
			? "text-success dark:text-green-400"
			: finding.confidence >= 60
				? "text-highlight dark:text-yellow-400"
				: "text-highlight dark:text-orange-400";

	return (
		<Card className="border-l-4 border-l-blue-500">
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CardHeader className="py-3 px-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-2">
							<Lightbulb className="h-4 w-4 text-blue-500" />
							<span className="font-medium text-sm">
								{finding.theme}
							</span>
						</div>
						<div className="flex items-center gap-2">
							<span
								className={`text-xs font-medium ${confidenceColor}`}
							>
								{finding.confidence}% confidence
							</span>
							<CollapsibleTrigger asChild>
								<Button
									variant="ghost"
									size="sm"
									className="p-1 h-auto"
								>
									{isOpen ? (
										<ChevronUp className="h-4 w-4" />
									) : (
										<ChevronDown className="h-4 w-4" />
									)}
								</Button>
							</CollapsibleTrigger>
						</div>
					</div>
				</CardHeader>
				<CollapsibleContent>
					<CardContent className="pt-0 px-4 pb-4">
						<ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
							{finding.findings.map((f, i) => (
								<li key={i}>{f}</li>
							))}
						</ul>
					</CardContent>
				</CollapsibleContent>
			</Collapsible>
		</Card>
	);
}

function SourcesList({ sources }: { sources: string[] }) {
	const [showAll, setShowAll] = useState(false);
	const displaySources = showAll ? sources : sources.slice(0, 5);
	const hasMore = sources.length > 5;

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-2">
				{displaySources.map((source, i) => {
					let hostname = source;
					try {
						hostname = new URL(source).hostname;
					} catch {
						// Keep original if not a valid URL
					}
					return (
						<a
							key={i}
							href={source}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200 bg-blue-50 dark:bg-blue-950 px-2 py-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"
						>
							<ExternalLink className="h-3 w-3" />
							{hostname}
						</a>
					);
				})}
			</div>
			{hasMore && (
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setShowAll(!showAll)}
					className="text-xs"
				>
					{showAll
						? "Show less"
						: `Show ${sources.length - 5} more sources`}
				</Button>
			)}
		</div>
	);
}

function toMarkdown(result: WorkflowResultViewerProps["result"]) {
	if (result.structuredReport) {
		return [
			`# ${result.structuredReport.title}`,
			"",
			"## Executive Summary",
			result.structuredReport.executiveSummary,
			"",
			...result.structuredReport.sections.flatMap((section) => [
				`## ${section.heading}`,
				section.content,
				"",
			]),
			"## Methodology",
			result.structuredReport.methodology,
			"",
			"## Sources",
			...result.structuredReport.citedSources.map(
				(source) => `- [${source.sourceType}] ${source.source}`,
			),
		].join("\n");
	}

	return [
		"# Research Results",
		"",
		result.summary ? `## Summary\n${result.summary}\n` : "",
		result.text ? `## Full Report\n${result.text}\n` : "",
		result.keyFindings.length > 0
			? `## Key Findings\n${result.keyFindings
					.map(
						(finding) =>
							`### ${finding.theme} (${finding.confidence}% confidence)\n${finding.findings.map((item) => `- ${item}`).join("\n")}`,
					)
					.join("\n\n")}\n`
			: "",
		result.sources.length > 0
			? `## Sources\n${result.sources.map((source) => `- ${source}`).join("\n")}`
			: "",
	].join("\n");
}

export function WorkflowResultViewer({
	result,
	instanceId,
	organizationId,
	projectId,
}: WorkflowResultViewerProps) {
	const [copied, setCopied] = useState(false);
	const [artifactId, setArtifactId] = useState<string | null>(null);
	const persistedSignatureRef = useRef<string | null>(null);
	const queryClient = useQueryClient();

	const reportMarkdown = useMemo(() => toMarkdown(result), [result]);
	const reportTitle =
		result.structuredReport?.title?.trim() || "Research Report";
	const reportSignature = useMemo(
		() =>
			result.structuredReport
				? `${reportTitle}:${result.structuredReport.executiveSummary}:${result.iterations}:${result.duration}`
				: null,
		[result, reportTitle],
	);

	const createArtifactMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.artifacts.create({
				organizationId: organizationId ?? null,
				instanceId,
				projectId,
				type: "RESEARCH_REPORT",
				title: reportTitle,
				description:
					result.structuredReport?.executiveSummary ??
					result.summary ??
					undefined,
				content: reportMarkdown,
				mimeType: "text/markdown",
				metadata: {
					structuredReport: result.structuredReport ?? undefined,
					keyFindings: result.keyFindings,
					sources: result.sources,
					iterations: result.iterations,
					goalAchieved: result.goalAchieved,
					duration: result.duration,
				},
			});
		},
		onSuccess: (data) => {
			setArtifactId(data.artifact.id);
			if (projectId) {
				queryClient.invalidateQueries({
					queryKey: ["artifacts", projectId],
				});
			}
		},
		onError: (error) => {
			toast.error("Failed to save research artifact", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const saveToProjectMutation = useMutation({
		mutationFn: async (id: string) => {
			return await orpcClient.artifacts.attachToProject({
				id,
				projectId: projectId as string,
				organizationId: organizationId ?? null,
				indexInProjectKnowledge: true,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: ["artifacts", projectId],
			});
			toast.success("Added to project knowledge");
		},
		onError: (error) => {
			toast.error("Failed to add report to project knowledge", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	useEffect(() => {
		if (persistedSignatureRef.current !== reportSignature) {
			setArtifactId(null);
		}
	}, [reportSignature]);

	useEffect(() => {
		if (
			!result.structuredReport ||
			createArtifactMutation.isPending ||
			(artifactId && persistedSignatureRef.current === reportSignature) ||
			persistedSignatureRef.current === reportSignature
		) {
			return;
		}

		createArtifactMutation.mutate(undefined, {
			onSuccess: (data) => {
				persistedSignatureRef.current = reportSignature;
				setArtifactId(data.artifact.id);
				if (projectId) {
					queryClient.invalidateQueries({
						queryKey: ["artifacts", projectId],
					});
				}
			},
		});
	}, [
		artifactId,
		createArtifactMutation,
		projectId,
		queryClient,
		reportSignature,
		result.structuredReport,
	]);

	if (result.structuredReport) {
		return (
			<ResearchReportCard
				report={{
					...result.structuredReport,
					keyFindings: result.keyFindings,
					iterations: result.iterations,
					duration: result.duration,
					goalAchieved: result.goalAchieved,
				}}
				onSaveToProject={
					projectId && artifactId
						? () => saveToProjectMutation.mutate(artifactId)
						: undefined
				}
			/>
		);
	}

	const handleCopy = async () => {
		const content = result.text || result.summary || "";
		await navigator.clipboard.writeText(content);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleDownload = () => {
		const blob = new Blob([reportMarkdown], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `research-results-${new Date().toISOString().slice(0, 10)}.md`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	return (
		<div className="space-y-4">
			{/* Header with metadata */}
			<Card>
				<CardHeader className="pb-2">
					<div className="flex items-center justify-between">
						<CardTitle className="text-base font-medium flex items-center gap-2">
							<CheckCircle2 className="h-5 w-5 text-success" />
							Research Complete
						</CardTitle>
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={handleCopy}
							>
								<Copy className="h-3.5 w-3.5 mr-1" />
								{copied ? "Copied!" : "Copy"}
							</Button>
							<Button
								variant="outline"
								size="sm"
								onClick={handleDownload}
							>
								<Download className="h-3.5 w-3.5 mr-1" />
								Export
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					<div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
						{result.goalAchieved && (
							<Badge
								variant="outline"
								className="bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-0"
							>
								<Target className="h-3 w-3 mr-1" />
								Goal achieved
							</Badge>
						)}
						<span>
							{result.iterations} iteration
							{result.iterations !== 1 ? "s" : ""}
						</span>
						<span>
							{(result.duration / 1000).toFixed(1)}s total
						</span>
						<span>{result.sources.length} sources</span>
					</div>
				</CardContent>
			</Card>

			{/* Summary */}
			{result.summary && (
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium flex items-center gap-2">
							<BookOpen className="h-4 w-4" />
							Executive Summary
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="prose prose-sm dark:prose-invert max-w-none">
							<ReactMarkdown>{result.summary}</ReactMarkdown>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Key Findings */}
			{result.keyFindings.length > 0 && (
				<div className="space-y-2">
					<h3 className="text-sm font-medium flex items-center gap-2">
						<Lightbulb className="h-4 w-4" />
						Key Findings
					</h3>
					<div className="grid gap-2">
						{result.keyFindings.map((finding, index) => (
							<KeyFindingCard
								key={index}
								finding={finding}
								index={index}
							/>
						))}
					</div>
				</div>
			)}

			{/* Full Result */}
			{result.text && (
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium">
							Full Report
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="prose prose-sm dark:prose-invert max-w-none">
							<ReactMarkdown>{result.text}</ReactMarkdown>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Sources */}
			{result.sources.length > 0 && (
				<Card>
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-medium flex items-center gap-2">
							<ExternalLink className="h-4 w-4" />
							Sources ({result.sources.length})
						</CardTitle>
					</CardHeader>
					<CardContent>
						<SourcesList sources={result.sources} />
					</CardContent>
				</Card>
			)}
		</div>
	);
}
