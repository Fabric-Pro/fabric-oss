"use client";

/**
 * CugaVariablesInspector
 *
 * Displays the Variables Manager state from CUGA.
 * Shows variables with their types, values, and previews.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { ScrollArea } from "@ui/components/scroll-area";
import { cn } from "@ui/lib";
import { Check, ChevronDown, ChevronRight, Copy, Database } from "lucide-react";
import { useState } from "react";
import type { CugaVariable } from "./types";

interface CugaVariablesInspectorProps {
	variables: Record<string, CugaVariable>;
	className?: string;
}

function VariableItem({ variable }: { variable: CugaVariable }) {
	const [isExpanded, setIsExpanded] = useState(false);
	const [copied, setCopied] = useState(false);

	const handleCopy = async () => {
		await navigator.clipboard.writeText(
			JSON.stringify(variable.value, null, 2),
		);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const typeColors: Record<string, string> = {
		string: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
		number: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
		boolean:
			"bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
		array: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
		object: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
	};

	return (
		<div className="border rounded-lg p-3 bg-card hover:bg-muted/50 transition-colors">
			<div className="flex items-start justify-between gap-2">
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-1">
						<code className="text-sm font-mono font-medium text-foreground">
							{variable.name}
						</code>
						<Badge
							variant="secondary"
							className={cn(
								"text-xs",
								typeColors[variable.type] || "bg-muted",
							)}
						>
							{variable.type}
						</Badge>
						{variable.countItems !== undefined &&
							variable.countItems > 1 && (
								<Badge variant="outline" className="text-xs">
									{variable.countItems} items
								</Badge>
							)}
					</div>
					{variable.description && (
						<p className="text-xs text-muted-foreground mb-2">
							{variable.description}
						</p>
					)}
					<div className="text-xs text-muted-foreground font-mono bg-muted/50 rounded px-2 py-1 truncate">
						{variable.valuePreview ||
							JSON.stringify(variable.value).substring(0, 100)}
					</div>
				</div>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 w-7 p-0"
						onClick={handleCopy}
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
						className="h-7 w-7 p-0"
						onClick={() => setIsExpanded(true)}
					>
						<ChevronRight className="h-4 w-4" />
					</Button>
				</div>
			</div>

			{/* Full Value Dialog */}
			<Dialog open={isExpanded} onOpenChange={setIsExpanded}>
				<DialogContent className="max-w-2xl max-h-[80vh]">
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<code className="font-mono">{variable.name}</code>
							<Badge variant="secondary" className="text-xs">
								{variable.type}
							</Badge>
						</DialogTitle>
					</DialogHeader>
					<ScrollArea className="max-h-[60vh]">
						<pre className="bg-muted rounded-md p-4 text-xs font-mono overflow-x-auto">
							{JSON.stringify(variable.value, null, 2)}
						</pre>
					</ScrollArea>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export function CugaVariablesInspector({
	variables,
	className,
}: CugaVariablesInspectorProps) {
	const [isCollapsed, setIsCollapsed] = useState(false);
	const variableList = Object.values(variables);

	if (variableList.length === 0) {
		return null;
	}

	return (
		<div className={cn("rounded-lg border bg-card", className)}>
			{/* Header */}
			<button
				type="button"
				className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
				onClick={() => setIsCollapsed(!isCollapsed)}
			>
				<h3 className="text-sm font-medium flex items-center gap-2">
					<Database className="h-4 w-4" />
					Variables
					<Badge variant="secondary" className="text-xs">
						{variableList.length}
					</Badge>
				</h3>
				{isCollapsed ? (
					<ChevronRight className="h-4 w-4" />
				) : (
					<ChevronDown className="h-4 w-4" />
				)}
			</button>

			{/* Variables List */}
			{!isCollapsed && (
				<div className="px-4 pb-4 space-y-2">
					{variableList.map((variable) => (
						<VariableItem key={variable.name} variable={variable} />
					))}
				</div>
			)}
		</div>
	);
}
