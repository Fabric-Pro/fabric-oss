"use client";

import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { CheckIcon, Loader2Icon } from "lucide-react";
import type { ParlumeSession } from "../lib/parlume-format";
import { CARD_TITLE } from "../lib/parlume-styles";
import { JOIN_STEPS, joinStepIndex, joinTitle } from "../lib/parlume-view";

const STEP_BAR = {
	done: "bg-success",
	active: "bg-highlight",
	pending: "bg-border",
} as const;

const STEP_TEXT = {
	done: "text-success",
	active: "text-highlight-ink",
	pending: "text-muted-foreground",
} as const;

/** The bot has been invited and has not started listening yet. */
export function ParlumeJoiningCard({
	session,
	canStop,
	isStopping,
	onStop,
}: {
	session: ParlumeSession;
	canStop: boolean;
	isStopping: boolean;
	onStop: (sessionId: string) => void;
}) {
	const activeStep = joinStepIndex(session);
	const isLeaving = isStopping || session.status === "LEAVING";
	return (
		<Card>
			<div className="flex flex-wrap items-start justify-between gap-4 p-6">
				<div className="flex items-start gap-3.5">
					<Loader2Icon
						className="mt-1 size-[18px] shrink-0 text-highlight-ink motion-safe:animate-spin"
						aria-hidden="true"
					/>
					<div aria-live="polite" className="space-y-1">
						<h3 className={CARD_TITLE}>{joinTitle(session)}</h3>
						<p className="text-sm text-muted-foreground">
							Ask the organizer to admit “Fabric Parlume” from the
							Teams lobby.
						</p>
					</div>
				</div>
				{canStop && (
					<Button
						type="button"
						variant="outline"
						autoLoading={false}
						onClick={() => onStop(session.id)}
						disabled={isLeaving}
					>
						{isLeaving ? "Cancelling…" : "Cancel"}
					</Button>
				)}
			</div>
			{session.status === "STOP_FAILED" && (
				<p role="alert" className="px-6 pb-4 text-sm text-destructive">
					Parlume could not confirm it left the meeting. Try again.
				</p>
			)}
			<ol className="grid grid-cols-3 gap-3 px-6 pb-6">
				{JOIN_STEPS.map((label, index) => {
					const state =
						index < activeStep
							? "done"
							: index === activeStep
								? "active"
								: "pending";
					return (
						<li
							key={label}
							aria-current={
								state === "active" ? "step" : undefined
							}
							className="space-y-2"
						>
							<span
								className={`block h-[3px] rounded-full ${STEP_BAR[state]}`}
							/>
							<span
								className={`flex items-center gap-1.5 text-[13px] leading-[18px] ${STEP_TEXT[state]}`}
							>
								{state === "done" && (
									<CheckIcon
										className="size-3.5"
										aria-hidden="true"
									/>
								)}
								{label}
							</span>
						</li>
					);
				})}
			</ol>
		</Card>
	);
}
