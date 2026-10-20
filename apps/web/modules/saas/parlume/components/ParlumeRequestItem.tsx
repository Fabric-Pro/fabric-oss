"use client";

import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { Badge } from "@ui/components/badge";
import { ZapIcon } from "lucide-react";
import {
	formatClock,
	formatTimestamp,
	initialsOf,
	modeLabel,
	type ParlumeAction,
	type ParlumeRequest,
} from "../lib/parlume-format";
import { MONO_LABEL } from "../lib/parlume-styles";
import {
	actionStatus,
	actionSteps,
	TONE_BADGE,
	TONE_DOT,
} from "../lib/parlume-view";

function ActionBlock({ action }: { action: ParlumeAction }) {
	const status = actionStatus(action);
	const steps = actionSteps(action);
	return (
		<div className="ml-[30px] space-y-2.5 rounded-lg border border-border px-3.5 py-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className={`flex items-center gap-1.5 ${MONO_LABEL}`}>
					<ZapIcon className="size-[13px]" aria-hidden="true" />
					Action
				</span>
				<Badge variant={TONE_BADGE[status.tone]}>{status.label}</Badge>
			</div>
			<p className="text-sm">{action.summary}</p>
			<ol className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
				{steps.map((step, index) => (
					<li key={step.label} className="flex items-center gap-1.5">
						<span
							aria-hidden="true"
							className={`size-1.5 rounded-full ${TONE_DOT[step.tone]}`}
						/>
						{step.label}{" "}
						<span className="tabular-nums text-foreground">
							{formatClock(step.at)}
						</span>
						{index < steps.length - 1 && (
							<span
								aria-hidden="true"
								className="ml-0.5 text-border"
							>
								—
							</span>
						)}
					</li>
				))}
			</ol>
			{action.outcome && (
				<p className="whitespace-pre-wrap break-words text-[13px] leading-[18px]">
					{action.outcome}
				</p>
			)}
			<details>
				<summary className="min-h-6 cursor-pointer text-xs text-muted-foreground">
					Exact action details
				</summary>
				<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2.5 font-mono text-xs leading-[17px]">
					{JSON.stringify(action.arguments, null, 2)}
				</pre>
			</details>
		</div>
	);
}

/** One question or action request, as the meeting asked it and Parlume answered. */
export function ParlumeRequestItem({ request }: { request: ParlumeRequest }) {
	const hasSpeaker = request.speakerName !== null;
	const state = request.status === "COMPLETED" ? null : request.status;
	return (
		<li className="flex gap-3.5 border-b border-border px-6 py-[18px]">
			<span
				aria-hidden="true"
				className={`flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px] ${hasSpeaker ? "bg-muted" : "border border-dashed border-input bg-card"}`}
			>
				{initialsOf(request.speakerName)}
			</span>
			<div className="min-w-0 flex-1 space-y-2.5">
				<div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
					<span className="text-sm font-medium">
						{request.speakerName ?? "Unidentified attendee"}
					</span>
					<span className="text-xs text-muted-foreground">
						<time
							dateTime={new Date(request.createdAt).toISOString()}
						>
							{formatTimestamp(request.createdAt)}
						</time>{" "}
						· {modeLabel(request.session.toolsReadOnly)}
						{state ? ` · ${state.toLowerCase()}` : ""}
					</span>
				</div>
				<p className="whitespace-pre-wrap break-words text-sm leading-[21px]">
					{request.requestText}
				</p>
				{request.responseText && (
					<div className="flex gap-2.5">
						<span
							aria-hidden="true"
							className="flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-foreground"
						>
							<FabricLogo size={12} variant="inverse" />
						</span>
						<p className="whitespace-pre-wrap break-words text-sm leading-[21px] text-muted-foreground">
							{request.responseText}
						</p>
					</div>
				)}
				{request.error && (
					<p className="text-sm text-destructive">{request.error}</p>
				)}
				{request.actions.map((action) => (
					<ActionBlock key={action.id} action={action} />
				))}
			</div>
		</li>
	);
}
