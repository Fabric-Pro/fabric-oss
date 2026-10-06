"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";

export const READ_ONLY_MCP_TAG = "read-only";

export function isReadOnlyMcpServer(
	serverOrConfig?: {
		tags?: string[] | null;
		mcpServer?: { tags?: string[] | null } | null;
	} | null,
): boolean {
	if (!serverOrConfig) {
		return false;
	}
	const hasOwnTag =
		Array.isArray(serverOrConfig.tags) &&
		serverOrConfig.tags.includes(READ_ONLY_MCP_TAG);
	const hasServerTag =
		Array.isArray(serverOrConfig.mcpServer?.tags) &&
		serverOrConfig.mcpServer.tags.includes(READ_ONLY_MCP_TAG);
	return hasOwnTag || hasServerTag;
}

export function ReadOnlyBadge({ className }: { className?: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					// biome-ignore lint/a11y/noNoninteractiveTabindex: Focusable span trigger for Radix tooltip
					tabIndex={0}
					data-testid="mcp-read-only-badge"
					className={cn(
						"rounded-sm border border-border bg-muted px-1.5 py-0 text-[10px] text-muted-foreground font-normal shrink-0 cursor-default outline-none focus-visible:ring-1 focus-visible:ring-ring h-4 leading-none inline-flex items-center select-none",
						className,
					)}
				>
					Read-only
				</span>
			</TooltipTrigger>
			<TooltipContent className="text-xs">
				Agents can read and inspect resources, but can't make changes.
			</TooltipContent>
		</Tooltip>
	);
}
