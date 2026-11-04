"use client";

import { cn } from "@ui/lib";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatDuration } from "../../lib/format-duration";
import { getNodeAppearance } from "../../lib/node-appearance";
import type { ViewedRun } from "../../lib/run-steps";
import type { WorkflowNode, WorkflowNodeData } from "../../lib/types";
import { NodeConfigEditor } from "../NodeConfigEditor";
import { DatabricksRunResult } from "./DatabricksRunResult";
import { RunStatusIcon } from "./RunStatusIcon";

const STATUS_LABELS: Record<string, string> = {
	PENDING: "pending",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
	SKIPPED: "skipped",
};

function StepRunOutput({
	nodeId,
	nodeType,
	viewedRun,
}: {
	nodeId: string;
	nodeType?: string;
	viewedRun: ViewedRun;
}) {
	const t = useTranslations("workflows.results");
	const step = viewedRun.steps.get(nodeId);
	const textOutput =
		typeof step?.output === "string"
			? step.output
			: nodeType === "ai-generate-text" &&
					step?.output &&
					typeof step.output === "object" &&
					"text" in step.output &&
					typeof step.output.text === "string"
				? step.output.text
				: null;
	return (
		<div className="flex flex-col gap-1.5">
			<p className="text-xs text-muted-foreground">
				Output from run{" "}
				<span className="font-mono">{viewedRun.shortId}</span>
			</p>
			{step ? (
				<div className="rounded-lg border bg-muted p-2.5 text-xs leading-relaxed">
					<p className="flex items-center gap-1.5 text-muted-foreground">
						<RunStatusIcon
							status={step.status}
							className="size-3"
						/>
						status: {STATUS_LABELS[step.status] ?? step.status}
						{step.duration !== null && step.duration > 0
							? ` · ${formatDuration(step.duration)}`
							: ""}
					</p>
					{step.error ? (
						<p
							role="alert"
							className="mt-2 whitespace-pre-wrap break-words text-destructive"
						>
							{step.error}
						</p>
					) : null}
					{nodeType?.startsWith("databricks-sql-") &&
					step.output &&
					typeof step.output === "object" &&
					"rows" in step.output &&
					"columns" in step.output ? (
						<DatabricksRunResult
							output={step.output as Record<string, unknown>}
						/>
					) : textOutput !== null ? (
						<>
							<output
								aria-label={t("stepOutput")}
								className="mt-2 block whitespace-pre-wrap break-words text-sm text-foreground"
							>
								{textOutput}
							</output>
							<details className="mt-3">
								<summary className="cursor-pointer text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
									{t("rawOutput")}
								</summary>
								<section aria-label={t("rawStepOutput")}>
									<pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
										{JSON.stringify(step.output, null, 2)}
									</pre>
								</section>
							</details>
						</>
					) : step.output !== null ? (
						<section aria-label={t("stepOutput")}>
							<pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
								{JSON.stringify(step.output, null, 2)}
							</pre>
						</section>
					) : null}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					This step did not run.
				</p>
			)}
		</div>
	);
}

/**
 * Editing shows configuration. Viewing a run puts its result first and
 * distinguishes the current draft configuration from the recorded output.
 */
export function StepInspector({
	node,
	onBack,
	onUpdate,
	onDelete,
	viewedRun,
}: {
	node: WorkflowNode;
	onBack: () => void;
	onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
	onDelete: (nodeId: string) => void;
	viewedRun: ViewedRun | null;
}) {
	const t = useTranslations("workflows.results");
	const { Icon, tileClass, kind } = getNodeAppearance(
		node.type ?? "",
		node.data,
	);

	return (
		<div className="flex flex-1 flex-col gap-[18px] p-4">
			<div className="flex items-center gap-2.5">
				<button
					type="button"
					onClick={onBack}
					aria-label="Back to workflow"
					title="Back to workflow"
					className="flex size-[26px] shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
				>
					<ArrowLeftIcon className="size-3.5" aria-hidden="true" />
				</button>
				<span
					className={cn(
						"flex size-[30px] shrink-0 items-center justify-center rounded-[7px]",
						tileClass,
					)}
				>
					<Icon className="size-[15px]" />
				</span>
				<span className="flex min-w-0 flex-col">
					<span className="truncate text-sm font-medium">
						{node.data.label || "Untitled"}
					</span>
					<span className="truncate text-xs text-muted-foreground">
						{kind}
					</span>
				</span>
			</div>

			{viewedRun ? (
				<>
					<StepRunOutput
						nodeId={node.id}
						nodeType={node.type}
						viewedRun={viewedRun}
					/>
					<details>
						<summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
							{t("draftConfiguration")}
						</summary>
						<div className="mt-3">
							<NodeConfigEditor node={node} onUpdate={onUpdate} />
						</div>
					</details>
				</>
			) : (
				<NodeConfigEditor node={node} onUpdate={onUpdate} />
			)}

			<div className="flex-1" />
			{!viewedRun && (
				<button
					type="button"
					onClick={() => onDelete(node.id)}
					className="flex h-[30px] items-center gap-1.5 self-start rounded-lg border border-input px-2.5 text-xs text-destructive hover:border-destructive focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
				>
					<Trash2Icon className="size-3.5" aria-hidden="true" />
					Delete step
				</button>
			)}
		</div>
	);
}
