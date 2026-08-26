"use client";

/**
 * CugaCodePanel
 *
 * Displays code execution from CUGA's Code Agent.
 * Shows code, output, and execution status with collapsible sections.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import {
	Check,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Code2,
	Copy,
	Loader2,
	Terminal,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import type { CugaCodeExecution } from "./types";

interface CugaCodePanelProps {
	execution: CugaCodeExecution;
	className?: string;
}

const STATUS_CONFIG = {
	pending: {
		icon: <Terminal className="h-4 w-4" />,
		label: "Pending",
		color: "bg-muted",
	},
	running: {
		icon: <Loader2 className="h-4 w-4 animate-spin" />,
		label: "Running",
		color: "bg-blue-100 text-blue-700",
	},
	complete: {
		icon: <CheckCircle2 className="h-4 w-4" />,
		label: "Complete",
		color: "bg-green-100 text-green-700",
	},
	failed: {
		icon: <XCircle className="h-4 w-4" />,
		label: "Failed",
		color: "bg-red-100 text-red-700",
	},
};

function getCodeSnippet(code: string, maxLines = 6): string {
	const lines = code.split("\n");
	if (lines.length <= maxLines) {
		return code;
	}
	return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

function truncateOutput(text: string, maxLength = 500): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength)}...`;
}

export function CugaCodePanel({ execution, className }: CugaCodePanelProps) {
	const [showFullCode, setShowFullCode] = useState(false);
	const [showFullOutput, setShowFullOutput] = useState(false);
	const [copied, setCopied] = useState(false);

	const codeLines = execution.code.split("\n").length;
	const statusConfig = STATUS_CONFIG[execution.status];

	const handleCopyCode = async () => {
		await navigator.clipboard.writeText(execution.code);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className={cn("rounded-lg border bg-card p-4", className)}>
			{/* Header */}
			<div className="flex items-center justify-between mb-3">
				<h3 className="text-sm font-medium flex items-center gap-2">
					<Code2 className="h-4 w-4" />
					Code Execution
				</h3>
				<div className="flex items-center gap-2">
					{execution.sandbox && (
						<Badge variant="outline" className="text-xs">
							{execution.sandbox}
						</Badge>
					)}
					<Badge className={cn("text-xs", statusConfig.color)}>
						{statusConfig.icon}
						<span className="ml-1">{statusConfig.label}</span>
					</Badge>
				</div>
			</div>

			{/* Code Section */}
			<div className="mb-3">
				<div className="flex items-center justify-between mb-2">
					<span className="text-xs text-muted-foreground">
						{execution.language} ({codeLines} lines)
					</span>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2"
							onClick={handleCopyCode}
						>
							{copied ? (
								<Check className="h-3 w-3" />
							) : (
								<Copy className="h-3 w-3" />
							)}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 px-2 text-xs"
							onClick={() => setShowFullCode(!showFullCode)}
						>
							{showFullCode ? (
								<ChevronUp className="h-3 w-3" />
							) : (
								<ChevronDown className="h-3 w-3" />
							)}
							{showFullCode ? "Less" : "More"}
						</Button>
					</div>
				</div>
				<ScrollArea className="max-h-64">
					<pre className="bg-zinc-900 dark:bg-zinc-950 rounded-md p-3 text-xs font-mono text-green-400 overflow-x-auto">
						{showFullCode
							? execution.code
							: getCodeSnippet(execution.code)}
					</pre>
				</ScrollArea>
			</div>

			{/* Output Section */}
			{(execution.output || execution.error) && (
				<div>
					<div className="flex items-center justify-between mb-2">
						<span className="text-xs text-muted-foreground flex items-center gap-1">
							<Terminal className="h-3 w-3" />
							Output
						</span>
						{execution.output && execution.output.length > 500 && (
							<Button
								variant="ghost"
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() =>
									setShowFullOutput(!showFullOutput)
								}
							>
								{showFullOutput ? (
									<ChevronUp className="h-3 w-3" />
								) : (
									<ChevronDown className="h-3 w-3" />
								)}
								{showFullOutput ? "Less" : "More"}
							</Button>
						)}
					</div>
					<ScrollArea className="max-h-48">
						<div
							className={cn(
								"rounded-md p-3 text-xs",
								execution.error
									? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400"
									: "bg-muted text-foreground",
							)}
						>
							<pre className="whitespace-pre-wrap font-mono">
								{execution.error ||
									(showFullOutput
										? execution.output
										: truncateOutput(
												execution.output || "",
											))}
							</pre>
						</div>
					</ScrollArea>
				</div>
			)}

			{/* Stats */}
			{execution.executionTimeMs && (
				<div className="mt-3 pt-3 border-t flex items-center gap-4 text-xs text-muted-foreground">
					<span>⏱️ {execution.executionTimeMs}ms</span>
					{execution.variables && execution.variables.length > 0 && (
						<span>📊 {execution.variables.length} variables</span>
					)}
				</div>
			)}
		</div>
	);
}
