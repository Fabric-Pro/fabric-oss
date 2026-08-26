import {
	assertPublishingCycleTenant,
	claimPublishingChatDelivery,
	db,
	getLinkedSlackChannels,
	getLinkedTeamsChannels,
	getPublishingSuiteSettings,
	isProjectReadOnly,
	isScheduledNewsletterActorValid,
	listPublishingChatDeliveriesForCycle,
	listPublishingTopicsForCycle,
	markPublishingChatDelivery,
	type PublishingChatChannel,
	type PublishingChatDeliveryReason,
	readCycleNotificationState,
} from "@repo/database";
import { getSlackCredentials } from "@repo/integrations/slack";
import { logger } from "@repo/logs";
import { getBaseUrl, renderPublishingChatMessage } from "@repo/utils";
import { heartbeat } from "@temporalio/activity";
import { postToTeams } from "../teams-mention";

export interface BroadcastPublishingTopicsInput {
	cycleId: string;
	tenant: {
		projectId: string;
		organizationId: string | null;
		userId: string | null;
	};
}
export interface BroadcastPublishingTopicsOutput {
	targetCount: number;
	sentCount: number;
	failedCount: number;
	skippedCount: number;
}

interface ResolvedTarget {
	platform: "TEAMS" | "SLACK";
	externalTeamId: string;
	channelId: string;
	linkUserId: string;
	linkOrgId: string | null;
}

interface SlackPostResult {
	ok: boolean;
	ts?: string;
	error?: string;
}

/** Raw chat.postMessage. Network/HTTP failures throw; Slack-level failures come
 *  back as `{ ok: false, error }` so the caller can branch on the code. */
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
 * Returns the Slack error code rather than a bare boolean, and the distinction
 * cost an incident to learn: a token minted before `channels:join` was requested
 * fails with `missing_scope`, and reporting that as the original
 * `not_in_channel` tells the operator to invite the app when the real remedy is
 * to reconnect Slack. A private channel fails with a channel-type error, where
 * inviting the app IS the remedy.
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

interface DeliverContext {
	cycleId: string;
	tenant: BroadcastPublishingTopicsInput["tenant"];
	topics: { title: string; angle: string | null }[];
	projectName: string;
	link: string;
}

/**
 * FR17 — broadcast a READY cycle's topics to the project's selected chat
 * channels. FR18 — and never let that affect the cycle.
 *
 * The isolation is the WORKFLOW's, not this activity's: this function REJECTS
 * when it cannot finish its job, which is what earns the Temporal retry, and the
 * workflow's own try/catch is what stops that reaching `markCycleFailed`. An
 * activity that swallowed everything would look robust and be strictly worse —
 * it would convert a retryable transient into a permanent silent loss by
 * suppressing the only mechanism that would have retried it.
 *
 * Takes only the cycle and its tenant, like notifyPublishingTopicsReady, and
 * loads settings, topics and linked channels itself. That keeps the workflow
 * input from growing a field per feature — and every added input field is a
 * payload change on a workflow that already has completed histories.
 */
