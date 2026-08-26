"use client";

import { cn } from "@ui/lib";
import type { ReactNode } from "react";

interface GlassCardProps {
	children: ReactNode;
	className?: string;
	gradient?: string;
	hover?: boolean;
	padding?: "none" | "sm" | "md" | "lg";
	onClick?: () => void;
	/** Required when onClick is provided — describes the action for screen readers */
	ariaLabel?: string;
}

const paddingMap = {
	none: "",
	sm: "p-4",
	md: "p-5",
	lg: "p-6",
};

export function GlassCard({
	children,
	className,
	hover = false,
	padding = "md",
	onClick,
	ariaLabel,
}: GlassCardProps) {
	const interactive = !!onClick;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: role, tabIndex, and keyboard handler are set conditionally when onClick is provided
		// biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-label is valid when role="button" is set; Biome cannot analyze the conditional role
		<div
			className={cn(
				"group relative overflow-hidden rounded-xl border bg-card transition-colors",
				hover && "hover:border-primary/30 hover:bg-muted/40",
				interactive &&
					"cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
				paddingMap[padding],
				className,
			)}
			onClick={onClick}
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			aria-label={interactive ? ariaLabel : undefined}
			onKeyDown={
				interactive
					? (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onClick?.();
							}
						}
					: undefined
			}
		>
			{children}
		</div>
	);
}
