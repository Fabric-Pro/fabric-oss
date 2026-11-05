"use client";

import {
	type AgentPreviewDraft,
	type AgentPreviewState,
	agentPreviewUnsupported,
} from "@repo/temporal/agent-preview-contracts";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Response } from "../../../../components/ai-elements/response";
import { AgentTestCaseDialog } from "./AgentTestCaseDialog";

type Receipt = { workflowId: string; runId?: string; draftHash: string };
type Message = { role: "user" | "assistant"; content: string };
function admissionMessage(error: unknown): string {
	if (
		error instanceof Error &&
		"code" in error &&
		[
			"BAD_REQUEST",
			"CONFLICT",
			"FORBIDDEN",
			"NOT_FOUND",
			"SERVICE_UNAVAILABLE",
		].includes(String(error.code))
	) {
		return error.message;
	}
	return "Your draft is preserved. Check your current access, selected knowledge, and AI connection, then retry.";
}
export function AgentBuilderPreview({
	organizationId,
	userId,
	draft,
	savedAgentHref,
}: {
	organizationId: string;
	userId?: string;
	draft: AgentPreviewDraft;
	savedAgentHref?: string;
}) {
	const id = useId();
	const [saveTestOpen, setSaveTestOpen] = useState(false);
	const [message, setMessage] = useState("");
	const [receipt, setReceipt] = useState<Receipt>();
	const [snapshot, setSnapshot] = useState<string>();
	const [history, setHistory] = useState<Message[]>([]);
	const [sent, setSent] = useState<string>();
	const [pollSince, setPollSince] = useState(Date.now);
	const attempt = useRef<{ fingerprint: string; key: string } | undefined>(
		undefined,
	);
	const generation = useRef(0);
	const mounted = useRef(true);
	const storageKey = userId
		? `fabric-agent-preview:${organizationId}:${userId}:${draft.instanceId ?? "new"}`
		: undefined;
	const fingerprint = JSON.stringify(draft);
	const unsupported = agentPreviewUnsupported(draft);
	const instructionsTooLong = draft.instructions.trim().length > 40_000;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		generation.current += 1;
		setReceipt(undefined);
		setSnapshot(undefined);
		setHistory([]);
		setSent(undefined);
		attempt.current = undefined;
		if (!storageKey) {
			return;
		}
		try {
			const stored = JSON.parse(
				sessionStorage.getItem(storageKey) ?? "null",
			);
			if (
				stored &&
				typeof stored.workflowId === "string" &&
				stored.workflowId.length < 200 &&
				typeof stored.draftHash === "string" &&
				/^[a-f0-9]{64}$/.test(stored.draftHash)
			) {
				setReceipt({
					workflowId: stored.workflowId,
					runId:
						typeof stored.runId === "string"
							? stored.runId
							: undefined,
					draftHash: stored.draftHash,
				});
			}
		} catch {
			/* Storage is optional; server ownership remains authoritative. */
		}
	}, [storageKey]);
	const detail = useQuery({
		queryKey: [
			"agent-draft-preview",
			organizationId,
			userId,
			receipt?.workflowId,
			receipt?.runId,
		],
		queryFn: async () => {
			if (!receipt) {
				throw new Error("Choose a preview.");
			}
			return orpcClient.agents.previews.get({
				organizationId,
				workflowId: receipt.workflowId,
				runId: receipt.runId,
			});
		},
		enabled: !!receipt,
		retry: false,
		refetchInterval: (q) =>
			!q.state.error &&
			q.state.data?.state.status === "RUNNING" &&
			Date.now() - pollSince < 300_000
				? 1500
				: false,
	});
	const state: AgentPreviewState | undefined = detail.isError
		? undefined
		: detail.data?.state;
	const earlierDraft = !!receipt && snapshot !== fingerprint;
	const running =
		state?.status === "RUNNING" || (!!receipt && detail.isPending);
	const followupTooLarge =
		state?.status === "COMPLETED" &&
		snapshot === fingerprint &&
		(state.response?.length ?? 0) > 20_000;
	const start = useMutation({
		mutationFn: async () => {
			const requestGeneration = generation.current;
			const previous =
				state?.status === "COMPLETED" &&
				snapshot === fingerprint &&
				sent
					? [
							...history,
							{ role: "user" as const, content: sent },
							{
								role: "assistant" as const,
								content: state.response ?? "",
							},
						].slice(-8)
					: [];
			const input = {
				draft,
				userMessage: message.trim(),
				history: previous,
			};
			const identity = JSON.stringify(input);
			if (!attempt.current || attempt.current.fingerprint !== identity) {
				attempt.current = {
					fingerprint: identity,
					key: crypto.randomUUID(),
				};
			}
			const accepted = await orpcClient.agents.previews.start({
				organizationId,
				...input,
				idempotencyKey: attempt.current.key,
			});
			return {
				accepted,
				requestGeneration,
				sent: input.userMessage,
				fingerprint,
				history: previous,
			};
		},
		retry: false,
		throwOnError: false,
		onSuccess: (value) => {
			if (
				!mounted.current ||
				value.requestGeneration !== generation.current
			) {
				return;
			}
			attempt.current = undefined;
			const next = {
				workflowId: value.accepted.workflowId,
				runId: value.accepted.runId,
				draftHash: value.accepted.draftHash,
			};
			setReceipt(next);
			setSnapshot(value.fingerprint);
			setSent(value.sent);
			setHistory(value.history);
			setMessage((current) =>
				current.trim() === value.sent ? "" : current,
			);
			setPollSince(Date.now());
			if (storageKey) {
				try {
					sessionStorage.setItem(storageKey, JSON.stringify(next));
				} catch {
					/* Run still exists in Temporal. */
				}
			}
		},
	});
	const cancel = useMutation({
		mutationFn: async () => {
			if (!receipt) {
				throw new Error("Choose a preview.");
			}
			return orpcClient.agents.previews.cancel({
				organizationId,
				workflowId: receipt.workflowId,
				runId: receipt.runId,
			});
		},
		retry: false,
		onSuccess: () => void detail.refetch(),
	});
	const reset = () => {
		generation.current += 1;
		setReceipt(undefined);
		setSnapshot(undefined);
		setHistory([]);
		setSent(undefined);
		attempt.current = undefined;
		start.reset();
		if (storageKey) {
			try {
				sessionStorage.removeItem(storageKey);
			} catch {
				/* Optional browser storage. */
			}
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
				<div className="space-y-2">
					<h2 className="font-semibold">Preview your draft</h2>
					<p className="text-sm text-muted-foreground">
						Try your instructions with selected workspace documents,
						skill instructions, and project read tools. The captured
						draft runs in the background; your saved agent stays
						unchanged.
					</p>
					<p className="text-xs text-muted-foreground">
						Read-only preview · Up to 30 selected documents · Source
						text is read in bounded pages. External actions and goal
						loops use saved-agent runs.
					</p>
					{draft.capabilityIds.includes("project-context") && (
						<p className="text-xs text-muted-foreground">
							Project preview reads documents, context sources and
							features. Semantic search and meeting transcripts
							use saved-agent runs.
						</p>
					)}
					{savedAgentHref && (
						<Link
							href={savedAgentHref}
							target="_blank"
							rel="noopener noreferrer"
							className="text-sm underline underline-offset-4"
						>
							Run the saved agent with its full configuration
							(opens a new tab)
						</Link>
					)}
				</div>
				{!draft.instructions.trim() && (
					<p role="status" className="text-sm text-muted-foreground">
						Add instructions to your draft before running a preview.
					</p>
				)}
				{instructionsTooLong && (
					<p role="status" className="text-sm text-muted-foreground">
						Preview supports up to 40,000 instruction characters.
						Shorten the draft or use a saved-agent run.
					</p>
				)}
				{unsupported.length > 0 && (
					<Alert>
						<AlertTitle>
							Some settings need a saved-agent run
						</AlertTitle>
						<AlertDescription>
							<ul className="list-disc space-y-1 pl-4">
								{unsupported.map((issue) => (
									<li key={issue}>{issue}</li>
								))}
							</ul>
							<p className="mt-2">
								These settings will not be silently omitted.
								Adjust the draft to test the supported read-only
								configuration.
							</p>
						</AlertDescription>
					</Alert>
				)}
				{draft.expectedOutput?.trim() && (
					<div className="space-y-1 text-sm">
						<h3 className="font-medium">What to check</h3>
						<p className="whitespace-pre-wrap break-words text-muted-foreground">
							{draft.expectedOutput}
						</p>
					</div>
				)}
				{receipt && (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								setPollSince(Date.now());
								void detail.refetch();
							}}
						>
							<RefreshCwIcon className="size-4" />
							Refresh preview
						</Button>
						{!running && !start.isPending && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={reset}
							>
								New preview
							</Button>
						)}
					</div>
				)}
				{(start.isError || detail.isError || cancel.isError) && (
					<Alert variant="error">
						<AlertTitle>Preview could not complete</AlertTitle>
						<AlertDescription>
							{admissionMessage(
								start.error ?? detail.error ?? cancel.error,
							)}
						</AlertDescription>
					</Alert>
				)}
				{earlierDraft && state && (
					<output className="block text-sm text-muted-foreground">
						{snapshot
							? "Your draft changed. The next message starts a fresh preview."
							: "Restored preview. Start a new preview to test the current draft."}
					</output>
				)}
				{!detail.isError &&
					history.map((item, index) => (
						<div
							key={`${index}-${item.role}`}
							className="space-y-1"
						>
							<p className="text-xs font-medium text-muted-foreground">
								{item.role === "user" ? "You" : "Agent"}
							</p>
							{item.role === "assistant" ? (
								<Response
									normalizeHeadings
									normalizeMarkdown={false}
								>
									{item.content}
								</Response>
							) : (
								<p className="whitespace-pre-wrap break-words text-sm">
									{item.content}
								</p>
							)}
						</div>
					))}
				{sent && !detail.isError && (
					<div className="space-y-1">
						<p className="text-xs font-medium text-muted-foreground">
							You
						</p>
						<p className="whitespace-pre-wrap break-words text-sm">
							{sent}
						</p>
					</div>
				)}
				{state && (
					<section aria-label="Preview result" className="space-y-4">
						<output className="block text-sm text-muted-foreground">
							{state.phase}
						</output>
						{state.status === "COMPLETED" &&
							state.toolCalls.some(
								(call) => call.status === "error",
							) && (
								<Alert>
									<AlertTitle>
										Some sources could not be read
									</AlertTitle>
									<AlertDescription>
										Review the activity and cited sources
										before relying on this answer.
									</AlertDescription>
								</Alert>
							)}
						{state.status === "COMPLETED" && receipt && (
							<div className="space-y-2">
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={!draft.instanceId}
									onClick={() => setSaveTestOpen(true)}
								>
									Save as test
								</Button>
								{!draft.instanceId && (
									<p className="text-xs text-muted-foreground">
										Save your agent first to keep reusable
										tests.
									</p>
								)}
							</div>
						)}
						{state.response && (
							<Response
								normalizeHeadings
								normalizeMarkdown={false}
							>
								{state.response}
							</Response>
						)}
						{state.error && (
							<Alert variant="error">
								<AlertTitle>
									{state.status === "CANCELLED"
										? "Preview stopped"
										: "Preview needs attention"}
								</AlertTitle>
								<AlertDescription>
									{state.error}
								</AlertDescription>
							</Alert>
						)}
						{state.sources.length > 0 && (
							<div className="space-y-2">
								<h3 className="text-sm font-medium">
									Sources read
								</h3>
								<ul className="space-y-2 text-sm">
									{state.sources.map((source, index) => (
										<li key={`${source.id}-${index}`}>
											<span className="break-words">
												{source.title}
											</span>
											<span className="ml-2 text-xs text-muted-foreground">
												{source.kind === "skill"
													? "Skill"
													: "Document"}
												{source.truncated
													? " · Partial text; more pages available"
													: ""}
											</span>
										</li>
									))}
								</ul>
							</div>
						)}
						{state.toolCalls.length > 0 && (
							<details>
								<summary className="cursor-pointer text-sm font-medium">
									Activity · {state.toolCalls.length} reads
								</summary>
								<ol className="mt-2 space-y-2 text-xs text-muted-foreground">
									{state.toolCalls.map((call, index) => (
										<li
											key={`${call.id}-${index}`}
											className="break-words"
										>
											{call.name} · {call.status} ·{" "}
											{call.durationMs}ms{" "}
											{call.message && (
												<span>{call.message}</span>
											)}
										</li>
									))}
								</ol>
							</details>
						)}
					</section>
				)}
				{start.isPending && (
					<output className="block text-sm text-muted-foreground">
						Starting preview…
					</output>
				)}
			</div>
			{saveTestOpen && draft.instanceId && receipt && (
				<AgentTestCaseDialog
					organizationId={organizationId}
					instanceId={draft.instanceId}
					initialInput={sent ?? ""}
					sourcePreview={{
						workflowId: receipt.workflowId,
						runId: receipt.runId,
					}}
					onClose={() => setSaveTestOpen(false)}
				/>
			)}
			{followupTooLarge && (
				<p
					role="status"
					className="px-3 py-2 text-sm text-muted-foreground"
				>
					This response is too long for a follow-up. Choose New
					preview to start a fresh conversation.
				</p>
			)}
			<form
				className="shrink-0 space-y-2 border-t border-border bg-card p-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (
						message.trim() &&
						userId &&
						draft.instructions.trim() &&
						!instructionsTooLong &&
						!followupTooLarge &&
						!running &&
						!start.isPending &&
						!unsupported.length
					) {
						start.mutate();
					}
				}}
			>
				<Label htmlFor={`${id}-message`}>
					{state?.status === "COMPLETED" && !earlierDraft
						? "Follow-up message"
						: "Test message"}
				</Label>
				<Textarea
					id={`${id}-message`}
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					placeholder="Give your agent a sample task…"
					rows={3}
					maxLength={20_000}
				/>
				<div className="flex items-center justify-between gap-2">
					<Button
						type="submit"
						size="sm"
						loading={start.isPending}
						disabled={
							!message.trim() ||
							!userId ||
							!draft.instructions.trim() ||
							instructionsTooLong ||
							followupTooLarge ||
							running ||
							start.isPending ||
							unsupported.length > 0
						}
					>
						<PlayIcon className="size-4" />
						{state?.status === "COMPLETED" && !earlierDraft
							? "Send follow-up"
							: "Run preview"}
					</Button>
					{running && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							loading={cancel.isPending}
							onClick={() => cancel.mutate()}
						>
							<SquareIcon className="size-3" />
							Stop preview
						</Button>
					)}
				</div>
			</form>
		</div>
	);
}
