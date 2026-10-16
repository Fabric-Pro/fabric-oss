"use client";

import { isTeamsMeetingUrl } from "@repo/api/modules/projects/lib/parlume-attendee";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import {
	ArrowRightIcon,
	CircleAlertIcon,
	CircleCheckIcon,
	LinkIcon,
} from "lucide-react";
import { useState } from "react";
import { CARD_TITLE } from "../lib/parlume-styles";
import {
	AGENTS_QUERY_KEY,
	SESSIONS_QUERY_KEY,
	USAGE_QUERY_KEY,
} from "../lib/query-keys";
import {
	agentKey,
	FABRIC_AGENT_KIND,
	ParlumeAgentPicker,
} from "./ParlumeAgentPicker";
import { ParlumeModePicker } from "./ParlumeModePicker";

function UrlHint({ url, valid }: { url: string; valid: boolean }) {
	if (url === "") {
		return (
			<p className="text-xs text-muted-foreground">
				Copy the join link from the meeting invite in Teams or Outlook.
			</p>
		);
	}
	return valid ? (
		<p className="flex items-center gap-1.5 text-xs text-success">
			<CircleCheckIcon className="size-3.5" aria-hidden="true" />
			Teams meeting link
		</p>
	) : (
		<p
			role="alert"
			className="flex items-center gap-1.5 text-xs text-destructive"
		>
			<CircleAlertIcon className="size-3.5" aria-hidden="true" />
			This doesn't look like a Teams meeting link.
		</p>
	);
}

/**
 * Custom agents must carry this project's project-context binding; the server
 * rechecks that binding at start.
 */
export function ParlumeInviteCard({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const [agentSelection, setAgentSelection] = useState(FABRIC_AGENT_KIND);
	const [meetingUrl, setMeetingUrl] = useState("");
	const [toolsReadOnly, setToolsReadOnly] = useState(true);
	const [consent, setConsent] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [isInviting, setIsInviting] = useState(false);
	const agentsQuery = useQuery({
		queryKey: [AGENTS_QUERY_KEY, projectId],
		queryFn: () =>
			orpcClient.projects.parlume.listAgents({
				projectId,
				includeBuiltIn: true,
			}),
		retry: false,
	});
	const agents = agentsQuery.data?.agents ?? [];
	const operatorReady = agentsQuery.data?.operatorReady !== false;
	const selectedAgent = agents.find(
		(agent) => agentKey(agent) === agentSelection,
	);

	const url = meetingUrl.trim();
	const urlValid = isTeamsMeetingUrl(url);
	const blockedReason = !operatorReady
		? "Parlume is not configured for invitations in this environment"
		: !selectedAgent
			? "Choose an agent first"
			: !urlValid
				? "Paste a Teams meeting link first"
				: !consent
					? "Confirm you have told participants"
					: null;

	const invite = async () => {
		if (!selectedAgent || blockedReason) {
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
				meetingUrl: url,
				toolsReadOnly,
			});
			setMeetingUrl("");
			setToolsReadOnly(true);
			setConsent(false);
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: [SESSIONS_QUERY_KEY, projectId],
				}),
				queryClient.invalidateQueries({
					queryKey: [USAGE_QUERY_KEY, projectId],
				}),
			]);
		} catch (inviteError) {
			const message =
				inviteError instanceof Error ? inviteError.message : "";
			setError(
				message.includes("not ready") ||
					message.includes("needs a voice")
					? "Parlume needs operator setup in this environment before it can join meetings."
					: "Parlume could not join this meeting. Check the link and try again.",
			);
		} finally {
			setIsInviting(false);
		}
	};

	return (
		<Card>
			<CardHeader className="space-y-1.5 p-6 pb-5">
				<CardTitle className={CARD_TITLE}>
					Invite Parlume to a meeting
				</CardTitle>
				<p className="text-sm text-muted-foreground">
					Parlume joins as an external AI guest. The organizer may
					need to admit it from the lobby.
				</p>
			</CardHeader>
			<CardContent className="space-y-6 p-6 pt-0">
				{!operatorReady && (
					<p
						className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
						role="alert"
					>
						Parlume is not configured for invitations in this
						environment. An operator must complete its media setup
						before a meeting link can be used.
					</p>
				)}

				<div className="space-y-2">
					<Label htmlFor="parlume-meeting-url">
						Teams meeting link
					</Label>
					<div className="flex flex-wrap gap-2">
						<div className="relative min-w-0 flex-1 basis-80">
							<LinkIcon
								className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground"
								aria-hidden="true"
							/>
							<Input
								id="parlume-meeting-url"
								type="url"
								className="h-10 pl-9"
								placeholder="https://teams.microsoft.com/l/meetup-join/..."
								value={meetingUrl}
								onChange={(event) =>
									setMeetingUrl(event.target.value)
								}
								aria-invalid={url !== "" && !urlValid}
								aria-describedby="parlume-meeting-url-hint"
							/>
						</div>
						<Tooltip disabled={!blockedReason}>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<Button
										type="button"
										size="lg"
										autoLoading={false}
										onClick={invite}
										disabled={
											isInviting || blockedReason !== null
										}
										aria-describedby={
											blockedReason
												? "parlume-invite-blocked"
												: undefined
										}
									>
										{isInviting
											? "Inviting…"
											: "Invite Parlume"}
										<ArrowRightIcon aria-hidden="true" />
									</Button>
								</span>
							</TooltipTrigger>
							{blockedReason && (
								<TooltipContent>{blockedReason}</TooltipContent>
							)}
						</Tooltip>
						{blockedReason && (
							<span
								id="parlume-invite-blocked"
								className="sr-only"
							>
								{blockedReason}
							</span>
						)}
					</div>
					<div id="parlume-meeting-url-hint">
						<UrlHint url={url} valid={urlValid} />
					</div>
				</div>

				<div className="flex flex-wrap gap-5">
					<ParlumeAgentPicker
						agents={agents}
						isLoading={agentsQuery.isLoading}
						isError={agentsQuery.isError}
						onRetry={() => agentsQuery.refetch()}
						selection={agentSelection}
						onSelect={setAgentSelection}
						disabled={isInviting}
					/>
					<ParlumeModePicker
						toolsReadOnly={toolsReadOnly}
						onChange={setToolsReadOnly}
						disabled={isInviting}
					/>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
					<div className="flex items-start gap-2.5">
						<Checkbox
							id="parlume-consent"
							className="mt-0.5"
							checked={consent}
							onCheckedChange={(checked) =>
								setConsent(checked === true)
							}
							disabled={isInviting}
						/>
						<Label
							htmlFor="parlume-consent"
							className="cursor-pointer text-sm font-normal leading-5"
						>
							I've told participants that Parlume will record and
							transcribe this meeting.
						</Label>
					</div>
					<a
						href="#pr-how"
						className="whitespace-nowrap text-[13px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
					>
						What Parlume does in a meeting
					</a>
				</div>

				{error && (
					<p className="text-sm text-destructive" role="alert">
						{error}
					</p>
				)}
			</CardContent>
		</Card>
	);
}
