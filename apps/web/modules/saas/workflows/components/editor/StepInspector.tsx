"use client";

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatDuration } from "../../lib/format-duration";
import { getNodeAppearance } from "../../lib/node-appearance";
import type { OutputOption } from "../../lib/output-options";
import type { ViewedRun } from "../../lib/run-steps";
import type { WorkflowNode, WorkflowNodeData } from "../../lib/types";
import { NodeConfigEditor } from "../NodeConfigEditor";
import { WorkflowResultChecks } from "../WorkflowResultChecks";
import { DatabricksRunResult } from "./DatabricksRunResult";
import { RunStatusIcon } from "./RunStatusIcon";
import { WorkflowResult } from "./WorkflowResult";

const STATUS_LABELS: Record<string, string> = {
	PENDING: "pending",
	RUNNING: "running",
	COMPLETED: "completed",
	FAILED: "failed",
	SKIPPED: "skipped",
};

function StepRunOutput({
	resultCheckContext,
	nodeId,
	nodeType,
	viewedRun,
}: {
	resultCheckContext?: { workflowId: string; organizationId: string };
	nodeId: string;
	nodeType?: string;
	viewedRun: ViewedRun;
}) {
	const checkCopy = useTranslations("workflows.checks");
	const step = viewedRun.steps.get(nodeId);
	const actualNodeType = step?.nodeType ?? nodeType;
	const textOutput =
		typeof step?.output === "string"
			? step.output
			: step?.output &&
					typeof step.output === "object" &&
					"markdown" in step.output &&
					typeof step.output.markdown === "string"
				? step.output.markdown
				: step?.output &&
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
			{textOutput &&
				resultCheckContext &&
				viewedRun.executionId &&
				viewedRun.status === "COMPLETED" &&
				step?.status === "COMPLETED" &&
				(textOutput.length > 16384 ? (
					<div className="space-y-1">
						<Button size="sm" variant="outline" disabled>
							{checkCopy.has("open")
								? checkCopy("open")
								: "Check result"}
						</Button>
						<p className="text-xs text-muted-foreground">
							{checkCopy.has("tooLong")
								? checkCopy("tooLong")
								: "Checks support results up to 16,384 characters. This full result is still available below."}
						</p>
					</div>
				) : (
					<WorkflowResultChecks
						{...resultCheckContext}
						executionId={viewedRun.executionId}
						nodeId={nodeId}
					/>
				))}

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
					{actualNodeType?.startsWith("databricks-sql-") &&
					step.output &&
					typeof step.output === "object" &&
					"rows" in step.output &&
					"columns" in step.output ? (
						<DatabricksRunResult
							output={step.output as Record<string, unknown>}
						/>
					) : step.output !== null && step.output !== undefined ? (
						<WorkflowResult
							output={step.output}
							nodeType={actualNodeType}
						/>
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
	resultCheckContext,
	node,
	onBack,
	onUpdate,
	onDelete,
	viewedRun,
	availableVariables = [],
}: {
	resultCheckContext?: { workflowId: string; organizationId: string };
	node: WorkflowNode;
	onBack: () => void;
	onUpdate: (nodeId: string, data: Partial<WorkflowNodeData>) => void;
	onDelete: (nodeId: string) => void;
	viewedRun: ViewedRun | null;
	availableVariables?: OutputOption[];
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
						resultCheckContext={resultCheckContext}
						nodeId={node.id}
						nodeType={node.type}
						viewedRun={viewedRun}
					/>
					<details>
						<summary className="cursor-pointer text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
							{t("draftConfiguration")}
						</summary>
						<div className="mt-3">
							<NodeConfigEditor
								node={node}
								onUpdate={onUpdate}
								availableVariables={availableVariables}
							/>
						</div>
					</details>
				</>
			) : (
				<NodeConfigEditor
					node={node}
					onUpdate={onUpdate}
					availableVariables={availableVariables}
				/>
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
