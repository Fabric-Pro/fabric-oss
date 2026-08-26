"use client";

import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@ui/lib";
import { AlertTriangleIcon } from "lucide-react";
import * as React from "react";
import { TooltipProvider, TooltipTrigger } from "./tooltip";

export type DestructiveTooltipCopy = {
	label: string;
	warning: string;
};

export type DestructiveTooltipProps = {
	copy: DestructiveTooltipCopy;
	children: React.ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	delayDuration?: number;
};

// Track the most recent input modality at the document level.
// Radix fires onFocus for both keyboard tabbing and pointer-induced focus,
// and jsdom's :focus-visible matching is unreliable, so we infer modality
// from the last input event instead of relying on CSS :focus-visible.
function useLastInputModality(): React.RefObject<"keyboard" | "pointer"> {
	const modalityRef = React.useRef<"keyboard" | "pointer">("pointer");

	React.useEffect(() => {
		const handleKeyDown = () => {
			modalityRef.current = "keyboard";
		};
		const handlePointer = () => {
			modalityRef.current = "pointer";
		};

		document.addEventListener("keydown", handleKeyDown, true);
		document.addEventListener("pointerdown", handlePointer, true);
		document.addEventListener("mousedown", handlePointer, true);

		return () => {
			document.removeEventListener("keydown", handleKeyDown, true);
			document.removeEventListener("pointerdown", handlePointer, true);
			document.removeEventListener("mousedown", handlePointer, true);
		};
	}, []);

	return modalityRef;
}

export function DestructiveTooltip({
	copy,
	children,
	side = "top",
	delayDuration,
}: DestructiveTooltipProps) {
	const [isKeyboardFocus, setIsKeyboardFocus] = React.useState(false);
	const modalityRef = useLastInputModality();

	return (
		<TooltipProvider delayDuration={delayDuration}>
			<TooltipPrimitive.Root
				onOpenChange={(open) => {
					if (!open) {
						setIsKeyboardFocus(false);
					}
				}}
			>
				<TooltipTrigger
					asChild
					onFocus={() => {
						if (modalityRef.current === "keyboard") {
							setIsKeyboardFocus(true);
						}
					}}
					onBlur={() => setIsKeyboardFocus(false)}
					onPointerEnter={() => setIsKeyboardFocus(false)}
				>
					{children}
				</TooltipTrigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						data-slot="destructive-tooltip-content"
						side={side}
						sideOffset={4}
						className={cn(
							"animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
							"data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
							"z-50 max-w-xs text-xs text-balance",
						)}
					>
						{/* Radix v1.2 renders role="tooltip" on a VisuallyHidden child, not on
							the visible Content element. We render the role on an explicit inner
							<div> so hover keeps role="tooltip" and keyboard-focus upgrades to
							role="alert" for screen-reader announcement. */}
						<div
							role={isKeyboardFocus ? "alert" : "tooltip"}
							className={cn(
								"rounded-md border px-3 py-2",
								// Plain token pairing now. This used to add
								// `dark:bg-[color-mix(in_srgb,var(--destructive)_78%,#000)]`
								// because dark-mode `--destructive` under WHITE text measured
								// 3.76:1, and the reasoning at the time was that the token could
								// not be fixed: darkening `--destructive` itself would carry this
								// surface to 4.83:1 but drop every `text-destructive` on the page
								// from 5.02:1 to 3.91:1.
								//
								// That reasoning only considered darkening the FILL. Darkening
								// `--destructive-foreground` instead fixes the pairing without
								// touching the ink, and it is what every other bright dark-mode
								// fill already does. With that token fixed this surface measures
								// 5.02:1, so the local darkening has to GO — kept alongside the
								// new dark ink it would read 3.28:1, worse than what it fixed.
								"bg-destructive text-destructive-foreground",
								"border-destructive/60",
							)}
						>
							<div className="flex items-start gap-2">
								<AlertTriangleIcon
									className="size-3.5 shrink-0 mt-0.5"
									aria-hidden="true"
								/>
								<div className="flex flex-col gap-0.5">
									<span>{copy.label}</span>
									<span className="font-medium">
										{copy.warning}
									</span>
								</div>
							</div>
						</div>
						<TooltipPrimitive.Arrow className="fill-destructive" />
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipProvider>
	);
}
