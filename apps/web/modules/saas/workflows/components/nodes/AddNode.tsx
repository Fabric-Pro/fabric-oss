"use client";

import { Button } from "@ui/components/button";
import type { NodeProps } from "@xyflow/react";
import { Plus } from "lucide-react";

type AddNodeData = {
	onClick?: () => void;
};

export function AddNode({ data }: NodeProps & { data?: AddNodeData }) {
	return (
		<div className="flex w-[360px] flex-col items-center justify-center gap-6 rounded-[10px] border border-dashed border-input bg-card p-8">
			<div className="text-center">
				<h1 className="mb-2 font-serif text-2xl">
					AI Workflow Builder
				</h1>
				<p className="text-muted-foreground text-sm">
					Build powerful AI-powered automations with a visual
					drag-and-drop interface.
				</p>
			</div>
			<Button
				className="gap-2 cursor-pointer"
				onClick={data?.onClick}
				size="default"
			>
				<Plus className="size-4" />
				Add a Step
			</Button>
		</div>
	);
}
