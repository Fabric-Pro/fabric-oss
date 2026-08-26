"use client";

import { FabricLogo } from "@saas/shared/components/FabricLogo";

interface AiGeneratingIndicatorProps {
	text?: string;
	className?: string;
}

export function AiGeneratingIndicator({
	text = "Generating",
	className = "",
}: AiGeneratingIndicatorProps) {
	return (
		<div
			className={`flex items-center gap-2 px-4 py-1.5 rounded-full bg-foreground shadow-md ${className}`}
		>
			<FabricLogo
				className="size-3.5 opacity-80"
				size={14}
				variant="inverse"
			/>
			<span className="text-sm font-medium text-background">{text}</span>
			<span className="flex items-center gap-1">
				<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:0ms]" />
				<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:150ms]" />
				<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:300ms]" />
			</span>
		</div>
	);
}
