"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	X,
	XCircle,
} from "lucide-react";
import { useState } from "react";

interface ValidationIssue {
	field: string;
	message: string;
	severity: "error" | "warning";
	nodeId?: string;
}

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	issues?: ValidationIssue[];
}

interface ValidationErrorsPanelProps {
	validation: ValidationResult | null;
	onDismiss?: () => void;
	onNodeClick?: (nodeId: string) => void;
	className?: string;
}

/**
 * Displays validation errors and warnings in the Workflow Builder.
 * Can be collapsed/expanded and links to specific nodes when possible.
 */
export function ValidationErrorsPanel({
	validation,
	onDismiss,
	onNodeClick,
	className,
}: ValidationErrorsPanelProps) {
	const [isExpanded, setIsExpanded] = useState(true);

	if (
		!validation ||
		(validation.errors.length === 0 && validation.warnings.length === 0)
	) {
		return null;
	}

	const hasErrors = validation.errors.length > 0;
	const hasWarnings = validation.warnings.length > 0;

	return (
		<div
			className={cn(
				"absolute top-4 left-1/2 -translate-x-1/2 z-50",
				"max-w-lg w-full mx-4",
				"bg-background border rounded-lg shadow-lg",
				hasErrors ? "border-destructive" : "border-yellow-500",
				className,
			)}
		>
			{/* Header */}
			<div
				className={cn(
					"flex items-center justify-between px-4 py-2 rounded-t-lg",
					hasErrors ? "bg-destructive/10" : "bg-yellow-500/10",
				)}
			>
				<button
					type="button"
					onClick={() => setIsExpanded(!isExpanded)}
					className="flex items-center gap-2 text-sm font-medium"
				>
					{isExpanded ? (
						<ChevronDown className="h-4 w-4" />
					) : (
						<ChevronRight className="h-4 w-4" />
					)}
					{hasErrors ? (
						<>
							<XCircle className="h-4 w-4 text-destructive" />
							<span className="text-destructive">
								Pre-flight Validation Failed (
								{validation.errors.length} error
								{validation.errors.length !== 1 ? "s" : ""})
							</span>
						</>
					) : (
						<>
							<AlertTriangle className="h-4 w-4 text-highlight" />
							<span className="text-yellow-700 dark:text-yellow-400">
								Validation Warnings (
								{validation.warnings.length})
							</span>
						</>
					)}
				</button>
				{onDismiss && (
					<Button variant="ghost" size="icon-sm" onClick={onDismiss}>
						<X className="h-4 w-4" />
					</Button>
				)}
			</div>

			{/* Content */}
			{isExpanded && (
				<div className="px-4 py-3 space-y-3 max-h-64 overflow-y-auto">
					{/* Errors */}
					{hasErrors && (
						<div className="space-y-1">
							{validation.errors.map((error, index) => (
								<div
									key={`error-${index}`}
									className="flex items-start gap-2 text-sm"
								>
									<XCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
									<span className="text-foreground">
										{error}
									</span>
								</div>
							))}
						</div>
					)}

					{/* Warnings */}
					{hasWarnings && (
						<div className="space-y-1">
							{hasErrors && <div className="border-t pt-2" />}
							{validation.warnings.map((warning, index) => (
								<div
									key={`warning-${index}`}
									className="flex items-start gap-2 text-sm"
								>
									<AlertTriangle className="h-4 w-4 text-highlight flex-shrink-0 mt-0.5" />
									<span className="text-muted-foreground">
										{warning}
									</span>
								</div>
							))}
						</div>
					)}

					{/* Detailed Issues (if provided) */}
					{validation.issues && validation.issues.length > 0 && (
						<div className="space-y-1 border-t pt-2">
							<p className="text-xs font-medium text-muted-foreground mb-1">
								Detailed Issues:
							</p>
							{validation.issues.map((issue, index) => (
								<div
									key={`issue-${index}`}
									className="flex items-start gap-2 text-sm"
								>
									{issue.severity === "error" ? (
										<XCircle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
									) : (
										<AlertTriangle className="h-4 w-4 text-highlight flex-shrink-0 mt-0.5" />
									)}
									<div className="flex-1 min-w-0">
										<span
											className={cn(
												issue.severity === "error"
													? "text-foreground"
													: "text-muted-foreground",
											)}
										>
											{issue.message}
										</span>
										{issue.nodeId && onNodeClick && (
											<button
												type="button"
												onClick={() =>
													// biome-ignore lint/style/noNonNullAssertion: nodeId is guaranteed by the truthy check above
													onNodeClick(issue.nodeId!)
												}
												className="ml-2 text-xs text-primary hover:underline"
											>
												Go to node →
											</button>
										)}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