export async function broadcastPublishingTopicsToChat(
	input: BroadcastPublishingTopicsInput,
): Promise<BroadcastPublishingTopicsOutput> {
	heartbeat("broadcastPublishingTopicsToChat:start");
	const { cycleId, tenant } = input;

	// One helper for every exit, so the aggregate log line is emitted on EVERY
	// path rather than only the ones someone remembered. §3.5 makes an operator
	// depend on that line; a gate that returns without it is the case where they
	// see nothing and conclude nothing happened — which is the exact shape of the
	// chat outage that ran unnoticed for a month on the newsletter path.
	//
	// `skippedByReason` is PASSED IN, never accumulated in a counter alongside
	// the loop. Every other number on this line is derived from the durable
	// ledger, and a breakdown tallied in memory answers a different question from
	// the total it sits next to: the tally counts refusals this attempt DECIDED,
	// the ledger counts rows that EXIST. They diverge as soon as a selection
	// names the same channel twice — the second claim is refused and writes no
	// row, while a counter increments anyway — and an operator reading one line
	// has no way to see that its parts came from two different denominators.
	// Raised by the Copilot review on this PR.
	const emit = (
		out: BroadcastPublishingTopicsOutput,
		gate: string | null,
		skippedByReason: Record<string, number>,
		unconfirmedCount: number,
	) => {
		// LEVEL carries the signal, because a query keyed on a message string
		// alone cannot tell a total outage from a healthy run — every count would
		// be present either way. The module's neighbours already use level this
		// way (reconcile-notifications raises to warn only when it has something
		// to show). Here a run that reached targets and delivered none, or that
		// failed any of them, is evidence of a fault and says so.
		//
		// Message FIRST and the meta object LAST, which is the convention
		// `@repo/logs` documents: its correlation-id reporter merges into the
		// TRAILING argument. The sibling `logger.x({...}, msg)` form found
		// elsewhere in this directory would leave that reporter appending a
		// second object instead. `event` therefore goes INSIDE the meta object,
		// which gives the stable key a query needs without breaking that.
		const faulty =
			out.failedCount > 0 || (out.targetCount > 0 && out.sentCount === 0);
		const line = {
			event: "publishing.chat.broadcast_complete",
			cycleId,
			projectId: tenant.projectId,
			gate,
			...out,
			// SENDING rows, reported separately from `sentCount` (which still
			// includes them, so the never-re-post trade is unchanged). A SENDING
			// row means the process died somewhere between the claim and the
			// confirming write — the claim is taken BEFORE the provider is
			// contacted, so it does not establish that anything reached the room.
			// Folding it into "sent" with no way to see it is what let this read
			// as a delivered broadcast.
			unconfirmedCount,
			skippedByReason,
		};
		if (faulty) {
			logger.warn("publishing chat broadcast complete", line);
		} else {
			logger.info("publishing chat broadcast complete", line);
		}
	};

	const done = (
		out: BroadcastPublishingTopicsOutput,
		gate?: string,
		skippedByReason: Record<string, number> = {},
		unconfirmedCount = 0,
	): BroadcastPublishingTopicsOutput => {
		emit(out, gate ?? null, skippedByReason, unconfirmedCount);
		return out;
	};
	const NOTHING = {
		targetCount: 0,
		sentCount: 0,
		failedCount: 0,
		skippedCount: 0,
	};

	// ---- Whole-run gates. None of these writes a ledger row, deliberately: a
	// SKIPPED row asserts "this channel was refused", which is untrue when the
	// refusal was about the project, and rows written here would be refused by a
	// later attempt's claim — turning a temporary condition into a permanent one.
	const state = await readCycleNotificationState({
		cycleId,
		projectId: tenant.projectId,
	});
	if (state?.status !== "READY") {
		return done(NOTHING, "cycle-not-ready");
	}

	// The gate BOTH sibling activities in this directory treat as mandatory, and
	// which this one was missing. It refuses a project that is no longer ACTIVE,
	// one that has been soft-deleted, and one whose tenant tuple has moved since
	// the cycle was dispatched.
	//
	// The window is the suggestion workflow's own execution timeout — up to two
	// hours — and this activity runs at the very end of it. Without the gate an
	// archived or deleted project still announces its topics to a room, and a
	// transfer would have the linker re-authorized against the OLD tenant while
	// the ledger row is stamped with it. Neither is recoverable: chat never
	// re-posts, and by design there is no drain to walk it back.
	if (
		(await assertPublishingCycleTenant({
			projectId: tenant.projectId,
			cycleTenant: {
				organizationId: tenant.organizationId,
				userId: tenant.userId,
			},
		})) === "TENANT_CHANGED"
	) {
		return done(NOTHING, "tenant-changed");
	}

	const settings = await getPublishingSuiteSettings(tenant.projectId);
	if (!settings.notificationsEnabled) {
		return done(NOTHING, "notifications-disabled");
	}
	const selection = (settings.chatChannels ?? []) as PublishingChatChannel[];
	if (selection.length === 0) {
		return done(NOTHING, "no-channels-selected");
	}

	const topics = await listPublishingTopicsForCycle(cycleId);
	if (topics.length === 0) {
		// A READY cycle has topics by construction. Guarded anyway, because the
		// failure this prevents — a broadcast announcing ideas and listing none —
		// lands in a room full of people and cannot be recalled.
		return done(NOTHING, "no-topics");
	}

	// Posting to a linked channel is an outbound write to a connected source, and
	// this activity dispatches through the raw provider fetch and the Teams
	// executor, outside the MCP funnel — so it gates here directly, exactly as the
	// newsletter chat send does.
	if (await isProjectReadOnly(tenant.projectId)) {
		return done(NOTHING, "project-read-only");
	}

	const [teamsLinked, slackLinked] = await Promise.all([
		getLinkedTeamsChannels(tenant.projectId),
		getLinkedSlackChannels(tenant.projectId),
	]);

	// Per-linker memo. The stored linker is the actor whose OAuth token posts the
	// message, so it must still be authorized in the CYCLE's tenant at post time;
	// without this a departed member keeps powering posts under their token. The
	// answer is stable within one run and one linker commonly owns several
	// channels, so memoize rather than re-query org membership per channel.
	const linkerValidity = new Map<string, Promise<boolean>>();
	const isLinkerValid = (linkUserId: string): Promise<boolean> => {
		let p = linkerValidity.get(linkUserId);
		if (!p) {
			p = isScheduledNewsletterActorValid(
				linkUserId,
				tenant.organizationId,
				tenant.userId,
			);
			linkerValidity.set(linkUserId, p);
		}
		return p;
	};

	const recordSkip = async (
		sel: PublishingChatChannel,
		reason: PublishingChatDeliveryReason,
	) => {
		// ONE statement, landing directly in SKIPPED. It used to claim SENDING
		// and then settle — two un-transacted writes, so a failure or a worker
		// restart between them stranded a SENDING row for a channel this path
		// deliberately refused and never contacted. SENDING is counted as
		// delivered, so that row read as a delivered broadcast, and the claim's
		// fail-closed rule then made the channel permanently unpostable for the
		// cycle. The whole failure needed nothing more exotic than a transient.
		const claim = await claimPublishingChatDelivery({
			cycleId,
			projectId: tenant.projectId,
			organizationId: tenant.organizationId,
			userId: tenant.userId,
			platform: sel.platform,
			externalTeamId: sel.teamId,
			channelId: sel.channelId,
			status: "SKIPPED",
			reason,
		});
		// INSIDE the branch. Logged unconditionally, a retried attempt re-emitted
		// this line for every channel already recorded while writing nothing —
		// the same two-denominator divergence the aggregate line was just fixed
		// for, one function above it.
		if (claim.claimed) {
			logger.warn("publishing chat channel skipped", {
				event: "publishing.chat.channel_skipped",
				cycleId,
				projectId: tenant.projectId,
				platform: sel.platform,
				channelId: sel.channelId,
				reason,
			});
		}
	};

	// Intersect the persisted selection with the LIVE linked set, then confirm
	// each channel's linker is still authorized. Both drops are SKIPPED and not
	// FAILED: they are intentional refusals — a delivery that must not happen,
	// not one that failed to.
	const resolved: ResolvedTarget[] = [];
	for (const sel of selection) {
		const row =
			sel.platform === "TEAMS"
				? teamsLinked.find(
						(c) =>
							c.teamId === sel.teamId &&
							c.channelId === sel.channelId,
					)
				: slackLinked.find(
						(c) =>
							c.slackTeamId === sel.teamId &&
							c.channelId === sel.channelId,
					);
		if (!row) {
			await recordSkip(sel, "CHANNEL_NOT_LINKED");
			continue;
		}
		if (!row.userId || !(await isLinkerValid(row.userId))) {
			await recordSkip(sel, "LINKER_NOT_AUTHORIZED");
			continue;
		}
		resolved.push({
			platform: sel.platform,
			externalTeamId: sel.teamId,
			channelId: sel.channelId,
			linkUserId: row.userId,
			linkOrgId: row.organizationId,
		});
	}

	// The project's display name and the workspace slug for an ABSOLUTE link.
	// Read here rather than passed in, for the reason the input shape gives: an
	// activity that loads what it needs can be retried and re-driven, and the
	// workflow input stays fixed. Same two reads and the same null-organization
	// short-circuit notify-topics-ready.ts uses at its own link-building step — a
	// chat client, like a mail client, has no resolver that could complete a
	// context-relative address after the fact.
	const [project, organization] = await Promise.all([
		db.project.findUnique({
			where: { id: tenant.projectId },
			select: { name: true },
		}),
		tenant.organizationId
			? db.organization.findUnique({
					where: { id: tenant.organizationId },
					select: { slug: true },
				})
			: Promise.resolve(null),
	]);
	// getBaseUrl() returns the env value verbatim and may end in "/", which would
	// otherwise produce a double slash.
	const baseUrl = getBaseUrl().replace(/\/+$/, "");
	const workspacePrefix = organization?.slug
		? `/app/${organization.slug}`
		: "/app";
	const link = `${baseUrl}${workspacePrefix}/projects/${tenant.projectId}/publishing`;
	const projectName = project?.name ?? "your project";

	// Heartbeat as each target SETTLES, not as it starts. Every target is launched
	// at once by `allSettled`, so the previous per-target heartbeat at the top of
	// `deliverOne` fired for all of them within milliseconds of the run beginning
	// and then nothing beat again. That made `heartbeatTimeout: "1 minute"` on the
	// proxy a hazard rather than a wedge detector: a HEALTHY fan-out whose slowest
	// provider call outlasted the minute was killed, and it looked exactly like
	// the stall the timeout exists to catch.
	//
	// `finally`, so a target that threw still counts as settled — progress is
	// "this many are no longer outstanding", not "this many succeeded". The
	// payload is what Temporal surfaces as `lastHeartbeatDetails` on a timeout,
	// which is the only number a killed run leaves behind: the aggregate line is
	// emitted at the end and a killed activity never reaches it.
	let settled = 0;
	const total = resolved.length;
	const results = await Promise.allSettled(
		resolved.map((t) =>
			deliverOne(
				{ cycleId, tenant, topics, projectName, link },
				t,
			).finally(() => {
				settled += 1;
				heartbeat({ done: settled, total });
			}),
		),
	);

	// A REJECTED result means a target threw BEFORE reaching a terminal ledger row
	// — a render throw, or the claim itself failing. A POST failure is caught
	// inside deliverOne and recorded as FAILED, so it fulfils. Such targets are
	// invisible to the ledger-derived counts below, so swallowing them would let
	// the run report success for work it never did. Re-raise; the workflow absorbs
	// it, and the claim ledger makes the retry unable to double-post.
	const rejected = results.filter(
		(r): r is PromiseRejectedResult => r.status === "rejected",
	);

	// Derived from the durable ledger, never from per-invocation tallies, so a
	// retried attempt reports the true cumulative outcome. SENDING counts toward
	// `sentCount`: a duplicate in a shared channel is worse than an unconfirmed
	// count, so the claim's fail-closed rule stands. It is ALSO reported on its
	// own as `unconfirmedCount`, because the claim is taken before the provider
	// is contacted and therefore a SENDING row does not establish that anything
	// reached the room.
	const rows = await listPublishingChatDeliveriesForCycle(cycleId);
	const sentCount = rows.filter(
		(d) => d.status === "SENT" || d.status === "SENDING",
	).length;
	const failedCount = rows.filter((d) => d.status === "FAILED").length;
	const skipped = rows.filter((d) => d.status === "SKIPPED");

	// Same ledger read as every other count on the line, so the parts and the
	// total cannot disagree. `UNCLASSIFIED` is not decorative: `reason` is
	// nullable at the schema level, so a row written by some future path that
	// forgets it would otherwise vanish from the breakdown while still counting
	// in the total — a discrepancy with nothing naming it.
	const skippedByReason = skipped.reduce<Record<string, number>>((acc, d) => {
		const key = d.reason ?? "UNCLASSIFIED";
		acc[key] = (acc[key] ?? 0) + 1;
		return acc;
	}, {});

	const unconfirmedCount = rows.filter((d) => d.status === "SENDING").length;
	const out = {
		targetCount: sentCount + failedCount,
		sentCount,
		failedCount,
		skippedCount: skipped.length,
	};

	// A REJECTED result means a target threw BEFORE reaching a terminal ledger
	// row — a render throw, the claim itself failing, or a settle that could not
	// be written. Such targets are invisible to the counts above, so swallowing
	// them would let the run report success for work it never did. Re-raise; the
	// workflow absorbs it, and the claim ledger makes the retry unable to
	// double-post.
	//
	// The aggregate line is emitted BEFORE the throw, not skipped by it. These
	// are the runs whose state is least known and which an operator most needs a
	// count for, and they were the ones producing no line at all — while the
	// comment above `done`, the spec and the changeset all claimed every exit
	// path was covered.
	if (rejected.length > 0) {
		for (const r of rejected) {
			logger.warn("publishing chat target threw before a terminal row", {
				event: "publishing.chat.target_threw",
				cycleId,
				error:
					r.reason instanceof Error
						? r.reason.message
						: String(r.reason),
			});
		}
		emit(out, "targets-threw", skippedByReason, unconfirmedCount);
		throw new Error(
			`publishing chat broadcast: ${rejected.length} of ${resolved.length} target(s) failed before a terminal ledger row`,
		);
	}

	return done(out, undefined, skippedByReason, unconfirmedCount);
}

