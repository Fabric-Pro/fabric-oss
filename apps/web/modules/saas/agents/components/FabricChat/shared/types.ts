import type { ComponentType, ReactNode } from "react";

/**
 * Shared types for FabricChat components
 * Used by both Direct and Orchestrator chat modes
 */

/** Tool call item for rendering */
export interface ToolCallItem {
	id: string;
	name: string;
	serverName?: string;
	args: unknown;
	result?: unknown;
	/** Status of the tool call - supports both "success"/"complete" for compatibility */
	status: "pending" | "running" | "success" | "complete" | "error";
	durationMs?: number;
	error?: string;
}

/** Quick suggestion for welcome screen */
export interface QuickSuggestion {
	label: string;
	icon: ReactNode;
	value: string;
}

/** Example category for welcome screen */
export interface ExampleCategory {
	icon: ComponentType<{ className?: string }>;
	title: string;
	examples: string[];
	color: string;
	bgColor: string;
}
