"use client";

import { agentRunText } from "@repo/agent-types";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { CopyIcon, DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Response } from "../../../../components/ai-elements/response";
import { effectiveToolStatus } from "../../agents/components/FabricChat/shared/tool-activity";

export function runRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function printable(value: unknown): string {
	return typeof value === "string"
		? value
		: (JSON.stringify(value, null, 2) ?? "");
}

function toolNeedsInspection(value: unknown): boolean {
	const tool = runRecord(value);
	let result = tool.result;
	if (typeof result === "string") {
		try {
			result = JSON.parse(result);
		} catch {
			result = undefined;
		}
	}
	return (
		tool.inspectionRequired === true ||
		runRecord(result).inspectionRequired === true
	);
}

function recordedToolStatus(value: unknown) {
	const tool = runRecord(value);
	const raw = typeof tool.status === "string" ? tool.status : "recorded";
	const status = effectiveToolStatus({
		status: raw,
		result: tool.result,
		error: tool.error,
	});
	if (status === "failed") {
		return "error";
	}
	if (status === "success" || status === "completed") {
		return "complete";
	}
	return status;
}

function downloadUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return;
	try {
		const url = new URL(value);
		if (url.protocol === "https:" || url.protocol === "http:")
			return url.href;
	} catch {
		/* Only absolute HTTP artifact URLs are usable downloads. */
	}
}

