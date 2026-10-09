"use client";

import { useTranslations } from "next-intl";

export interface ChatgptPlanModelListTask {
	taskType: string;
	model: { canonicalName: string; displayName: string } | null;
}

/**
 * The organization's ChatGPT plan model per kind of work, read-only
 * (Fizzy #2770): shown where a member connects a plan and in their plan
 * card, because the organization decides and connecting means agreeing.
 */
export function ChatgptPlanModelList({
	tasks,
	className,
}: {
	tasks: ChatgptPlanModelListTask[];
	className?: string;
}) {
	const t = useTranslations("settings.chatgptPlanModels");
	return (
		<dl
			className={
				className ?? "grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
			}
			data-testid="chatgpt-plan-model-list"
		>
			{tasks.map((task) => (
				<div className="contents" key={task.taskType}>
					<dt className="text-muted-foreground">
						{t(`tasks.${task.taskType}`)}
					</dt>
					<dd>{task.model?.displayName ?? t("noModel")}</dd>
				</div>
			))}
		</dl>
	);
}
