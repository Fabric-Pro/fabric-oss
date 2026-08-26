"use client";

/**
 * ToolCallList - Shared component for rendering tool calls
 *
 * Used by both Direct and Orchestrator chat modes for consistent
 * tool call visualization with inputs and outputs.
 * Includes special handling for chart artifacts from data analysis tools.
 */

import {
	extractFrameToolResult,
	type FrameToolResult,
	isFrameToolName,
} from "@saas/frames/lib/frame-result";
import {
	Tool,
	ToolContent,
	ToolHeader,
	ToolInput,
	ToolOutput,
} from "../../../../../../components/ai-elements/tool";
import { ChartCard, isChartArtifact } from "../cards/ChartCard";
import type { ToolCallItem } from "./types";

export interface ToolCallListProps {
	toolCalls: ToolCallItem[];
	defaultOpen?: boolean;
	className?: string;
	/** Function to get display name for tool (e.g., strip prefixes) */
	getDisplayName?: (name: string) => string;
	/** Function to get input summary for collapsed state */
	getInputSummary?: (args: unknown) => string | undefined;
	activeFrameId?: string | null;
	onOpenFrame?: (frame: FrameToolResult) => void;
	/**
	 * When false, tools render as static pills — no expand chevron, no
	 * JSON Parameters/Result dump. Use on surfaces that intentionally hide
	 * tool internals (Fabric Loom launcher). Default true preserves
	 * Orchestrator chat and other call sites that rely on inspection.
	 */
	expandable?: boolean;
}

function getToolState(
	status: ToolCallItem["status"],
): "input-available" | "output-available" | "output-error" {
	switch (status) {
		case "pending":
		case "running":
			return "input-available";
		case "success":
		case "complete":
			return "output-available";
		case "error":
			return "output-error";
		default:
			return "output-available";
	}
}

function defaultGetInputSummary(args: unknown): string | undefined {
	if (!args || typeof args !== "object") {
		return undefined;
	}
	const obj = args as Record<string, unknown>;
	const keys = Object.keys(obj);
	if (keys.length === 0) {
		return undefined;
	}

	// Try to find a meaningful summary field
	const summaryFields = [
		"path",
		"file_path",
		"query",
		"command",
		"url",
		"name",
		"message",
	];
	for (const field of summaryFields) {
		if (obj[field] && typeof obj[field] === "string") {
			const value = obj[field] as string;
			return value.length > 50 ? `${value.slice(0, 50)}...` : value;
		}
	}

	// Fall back to first string field
	for (const key of keys) {
		if (typeof obj[key] === "string") {
			const value = obj[key] as string;
			return value.length > 50 ? `${value.slice(0, 50)}...` : value;
		}
	}

	return undefined;
}

// Chart artifact type matching ChartCard's expected prop
interface ChartArtifactData {
	type: "chart";
	id: string;
	chartType: "line" | "bar" | "pie" | "area" | "scatter";
	data: Record<string, unknown>[];
	config: {
		xAxis: string;
		yAxis: string | string[];
		title?: string;
		series?: string;
		stacked?: boolean;
		showLegend?: boolean;
	};
	metadata?: {
		createdAt?: string;
		sourceDescription?: string;
		dataPointCount?: number;
	};
}

/**
 * Try to extract a chart artifact from a tool result
 * Returns the artifact if found, null otherwise
 */
