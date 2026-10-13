"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { AlertTriangle, ArrowRight, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { TurnBudgetStop } from "../../lib/turn-budget-stop";

interface Props {
	parentConversationId: string;
	reason: string;
	summary: string;
	/**
	 * The structured token-allowance stop, when the turn stopped on it. It
	 * decides the card on its own: no "Continue in new chat" action and no
	 * new-chat suggestion, because the user can ask to continue right here.
	 */
	budgetStop?: TurnBudgetStop;
	organizationId?: string | null;
	onContinue: (newConversationId: string) => void;
	onDismiss?: () => void;
}

/**
 * Copy for a turn that used its token allowance. The reply above it is a
 * written answer (`allowance_exhausted`: the answer is sized to the tokens it
 * had left, so it may draw on only the most recent findings), or a plain list
 * of what was found (`finalization_unavailable`). The second has several
 * causes — the final reply did not fit what was left, came back too short
 * twice, or failed, or the stop came before there was a conversation to
 * answer from — so its copy names none of them.
 */
const TOKEN_ALLOWANCE_STOP_COPY = {
	title: "This answer used its token allowance",
	body: {
		allowance_exhausted:
			"The reply above was written from what was found before the assistant used the tokens it has for one answer. You can ask it to continue in this chat, or narrow the question.",
		finalization_unavailable:
			"The assistant couldn't write a full reply, so the reply above lists what was found. You can ask it to continue in this chat, or narrow the question.",
	},
} as const;

/**
 * The orchestrator stops a single answer when it has spent its own step or
 * token budget — the conversation itself can go on. Those stops report
 * `Token budget exceeded: n/m` or `Iteration limit reached: n/m`.
 */
function isAnswerBudgetStop(reason: string): boolean {
	return /^(Token budget exceeded|Iteration limit reached)\b/.test(reason);
}

export function ConversationHandoffCard({
	parentConversationId,
	reason,
	summary,
	budgetStop,
	organizationId,
	onContinue,
	onDismiss,
}: Props) {
	const [creating, setCreating] = useState(false);
	const [summaryOpen, setSummaryOpen] = useState(false);

	if (budgetStop?.kind === "token_allowance") {
		return (
			<div className="rounded-lg border border-amber-300/50 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-950/20 p-4 mb-3">
				<div className="flex items-start gap-3">
					<AlertTriangle
						className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5"
						aria-hidden="true"
					/>
					<div className="flex-1 min-w-0">
						<h3 className="text-sm font-semibold text-foreground">
							{TOKEN_ALLOWANCE_STOP_COPY.title}
						</h3>
						<p className="mt-1 text-xs text-muted-foreground">
							{
								TOKEN_ALLOWANCE_STOP_COPY.body[
									budgetStop.stopReason
								]
							}
						</p>
						{onDismiss && (
							<div className="mt-4 flex flex-wrap items-center gap-2">
								<Button
									size="sm"
									variant="ghost"
									onClick={onDismiss}
								>
									Dismiss
								</Button>
							</div>
						)}
					</div>
				</div>
			</div>
		);
	}

	const handleContinue = async () => {
		setCreating(true);
		try {
			const result =
				await orpcClient.agents.conversations.continueInNewChat({
					organizationId: organizationId ?? null,
					parentConversationId,
					summary,
				});
			onContinue(result.id);
		} catch (error) {
			console.error(
				"[ConversationHandoffCard] continueInNewChat failed",
				error,
			);
			toast.error(
				error instanceof Error
					? error.message
					: "Could not start a new chat. Please try again.",
			);
			setCreating(false);
		}
	};

	const wordCount = summary.trim().split(/\s+/).length;
	const answerBudgetStop = isAnswerBudgetStop(reason);

	return (
		<div className="rounded-lg border border-amber-300/50 bg-amber-50/40 dark:border-amber-700/50 dark:bg-amber-950/20 p-4 mb-3">
			<div className="flex items-start gap-3">
				<AlertTriangle
					className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-500 mt-0.5"
					aria-hidden="true"
				/>
				<div className="flex-1 min-w-0">
					{answerBudgetStop ? (
						<>
							<h3 className="text-sm font-semibold text-foreground">
								This answer ran out of its step budget
							</h3>
							<p className="mt-1 text-xs text-muted-foreground">
								The reply above covers what was found before the
								assistant used up the steps it has for one
								answer. Ask it to continue, narrow the question,
								or start a fresh chat with the progress summary
								attached.
							</p>
						</>
					) : (
						<>
							<h3 className="text-sm font-semibold text-foreground">
								This conversation has reached its context limit
							</h3>
							<p className="mt-1 text-xs text-muted-foreground">
								{reason}. Start a fresh chat with the progress
								summary attached so the agent can continue from
								where we left off without the prior thread's
								context bloat.
							</p>
						</>
					)}

					<Collapsible
						open={summaryOpen}
						onOpenChange={setSummaryOpen}
						className="mt-3"
					>
						<CollapsibleTrigger asChild>
							<button
								type="button"
								className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
							>
								<ChevronDown
									className={`h-3 w-3 transition-transform ${
										summaryOpen ? "rotate-180" : ""
									}`}
									aria-hidden="true"
								/>
								{summaryOpen ? "Hide" : "View"} summary (~
								{wordCount} words)
							</button>
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-2">
							<div className="rounded-md border border-border/60 bg-background/60 p-3 text-xs text-foreground whitespace-pre-wrap max-h-72 overflow-y-auto">
								{summary}
							</div>
						</CollapsibleContent>
					</Collapsible>

					<div className="mt-4 flex flex-wrap items-center gap-2">
						<Button
							size="sm"
							onClick={handleContinue}
							disabled={creating}
							className="gap-1.5"
						>
							{creating ? (
								<Loader2
									className="h-3.5 w-3.5 animate-spin"
									aria-hidden="true"
								/>
							) : (
								<ArrowRight
									className="h-3.5 w-3.5"
									aria-hidden="true"
								/>
							)}
							{creating
								? "Creating new chat..."
								: "Continue in new chat"}
						</Button>
						{onDismiss && (
							<Button
								size="sm"
								variant="ghost"
								onClick={onDismiss}
								disabled={creating}
							>
								Stay here
							</Button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
