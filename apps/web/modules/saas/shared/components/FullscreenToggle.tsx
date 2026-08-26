"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { useFullscreen } from "../contexts/FullscreenContext";

interface FullscreenToggleProps {
	variant?: "floating" | "inline";
	className?: string;
}

/**
 * Fullscreen toggle button that can be rendered as a floating control
 * (default) or inline when embedded inside other toolbars.
 */
export function FullscreenToggle({
	variant = "floating",
	className,
}: FullscreenToggleProps) {
	const { isFullscreen, setIsFullscreen } = useFullscreen();

	const buttonClasses = cn(
		"rounded-lg border bg-card",
		variant === "floating"
			? "fixed right-8 top-8 z-50 shadow-lg hover:bg-accent"
			: "shadow-sm hover:bg-muted",
		className,
	);

	return (
		<Button
			variant="ghost"
			size="icon"
			className={buttonClasses}
			onClick={() => setIsFullscreen(!isFullscreen)}
			aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
		>
			{isFullscreen ? (
				<Minimize2Icon className="size-4" aria-hidden="true" />
			) : (
				<Maximize2Icon className="size-4" aria-hidden="true" />
			)}
		</Button>
	);
}