function extractChartArtifact(result: unknown): ChartArtifactData | null {
	if (!result) {
		console.log("[extractChartArtifact] No result provided");
		return null;
	}

	console.log("[extractChartArtifact] Checking result:", {
		type: typeof result,
		isString: typeof result === "string",
		preview:
			typeof result === "string"
				? result.slice(0, 200)
				: JSON.stringify(result).slice(0, 200),
	});

	// Direct chart artifact
	if (isChartArtifact(result)) {
		console.log("[extractChartArtifact] Found direct chart artifact");
		return result as ChartArtifactData;
	}

	// Check if result is a JSON string
	if (typeof result === "string") {
		try {
			const parsed = JSON.parse(result);
			console.log(
				"[extractChartArtifact] Parsed JSON, checking for artifact:",
				{
					hasArtifact: !!parsed.artifact,
					parsedType: typeof parsed,
				},
			);
			// Check for chart artifact wrapped in response
			if (parsed.artifact && isChartArtifact(parsed.artifact)) {
				console.log(
					"[extractChartArtifact] Found artifact in parsed.artifact",
				);
				return parsed.artifact as ChartArtifactData;
			}
			// Check if the parsed result itself is a chart artifact
			if (isChartArtifact(parsed)) {
				console.log(
					"[extractChartArtifact] Parsed result is a chart artifact",
				);
				return parsed as ChartArtifactData;
			}
		} catch (e) {
			console.log("[extractChartArtifact] Failed to parse JSON:", e);
		}
	}

	// Check for nested artifact in object
	if (typeof result === "object" && result !== null) {
		const obj = result as Record<string, unknown>;
		console.log("[extractChartArtifact] Checking object for artifact:", {
			hasArtifact: !!obj.artifact,
			hasArtifacts: Array.isArray(obj.artifacts),
			keys: Object.keys(obj).slice(0, 10),
		});
		if (obj.artifact && isChartArtifact(obj.artifact)) {
			console.log(
				"[extractChartArtifact] Found artifact in obj.artifact",
			);
			return obj.artifact as ChartArtifactData;
		}
		// Check artifacts array
		if (Array.isArray(obj.artifacts)) {
			const chartArtifact = obj.artifacts.find(isChartArtifact);
			if (chartArtifact) {
				console.log(
					"[extractChartArtifact] Found chart in artifacts array",
				);
				return chartArtifact as ChartArtifactData;
			}
		}
	}

	console.log("[extractChartArtifact] No chart artifact found");
	return null;
}

/**
 * Check if a tool call is for chart creation
 */
function isChartTool(toolName: string): boolean {
	return toolName === "create_chart" || toolName.endsWith("_create_chart");
}

function extractAuthorityState(result: unknown): {
	authorityRequired: boolean;
	providerKey?: string;
	requiredAccessLevel?: string;
	pendingSessionId?: string;
	hint?: string;
} | null {
	if (!result || typeof result !== "object") {
		return null;
	}

	const obj = result as Record<string, unknown>;
	if (!obj.authorityRequired) {
		return null;
	}

	return {
		authorityRequired: true,
		providerKey:
			typeof obj.providerKey === "string" ? obj.providerKey : undefined,
		requiredAccessLevel:
			typeof obj.requiredAccessLevel === "string"
				? obj.requiredAccessLevel
				: undefined,
		pendingSessionId:
			typeof obj.pendingSessionId === "string"
				? obj.pendingSessionId
				: undefined,
		hint: typeof obj.hint === "string" ? obj.hint : undefined,
	};
}

