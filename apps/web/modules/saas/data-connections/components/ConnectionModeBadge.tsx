/**
 * ConnectionModeBadge Component
 *
 * Displays the connection mode (Knowledge / Action / Hybrid) for a data source.
 */

"use client";

import { Badge } from "@ui/components/badge";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { Layers, Search, Zap } from "lucide-react";
import { CONNECTION_MODE_CONFIG, type ConnectionMode } from "../lib/providers";

const MODE_ICONS: Record<
	ConnectionMode,
	React.ComponentType<{ className?: string }>
> = {
	knowledge: Search,
	action: Zap,
	hybrid: Layers,
};

interface ConnectionModeBadgeProps {
	mode: ConnectionMode;
	className?: string;
}

export function ConnectionModeBadge({
	mode,
	className,
}: ConnectionModeBadgeProps) {
	const config = CONNECTION_MODE_CONFIG[mode];
	const Icon = MODE_ICONS[mode];

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Badge
						variant="outline"
						className={cn(
							"flex items-center gap-1 text-xs",
							config.bgColor,
							config.color,
							"border-transparent",
							className,
						)}
					>
						<Icon className="h-3 w-3" />
						{config.label}
					</Badge>
				</TooltipTrigger>
				<TooltipContent>
					<p className="text-xs">{config.description}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
