"use client";

import { Button } from "@ui/components/button";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ui/components/hover-card";
import { cn } from "@ui/lib";
import * as React from "react";
import { getUsage, type ModelId } from "tokenlens";

// ============================================================================
// Types
// ============================================================================

/**
 * Language model usage following AI SDK conventions
 */
export interface LanguageModelUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
}

/**
 * Context value shared via React Context
 */
interface ContextValue {
	maxTokens?: number;
	usedTokens?: number;
	usage?: LanguageModelUsage;
	modelId?: ModelId;
	percentage: number;
}

const ContextContext = React.createContext<ContextValue | null>(null);

function useContextValue(): ContextValue {
	const context = React.useContext(ContextContext);
	if (!context) {
		throw new Error("Context components must be used within <Context>");
	}
	return context;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format token count with compact notation (K, M, B)
 */
function formatTokens(tokens: number | undefined): string {
	if (tokens === undefined) {
		return "—";
	}
	return new Intl.NumberFormat("en-US", {
		notation: "compact",
	}).format(tokens);
}

/**
 * Format currency with USD style
 */
function formatCurrency(amount: number | undefined): string {
	if (amount === undefined) {
		return "—";
	}
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(amount);
}

// ============================================================================
// Circular Progress Ring Component
// ============================================================================

interface ProgressRingProps {
	percentage: number;
	size?: number;
	strokeWidth?: number;
	className?: string;
}

function ProgressRing({
	percentage,
	size = 24,
	strokeWidth = 2.5,
	className,
}: ProgressRingProps) {
	const radius = (size - strokeWidth) / 2;
	const circumference = radius * 2 * Math.PI;
	const offset = circumference - (percentage / 100) * circumference;

	return (
		<svg
			width={size}
			height={size}
			className={cn("transform -rotate-90", className)}
		>
			<title>{`Context usage ${percentage.toFixed(1)}%`}</title>
			{/* Background circle */}
			<circle
				cx={size / 2}
				cy={size / 2}
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				className="text-muted/30"
			/>
			{/* Progress circle */}
			<circle
				cx={size / 2}
				cy={size / 2}
				r={radius}
				fill="none"
				stroke="currentColor"
				strokeWidth={strokeWidth}
				strokeDasharray={circumference}
				strokeDashoffset={offset}
				strokeLinecap="round"
				className={cn(
					"transition-all duration-300",
					percentage >= 90
						? "text-destructive"
						: percentage >= 70
							? "text-yellow-500"
							: "text-primary",
				)}
			/>
		</svg>
	);
}

// ============================================================================
// Main Context Component (Root Provider)
// ============================================================================

export type ContextProps = React.ComponentProps<typeof HoverCard> & {
	/** Maximum context window tokens for the model */
	maxTokens?: number;
	/** Currently used tokens */
	usedTokens?: number;
	/** Detailed usage breakdown from AI SDK */
	usage?: LanguageModelUsage;
	/** Model ID for cost calculation (e.g., "openai:gpt-4") */
	modelId?: ModelId;
};

export function Context({
	maxTokens = 128_000,
	usedTokens = 0,
	usage,
	modelId,
	children,
	...props
}: ContextProps) {
	const totalUsed = usedTokens || usage?.totalTokens || 0;
	const percentage =
		maxTokens > 0 ? Math.min((totalUsed / maxTokens) * 100, 100) : 0;

	const contextValue: ContextValue = {
		maxTokens,
		usedTokens: totalUsed,
		usage,
		modelId,
		percentage,
	};

	return (
		<ContextContext.Provider value={contextValue}>
			<HoverCard {...props}>{children}</HoverCard>
		</ContextContext.Provider>
	);
}

// ============================================================================
// Context Trigger (Button that shows percentage + progress ring)
// ============================================================================

export type ContextTriggerProps = React.ComponentProps<typeof Button>;

export function ContextTrigger({
	className,
	children,
	...props
}: ContextTriggerProps) {
	const { percentage } = useContextValue();

	return (
		<HoverCardTrigger asChild>
			<Button
				variant="ghost"
				size="sm"
				className={cn(
					"h-auto px-2.5 py-1.5 text-xs font-medium gap-1.5",
					className,
				)}
				{...props}
			>
				{children ?? (
					<>
						<span>{percentage.toFixed(1)}%</span>
						<ProgressRing
							percentage={percentage}
							size={18}
							strokeWidth={2}
						/>
					</>
				)}
			</Button>
		</HoverCardTrigger>
	);
}

// ============================================================================
// Context Content (HoverCard Content Wrapper)
// ============================================================================

export type ContextContentProps = React.ComponentProps<typeof HoverCardContent>;

export function ContextContent({
	className,
	children,
	...props
}: ContextContentProps) {
	return (
		<HoverCardContent
			className={cn("w-64 p-0", className)}
			side="top"
			{...props}
		>
			{children}
		</HoverCardContent>
	);
}

// ============================================================================
// Context Content Header (Shows percentage, progress bar, token counts)
// ============================================================================

export type ContextContentHeaderProps = React.ComponentProps<"div">;

export function ContextContentHeader({
	className,
	children,
	...props
}: ContextContentHeaderProps) {
	const { percentage, usedTokens, maxTokens } = useContextValue();

	if (children) {
		return (
			<div className={cn("p-3 border-b", className)} {...props}>
				{children}
			</div>
		);
	}

	return (
		<div className={cn("p-3 border-b space-y-2", className)} {...props}>
			<div className="flex items-center justify-between text-sm">
				<span className="font-medium">{percentage.toFixed(1)}%</span>
				<span className="text-muted-foreground">
					{formatTokens(usedTokens)} / {formatTokens(maxTokens)}
				</span>
			</div>
			{/* Progress bar */}
			<div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
				<div
					className={cn(
						"h-full transition-all duration-300 rounded-full",
						percentage >= 90
							? "bg-destructive"
							: percentage >= 70
								? "bg-yellow-500"
								: "bg-primary",
					)}
					style={{ width: `${Math.min(percentage, 100)}%` }}
				/>
			</div>
		</div>
	);
}

// ============================================================================
// Context Content Body (Container for usage rows)
// ============================================================================

export type ContextContentBodyProps = React.ComponentProps<"div">;

export function ContextContentBody({
	className,
	children,
	...props
}: ContextContentBodyProps) {
	return (
		<div className={cn("p-3 space-y-1.5", className)} {...props}>
			{children}
		</div>
	);
}

// ============================================================================
// Context Content Footer (Shows total cost)
// ============================================================================

export type ContextContentFooterProps = React.ComponentProps<"div">;

export function ContextContentFooter({
	className,
	children,
	...props
}: ContextContentFooterProps) {
	const { usage, modelId } = useContextValue();

	if (children) {
		return (
			<div className={cn("p-3 border-t", className)} {...props}>
				{children}
			</div>
		);
	}

	// Calculate total cost if modelId is provided
	let totalCost: number | undefined;
	if (modelId && usage) {
		try {
			const result = getUsage({
				modelId,
				usage: {
					input: usage.inputTokens ?? 0,
					output: usage.outputTokens ?? 0,
					reasoningTokens: usage.reasoningTokens,
					cacheReads: usage.cachedInputTokens,
				},
			});
			totalCost = result.costUSD?.totalUSD;
		} catch {
			// Model not found in tokenlens
		}
	}

	return (
		<div
			className={cn(
				"p-3 border-t flex items-center justify-between text-xs",
				className,
			)}
			{...props}
		>
			<span className="text-muted-foreground">Total cost</span>
			<span className="font-medium">{formatCurrency(totalCost)}</span>
		</div>
	);
}

// ============================================================================
// Token Usage Row Components
// ============================================================================

interface TokensWithCostProps {
	tokens?: number;
	costText?: string;
}

function TokensWithCost({ tokens, costText }: TokensWithCostProps) {
	return (
		<span>
			{formatTokens(tokens)}
			{costText && tokens !== undefined && (
				<span className="ml-2 text-muted-foreground">• {costText}</span>
			)}
		</span>
	);
}

export type ContextInputUsageProps = React.ComponentProps<"div">;

export function ContextInputUsage({
	className,
	children,
	...props
}: ContextInputUsageProps) {
	const { usage, modelId } = useContextValue();
	const inputTokens = usage?.inputTokens ?? 0;

	if (children) {
		return <>{children}</>;
	}

	let inputCost: number | undefined;
	if (modelId && inputTokens) {
		try {
			const result = getUsage({
				modelId,
				usage: { input: inputTokens, output: 0 },
			});
			inputCost = result.costUSD?.inputUSD;
		} catch {
			// Ignore
		}
	}
	const inputCostText =
		inputCost !== undefined ? formatCurrency(inputCost) : undefined;

	return (
		<div
			className={cn(
				"flex items-center justify-between text-xs",
				className,
			)}
			{...props}
		>
			<span className="text-muted-foreground">Input</span>
			<TokensWithCost tokens={inputTokens} costText={inputCostText} />
		</div>
	);
}

export type ContextOutputUsageProps = React.ComponentProps<"div">;

export function ContextOutputUsage({
	className,
	children,
	...props
}: ContextOutputUsageProps) {
	const { usage, modelId } = useContextValue();
	const outputTokens = usage?.outputTokens ?? 0;

	if (children) {
		return <>{children}</>;
	}

	let outputCost: number | undefined;
	if (modelId && outputTokens) {
		try {
			const result = getUsage({
				modelId,
				usage: { input: 0, output: outputTokens },
			});
			outputCost = result.costUSD?.outputUSD;
		} catch {
			// Ignore
		}
	}
	const outputCostText =
		outputCost !== undefined ? formatCurrency(outputCost) : undefined;

	return (
		<div
			className={cn(
				"flex items-center justify-between text-xs",
				className,
			)}
			{...props}
		>
			<span className="text-muted-foreground">Output</span>
			<TokensWithCost tokens={outputTokens} costText={outputCostText} />
		</div>
	);
}

export type ContextReasoningUsageProps = React.ComponentProps<"div">;

export function ContextReasoningUsage({
	className,
	children,
	...props
}: ContextReasoningUsageProps) {
	const { usage, modelId } = useContextValue();
	const reasoningTokens = usage?.reasoningTokens ?? 0;

	if (children) {
		return <>{children}</>;
	}
	if (!reasoningTokens) {
		return null;
	}

	let reasoningCost: number | undefined;
	if (modelId && reasoningTokens) {
		try {
			const result = getUsage({
				modelId,
				usage: { reasoningTokens, input: 0, output: 0 },
			});
			reasoningCost = result.costUSD?.totalUSD;
		} catch {
			// Ignore
		}
	}
	const reasoningCostText =
		reasoningCost !== undefined ? formatCurrency(reasoningCost) : undefined;

	return (
		<div
			className={cn(
				"flex items-center justify-between text-xs",
				className,
			)}
			{...props}
		>
			<span className="text-muted-foreground">Reasoning</span>
			<TokensWithCost
				tokens={reasoningTokens}
				costText={reasoningCostText}
			/>
		</div>
	);
}

// ============================================================================
// Context Badge (Standalone badge component)
// ============================================================================

interface ContextBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
	label: string;
	value: string | number;
	variant?: "default" | "success" | "warning" | "error";
}

export function ContextBadge({
	label,
	value,
	variant = "default",
	className,
	...props
}: ContextBadgeProps) {
	const variantStyles = {
		default: "bg-muted text-muted-foreground",
		success: "bg-green-500/10 text-green-600 dark:text-green-400",
		warning: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
		error: "bg-red-500/10 text-red-600 dark:text-red-400",
	};

	return (
		<div
			className={cn(
				"inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium",
				variantStyles[variant],
				className,
			)}
			{...props}
		>
			<span className="text-muted-foreground">{label}:</span>
			<span>{value}</span>
		</div>
	);
}
