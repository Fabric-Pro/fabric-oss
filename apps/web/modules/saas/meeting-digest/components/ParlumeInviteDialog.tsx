"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Loader2Icon } from "lucide-react";
import { type ReactElement, useState } from "react";

const SESSIONS_QUERY_KEY = "parlume-sessions";
const FABRIC_AGENT_KIND = "FABRIC_AGENT";

/**
 * This is deliberately a project-admin control rather than a Teams
 * integration setting. Custom agents must carry this project's project-context
 * binding; the server rechecks that binding at start.
 */
export function ParlumeInviteDialog({
	projectId,
	children,
}: {
	projectId: string;
	children: ReactElement;
}) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [agentSelection, setAgentSelection] = useState(FABRIC_AGENT_KIND);
	const [meetingUrl, setMeetingUrl] = useState("");
	const [toolsReadOnly, setToolsReadOnly] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [isInviting, setIsInviting] = useState(false);
	const [stoppingSessionId, setStoppingSessionId] = useState<string | null>(
		null,
	);
	const agentsQuery = useQuery({
		queryKey: ["parlume-agents", projectId],
		queryFn: () =>
			orpcClient.projects.parlume.listAgents({
				projectId,
				includeBuiltIn: true,
			}),
		enabled: open,
		retry: false,
	});
	const sessionsQuery = useQuery({
		queryKey: [SESSIONS_QUERY_KEY, projectId],
		queryFn: () => orpcClient.projects.parlume.listSessions({ projectId }),
		enabled: open,
		retry: false,
		refetchInterval: open ? 10_000 : false,
	});
	const agents = agentsQuery.data?.agents ?? [];
	const operatorReady = agentsQuery.data?.operatorReady !== false;
	const selectedAgent = agents.find((agent) =>
		agent.kind === FABRIC_AGENT_KIND
			? agentSelection === FABRIC_AGENT_KIND
			: agentSelection === `custom:${agent.agentInstanceSId}`,
	);

	const invite = async () => {
		if (!selectedAgent) {
			setError("Choose a Fabric Agent first.");
			return;
		}
		setError(null);
		setIsInviting(true);
		try {
			await orpcClient.projects.parlume.start({
				projectId,
				agentKind: selectedAgent.kind,
				...(selectedAgent.kind === "TEMPLATE_INSTANCE"
					? { agentInstanceSId: selectedAgent.agentInstanceSId }
					: {}),
				meetingUrl: meetingUrl.trim(),
				toolsReadOnly,
			});
			setMeetingUrl("");
			setToolsReadOnly(true);
			await queryClient.invalidateQueries({
				queryKey: [SESSIONS_QUERY_KEY, projectId],
			});
		} catch (inviteError) {
			const message =
				inviteError instanceof Error ? inviteError.message : "";
			setError(
				message.includes("not ready") || message.includes("voice key")
					? "Parlume needs operator setup in this environment before it can join meetings."
					: "Parlume could not join this meeting. Check the link and try again.",
			);
		} finally {
			setIsInviting(false);
		}
	};

	const stop = async (sessionId: string) => {
		setError(null);
		setStoppingSessionId(sessionId);
		try {
			await orpcClient.projects.parlume.stop({ projectId, sessionId });
			await queryClient.invalidateQueries({
				queryKey: [SESSIONS_QUERY_KEY, projectId],
			});
		} catch {
			setError(
				"Parlume could not leave the meeting. Try stopping it again.",
			);
		} finally {
			setStoppingSessionId(null);
		}
	};

	const pending = isInviting;

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-lg max-sm:[&_:is(button,input,select,summary)]:min-h-11 pointer-coarse:[&_:is(button,input,select,summary)]:min-h-11">
				<DialogHeader>
					<DialogTitle>Invite Parlume</DialogTitle>
					<DialogDescription>
						Parlume joins as an external AI guest. The organizer may
						need to admit it from the lobby. It records and
						transcribes meeting audio, and its replies use an
						AI-generated voice. Any meeting attendee can say “Hey
						Fabric,” “Hey Parlume,” or “Hey Fabric Parlume” to use
						the selected agent and its connected knowledge.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					{!operatorReady && (
						<p
							className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
							role="alert"
						>
							Parlume is not configured for invitations in this
							environment. An operator must complete its media
							setup before a meeting link can be used.
						</p>
					)}
					<div className="space-y-2">
						<Label htmlFor="parlume-agent">Fabric Agent</Label>
						{agentsQuery.isLoading ? (
							<p className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2Icon
									className="size-4 animate-spin"
									aria-hidden="true"
								/>
								Loading project agents…
							</p>
						) : agentsQuery.isError ? (
							<p
								className="flex items-center gap-2 text-sm text-destructive"
								role="alert"
							>
								Could not load project agents.
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => agentsQuery.refetch()}
								>
									Retry agents
								</Button>
							</p>
						) : (
							<select
								id="parlume-agent"
								className="h-9 w-full rounded-md border bg-background px-3 text-sm"
								value={agentSelection}
								onChange={(event) =>
									setAgentSelection(event.target.value)
								}
							>
								{agents.map((agent) => (
									<option
										key={
											agent.kind === FABRIC_AGENT_KIND
												? FABRIC_AGENT_KIND
												: agent.agentInstanceSId
										}
										value={
											agent.kind === FABRIC_AGENT_KIND
												? FABRIC_AGENT_KIND
												: `custom:${agent.agentInstanceSId}`
										}
									>
										{agent.label}
										{agent.version
											? ` (v${agent.version})`
											: ""}
									</option>
								))}
							</select>
						)}
					</div>
					<div className="space-y-2">
						<Label htmlFor="parlume-meeting-url">
							Teams meeting link
						</Label>
						<Input
							id="parlume-meeting-url"
							type="url"
							placeholder="https://teams.microsoft.com/l/meetup-join/..."
							value={meetingUrl}
							onChange={(event) =>
								setMeetingUrl(event.target.value)
							}
						/>
					</div>
					<div className="space-y-2 rounded-md border p-3">
						<div className="flex items-center justify-between gap-3">
							<Label htmlFor="parlume-read-only">Read-only</Label>
							<Switch
								id="parlume-read-only"
								checked={toolsReadOnly}
								onCheckedChange={setToolsReadOnly}
								aria-describedby="parlume-action-mode"
								disabled={pending}
							/>
						</div>
						<p
							id="parlume-action-mode"
							className="text-xs text-muted-foreground"
						>
							{toolsReadOnly
								? "Parlume can answer questions and look up information. It cannot make changes."
								: "Attendees may request changes using your current permissions. Parlume describes each action and waits for that requester to confirm. If the speaker cannot be identified, the action is blocked."}
						</p>
					</div>
					<p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
						Parlume saves a project-scoped transcript after the
						meeting. Requests, approvals and outcomes appear in
						Parlume history. Its voice replies can be interrupted by
						another speaker. Review meeting policies and tell
						participants before inviting it.
					</p>
					{error && (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					)}
					{sessionsQuery.isError ? (
						<p
							className="flex items-center gap-2 text-sm text-destructive"
							role="alert"
						>
							Could not load recent invitations.
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() => sessionsQuery.refetch()}
							>
								Retry invitations
							</Button>
						</p>
					) : sessionsQuery.data?.sessions.length ? (
						<div className="space-y-2 border-t pt-3">
							<p className="text-sm font-medium">
								Recent invitations
							</p>
							{sessionsQuery.data.sessions.map((session) => {
								const invitationLabel = `${session.agentLabel} invited ${new Intl.DateTimeFormat(
									undefined,
									{ dateStyle: "medium", timeStyle: "short" },
								).format(new Date(session.createdAt))}`;

								return (
									<div
										key={session.id}
										className="space-y-2 rounded-md border p-2 text-sm"
									>
										<p className="font-medium">
											{invitationLabel}
										</p>
										<p className="text-xs text-muted-foreground">
											{session.toolsReadOnly
												? "Read-only"
												: "Actions with confirmation"}
										</p>
										<div className="flex items-center justify-between gap-3">
											<span className="text-muted-foreground">
												{session.status
													.toLowerCase()
													.replaceAll("_", " ")}
											</span>
											{!["ENDED", "FAILED"].includes(
												session.status,
											) && (
												<Button
													type="button"
													variant="outline"
													size="sm"
													onClick={() =>
														stop(session.id)
													}
													disabled={
														stoppingSessionId ===
														session.id
													}
													aria-label={`Stop ${invitationLabel}`}
												>
													{stoppingSessionId ===
													session.id
														? "Stopping…"
														: "Stop"}
												</Button>
											)}
										</div>
										{session.lastError && (
											<p className="text-destructive">
												{session.lastError}
											</p>
										)}
										{session.notes && (
											<details>
												<summary className="cursor-pointer font-medium">
													Meeting notes
												</summary>
												<p className="mt-2 whitespace-pre-wrap text-muted-foreground">
													{session.notes}
												</p>
											</details>
										)}
										{session.transcriptContextId &&
											!session.notes && (
												<p className="text-muted-foreground">
													{session.notesStatus ===
													"FAILED"
														? "Meeting notes are unavailable. The transcript is saved in project Context."
														: "Preparing meeting notes…"}
												</p>
											)}
									</div>
								);
							})}
						</div>
					) : null}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => setOpen(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={invite}
						disabled={
							pending ||
							!operatorReady ||
							agentsQuery.isError ||
							!selectedAgent ||
							meetingUrl.trim() === ""
						}
					>
						Invite Parlume
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
