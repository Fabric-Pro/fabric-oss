"use client";

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

/**
 * A PM-sync action button gated on the connected tool's capability. When
 * `supported` is false it renders `aria-disabled` with the "not supported yet"
 * tooltip — `aria-disabled` (not `disabled`) keeps it focusable + hoverable so
 * the tooltip reaches both pointer AND keyboard users. When supported it's a
 * normal action button with an optional pending spinner.
 *
 * Shared by every gated PM-sync control (per-case "Sync now", the bulk toolbar
 * "Sync") so the gated affordance is defined once. `variant`/`size` let callers
 * match their surrounding controls (the toolbar uses `ghost`).
 */
export function SyncGateButton({
	supported,
	unsupportedCopy,
	onClick,
	pending = false,
	disabled = false,
	icon,
	label,
	ariaLabel,
	variant = "outline",
	size = "sm",
}: {
	supported: boolean;
	unsupportedCopy: string;
	onClick: () => void;
	pending?: boolean;
	/** Extra disable reason when supported (e.g. another action in flight). */
	disabled?: boolean;
	/** Rendered before the label when not pending (a lucide icon element). */
	icon: ReactNode;
	label: string;
	/** aria-label for the enabled button (the unsupported one uses the copy). */
	ariaLabel?: string;
	variant?: ComponentProps<typeof Button>["variant"];
	size?: ComponentProps<typeof Button>["size"];
}) {
	if (!supported) {
		return (
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant={variant}
						size={size}
						aria-disabled
						onClick={(e) => e.preventDefault()}
						className="cursor-not-allowed text-muted-foreground opacity-60"
						aria-label={unsupportedCopy}
					>
						{icon}
						{label}
					</Button>
				</TooltipTrigger>
				<TooltipContent surface="popover" className="max-w-[15rem]">
					{unsupportedCopy}
				</TooltipContent>
			</Tooltip>
		);
	}

	return (
		<Button
			type="button"
			variant={variant}
			size={size}
			disabled={disabled || pending}
			aria-label={ariaLabel}
			onClick={onClick}
		>
			{pending ? (
				<Loader2Icon
					className="mr-2 size-4 animate-spin"
					aria-hidden="true"
				/>
			) : (
				icon
			)}
			{label}
		</Button>
	);
}
