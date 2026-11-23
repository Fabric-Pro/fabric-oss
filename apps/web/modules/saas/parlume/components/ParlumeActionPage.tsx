"use client";

import { ORPCError } from "@orpc/client";
import {
	parlumeProposalFieldLabel,
	parlumeProposalValueLabel,
} from "@repo/utils/parlume-proposal-fields";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { CheckIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
	formatTimestamp,
	type ParlumeActionDetail,
} from "../lib/parlume-format";
import { MONO_LABEL } from "../lib/parlume-styles";
import {
	actionDecision,
	actionResult,
	actionStatus,
	TONE_BADGE,
} from "../lib/parlume-view";
import { ACTION_QUERY_KEY, HISTORY_QUERY_KEY } from "../lib/query-keys";

const RUNNING_POLL_MS = 3_000;

function argumentText(value: unknown): string {
	return typeof value === "string"
		? parlumeProposalValueLabel(value)
		: JSON.stringify(value, null, 2);
}

function argumentEntries(value: unknown): Array<[string, unknown]> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.entries(value)
		: [];
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof ORPCError && error.message
		? error.message
		: fallback;
}

/**
 * One change Parlume proposed in a meeting. A signed-in member with edit
 * rights confirms or dismisses it here; this is the only place a proposal is
 * confirmed. Everyone else who can open the project sees it and why they
 * cannot decide it.
 */
export function ParlumeActionPage({
	projectId,
	actionId,
	projectBasePath,
	dismissIntent,
}: {
	projectId: string;
	actionId: string;
	/** `/app/{org}/projects/{id}`, where the Parlume page lives. */
	projectBasePath: string;
	/** Opened from a chat post's Dismiss link: Dismiss takes the focus. */
	dismissIntent: boolean;
}) {
	const queryClient = useQueryClient();
	const queryKey = [ACTION_QUERY_KEY, projectId, actionId];
	const [error, setError] = useState<string | null>(null);
	const [deciding, setDeciding] = useState(false);
	const dismissRef = useRef<HTMLButtonElement>(null);
	const actionQuery = useQuery({
		queryKey,
		queryFn: () =>
			orpcClient.projects.parlume.action({ projectId, actionId }),
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.action.status === "EXECUTING"
				? RUNNING_POLL_MS
				: false,
	});

	const decide = async (decision: "confirm" | "dismiss") => {
		setError(null);
		setDeciding(true);
		try {
			const result =
				decision === "confirm"
					? await orpcClient.projects.parlume.confirmAction({
							projectId,
							actionId,
						})
					: await orpcClient.projects.parlume.dismissAction({
							projectId,
							actionId,
						});
			queryClient.setQueryData<ParlumeActionDetail>(
				queryKey,
				(current) =>
					current ? { ...current, action: result.action } : current,
			);
			await queryClient.invalidateQueries({
				queryKey: [HISTORY_QUERY_KEY, projectId],
			});
		} catch (decideError) {
			setError(
				errorMessage(
					decideError,
					decision === "confirm"
						? "Fabric could not confirm this change. Try again."
						: "Fabric could not dismiss this proposal. Try again.",
				),
			);
			await actionQuery.refetch();
		} finally {
			setDeciding(false);
		}
	};

	const openForDecision =
		actionQuery.data?.canConfirm === true &&
		actionQuery.data.action.status === "PROPOSED";
	useEffect(() => {
		if (dismissIntent && openForDecision) {
			dismissRef.current?.focus();
		}
	}, [dismissIntent, openForDecision]);

	if (actionQuery.isLoading) {
		return (
			<output className="block text-sm text-muted-foreground">
				Loading the proposed change…
			</output>
		);
	}
	if (!actionQuery.data) {
		return (
			<p role="alert" className="text-sm text-destructive">
				{actionQuery.error instanceof ORPCError &&
				actionQuery.error.code === "NOT_FOUND"
					? "This proposal does not exist in this project, or you cannot open it."
					: "Could not load this proposal. Try refreshing."}
			</p>
		);
	}

	const { action, canConfirm } = actionQuery.data;
	const status = actionStatus(action);
	const decision = actionDecision(action);
	const entries = argumentEntries(action.arguments);
	const meetingAt = action.session.joinedAt ?? action.session.createdAt;
	const result = actionResult(action, window.location.origin);

	return (
		<div className="max-w-2xl space-y-6">
			<header className="space-y-2.5">
				<p className="app-editorial-label">
					Proposed change
					{action.chatTag ? ` · ${action.chatTag}` : ""}
				</p>
				<h1 className="font-serif text-3xl font-normal leading-tight">
					{action.summary}
				</h1>
				<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
					<Badge variant={TONE_BADGE[status.tone]}>
						{status.label}
					</Badge>
					<span>
						Proposed by {action.session.agentLabel} in the meeting
						of{" "}
						<time dateTime={new Date(meetingAt).toISOString()}>
							{formatTimestamp(meetingAt)}
						</time>
					</span>
				</div>
			</header>

			<Card className="space-y-5 p-6">
				<section className="space-y-1.5">
					<h2 className={MONO_LABEL}>Asked by</h2>
					<p className="text-sm font-medium">
						{action.speakerName ?? "Unidentified attendee"}
					</p>
					<blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm text-muted-foreground">
						{action.requestText}
					</blockquote>
				</section>

				<section className="space-y-2">
					<h2 className={MONO_LABEL}>What the change sets</h2>
					{entries.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							This change takes no values.
						</p>
					) : (
						<dl className="divide-y divide-border rounded-lg border border-border">
							{entries.map(([key, value]) => (
								<div
									key={key}
									className="grid gap-1 px-3.5 py-2.5 sm:grid-cols-[10rem_1fr] sm:gap-3"
								>
									<dt className="text-xs text-muted-foreground">
										{parlumeProposalFieldLabel(key)}
									</dt>
									<dd className="whitespace-pre-wrap break-words text-sm">
										{argumentText(value)}
									</dd>
								</div>
							))}
						</dl>
					)}
				</section>

				{result && (
					<section className="space-y-1.5">
						<h2 className={MONO_LABEL}>Result</h2>
						<p className="whitespace-pre-wrap break-words text-sm">
							{result.href ? (
								<Link
									href={result.href}
									className="text-primary underline-offset-4 hover:underline"
								>
									{result.text}
								</Link>
							) : (
								result.text
							)}
						</p>
					</section>
				)}

				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}

				{decision ? (
					<p className="text-sm">{decision}</p>
				) : canConfirm ? (
					<div className="space-y-3">
						<p className="text-sm text-muted-foreground">
							Nothing changes until you confirm. Fabric makes the
							change as you, with your access, and records you as
							the member who confirmed it. Open until{" "}
							<time
								dateTime={new Date(
									action.expiresAt,
								).toISOString()}
							>
								{formatTimestamp(action.expiresAt)}
							</time>
							.
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								disabled={deciding}
								onClick={() => decide("confirm")}
							>
								<CheckIcon aria-hidden="true" />
								Confirm change
							</Button>
							<Button
								type="button"
								variant="outline"
								disabled={deciding}
								ref={dismissRef}
								onClick={() => decide("dismiss")}
							>
								<XIcon aria-hidden="true" />
								Dismiss
							</Button>
						</div>
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						Only a project member with edit rights can confirm or
						dismiss this change. You can see it, but you cannot
						decide it. Ask a member who can edit this project.
					</p>
				)}
			</Card>

			<Link
				href={`${projectBasePath}/parlume`}
				className="text-sm text-primary underline-offset-4 hover:underline"
			>
				Back to Parlume
			</Link>
		</div>
	);
}