export function AgentRunResult({
	output,
	result,
	progress,
	error,
	status,
	artifacts,
}: {
	output: unknown;
	result?: unknown;
	progress?: unknown;
	error?: string | null;
	status: string;
	artifacts?: unknown;
}) {
	const t = useTranslations("genieExperience");
	const toolLabel = (tool: unknown) => {
		if (toolNeedsInspection(tool)) {
			return t("toolNeedsInspection");
		}
		switch (recordedToolStatus(tool)) {
			case "error":
				return t("toolFailed");
			case "complete":
				return t("toolCompleted");
			case "pending":
				return t("toolAwaitingConfirmation");
			case "running":
				return t("toolRunning");
			case "cancelled":
				return t("toolCancelled");
			case "skipped":
				return t("toolSkipped");
			default:
				return t("toolRecorded");
		}
	};
	const data = runRecord(output);
	const resultData = runRecord(result);
	const live = runRecord(progress);
	const steps = Array.isArray(data.stepsExecuted)
		? data.stepsExecuted
		: Array.isArray(resultData.stepsExecuted)
			? resultData.stepsExecuted
			: [];
	const failedSteps = steps.filter((step) =>
		["failed", "error"].includes(String(runRecord(step).status)),
	);
	const toolCalls = [
		...(Array.isArray(data.toolCalls) ? data.toolCalls : []),
		...steps.flatMap((step) => {
			const calls = runRecord(step).toolCalls;
			return Array.isArray(calls) ? calls : [];
		}),
	];
	const failedTools = toolCalls.filter(
		(call) => recordedToolStatus(call) === "error",
	);
	const completedTools = Array.isArray(live.completedToolCalls)
		? live.completedToolCalls
		: [];
	const needsInspection =
		data.inspectionRequired === true ||
		resultData.inspectionRequired === true ||
		[...toolCalls, ...completedTools].some(
			(call) =>
				toolNeedsInspection(call) ||
				runRecord(call).status === "pending",
		);
	const text = agentRunText(output);
	const files = Array.isArray(artifacts) ? artifacts : [];
	const active = ["PENDING", "RUNNING", "UNKNOWN"].includes(status);
	const goalAchieved = data.goalAchieved ?? resultData.goalAchieved;
	const currentTool = runRecord(live.currentToolCall);
	return (
		<div className="min-w-0 space-y-4">
			{!active && typeof goalAchieved === "boolean" && (
				<p className="text-sm font-medium">
					{goalAchieved
						? "Goal achieved"
						: "Goal not achieved. Review the result and recorded steps."}
				</p>
			)}
			{needsInspection && (
				<Alert variant="warning">
					<AlertTitle>
						Check the external action before running again
					</AlertTitle>
					<AlertDescription>
						A tool may have completed its action without returning
						confirmation. Check the connected service and the step
						details below. Starting another run could repeat that
						action.
					</AlertDescription>
				</Alert>
			)}
			{(failedTools.length > 0 || failedSteps.length > 0) && (
				<Alert variant="warning">
					<AlertTitle>{t("toolFailuresTitle")}</AlertTitle>
					<AlertDescription>
						{t("toolFailuresDescription")}
					</AlertDescription>
				</Alert>
			)}
			{error && (
				<Alert variant={status === "CANCELLED" ? "default" : "error"}>
					<AlertTitle>
						{status === "CANCELLED"
							? "Run cancelled"
							: "Run did not complete"}
					</AlertTitle>
					<AlertDescription className="break-words whitespace-pre-wrap">
						{error}
					</AlertDescription>
				</Alert>
			)}
			{typeof live.message === "string" && (
				<p className="text-sm text-muted-foreground">{live.message}</p>
			)}
			{active &&
				typeof live.stepsCompleted === "number" &&
				typeof live.totalSteps === "number" &&
				live.totalSteps > 0 && (
					<p className="text-sm text-muted-foreground">
						{live.stepsCompleted} of {live.totalSteps} planned steps
						completed
					</p>
				)}
			{active &&
				(completedTools.length > 0 ||
					typeof currentTool.name === "string") && (
					<ul
						aria-label="Tool progress"
						className="space-y-2 text-sm"
					>
						{completedTools.map((tool, index) => (
							<li key={index}>
								{String(runRecord(tool).name ?? "Tool")} ·{" "}
								{toolLabel(tool)}
							</li>
						))}
						{typeof currentTool.name === "string" && (
							<li>{currentTool.name} · Running</li>
						)}
					</ul>
				)}
			{text ? (
				<>
					<div className="flex items-center justify-between gap-2">
						<h4 className="font-semibold text-sm">Result</h4>
						<Button
							variant="ghost"
							size="sm"
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(text);
									toast.success("Result copied");
								} catch {
									toast.error(
										"Could not copy the result. Select the text to copy it.",
									);
								}
							}}
						>
							<CopyIcon className="size-4" />
							Copy result
						</Button>
					</div>
					<div className="prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
						<Response normalizeHeadings normalizeMarkdown={false}>
							{text}
						</Response>
					</div>
				</>
			) : (
				!error && (
					<p className="text-sm text-muted-foreground">
						{active
							? "Results will appear here as the run progresses."
							: Object.keys(data).length
								? "Structured output is available below."
								: "This run returned no text output."}
					</p>
				)
			)}
			{files.length > 0 && (
				<div className="space-y-2">
					<h4 className="font-semibold text-sm">Generated files</h4>
					{files.map((file, index) => {
						const artifact = runRecord(file);
						const url = downloadUrl(
							artifact.downloadUrl ?? artifact.url,
						);
						const name =
							typeof artifact.name === "string"
								? artifact.name
								: `File ${index + 1}`;
						return url ? (
							<Button
								key={url}
								variant="outline"
								size="sm"
								asChild
							>
								<a
									href={url}
									target="_blank"
									rel="noopener noreferrer"
								>
									<DownloadIcon className="size-4" />
									{name}
								</a>
							</Button>
						) : (
							<p
								key={`${name}-${index}`}
								className="text-sm text-muted-foreground"
							>
								{name} — download unavailable
							</p>
						);
					})}
				</div>
			)}
			{(toolCalls.length > 0 || failedSteps.length > 0) && (
				<div className="space-y-2">
					<h4 className="font-semibold text-sm">Steps</h4>
					{failedSteps.map((value, index) => {
						const step = runRecord(value);
						return (
							<details
								key={`failed-${String(step.id ?? index)}`}
								className="rounded-md border border-border p-3"
							>
								<summary className="cursor-pointer text-sm">
									<span className="mr-2">
										{typeof step.description === "string"
											? step.description
											: `Step ${index + 1}`}
									</span>
									<Badge variant="outline">
										{t("toolFailed")}
									</Badge>
								</summary>
								<pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
									{printable(step)}
								</pre>
							</details>
						);
					})}

					{toolCalls.map((call, index) => {
						const step = runRecord(call);
						return (
							<details
								key={`${String(step.toolCallId ?? step.name)}-${index}`}
								className="rounded-md border border-border p-3"
							>
								<summary className="cursor-pointer text-sm">
									<span className="mr-2">
										{typeof step.name === "string"
											? step.name
											: `Step ${index + 1}`}
									</span>
									<Badge variant="outline">
										{toolLabel(step)}
									</Badge>
								</summary>
								<pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
									{printable(step)}
								</pre>
							</details>
						);
					})}
				</div>
			)}
			{Object.keys(data).length > 0 && (
				<details className="rounded-md border border-border p-3">
					<summary className="cursor-pointer text-sm">
						Structured output
					</summary>
					<pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">
						{printable(output)}
					</pre>
				</details>
			)}
		</div>
	);
}
