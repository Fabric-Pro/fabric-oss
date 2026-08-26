"use client";

/**
 * SubAgentCard Component
 *
 * Displays the status and results of a single sub-agent in a workflow.
 * Shows title, status, findings preview, confidence, and sources.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import {
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Clock,
	ExternalLink,
	Loader2,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import type { SubAgentResult } from "../../hooks/useWorkflowTemplateStream";

interface SubAgentCardProps {
	result: SubAgentResult;
	index: number;
}

function StatusIcon({ status }: { status: SubAgentResult["status"] }) {
	switch (status) {
		case "completed":
			return <CheckCircle2 className="h-4 w-4 text-success" />;
		case "failed":
			return <XCircle className="h-4 w-4 text-destructive" />;
		case "timeout":
			return <Clock className="h-4 w-4 text-yellow-500" />;
		default:
			return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
	}
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
	const variant =
		confidence >= 80
			? "default"
			: confidence >= 60
				? "secondary"
				: "outline";

	return (
		<Badge variant={variant} className="text-xs">
			{confidence}% confidence
		</Badge>
	);
}

export function SubAgentCard({ result, index }: SubAgentCardProps) {
	const [isOpen, setIsOpen] = useState(false);

	const truncatedFindings =
		result.findings.length > 200
			? `${result.findings.slice(0, 200)}...`
			: result.findings;

	return (
		<Card
			className={`transition-all ${
				result.status === "completed"
					? "border-green-200 dark:border-green-900"
					: result.status === "failed"
						? "border-red-200 dark:border-red-900"
						: "border-yellow-200 dark:border-yellow-900"
			}`}
		>
			<Collapsible open={isOpen} onOpenChange={setIsOpen}>
				<CardHeader className="py-3 px-4">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium">
								{index + 1}
							</div>
							<StatusIcon status={result.status} />
							<span className="font-medium text-sm">
								{result.title}
							</span>
						</div>
						<div className="flex items-center gap-2">
							{result.status === "completed" && (
								<ConfidenceBadge
									confidence={result.confidence}
								/>
							)}
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
						{/* Findings */}
						{result.findings && (
							<div className="mb-4">
								<h4 className="text-xs font-medium text-muted-foreground mb-1">
									Findings
								</h4>
								<p className="text-sm text-foreground whitespace-pre-wrap">
									{isOpen
										? result.findings
										: truncatedFindings}
								</p>
							</div>
						)}

						{/* Error */}
						{result.error && (
							<div className="mb-4 p-2 rounded bg-red-50 dark:bg-red-950">
								<h4 className="text-xs font-medium text-destructive mb-1">
									Error
								</h4>
								<p className="text-sm text-destructive/80">
									{result.error}
								</p>
							</div>
						)}

						{/* Sources */}
						{result.sources && result.sources.length > 0 && (
							<div>
								<h4 className="text-xs font-medium text-muted-foreground mb-2">
									Sources ({result.sources.length})
								</h4>
								<div className="flex flex-wrap gap-2">
									{result.sources.map((source, i) => {
										// Check if source is a valid URL
										const isUrl =
											source.startsWith("http://") ||
											source.startsWith("https://");

										if (isUrl) {
											try {
												const url = new URL(source);
												return (
													<a
														key={i}
														href={source}
														target="_blank"
														rel="noopener noreferrer"
														className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-200 bg-blue-50 dark:bg-blue-950 px-2 py-1 rounded"
													>
														<ExternalLink className="h-3 w-3" />
														{url.hostname}
													</a>
												);
											} catch {
												// Fall through to plain text display
											}
										}

										// Display as plain text for non-URLs
										return (
											<span
												key={i}
												className="inline-flex items-center text-xs text-muted-foreground bg-muted px-2 py-1 rounded"
											>
												{source}
											</span>
										);
									})}
								</div>
							</div>
						)}

						{/* Duration */}
						{result.duration > 0 && (
							<div className="mt-3 text-xs text-muted-foreground">
								Completed in{" "}
								{(result.duration / 1000).toFixed(1)}s
							</div>
						)}
					</CardContent>
				</CollapsibleContent>
			</Collapsible>
		</Card>
	);
}

/**
 * Placeholder card for a pending sub-agent
 */
export function SubAgentPlaceholder({ index }: { index: number }) {
	return (
		<Card className="border-dashed">
			<CardHeader className="py-3 px-4">
				<div className="flex items-center gap-3">
					<div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-xs font-medium">
						{index + 1}
					</div>
					<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
					<span className="text-sm text-muted-foreground">
						Waiting...
					</span>
				</div>
			</CardHeader>
		</Card>
	);
}
