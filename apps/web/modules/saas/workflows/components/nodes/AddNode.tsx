"use client";

import { Button } from "@ui/components/button";
import type { NodeProps } from "@xyflow/react";
import { Plus, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";

type AddNodeData = {
	onClick?: () => void;
	onAskAi?: () => void;
};

export function AddNode({ data }: NodeProps & { data?: AddNodeData }) {
	const t = useTranslations("workflows.studio");
	return (
		<div className="flex w-[360px] flex-col items-center justify-center gap-6 rounded-lg border border-dashed border-input bg-card p-8">
			<div className="text-center">
				<h2 className="mb-2 font-semibold text-2xl">
					{t("canvasTitle")}
				</h2>
				<p className="text-muted-foreground text-sm">
					{t("canvasBody")}
				</p>
			</div>
			<div className="flex flex-wrap items-center justify-center gap-2">
				<Button type="button" onClick={data?.onAskAi}>
					<SparklesIcon className="mr-2 size-4" aria-hidden="true" />
					{t("buildWithAi")}
				</Button>
				<Button
					variant="outline"
					className="gap-2 cursor-pointer"
					onClick={data?.onClick}
					size="default"
				>
					<Plus className="size-4" />
					{t("addFirstStep")}
				</Button>
			</div>
		</div>
	);
}
