import {
	claimChatDelivery,
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	isProjectReadOnly,
	isScheduledNewsletterActorValid,
	listChatDeliveriesForSend,
	markChatDelivery,
	type NewsletterChatDeliveryKind,
} from "@repo/database";
import { getSlackCredentials } from "@repo/integrations/slack";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { postToTeams } from "../teams-mention";

export interface ChatDeliveryTargetSelection {
	platform: "TEAMS" | "SLACK";
	teamId: string;
	channelId: string;
	channelName?: string;
}

export interface DeliverChatMessagesInput {
	sendId: string;
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	kind: NewsletterChatDeliveryKind;
	channels: ChatDeliveryTargetSelection[];
	/**
	 * Platform-aware body. Called ONCE PER TARGET and, critically, BEFORE that
	 * target's ledger claim (see the render-before-claim note below).
	 *
	 * Takes the platform rather than an `isSlack` boolean so the codebase keeps
	 * ONE convention: `renderNewsletterChatMessage` already takes
	 * `opts.platform`, and the content adapter passes `t.platform` straight
	 * through today.
	 */
	renderText: (platform: "TEAMS" | "SLACK") => string;
	stillWanted?: () => Promise<boolean>;
}

export interface DeliverChatMessagesOutput {
	targetCount: number;
	sentCount: number;
	failedCount: number;
	skippedCount: number;
}

interface ResolvedTarget {
	platform: "TEAMS" | "SLACK";
	externalTeamId: string;
	channelId: string;
	linkUserId: string | null;
	linkOrgId: string | null;
}

interface SlackPostResult {
	ok: boolean;
	ts?: string;
	error?: string;
}

/** Raw chat.postMessage. Network/HTTP failures throw; Slack-level failures
 *  come back as `{ ok: false, error }` so the caller can branch on the code. */
async function postSlackMessage(
	token: string,
	channelId: string,
	text: string,
): Promise<SlackPostResult> {
	const resp = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ channel: channelId, text }),
	});
	if (!resp.ok) {
		throw new Error(`Slack API error: ${resp.status} ${resp.statusText}`);
	}
	return (await resp.json()) as SlackPostResult;
}

/**
 * Best-effort `conversations.join`. Joining is idempotent and succeeds only for
 * PUBLIC channels.
 *
 * Returns the Slack error code on failure rather than a bare boolean. The code
 * matters: a token minted before `channels:join` was requested fails with
 * `missing_scope`, and reporting that as the original `not_in_channel` would
 * tell the operator to invite the app when the real remedy is to reconnect
 * Slack. A private channel fails with a channel-type error, where inviting the
 * app IS the remedy. The two need different guidance.
 */
async function joinSlackChannel(
	token: string,
	channelId: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const resp = await fetch("https://slack.com/api/conversations.join", {
			method: "POST",
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ channel: channelId }),
		});
		if (!resp.ok) {
			return { ok: false, error: `http_${resp.status}` };
		}
		const data = (await resp.json()) as { ok: boolean; error?: string };
		return { ok: data.ok === true, error: data.error };
	} catch (e) {
		return {
			ok: false,
			error: e instanceof Error ? e.message : "join_failed",
		};
	}
}

/**
 * Newsletter-only chat delivery engine (Fizzy #2203): resolves the persisted
 * channel selection against the live linked set, claims/posts/marks each
 * target against the `NewsletterChatDelivery` ledger, and derives the return
 * counts from that ledger. Shared by the published-content send
 * (`send-newsletter-chat-messages.ts`, kind CONTENT) and, later, the
 * review-alert send (kind APPROVAL) — NOT by
 * `publishing-suggestion/broadcast-topics-to-chat.ts`, which settles against a
 * different ledger keyed on `cycleId` and is out of scope here.
 */
