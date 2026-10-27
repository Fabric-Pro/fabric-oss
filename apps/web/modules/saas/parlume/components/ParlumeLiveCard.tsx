"use client";

import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { AudioLinesIcon, LogOutIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	formatClock,
	formatCost,
	formatElapsed,
	initialsOf,
	modeLabel,
	type ParlumeRequest,
	type ParlumeSession,
} from "../lib/parlume-format";
import { CARD_TITLE, MONO_LABEL } from "../lib/parlume-styles";
import { useNow } from "../lib/use-now";

const LIVE_ACTIVITY_ITEMS = 3;

function LiveDot() {
	return (
		<span className="relative flex size-2.5" aria-hidden="true">
			<span className="absolute inline-flex size-full rounded-full bg-success opacity-50 motion-safe:animate-ping" />
			<span className="relative inline-flex size-2.5 rounded-full bg-success" />
		</span>
	);
}

function Elapsed({ joinedAt }: { joinedAt: Date | string }) {
	const now = useNow(1000);
	return (
		<span role="timer" className="font-mono tabular-nums text-success">
			{formatElapsed(now - new Date(joinedAt).getTime())}
		</span>
	);
}

function LiveActivity({
	requests,
	isLoading,
}: {
	requests: ParlumeRequest[];
	isLoading: boolean;
}) {
	return (
		<div className="space-y-3 px-6 pt-4.5 pb-5.5">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className={MONO_LABEL}>Live activity</span>
				<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
					<AudioLinesIcon className="size-3.5" aria-hidden="true" />
					Listening for “Hey Fabric”
				</span>
			</div>
			{requests.slice(0, LIVE_ACTIVITY_ITEMS).map((request) => (
				<div key={request.id} className="flex gap-3">
					<span
						aria-hidden="true"
						className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10.5px]"
					>
						{initialsOf(request.speakerName)}
					</span>
					<div className="min-w-0 flex-1 space-y-1">
						<div className="flex justify-between gap-2 text-[13px] leading-[18px]">
							<span className="font-medium">
								{request.speakerName ?? "Unidentified attendee"}
							</span>
							<span className="text-muted-foreground">
								{formatClock(request.createdAt)}
							</span>
						</div>
						<p className="text-sm">{request.requestText}</p>
						{request.responseText && (
							<p className="truncate text-[13px] leading-[18px] text-muted-foreground">
								{request.responseText}
							</p>
						)}
					</div>
				</div>
			))}
			{requests.length === 0 && (
				<p className="text-[13px] leading-[18px] text-muted-foreground">
					{isLoading
						? "Loading requests…"
						: "No requests yet. Any attendee can say “Hey Fabric” to ask a question."}
				</p>
			)}
		</div>
	);
}

/** The session Parlume is in right now, with the way to take it out. */
export function ParlumeLiveCard({
	session,
	joinedAt,
	costMicroUsd,
	requests,
	requestsLoading,
	canStop,
	isStopping,
	onStop,
}: {
	session: ParlumeSession;
	joinedAt: Date | string;
	costMicroUsd: number | undefined;
	requests: ParlumeRequest[];
	requestsLoading: boolean;
	canStop: boolean;
	isStopping: boolean;
	onStop: (sessionId: string) => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const keepRef = useRef<HTMLButtonElement>(null);
	const removeRef = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	useEffect(() => {
		if (confirming) {
			keepRef.current?.focus();
		} else if (wasConfirming.current) {
			removeRef.current?.focus();
		}
		wasConfirming.current = confirming;
	}, [confirming]);

	const isLeaving = isStopping || session.status === "LEAVING";
	const canRemove =
		canStop &&
		(session.status === "ACTIVE" || session.status === "STOP_FAILED");

	return (
		<Card className="border-success/35">
			<div className="flex flex-wrap items-start justify-between gap-4 p-6 pb-5">
				<div className="flex items-start gap-3.5">
					<span className="flex pt-2">
						<LiveDot />
					</span>
					<div aria-live="polite" className="space-y-1">
						<h3 className={CARD_TITLE}>
							{isLeaving
								? "Leaving the meeting…"
								: "Live in meeting"}
						</h3>
						<p className="flex flex-wrap gap-2 text-[13px] leading-[18px] text-muted-foreground">
							<Elapsed joinedAt={joinedAt} />
							<span>Joined {formatClock(joinedAt)}</span>
						</p>
					</div>
				</div>
				{canRemove && !confirming && !isLeaving && (
					<Button
						ref={removeRef}
						type="button"
						variant="outline"
						className="border-destructive/35 text-destructive hover:border-destructive hover:bg-destructive/5"
						onClick={() => setConfirming(true)}
					>
						<LogOutIcon aria-hidden="true" />
						Remove from meeting
					</Button>
				)}
			</div>
			{session.status === "STOP_FAILED" && (
				<p role="alert" className="px-6 pb-4 text-sm text-destructive">
					Parlume could not confirm it left the meeting. Try again.
				</p>
			)}
			{confirming && (
				<fieldset
					aria-label="Confirm removal"
					className="mx-6 mb-5 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg bg-destructive/5 px-3.5 py-3"
				>
					<span className="text-sm">
						Parlume will leave the meeting and save the transcript
						to project Context.
					</span>
					<span className="flex gap-2">
						<Button
							ref={keepRef}
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setConfirming(false)}
						>
							Keep in meeting
						</Button>
						<Button
							type="button"
							variant="destructive"
							size="sm"
							disabled={isLeaving}
							onClick={() => {
								setConfirming(false);
								onStop(session.id);
							}}
						>
							Remove now
						</Button>
					</span>
				</fieldset>
			)}
			<dl className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] border-y border-border">
				<div className="space-y-0.5 px-6 py-3.5">
					<dt className={MONO_LABEL}>Agent</dt>
					<dd className="text-sm">{session.agentLabel}</dd>
				</div>
				<div className="space-y-0.5 border-l border-border px-6 py-3.5">
					<dt className={MONO_LABEL}>Mode</dt>
					<dd className="text-sm">
						{modeLabel(session.toolsReadOnly)}
					</dd>
				</div>
				<div className="min-w-0 space-y-0.5 border-l border-border px-6 py-3.5">
					<dt className={MONO_LABEL}>Spend so far</dt>
					<dd className="text-sm tabular-nums">
						{costMicroUsd === undefined
							? "—"
							: formatCost(costMicroUsd)}
					</dd>
					<dd className="text-xs text-muted-foreground">
						Bot and transcription time are added when the meeting
						ends.
					</dd>
				</div>
			</dl>
			<LiveActivity requests={requests} isLoading={requestsLoading} />
		</Card>
	);
}
