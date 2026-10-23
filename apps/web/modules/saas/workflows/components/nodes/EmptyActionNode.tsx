"use client";

import { cn } from "@ui/lib";
import { Handle, Position } from "@xyflow/react";
import { PlusIcon } from "lucide-react";
import { memo } from "react";

interface EmptyActionNodeProps {
	data: {
		label?: string;
		onClick?: () => void;
	};
	selected?: boolean;
}

const HANDLE_CLASS =
	"size-2! border-2! border-background! bg-muted-foreground!";

/** A step whose action has not been chosen yet; picking one replaces it. */
export const EmptyActionNode = memo(
	({ data, selected }: EmptyActionNodeProps) => {
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: ReactFlow canvas node; interactive semantics are managed by the ReactFlow library
			<div
				className="relative"
				onClick={data.onClick}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						data.onClick?.();
					}
				}}
			>
				<Handle
					type="target"
					position={Position.Top}
					className={HANDLE_CLASS}
				/>

				<div
					className={cn(
						"flex w-[300px] cursor-pointer items-center gap-3 rounded-[10px] border border-dashed bg-card px-3.5 py-3",
						"motion-safe:transition-[border-color,box-shadow] motion-safe:duration-150",
						selected
							? "border-foreground ring-[3px] ring-foreground/10"
							: "border-input hover:border-muted-foreground",
					)}
				>
					<span className="flex size-[34px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<PlusIcon className="size-[17px]" aria-hidden="true" />
					</span>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="text-sm font-medium">New step</span>
						<span className="text-xs text-muted-foreground">
							Choose an action in Add step
						</span>
					</span>
				</div>

				<Handle
					type="source"
					position={Position.Bottom}
					className={HANDLE_CLASS}
				/>
			</div>
		);
	},
);

EmptyActionNode.displayName = "EmptyActionNode";