export async function deliverChatMessages(
	input: DeliverChatMessagesInput,
): Promise<DeliverChatMessagesOutput> {
	// Read-only mode: this engine is the shared entry point for every chat
	// delivery, both today's (CONTENT, APPROVAL) and any future one — its
	// `postSlackMessage`/`postToTeams` calls are raw provider writes outside the
	// MCP funnel. Both current callers already gate on `isProjectReadOnly`
	// before delegating here, so this check is defence in depth, not a
	// relocation: keep their gates too. But the guarantee that a read-only
	// project never gets posted to has to live where the write actually
	// happens, not depend on every future caller remembering to check first.
	if (await isProjectReadOnly(input.projectId)) {
		logger.info(
			"[Newsletter] Skipped chat delivery — project is in Read-only mode",
			{
				projectId: input.projectId,
				sendId: input.sendId,
				kind: input.kind,
			},
		);
		return {
			targetCount: input.channels.length,
			sentCount: 0,
			failedCount: 0,
			skippedCount: input.channels.length,
		};
	}

	const [teamsLinked, slackLinked] = await Promise.all([
		getLinkedTeamsChannels(input.projectId),
		getLinkedSlackChannels(input.projectId),
	]);

	// Per-linker validity memo. row.userId is the channel-linker: the stored actor
	// whose OAuth token posts the message. It must still be authorized in the
	// SEND's tenant at post time — exact parity with the scheduled-actor guard in
	// find-due-newsletter-projects (a current org member for an org send, or the
	// project owner for a personal send). Without this a departed/removed linker
	// keeps powering posts under their token (Codex 2026-07-08). The answer is
	// stable within one run, so memoize per linker to avoid re-querying org
	// membership for a linker that appears on multiple channels.
	const linkerValidity = new Map<string, Promise<boolean>>();
	const isLinkerValid = (linkUserId: string): Promise<boolean> => {
		let p = linkerValidity.get(linkUserId);
		if (!p) {
			p = isScheduledNewsletterActorValid(
				linkUserId,
				input.organizationId,
				input.userId,
			);
			linkerValidity.set(linkUserId, p);
		}
		return p;
	};

	// Intersect the persisted selection with the LIVE linked set,
	// then confirm each channel's linker is still authorized before it becomes a
	// delivery target. Both drops are recorded as SKIPPED (not FAILED): they are
	// intentional refusals, not delivery failures, so they never mark the send
	// errored.
	const resolved: ResolvedTarget[] = [];
	for (const sel of input.channels) {
		if (sel.platform === "TEAMS") {
			const row = teamsLinked.find(
				(c) => c.teamId === sel.teamId && c.channelId === sel.channelId,
			);
			if (!row) {
				await recordSkip(
					input,
					sel,
					"channel no longer linked to project",
				);
				continue;
			}
			if (!row.userId || !(await isLinkerValid(row.userId))) {
				await recordSkip(
					input,
					sel,
					"channel linker no longer authorized for project",
				);
				continue;
			}
			resolved.push({
				platform: "TEAMS",
				externalTeamId: row.teamId,
				channelId: row.channelId,
				linkUserId: row.userId,
				linkOrgId: row.organizationId,
			});
		} else {
			const row = slackLinked.find(
				(c) =>
					c.slackTeamId === sel.teamId &&
					c.channelId === sel.channelId,
			);
			if (!row) {
				await recordSkip(
					input,
					sel,
					"channel no longer linked to project",
				);
				continue;
			}
			if (!row.userId || !(await isLinkerValid(row.userId))) {
				await recordSkip(
					input,
					sel,
					"channel linker no longer authorized for project",
				);
				continue;
			}
			resolved.push({
				platform: "SLACK",
				externalTeamId: row.slackTeamId,
				channelId: row.channelId,
				linkUserId: row.userId,
				linkOrgId: row.organizationId,
			});
		}
	}

	const results = await Promise.allSettled(
		resolved.map((t) => deliverOne(input, t)),
	);

	// A REJECTED settled result means a target threw BEFORE reaching a terminal
	// ledger row — i.e. rendering or claimChatDelivery itself failed (a *post*
	// failure is caught inside deliverOne and recorded as FAILED, so it FULFILS,
	// not rejects). Such targets are invisible to the ledger-derived counts below,
	// so swallowing them would let the workflow finalize a real infra failure as a
	// false SKIPPED_EMPTY (chat-only) or SENT (email ok). Re-raise so the
	// workflow's catch marks the send errored and Temporal retries; the claim
	// ledger is idempotent (an existing SENT/SENDING/FAILED/SKIPPED row returns
	// claimed:false -> SKIPPED), so a retry never double-posts an already-delivered
	// channel.
	const rejected = results.filter(
		(r): r is PromiseRejectedResult => r.status === "rejected",
	);
	if (rejected.length > 0) {
		for (const r of rejected) {
			logger.warn(
				"newsletter: chat delivery target threw before a terminal ledger row",
				{
					sendId: input.sendId,
					error:
						r.reason instanceof Error
							? r.reason.message
							: String(r.reason),
				},
			);
		}
		throw new Error(
			`newsletter chat delivery: ${rejected.length} of ${resolved.length} target(s) failed before a terminal ledger row`,
		);
	}

	// Derive the RETURN from the durable ledger, NOT per-invocation tallies. This
	// is retry-safe: if Temporal re-runs this activity (e.g. a heartbeat timeout
	// mid-post), the prior attempt's SENT/SENDING rows are already recorded, so the
	// re-run reports the true cumulative outcome (correct advanceLastSentAt), instead
	// of 0 sent (which would corrupt the next collection window). SENDING =
	// posted-but-unconfirmed → counted as sent (fail-closed "assume posted").
	//
	// Why SENDING counts as sent (not failed): `claimChatDelivery` writes the row
	// as SENDING *before* the post fires, then `deliverOne` flips it to SENT/FAILED
	// after the post settles. A row can be left at SENDING only if the process
	// dies in the narrow window between the Slack/Teams API call returning success
	// and the follow-up `markChatDelivery(SENT)` write landing — e.g. worker crash
	// or activity timeout right after the message was actually posted. Treating
	// that as "sent" is deliberate: it upholds the spec's dup-over-miss principle
	// by letting the collection window advance so this channel is never re-posted
	// to on the next run (posting twice is worse than an unconfirmed count). Counting
	// it as failed instead would re-trigger a retry/re-post next window, risking a
	// duplicate message when the original post in fact succeeded. The durable
	// SENDING row itself is not hidden — it remains in the ledger as the
	// operator-visible "unconfirmed delivery" signal for anyone auditing the send.
	const ledger = await listChatDeliveriesForSend(input.sendId, input.kind);

	// Every RESOLVED target must have left a row of THIS kind. If one has not,
	// its claim was refused by something other than a prior attempt of this kind
	// — and `deliverOne` turned that into a bare `"SKIPPED"` with no row, which
	// is invisible to every count below. A CHAT-only send would then finalize
	// SKIPPED_EMPTY / NO_CHAT_TARGETS ("there was nothing to send") and a BOTH
	// send would finalize SENT, in both cases with no FAILED row, no reason, and
	// nothing in the Channels disclosure. That is a silent miss of an
	// already-shipped feature, so it is raised instead (Fizzy #2203).
	//
	// The path that used to reach this is closed: a retained legacy index once
	// refused a row whose channel the other kind already held, so the row
	// existed under the wrong `kind` and this read could not see it. That index
	// was dropped in the contract release (Fizzy #2203). The check stays
	// deliberately — it is cheap, and it catches any future cause of a target
	// that left no row of its own kind. A guard is not retired because its first
	// known trigger was.
	//
	// Why the check lives HERE and not on the P2002 in `claimChatDelivery`:
	// `meta.target` is `undefined` for every P2002 on Prisma 6.18 + the Postgres
	// driver adapter, so the violated constraint is not reachable through any
	// supported API — it appears only in the driver's raw message, which is not
	// a contract. This shape does not need it — it asks the ledger what is
	// actually there. On a real retry the prior attempt's row is present with the
	// right kind and nothing raises.
	const ledgerKeys = new Set(
		ledger.map((d) => `${d.platform}:${d.externalTeamId}:${d.channelId}`),
	);
	const unrecorded = resolved.filter(
		(t) =>
			!ledgerKeys.has(`${t.platform}:${t.externalTeamId}:${t.channelId}`),
	);
	if (unrecorded.length > 0) {
		const names = unrecorded
			.map((t) => `${t.platform}:${t.channelId}`)
			.join(", ");
		logger.error(
			"newsletter: chat delivery target left no ledger row of its own kind — the channel is invisible to the send's delivery counts",
			{
				sendId: input.sendId,
				projectId: input.projectId,
				kind: input.kind,
				channels: names,
			},
		);
		throw new Error(
			`newsletter chat delivery: ${unrecorded.length} of ${resolved.length} ${input.kind} target(s) left no ledger row (${names}) — another delivery kind is holding the channel for this send`,
		);
	}

	const sentCount = ledger.filter(
		(d) => d.status === "SENT" || d.status === "SENDING",
	).length;
	const failedCount = ledger.filter((d) => d.status === "FAILED").length;
	const ledgerSkipped = ledger.filter((d) => d.status === "SKIPPED").length;

	return {
		targetCount: sentCount + failedCount,
		sentCount,
		failedCount,
		skippedCount: ledgerSkipped,
	};
}