export function ToolCallList({
	toolCalls,
	defaultOpen = false,
	className,
	getDisplayName,
	getInputSummary = defaultGetInputSummary,
	activeFrameId,
	onOpenFrame,
	expandable = true,
}: ToolCallListProps) {
	if (!toolCalls || toolCalls.length === 0) {
		return null;
	}

	// Debug logging for chart tool detection
	console.log(
		"[ToolCallList] Rendering tool calls:",
		toolCalls.map((tc) => ({
			name: tc.name,
			isChartTool: isChartTool(tc.name),
			hasResult: tc.result !== undefined && tc.result !== null,
			resultType: typeof tc.result,
		})),
	);

	return (
		<div className={className}>
			<div className="space-y-2">
				{toolCalls.map((toolCall) => {
					const displayName = getDisplayName
						? getDisplayName(toolCall.name)
						: toolCall.name;
					const title = toolCall.serverName
						? `${displayName} (${toolCall.serverName})`
						: displayName;
					const inputSummary = getInputSummary(toolCall.args);

					// Check if this is a chart tool with a chart artifact result
					const isChart = isChartTool(toolCall.name);
					console.log(
						`[ToolCallList] Tool "${toolCall.name}" isChartTool: ${isChart}`,
					);
					const chartArtifact = isChart
						? extractChartArtifact(toolCall.result)
						: null;
					const frameResult = isFrameToolName(toolCall.name)
						? extractFrameToolResult(toolCall.result)
						: null;
					const authorityState = extractAuthorityState(
						toolCall.result,
					);
					console.log(
						"[ToolCallList] Chart artifact extracted:",
						chartArtifact ? "YES" : "NO",
					);

					// If we have a chart artifact, render ChartCard instead of tool output
					if (chartArtifact) {
						return (
							<div key={toolCall.id} className="space-y-2">
								<Tool
									defaultExpanded={false}
									expandable={expandable}
									toolName={toolCall.name}
								>
									<ToolHeader
										title={title}
										type="tool-invocation"
										state={getToolState(toolCall.status)}
										inputSummary={
											chartArtifact.config.title ||
											"Chart created"
										}
									/>
									<ToolContent>
										{Object.keys(
											(toolCall.args as object) || {},
										).length > 0 && (
											<ToolInput input={toolCall.args} />
										)}
									</ToolContent>
								</Tool>
								<ChartCard artifact={chartArtifact} />
							</div>
						);
					}

					return (
						<div key={toolCall.id} className="space-y-2">
							<Tool
								defaultExpanded={defaultOpen}
								expandable={expandable}
								toolName={toolCall.name}
							>
								<ToolHeader
									title={title}
									type="tool-invocation"
									state={getToolState(toolCall.status)}
									inputSummary={inputSummary}
								/>
								<ToolContent>
									{Object.keys(
										(toolCall.args as object) || {},
									).length > 0 && (
										<ToolInput input={toolCall.args} />
									)}
									{toolCall.result !== undefined &&
										toolCall.status !== "error" && (
											<ToolOutput
												output={toolCall.result}
												errorText={undefined}
											/>
										)}
								</ToolContent>
							</Tool>
							{/*
							 * Error / authority surfaces (PR 1093 review #1+#2).
							 *
							 * The error message and Runtime-Authority recovery
							 * banner USED to live inside <ToolContent>, which
							 * meant a Tool rendered with expandable={false}
							 * (Fabric Loom) silently hid both — users saw only
							 * the red "Error" status badge with no actionable
							 * info. Lift them OUT so they always render
							 * alongside the tool card, regardless of expand
							 * state. Same pattern as the frameResult panel
							 * below.
							 *
							 * In expandable surfaces (Orchestrator chat) this
							 * means the banner is also always visible — a
							 * small UX upgrade (errors no longer require a
							 * click to see).
							 */}
							{toolCall.status === "error" && (
								<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
									<p className="font-medium">Error</p>
									<p className="mt-1 wrap-break-word">
										{/* `JSON.stringify(undefined)` returns
										    undefined, not a string, so a call
										    carrying neither an error nor a
										    result used to render this box
										    empty - a red "Error" heading over
										    nothing at all. */}
										{toolCall.error ||
											(typeof toolCall.result === "string"
												? toolCall.result
												: toolCall.result !== undefined
													? JSON.stringify(
															toolCall.result,
														)
													: "This tool reported an error but sent no details.")}
									</p>
								</div>
							)}
							{authorityState && (
								<div className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
									<p className="font-medium">
										Runtime authority required
									</p>
									<p className="mt-1">
										Approve{" "}
										{authorityState.providerKey ||
											"this provider"}
										{authorityState.requiredAccessLevel
											? ` (${authorityState.requiredAccessLevel})`
											: ""}{" "}
										in Runtime Authority, then retry.
									</p>
									{authorityState.pendingSessionId && (
										<p className="mt-1 text-[11px] opacity-80">
											Session:{" "}
											{authorityState.pendingSessionId}
										</p>
									)}
									{authorityState.hint && (
										<p className="mt-1 text-[11px] opacity-80">
											{authorityState.hint}
										</p>
									)}
								</div>
							)}
							{frameResult ? (
								<div className="mt-2 rounded-md border border-border/60 bg-background/80 px-3 py-2 text-xs text-muted-foreground">
									<p className="font-medium text-foreground">
										Interactive content ready
									</p>
									<p className="mt-1">
										{activeFrameId === frameResult.frameId
											? "Opened in the interactive content panel."
											: "Open this frame in the interactive content panel."}
									</p>
									{onOpenFrame ? (
										<button
											type="button"
											onClick={() =>
												onOpenFrame(frameResult)
											}
											className="mt-2 font-medium text-foreground transition-colors hover:text-primary"
										>
											{activeFrameId ===
											frameResult.frameId
												? "Re-open interactive content"
												: "Open interactive content"}
										</button>
									) : null}
								</div>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}
