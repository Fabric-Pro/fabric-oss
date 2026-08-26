"use client";

import { Handle, Position } from "@xyflow/react";
import { PlusIcon, SparklesIcon } from "lucide-react";
import { memo } from "react";

interface EmptyActionNodeProps {
	data: {
		label?: string;
		onClick?: () => void;
	};
	selected?: boolean;
}

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
					className="w-2 h-2"
				/>

				<div
					className={`
					min-w-[200px] px-4 py-3 rounded-lg border-2 border-dashed
					bg-background cursor-pointer transition-all
					${selected ? "border-primary shadow-lg" : "border-muted-foreground/30 hover:border-primary/50"}
				`}
				>
					<div className="flex items-center gap-3">
						<div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
							<SparklesIcon className="h-5 w-5 text-muted-foreground" />
						</div>
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2 mb-1">
								<span className="text-sm font-medium">
									Action
								</span>
								<PlusIcon className="h-3 w-3 text-muted-foreground" />
							</div>
							<p className="text-xs text-muted-foreground">
								Select an action
							</p>
						</div>
					</div>
				</div>

				<Handle
					type="source"
					position={Position.Bottom}
					className="w-2 h-2"
				/>
			</div>
		);
	},
);

EmptyActionNode.displayName = "EmptyActionNode";
