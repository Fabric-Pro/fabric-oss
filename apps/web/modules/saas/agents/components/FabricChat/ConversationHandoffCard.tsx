"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Textarea } from "@ui/components/textarea";
import { AlertTriangle, ArrowRight, ChevronDown, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { TurnBudgetStop } from "../../lib/turn-budget-stop";

interface Props {
	parentConversationId: string;
	reason: string;
	summary: string;
	/** The server-owned budget stop decides the limit copy. */
	budgetStop?: TurnBudgetStop;
	organizationId?: string | null;
	onContinue: (newConversationId: string) => void;
	/** Available on the owner chat surface, with a stopped server turn id. */
	onContinueInChat?: () => void | Promise<void>;
	busy?: boolean;
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
 * `Token budget exceeded: n/m`, `Iteration limit reached: n/m`, or
 * `Time limit reached: n/m seconds`.
 */
function isAnswerBudgetStop(reason: string): boolean {
	return /^(Token budget exceeded|Iteration limit reached|Time limit reached)\b/.test(
		reason,
	);
}

export function ConversationHandoffCard({
	parentConversationId,
	reason,
	summary,
	budgetStop,
	organizationId,
	onContinue,
	onContinueInChat,
	onDismiss,
	busy = false,
}: Props) {
	const [creating, setCreating] = useState(false);
	const [continuing, setContinuing] = useState(false);
	const [summaryOpen, setSummaryOpen] = useState(false);
	const disabled = busy || creating || continuing;
	const answerBudgetStop = isAnswerBudgetStop(reason);
	const timeLimitStop =
		budgetStop?.kind === "time_limit" ||
		(!budgetStop && /^Time limit reached\b/.test(reason));
	const title =
		budgetStop?.kind === "token_allowance"
			? TOKEN_ALLOWANCE_STOP_COPY.title
			: timeLimitStop
				? "This answer reached its time limit"
				: budgetStop?.kind === "round_limit"
					? "This answer reached its step limit"
					: budgetStop?.kind === "token_budget"
						? "This answer reached its token budget"
						: answerBudgetStop
							? "This answer ran out of its step budget"
							: "This conversation has reached its context limit";
	const body =
		budgetStop?.kind === "token_allowance"
			? TOKEN_ALLOWANCE_STOP_COPY.body[budgetStop.stopReason]
			: timeLimitStop
				? "The reply above covers the progress made before this answer reached its time limit. Continue to pick up from where it stopped."
				: budgetStop?.kind === "token_budget"
					? "The reply above covers the progress made before this answer reached its token budget. Continue to pick up from where it stopped."
					: budgetStop?.kind === "round_limit"
						? "The reply above covers the progress made within this answer's steps. Continue to pick up from where it stopped."
						: answerBudgetStop
							? "The reply above covers what was found before the assistant used up the steps it has for one answer. Ask it to continue, narrow the question, or start a fresh chat with the progress summary attached."
							: `${reason}. Start a fresh chat with the progress summary attached so the agent can continue from where we left off.`;
	const handleNewChat = async () => {
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
			toast.error(
				error instanceof Error
					? error.message
					: "Could not start a new chat. Please try again.",
			);
		} finally {
			setCreating(false);
		}
	};
	const handleContinue = async () => {
		setContinuing(true);
		try {
			await onContinueInChat?.();
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Could not continue. Please try again.",
			);
		} finally {
			setContinuing(false);
		}
	};
	return (
		<Card className="mb-3 bg-muted/50">
			<CardContent className="p-4">
				<div className="flex items-start gap-3">
					<AlertTriangle
						className="h-5 w-5 shrink-0 text-muted-foreground mt-0.5"
						aria-hidden="true"
					/>
					<div className="flex-1 min-w-0">
						<h3 className="text-sm font-semibold text-foreground">
							{title}
						</h3>
						<p className="mt-1 text-sm text-muted-foreground">
							{body}
						</p>
						<div className="mt-4 flex flex-wrap items-center gap-2">
							{onContinueInChat && (
								<Button
									size="sm"
									onClick={handleContinue}
									disabled={disabled}
								>
									{continuing ? "Continuing..." : "Continue"}
								</Button>
							)}
							<Button
								size="sm"
								variant={
									onContinueInChat ? "outline" : "primary"
								}
								onClick={handleNewChat}
								disabled={disabled}
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
									: budgetStop || onContinueInChat
										? "Start a new chat with this summary"
										: "Continue in new chat"}
							</Button>
							{onDismiss && (
								<Button
									size="sm"
									variant="ghost"
									onClick={onDismiss}
									disabled={disabled}
								>
									Dismiss
								</Button>
							)}
						</div>
						{summary && (
							<Collapsible
								open={summaryOpen}
								onOpenChange={setSummaryOpen}
								className="mt-3"
							>
								<CollapsibleTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="sm"
									>
										<ChevronDown
											className="h-3 w-3"
											aria-hidden="true"
										/>
										{summaryOpen ? "Hide" : "View"} summary
									</Button>
								</CollapsibleTrigger>
								<CollapsibleContent className="mt-2">
									<Textarea
										readOnly
										rows={8}
										aria-label="Progress summary"
										value={summary}
										className="max-h-72 text-sm"
									/>
								</CollapsibleContent>
							</Collapsible>
						)}
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
