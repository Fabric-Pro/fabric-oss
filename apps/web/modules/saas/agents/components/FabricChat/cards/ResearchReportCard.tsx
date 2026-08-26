/**
 * ResearchReportCard
 *
 * Renders a structured deep research report with:
 * - Executive summary
 * - Collapsible sections with inline citations
 * - Methodology description
 * - Source list with types
 * - Key findings with confidence
 * - Download action
 */

"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { cn } from "@ui/lib";
import {
	BookOpen,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Copy,
	Download,
	ExternalLink,
	FileText,
	Globe,
	Search,
	Users,
} from "lucide-react";
import { useState } from "react";

interface Citation {
	source: string;
	sourceType: "rag" | "web" | "sub-agent";
	sourceNumber?: number;
	relevance?: number;
}

interface ReportSection {
	heading: string;
	content: string;
	citations: Citation[];
}

interface KeyFinding {
	theme: string;
	findings: string[];
	confidence: number;
}

interface ResearchReportData {
	title: string;
	executiveSummary: string;
	sections: ReportSection[];
	methodology: string;
	citedSources: Citation[];
	keyFindings?: KeyFinding[];
	iterations?: number;
	duration?: number;
	goalAchieved?: boolean;
}

interface ResearchReportCardProps {
	report: ResearchReportData;
	onSaveToProject?: () => void;
	className?: string;
}

const SOURCE_TYPE_CONFIG: Record<
	string,
	{ label: string; icon: React.ReactNode; color: string }
> = {
	rag: {
		label: "Knowledge Base",
		icon: <FileText className="h-3 w-3" />,
		color: "text-emerald-600",
	},
	workspace: {
		label: "Workspace",
		icon: <FileText className="h-3 w-3" />,
		color: "text-emerald-600",
	},
	web: {
		label: "Web",
		icon: <Globe className="h-3 w-3" />,
		color: "text-blue-600",
	},
	"sub-agent": {
		label: "Research Agent",
		icon: <Users className="h-3 w-3" />,
		color: "text-violet-600",
	},
};

