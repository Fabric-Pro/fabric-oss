"use client";

/**
 * A per-item push or pull in a menu, read against its Roadmap gate
 * (Fizzy #2204, FR53/FR54).
 *
 * Push reads `roadmap.sync-to-pm` and pull `roadmap.pull-from-pm`, the same
 * keys the single-item door asserts by direction. A blocked item stays in the
 * menu, `aria-disabled` so its reason is reachable by keyboard, with the
 * gate's title and body under the label; a running sync shows as Processing.
 * With gating off there is no gate, and the item behaves exactly as before.
 */

import { DropdownMenuItem } from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { Loader2Icon, type LucideIcon } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useCapabilityGate } from "../../capability-gates/useCapabilityGates";
import { GateReasonLines } from "../roadmap-entry/entry-point-reason";

export function GatedSyncMenuItem({
	direction,
	icon: Icon,
	onActivate,
	children,
}: {
	direction: "push" | "pull";
	icon: LucideIcon;
	onActivate: (event: MouseEvent) => void;
	children: ReactNode;
}) {
	const { blocked, view } = useCapabilityGate(
		direction === "pull" ? "roadmap.pull-from-pm" : "roadmap.sync-to-pm",
	);
	const processing = blocked && view?.state === "PROCESSING";

	return (
		<DropdownMenuItem
			aria-disabled={blocked || undefined}
			onSelect={blocked ? (event) => event.preventDefault() : undefined}
			onClick={(event) => {
				if (blocked) {
					event.stopPropagation();
					return;
				}
				onActivate(event);
			}}
			className={cn(
				blocked &&
					"items-start cursor-not-allowed text-muted-foreground focus:text-muted-foreground",
			)}
		>
			{processing ? (
				<Loader2Icon
					aria-hidden="true"
					className="size-4 mr-2 shrink-0 motion-safe:animate-spin"
				/>
			) : (
				<Icon
					aria-hidden="true"
					className={cn("size-4 mr-2 shrink-0", blocked && "mt-0.5")}
				/>
			)}
			{blocked && view ? (
				<span className="flex flex-col gap-0.5">
					<span>{children}</span>
					<GateReasonLines view={view} />
				</span>
			) : (
				children
			)}
		</DropdownMenuItem>
	);
}
