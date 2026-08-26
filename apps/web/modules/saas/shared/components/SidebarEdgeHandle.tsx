"use client";

import { cn } from "@ui/lib";
import type React from "react";

interface SidebarEdgeHandleProps {
	isExpanded: boolean;
	onClick: () => void;
	expandLabel: string;
	collapseLabel: string;
	className?: string;
	expandedClassName?: string;
	collapsedClassName?: string;
	style?: React.CSSProperties;
}

export function SidebarEdgeHandle({
	isExpanded,
	onClick,
	expandLabel,
	collapseLabel,
	className,
	expandedClassName,
	collapsedClassName,
	style,
}: SidebarEdgeHandleProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={isExpanded ? collapseLabel : expandLabel}
			style={style}
			className={cn(
				"absolute top-1/2 z-40 hidden h-8 w-3 -translate-y-1/2 items-center justify-center rounded-full border border-border/80 bg-background shadow-sm transition-colors hover:bg-muted/60 md:flex",
				isExpanded
					? "left-full -translate-x-1/2"
					: "left-full -translate-x-1/2",
				isExpanded ? expandedClassName : collapsedClassName,
				className,
			)}
		>
			<span className="absolute inset-y-1.5 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-border/90" />
		</button>
	);
}