export function ResearchReportCard({
	report,
	onSaveToProject,
	className,
}: ResearchReportCardProps) {
	const [expandedSections, setExpandedSections] = useState<Set<number>>(
		new Set([0]), // First section expanded by default
	);
	const [showMethodology, setShowMethodology] = useState(false);
	const [showSources, setShowSources] = useState(false);

	const toggleSection = (idx: number) => {
		setExpandedSections((prev) => {
			const next = new Set(prev);
			if (next.has(idx)) {
				next.delete(idx);
			} else {
				next.add(idx);
			}
			return next;
		});
	};

	const handleCopyReport = () => {
		const text = [
			`# ${report.title}`,
			"",
			"## Executive Summary",
			report.executiveSummary,
			"",
			...report.sections.flatMap((s) => [
				`## ${s.heading}`,
				s.content,
				"",
			]),
			"## Methodology",
			report.methodology,
			"",
			"## Sources",
			...report.citedSources.map(
				(s, i) => `- [${s.sourceNumber ?? i + 1}] ${s.source}`,
			),
		].join("\n");
		navigator.clipboard.writeText(text);
	};

	return (
		<Card className={cn("overflow-hidden", className)}>
			<CardHeader className="pb-3">
				<div className="flex items-start justify-between">
					<div className="flex items-center gap-2">
						<BookOpen className="h-5 w-5 text-primary" />
						<CardTitle className="text-base">
							{report.title}
						</CardTitle>
					</div>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							onClick={handleCopyReport}
							title="Copy report as markdown"
						>
							<Copy className="h-3.5 w-3.5" />
						</Button>
						{onSaveToProject && (
							<Button
								variant="ghost"
								size="sm"
								onClick={onSaveToProject}
								className="text-xs"
							>
								<Download className="h-3.5 w-3.5 mr-1" />
								Add to Project Knowledge
							</Button>
						)}
					</div>
				</div>

				{/* Meta badges */}
				<div className="flex items-center gap-2 mt-1">
					{report.goalAchieved != null && (
						<Badge
							variant="outline"
							className={cn(
								"text-xs",
								report.goalAchieved
									? "bg-emerald-50 text-emerald-700 border-transparent"
									: "bg-amber-50 text-amber-700 border-transparent",
							)}
						>
							<CheckCircle2 className="h-3 w-3 mr-1" />
							{report.goalAchieved
								? "Goals met"
								: "Partial results"}
						</Badge>
					)}
					{report.citedSources.length > 0 && (
						<Badge
							variant="outline"
							className="text-xs border-transparent bg-muted"
						>
							<Search className="h-3 w-3 mr-1" />
							{report.citedSources.length} sources
						</Badge>
					)}
					{report.iterations != null && report.iterations > 1 && (
						<Badge
							variant="outline"
							className="text-xs border-transparent bg-muted"
						>
							{report.iterations} iterations
						</Badge>
					)}
					{report.duration != null && (
						<Badge
							variant="outline"
							className="text-xs border-transparent bg-muted"
						>
							{Math.round(report.duration / 1000)}s
						</Badge>
					)}
				</div>
			</CardHeader>

			<CardContent className="space-y-4">
				{/* Executive Summary */}
				<div className="rounded-lg bg-muted/40 p-3">
					<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
						Executive Summary
					</p>
					<p className="text-sm leading-relaxed">
						{report.executiveSummary}
					</p>
				</div>

				{/* Key Findings */}
				{report.keyFindings && report.keyFindings.length > 0 && (
					<div className="space-y-2">
						<p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
							Key Findings
						</p>
						{report.keyFindings.map((finding, idx) => (
							<div
								key={idx}
								className="flex items-start gap-2 text-sm"
							>
								<div
									className="mt-1 h-2 w-2 rounded-full shrink-0"
									style={{
										backgroundColor: `hsl(${Math.round(finding.confidence * 1.2)}, 70%, 50%)`,
									}}
								/>
								<div>
									<span className="font-medium">
										{finding.theme}
									</span>
									<span className="text-muted-foreground ml-2 text-xs">
										{finding.confidence}% confidence
									</span>
								</div>
							</div>
						))}
					</div>
				)}

				{/* Report Sections (collapsible) */}
				{report.sections.length > 0 && (
					<div className="space-y-1">
						{report.sections.map((section, idx) => (
							<div key={idx} className="border rounded-lg">
								<button
									type="button"
									className="flex items-center gap-2 w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors text-sm font-medium"
									onClick={() => toggleSection(idx)}
								>
									{expandedSections.has(idx) ? (
										<ChevronDown className="h-3.5 w-3.5 shrink-0" />
									) : (
										<ChevronRight className="h-3.5 w-3.5 shrink-0" />
									)}
									{section.heading}
									{section.citations.length > 0 && (
										<span className="text-xs text-muted-foreground ml-auto">
											{section.citations.length} source
											{section.citations.length !== 1
												? "s"
												: ""}
										</span>
									)}
								</button>
								{expandedSections.has(idx) && (
									<div className="px-3 pb-3 text-sm leading-relaxed border-t">
										<p className="mt-2 whitespace-pre-wrap">
											{section.content}
										</p>
										{section.citations.length > 0 && (
											<div className="mt-2 flex flex-wrap gap-1">
												{section.citations.map(
													(cite, cIdx) => {
														const config =
															SOURCE_TYPE_CONFIG[
																cite.sourceType
															] ??
															SOURCE_TYPE_CONFIG[
																"sub-agent"
															];
														const isUrl =
															cite.source.startsWith(
																"http",
															);
														const label =
															cite.sourceNumber
																? `[${cite.sourceNumber}]`
																: isUrl
																	? (() => {
																			try {
																				return new URL(
																					cite.source,
																				)
																					.hostname;
																			} catch {
																				return cite.source;
																			}
																		})()
																	: cite.source;
														return (
															<span
																key={cIdx}
																className={cn(
																	"inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted",
																	config.color,
																)}
															>
																{config.icon}
																<span className="truncate max-w-[200px]">
																	{label}
																</span>
															</span>
														);
													},
												)}
											</div>
										)}
									</div>
								)}
							</div>
						))}
					</div>
				)}

				{/* Methodology (collapsible) */}
				{report.methodology && (
					<div className="border-t pt-3">
						<button
							type="button"
							className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => setShowMethodology(!showMethodology)}
						>
							{showMethodology ? (
								<ChevronDown className="h-3 w-3" />
							) : (
								<ChevronRight className="h-3 w-3" />
							)}
							Methodology
						</button>
						{showMethodology && (
							<p className="mt-2 text-xs text-muted-foreground leading-relaxed">
								{report.methodology}
							</p>
						)}
					</div>
				)}

				{/* Sources (collapsible) */}
				{report.citedSources.length > 0 && (
					<div className="border-t pt-3">
						<button
							type="button"
							className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => setShowSources(!showSources)}
						>
							{showSources ? (
								<ChevronDown className="h-3 w-3" />
							) : (
								<ChevronRight className="h-3 w-3" />
							)}
							All Sources ({report.citedSources.length})
						</button>
						{showSources && (
							<div className="mt-2 space-y-1">
								{report.citedSources.map((source, idx) => {
									const config =
										SOURCE_TYPE_CONFIG[source.sourceType] ??
										SOURCE_TYPE_CONFIG["sub-agent"];
									const isUrl =
										source.source.startsWith("http");
									const num = source.sourceNumber ?? idx + 1;
									return (
										<div
											key={idx}
											className="flex items-center gap-2 text-xs"
										>
											<span className="shrink-0 font-mono text-muted-foreground w-7 text-right">
												[{num}]
											</span>
											<span
												className={cn(
													"shrink-0",
													config.color,
												)}
											>
												{config.icon}
											</span>
											{isUrl ? (
												<a
													href={source.source}
													target="_blank"
													rel="noopener noreferrer"
													className="text-primary hover:underline truncate flex items-center gap-1"
												>
													{(() => {
														try {
															return new URL(
																source.source,
															).hostname;
														} catch {
															return source.source;
														}
													})()}
													<ExternalLink className="h-2.5 w-2.5 shrink-0" />
												</a>
											) : (
												<span className="truncate text-muted-foreground">
													{source.source}
												</span>
											)}
										</div>
									);
								})}
							</div>
						)}
					</div>
				)}
			</CardContent>
		</Card>
	);
}
