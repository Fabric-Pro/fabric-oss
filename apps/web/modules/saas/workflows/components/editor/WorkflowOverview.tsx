"use client";

import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import type { Node } from "@xyflow/react";
import { formatDistanceToNow } from "date-fns";
import { ChevronRightIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatDuration } from "../../lib/format-duration";
import { getNodeAppearance, stepLabel } from "../../lib/node-appearance";
import type { WorkflowStatus } from "../../lib/workflow-status-display";
import { WorkflowStatusPill } from "./EditorHeader";

export interface LastRun {
	startedAt: Date | string | null;
	duration: number | null;
}

function NameField({
	workflowName,
	onRename,
}: {
	workflowName: string;
	onRename?: (name: string) => void;
}) {
	const [draft, setDraft] = useState(workflowName);

	useEffect(() => {
		setDraft(workflowName);
	}, [workflowName]);

	const commit = () => {
		const name = draft.trim();
		if (name && name !== workflowName) {
			onRename?.(name);
		} else {
			setDraft(workflowName);
		}
	};

	return (
		<div className="flex flex-col gap-1.5">
			<label
				htmlFor="workflow-overview-name"
				className="text-xs text-muted-foreground"
			>
				Name
			</label>
			<Textarea
				id="workflow-overview-name"
				rows={2}
				value={draft}
				readOnly={!onRename}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					// Enter commits by leaving the field, so blur is the one
					// place a rename is sent.
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						e.currentTarget.blur();
					} else if (e.key === "Escape") {
						setDraft(workflowName);
					}
				}}
				className="min-h-0 resize-none rounded-lg leading-[1.45]"
			/>
		</div>
	);
}

function formatLastRun(lastRun: LastRun | null | undefined) {
	if (!lastRun?.startedAt) {
		return "Never";
	}
	const ago = formatDistanceToNow(new Date(lastRun.startedAt), {
		addSuffix: true,
	});
	return lastRun.duration && lastRun.duration > 0
		? `${ago} · ${formatDuration(lastRun.duration)}`
		: ago;
}

async function copyId(workflowId: string) {
	try {
		await navigator.clipboard.writeText(workflowId);
		toast.success("Workflow ID copied");
	} catch {
		toast.error("Could not copy the workflow ID");
	}
}

/**
 * The inspector's "Workflow" tab with no step selected: the name, what state
 * the workflow is in, and its steps in order (click one to select it).
 */
export function WorkflowOverview({
	workflowId,
	workflowName,
	onRename,
	status,
	version,
	publishedVersion,
	triggerLabel,
	lastRun,
	steps,
	onSelectStep,
}: {
	workflowId: string;
	workflowName: string;
	onRename?: (name: string) => void;
	status: WorkflowStatus;
	version: number;
	publishedVersion?: number | null;
	triggerLabel: string;
	lastRun?: LastRun | null;
	steps: Node[];
	onSelectStep: (nodeId: string) => void;
}) {
	return (
		<div className="flex flex-col gap-5 p-4">
			<NameField workflowName={workflowName} onRename={onRename} />

			<dl className="grid grid-cols-[88px_minmax(0,1fr)] items-center gap-y-2.5 text-[13px]">
				<dt className="text-muted-foreground">Status</dt>
				<dd>
					<WorkflowStatusPill
						status={status}
						version={version}
						publishedVersion={publishedVersion}
						className="w-fit"
					/>
				</dd>
				<dt className="text-muted-foreground">Trigger</dt>
				<dd>{triggerLabel}</dd>
				<dt className="text-muted-foreground">Last run</dt>
				<dd>{formatLastRun(lastRun)}</dd>
				<dt className="text-muted-foreground">ID</dt>
				<dd className="flex min-w-0 items-center gap-1.5">
					{workflowId ? (
						<>
							<span className="truncate font-mono text-[11px]">
								{workflowId}
							</span>
							<button
								type="button"
								aria-label="Copy workflow ID"
								title="Copy ID"
								onClick={() => copyId(workflowId)}
								className="flex shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
							>
								<CopyIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							</button>
						</>
					) : (
						<span className="text-muted-foreground">Not saved</span>
					)}
				</dd>
			</dl>

			<div className="h-px bg-border" aria-hidden="true" />

			<section aria-label="Steps" className="flex flex-col gap-1">
				<h3 className="pb-1 text-xs text-muted-foreground">Steps</h3>
				{steps.length === 0 ? (
					<p className="text-[13px] text-muted-foreground">
						No steps yet. Add one from the Add step tab.
					</p>
				) : (
					<ol className="flex flex-col gap-1">
						{steps.map((node, index) => {
							const { Icon, iconClass } = getNodeAppearance(
								node.type ?? "",
								node.data,
							);
							return (
								<li key={node.id}>
									<button
										type="button"
										onClick={() => onSelectStep(node.id)}
										className="flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring motion-safe:transition-colors"
									>
										<span className="w-3 font-mono text-[11px] text-muted-foreground">
											{index + 1}
										</span>
										<Icon
											className={cn(
												"size-3.5 shrink-0",
												iconClass,
											)}
										/>
										<span className="min-w-0 flex-1 truncate text-[13px]">
											{stepLabel(node.data)}
										</span>
										<ChevronRightIcon
											className="size-3.5 shrink-0 text-muted-foreground/60"
											aria-hidden="true"
										/>
									</button>
								</li>
							);
						})}
					</ol>
				)}
			</section>
		</div>
	);
}