async function deliverOne(
	ctx: DeliverContext,
	t: ResolvedTarget,
): Promise<void> {
	// No heartbeat here. It used to sit at this line, and because the caller
	// launches every target concurrently it beat once per target at t≈0 and never
	// again — liveness that expired the moment the run needed it. The caller now
	// beats on each SETTLE instead, which is when there is progress to report.

	// RENDER FIRST — pure, deterministic, no I/O, and BEFORE the claim writes a
	// SENDING row. The ledger-derived count treats SENDING as sent, so a render
	// throw after the claim would be silently counted as a delivery that never
	// happened. Rendering up front means a render failure creates no row and
	// surfaces as a rejected promise the caller re-raises.
	const { text } = renderPublishingChatMessage(
		{ projectName: ctx.projectName, topics: ctx.topics },
		{ platform: t.platform, link: ctx.link },
	);

	// The row carries the CYCLE's tenant, so RLS user_owned matches the cycle's
	// visibility. The channel-linker identity is used ONLY for the post
	// credentials below, never for the row's tenant columns.
	const claim = await claimPublishingChatDelivery({
		cycleId: ctx.cycleId,
		projectId: ctx.tenant.projectId,
		organizationId: ctx.tenant.organizationId,
		userId: ctx.tenant.userId,
		platform: t.platform,
		externalTeamId: t.externalTeamId,
		channelId: t.channelId,
	});
	if (!claim.claimed) {
		return; // fail-closed: already handled by some attempt, never double-post
	}

	const settle = (
		status: "SENT" | "FAILED",
		extra: { postedMessageId?: string; errorMessage?: string },
	) =>
		markPublishingChatDelivery({
			cycleId: ctx.cycleId,
			platform: t.platform,
			externalTeamId: t.externalTeamId,
			channelId: t.channelId,
			status,
			...(status === "FAILED" ? { reason: "POST_FAILED" as const } : {}),
			...extra,
		});

	// The try wraps the PROVIDER CALL and nothing else. Settling SENT sits
	// outside it, and the separation is load-bearing rather than tidy: with the
	// settle inside, a transient database error while writing SENT lands in the
	// catch, which then records FAILED — for a message that is already in the
	// channel. That is the worst cell in the table. FAILED is terminal by design
	// (§3.4 — chat never re-posts), so the misreport is permanent; it moves the
	// message from sentCount to failedCount in the line an operator reads; and it
	// contradicts the rule the whole ledger is built on, that an unconfirmed
	// delivery is left SENDING and counted as delivered.
	//
	// So: a provider failure is caught and settled FAILED. A failure to write the
	// SUCCESS is allowed to propagate — the row stays SENDING, the caller
	// re-raises, and SENDING is already counted as delivered. Raised by the
	// Copilot review on this PR; the fix is the one it proposed.
	let postedMessageId: string | undefined;
	let failure: string | undefined;
	try {
		if (t.platform === "TEAMS") {
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
			postedMessageId = r.messageId;
		} else {
			// Resolve credentials against the channel-linker's identity directly,
			// NOT via `sendSlackMessage` — that helper's token resolver requires
			// an AgentDeploymentTrigger row, which linking a Slack channel never
			// creates, so a project that connected Slack purely for delivery would
			// have every post fail with "No Slack bot token found".
			// `getSlackCredentials` resolves the WorkflowIntegration directly. It
			// throws when Slack is not connected; that throw is caught below like
			// any other post failure.
			const creds = await getSlackCredentials(
				t.linkUserId,
				t.linkOrgId ?? undefined,
			);
			let data = await postSlackMessage(
				creds.accessToken,
				t.channelId,
				text,
			);
			// A bot that is not a member of the channel gets not_in_channel on
			// EVERY post, permanently, and the picker happily links non-member
			// channels. Join once and retry once. Only not_in_channel is retried:
			// the other codes are not fixable by joining, and a blind retry risks
			// a duplicate post if the first call actually landed.
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
					// Refused for lack of permission, not because the channel is
					// private. Report THAT — "invite the app" would hide the fact
					// that the Slack connection itself needs re-authorizing.
					throw new Error("join_missing_scope");
				}
			}
			if (!data.ok) {
				throw new Error(data.error ?? "Slack post failed");
			}
			postedMessageId = data.ts;
		}
	} catch (e) {
		failure = e instanceof Error ? e.message : String(e);
	}

	// BOTH settles now sit outside the catch, and this half is a READABILITY
	// change, not a behaviour one — stated plainly because it was nearly
	// committed as a fix. A throw inside a `catch` block is not caught by that
	// block's own `try`, so a failure to write FAILED already propagated. The
	// asymmetry was only that one settle looked guarded and the other did not.
	//
	// What is NOT fixed by moving it, and could not be: either settle failing
	// leaves the row at SENDING, and SENDING counts toward `sentCount`. The
	// mitigation for that is `unconfirmedCount` on the aggregate line — a
	// separate number, so an operator can see the difference between a delivery
	// confirmed in the room and one nobody can vouch for.
	if (failure !== undefined) {
		await settle("FAILED", { errorMessage: failure });
		logger.warn("publishing chat delivery failed", {
			event: "publishing.chat.delivery_failed",
			cycleId: ctx.cycleId,
			platform: t.platform,
			channelId: t.channelId,
			error: failure,
		});
		return;
	}

	await settle("SENT", { postedMessageId });
}
