"use client";
import { Button } from "@ui/components/button";
import { type ReactNode, useSyncExternalStore } from "react";
import type {
	BacklogFlow,
	BacklogFlowController,
} from "./backlog-flow-controller";
import { ReviewSourcesSelector } from "./ReviewSourcesSelector";

type Props = {
	controller: BacklogFlowController;
	flowId: string;
	projectId: string;
	organizationId: string | null;
	renderReview: (flow: BacklogFlow) => ReactNode;
};
/** One admitted entry card changes from selectors to progress to review. */
export function BacklogFlowCard({
	controller,
	flowId,
	projectId,
	organizationId,
	renderReview,
}: Props) {
	const flow = useSyncExternalStore(
		controller.subscribe,
		() => controller.get(flowId),
		() => controller.get(flowId),
	);
	const activeFlowId = useSyncExternalStore(
		controller.subscribe,
		() => controller.current()?.flowId,
		() => controller.current()?.flowId,
	);
	if (!flow) {
		return null;
	}
	if (
		flow.phase === "reviewing" ||
		flow.phase === "applying" ||
		flow.phase === "apply-failed" ||
		(flow.phase === "done" && flow.outcome === "approved")
	) {
		return (
			<>
				{renderReview(flow)}
				{flow.phase === "apply-failed" && activeFlowId === flowId ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							void controller.retryApply(flowId);
						}}
					>
						Retry apply
					</Button>
				) : null}
				{flow.phase === "reviewing" ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							controller.startOver(flowId);
						}}
					>
						Start over
					</Button>
				) : null}
				{flow.logContextNote ? (
					<p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
						{flow.logContextNote}
					</p>
				) : null}
			</>
		);
	}
	if (flow.phase === "selecting") {
		return (
			<div className="space-y-2">
				{flow.sourcePlan[flow.selectorIndex] === "teams" ? (
					<ReviewSourcesSelector
						key={`${flowId}-teams`}
						projectId={projectId}
						organizationId={organizationId}
						onConfirm={(result) => {
							controller.confirm(flowId, "teams", result);
						}}
						onCancel={() => {
							controller.confirm(flowId, "teams", {
								daysBack: 30,
							});
						}}
					/>
				) : (
					<div className="rounded-lg border p-4 space-y-3">
						<p className="text-sm font-medium">
							Notion Page Selection
						</p>
						<p className="text-xs text-muted-foreground">
							Notion page selection is not available yet. Skip to
							continue with the other sources.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								controller.confirm(flowId, "notion");
							}}
						>
							Skip Notion
						</Button>
					</div>
				)}
				<Button
					variant="ghost"
					size="sm"
					onClick={() => {
						controller.cancel(flowId);
					}}
				>
					Cancel request
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						controller.startOver(flowId);
					}}
				>
					Start over
				</Button>
			</div>
		);
	}
	const heading =
		flow.phase === "failed"
			? flow.failureStatus === "timeout"
				? "Analysis Timed Out"
				: "Analysis Failed"
			: flow.phase === "no-changes"
				? "No Backlog Changes Needed"
				: flow.phase === "done"
					? flow.outcome === "rejected"
						? "Changes rejected"
						: flow.outcome === "superseded"
							? "Superseded by a new request"
							: "Request cancelled"
					: "Analyzing Context";
	return (
		<section className="rounded-lg border p-4 space-y-2" aria-live="polite">
			<p className="text-sm font-medium">{heading}</p>
			{flow.phase !== "done" ? (
				<p className="text-xs text-muted-foreground">
					{flow.proposal?.summary ?? flow.progress}
				</p>
			) : null}
			{flow.phase === "no-changes" && flow.proposal?.contextSummary ? (
				<p className="text-xs text-muted-foreground">
					{flow.proposal.contextSummary}
				</p>
			) : null}
			{flow.logContextNote ? (
				<p className="text-xs text-muted-foreground border-t pt-2">
					{flow.logContextNote}
				</p>
			) : null}
			{flow.phase === "analyzing" ? (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => {
						controller.startOver(flowId);
					}}
				>
					Start over
				</Button>
			) : null}
			{activeFlowId === flowId &&
			flow.phase === "failed" &&
			!flow.workflowId &&
			flow.startRetryable ? (
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						controller.retryStart(flowId);
					}}
				>
					Retry analysis
				</Button>
			) : null}
			{activeFlowId === flowId &&
			flow.phase === "failed" &&
			flow.workflowId ? (
				<Button
					size="sm"
					variant="outline"
					onClick={() => {
						void controller.reconcile(flowId);
					}}
				>
					Check existing analysis
				</Button>
			) : null}
		</section>
	);
}