async function deliverOne(
	input: DeliverChatMessagesInput,
	t: ResolvedTarget,
): Promise<"SENT" | "FAILED" | "SKIPPED"> {
	heartbeat(`chatDelivery:${input.kind}:${t.platform}:${t.channelId}`);
	// Render FIRST (pure, deterministic, no I/O), BEFORE the claim writes a
	// SENDING row. A render error must never orphan a ledger row: the
	// ledger-derived count treats SENDING as sent, so a post-claim render throw
	// would be silently counted as delivered (Codex BLOCKER 2026-07-08). Rendering
	// up front guarantees a render failure creates no row and instead surfaces as a
	// rejected promise that the caller re-raises.
	const text = input.renderText(t.platform);

	// Fizzy #2203: the review may have concluded while this fan-out was in
	// flight. Re-check before claiming, so a decision made mid-dispatch stops
	// the remaining pings. recordSkip claims-and-marks in one path, which is
	// how the target gets a TERMINAL row — an aborted target must be
	// distinguishable from one that failed to send, and the terminal row also
	// makes a later retry refuse the claim instead of re-pinging.
	if (input.stillWanted && !(await input.stillWanted())) {
		await recordSkip(
			input,
			{
				platform: t.platform,
				teamId: t.externalTeamId,
				channelId: t.channelId,
			},
			"review concluded before dispatch",
		);
		return "SKIPPED";
	}

	// P3: the ledger row carries the SEND's tenant (so RLS user_owned matches the
	// send's visibility). The channel-linker identity (t.linkUserId/t.linkOrgId) is
	// used ONLY for the post credentials below, never for the row's tenant columns.
	const claim = await claimChatDelivery({
		sendId: input.sendId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		kind: input.kind,
		platform: t.platform,
		externalTeamId: t.externalTeamId,
		channelId: t.channelId,
	});
	if (!claim.claimed) {
		return "SKIPPED"; // fail-closed: already handled, never double-post
	}

	try {
		if (t.platform === "TEAMS") {
			if (!t.linkUserId) {
				throw new Error("Teams channel has no linking user");
			}
			const r = await postToTeams({
				teamId: t.externalTeamId,
				channelId: t.channelId,
				message: text,
				userId: t.linkUserId,
				organizationId: t.linkOrgId ?? undefined,
			});
			if (!r.success) {
				throw new Error(r.error ?? "Teams post failed");
			}
			await markChatDelivery({
				sendId: input.sendId,
				kind: input.kind,
				platform: t.platform,
				externalTeamId: t.externalTeamId,
				channelId: t.channelId,
				status: "SENT",
				postedMessageId: r.messageId,
			});
		} else {
			if (!t.linkUserId) {
				throw new Error("Slack channel has no linking user");
			}
			// Resolve credentials directly against the channel-linker's identity
			// (t.linkUserId / t.linkOrgId), NOT via `sendSlackMessage` — that
			// helper's `resolveSlackBotToken` requires an `AgentDeploymentTrigger`
			// row, which is only ever created by the agent-deployments feature and
			// NEVER by linking a Slack channel or connecting Slack OAuth. A project
			// that connects Slack purely for newsletter delivery would otherwise
			// have every post fail with "No Slack bot token found... Connect
			// Slack." `getSlackCredentials` resolves the WorkflowIntegration
			// directly, independent of any trigger. It throws if Slack isn't
			// connected — that throw is caught below like any other post failure.
			const creds = await getSlackCredentials(
				t.linkUserId,
				t.linkOrgId ?? undefined,
			);
			let data = await postSlackMessage(
				creds.accessToken,
				t.channelId,
				text,
			);
			// A bot that is not a member of the channel gets not_in_channel
			// on EVERY post, permanently — nothing else in the send retries
			// it, and the channel picker happily links non-member channels.
			// Join once and retry once. `chat:write.public` makes this a
			// no-op for public channels on freshly-consented tokens; this
			// path is what rescues tokens issued before that scope existed.
			// Only not_in_channel is retried: other codes (invalid_auth,
			// missing_scope, channel_not_found) are not fixable by joining,
			// and a blind retry risks a duplicate post if the first call
			// actually landed.
			if (!data.ok && data.error === "not_in_channel") {
				const join = await joinSlackChannel(
					creds.accessToken,
					t.channelId,
				);
				if (join.ok) {
					data = await postSlackMessage(
						creds.accessToken,
						t.channelId,
						text,
					);
				} else if (
					join.error === "missing_scope" ||
					join.error === "not_allowed_token_type"
				) {
					// The join was refused for lack of permission, not
					// because the channel is private. Report THAT — telling
					// the operator to invite the app would hide the fact
					// that the Slack connection itself needs re-authorizing
					// (the exact state of every token issued before
					// channels:join was requested).
					throw new Error("join_missing_scope");
				}
			}
			if (!data.ok) {
				throw new Error(data.error ?? "Slack post failed");
			}
			await markChatDelivery({
				sendId: input.sendId,
				kind: input.kind,
				platform: t.platform,
				externalTeamId: t.externalTeamId,
				channelId: t.channelId,
				status: "SENT",
				postedMessageId: data.ts,
			});
		}
		return "SENT";
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await markChatDelivery({
			sendId: input.sendId,
			kind: input.kind,
			platform: t.platform,
			externalTeamId: t.externalTeamId,
			channelId: t.channelId,
			status: "FAILED",
			errorMessage: msg,
		});
		logger.warn("newsletter: chat delivery failed", {
			sendId: input.sendId,
			platform: t.platform,
			channelId: t.channelId,
			error: msg,
		});
		return "FAILED";
	}
}

async function recordSkip(
	input: DeliverChatMessagesInput,
	sel: ChatDeliveryTargetSelection,
	reason: string,
) {
	const claim = await claimChatDelivery({
		sendId: input.sendId,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		kind: input.kind,
		platform: sel.platform,
		externalTeamId: sel.teamId,
		channelId: sel.channelId,
	});
	if (claim.claimed) {
		await markChatDelivery({
			sendId: input.sendId,
			kind: input.kind,
			platform: sel.platform,
			externalTeamId: sel.teamId,
			channelId: sel.channelId,
			status: "SKIPPED",
			errorMessage: reason,
		});
		logger.warn("newsletter: chat channel skipped", {
			sendId: input.sendId,
			projectId: input.projectId,
			platform: sel.platform,
			teamId: sel.teamId,
			channelId: sel.channelId,
			reason,
		});
	}
}
