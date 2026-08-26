"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { cn } from "@ui/lib";
import { Fragment, useState } from "react";
import { formatChatDeliveryStatus } from "../newsletter-send-status";

/** The four buckets the reader filters by — mirrors the procedure's input. */
const STATUS_FILTERS = [
	{ value: "all", label: "All" },
	{ value: "ready", label: "Ready" },
	{ value: "failed", label: "Failed" },
	{ value: "empty", label: "No topics" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

const PAGE_SIZES = [15, 50, 100] as const;
type PageSize = (typeof PAGE_SIZES)[number];

/**
 * Labels for the five `PublishingCycleStatus` values.
 *
 * `NO_TOPICS` and `INSUFFICIENT_CONTEXT` share a label deliberately: to a
 * reader they mean the same thing — the run finished and produced nothing —
 * and the difference is not one anybody can act on differently.
 */
const STATUS_LABELS: Record<
	string,
	{ label: string; tone: "success" | "error" | "warning" | "info" }
> = {
	READY: { label: "Ready", tone: "success" },
	FAILED: { label: "Failed", tone: "error" },
	NO_TOPICS: { label: "No topics", tone: "warning" },
	INSUFFICIENT_CONTEXT: { label: "No topics", tone: "warning" },
	GENERATING: { label: "Running", tone: "info" },
};

/**
 * Looked up through `Object.hasOwn`, never a bare index with a `??` fallback.
 * A plain object literal inherits from Object.prototype, so a stored value of
 * "constructor" / "toString" resolves to a FUNCTION — truthy, so it defeats the
 * fallback and is rendered in place of a label. Nothing in the type system
 * stops a new enum member arriving here, so the lookup must not assume the key
 * is one of the five above.
 */
function describeStatus(status: string) {
	return Object.hasOwn(STATUS_LABELS, status)
		? STATUS_LABELS[status]
		: { label: status, tone: "info" as const };
}

/**
 * The cycle-level notification outcome, in the reader's words rather than the
 * operator's.
 *
 * `NOT_APPLICABLE` must NOT be collapsed together with `NO_RECIPIENTS` — "the
 * question was never asked" and "it was asked and the answer was nobody" send a
 * reader to different places, and the second is the one that explains a chat
 * message arriving with no bell beside it.
 *
 * `needsAttention` is the only styling input, and it marks the outcomes an
 * operator has to act on rather than merely read. `CANCELLED` is not one:
 * obligations existed and became undeliverable for ordinary reasons (a tenant
 * move, a project archived mid-run), and colouring it as a fault would cry wolf
 * on a routine event.
 *
 * `detail` carries what a one-word label cannot, and `SENT` is the reason this
 * field exists. The outcome means "every owed row terminal, at least one
 * confirmed delivered" — so a refresh that reached one contributor and skipped
 * three is `SENT`, and the bare word overstates it. The label stays short
 * because the column has to stay scannable; the precision goes here.
 */
const OUTCOME_LABELS: Record<
	string,
	{ label: string; needsAttention?: boolean; detail?: string }
> = {
	SENT: {
		label: "Sent",
		detail: "At least one contributor was notified. Individual recipients can still be skipped — for example when someone has switched publishing notifications off.",
	},
	PENDING: {
		label: "Sending…",
		detail: "This refresh is still working through its recipients.",
	},
	NO_RECIPIENTS: {
		label: "No one to notify",
		detail: "None of this refresh's topics were attributed to a contributor, so there was nobody to send an in-app notification or an email to. Chat, if configured, was still broadcast.",
	},
	DISABLED: {
		label: "Turned off",
		detail: "Contributor notifications are switched off for this project.",
	},
	CANCELLED: {
		label: "Cancelled",
		detail: "Recipients were owed a notification and none could be delivered — for example because the project moved or was archived mid-run.",
	},
	MAIL_NOT_CONFIGURED: {
		label: "Email not set up",
		needsAttention: true,
		detail: "Recipients were owed an email and this deployment has no mail provider configured.",
	},
	RESOLUTION_FAILED: {
		label: "Failed",
		needsAttention: true,
		detail: "Working out who to notify failed. This is an outage, not a quiet week — the refresh itself may still have produced topics.",
	},
	ABANDONED: {
		label: "Stalled",
		needsAttention: true,
		detail: "This refresh's notification step stopped without reaching a result.",
	},
};

/**
 * What a cycle that never entered the notification lifecycle shows.
 *
 * An em dash, NOT an empty cell — and that is a correction, not a preference.
 * Blank was the first cut, on the reasoning that printing a label would invent
 * an event that never happened. The reasoning was right and the rendering was
 * wrong: to a reader, an empty cell is indistinguishable from absent data, a
 * dropped API field or a broken render, so the blank reintroduced exactly the
 * ambiguity this column exists to remove. `formatDuration` in this same file
 * already answers "not applicable yet" with an em dash for the same reason.
 *
 * The useful consequence is that a blank Notified cell now means nothing
 * legitimate, so one is evidence of a fault rather than of a quiet cycle.
 */
const NOT_APPLICABLE_CELL = {
	label: "—",
	needsAttention: false,
	detail: "This refresh never reached the notification step — it produced no topics, or it failed before that point — so there is no delivery result to report.",
};

/**
 * The SAME em dash, for a cycle that reached READY with topics and still has no
 * outcome.
 *
 * `notificationOutcome` is a NOT NULL column defaulting to "NOT_APPLICABLE", so
 * every cycle that predates the notification lifecycle carries that value from
 * the backfill rather than from anything the run did. The database is honest —
 * "never entered the lifecycle" is exactly right — but the cell above explains
 * it with a cause, and for these rows BOTH halves of that cause are false: the
 * refresh produced topics and it did not fail. A reader comparing the tooltip
 * against the Status and Topics columns beside it finds it contradicted twice.
 *
 * On a column that exists to answer "why was nobody told?", a confidently wrong
 * why is worse than the blank this em dash replaced.
 *
 * The discriminator is sound rather than a guess: a run on current code always
 * enters the lifecycle (the workflow passes `activateNotificationLifecycle`
 * from a patch marker, not from the project's notification toggle — a project
 * with notifications off terminates at SUPPRESSED, which has its own label). So
 * READY with topics and no outcome cannot be produced by this version.
 *
 * The label stays "—" on purpose. Nothing was delivered and nothing is known;
 * inventing a distinct marker would imply a state the row does not have, and
 * these rows age out of every window that matters.
 */
const NO_OUTCOME_RECORDED_CELL = {
	label: "—",
	needsAttention: false,
	detail: "This refresh ran on a version of Fabric that did not record notification outcomes, so none was stored for it. It is not a statement that nobody was notified.",
};

/**
 * The unrecognised-value branch echoes the raw value for the same reason
 * `describeStatus` and `platformLabel` do: `notification_outcome` is TEXT under
 * a CHECK constraint, not a Postgres enum, so a value this build has never
 * heard of can reach the table — and naming it is honest where substituting a
 * neighbouring label would be a false statement about whether anyone was told.
 */
function describeOutcome(
	outcome: string,
	// The row, because "NOT_APPLICABLE" alone cannot tell a refresh that never
	// reached the step from one that predates the step existing. Status and
	// topic count are already on screen in the two neighbouring columns, which
	// is precisely why a tooltip contradicting them is so visible.
	cycle: { status: string; topicCount: number },
): {
	label: string;
	needsAttention: boolean;
	detail?: string;
} {
	if (outcome === "NOT_APPLICABLE") {
		return cycle.status === "READY" && cycle.topicCount > 0
			? NO_OUTCOME_RECORDED_CELL
			: NOT_APPLICABLE_CELL;
	}
	return Object.hasOwn(OUTCOME_LABELS, outcome)
		? { needsAttention: false, ...OUTCOME_LABELS[outcome] }
		: { label: outcome, needsAttention: false };
}

/**
 * Names the platform, and NAMES an unrecognised one rather than asserting a
 * wrong label for it.
 *
 * `platform === "SLACK" ? "Slack" : "Teams"` — the shape this replaces — is not
 * a degradation but a false statement: `publishing_chat_delivery.platform` is
 * plain TEXT with no enum and no CHECK, so any value that is not "SLACK" would
 * be presented to an operator as Teams. Echoing the raw value matches what the
 * API's own `platformLabel` does for the same reason.
 */
function platformLabel(platform: string): string {
	if (platform === "SLACK") {
		return "Slack";
	}
	if (platform === "TEAMS") {
		return "Teams";
	}
	return platform;
}

function formatStarted(value: Date | string): string {
	const d = value instanceof Date ? value : new Date(value);
	return d.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * Wall-clock length of a finished run. Blank while a cycle is still going —
 * a duration derived from `now` would tick without the row being refetched,
 * which reads as data rather than as a clock.
 */
function formatDuration(
	startedAt: Date | string,
	completedAt: Date | string | null,
): string {
	if (!completedAt) {
		return "—";
	}
	const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
	const end =
		completedAt instanceof Date ? completedAt : new Date(completedAt);
	const seconds = Math.max(
		0,
		Math.round((end.getTime() - start.getTime()) / 1000),
	);
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m ${seconds % 60}s`;
	}
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function PublishingCycleHistory({
	projectId,
	organizationId,
}: {
	projectId: string;
	organizationId: string | null;
}) {
	const [status, setStatus] = useState<StatusFilter>("all");
	const [pageSize, setPageSize] = useState<PageSize>(15);
	const [page, setPage] = useState(0);
	const [expandedCycleId, setExpandedCycleId] = useState<string | null>(null);

	const query = useQuery(
		orpc.projects.publishingSuite.listCycles.queryOptions({
			input: {
				projectId,
				organizationId,
				limit: pageSize,
				offset: page * pageSize,
				status,
			},
		}),
	);

	// Fetched only while a row is open. Without the `enabled` gate this issues a
	// request on every render of the table, for every user, with an empty cycle
	// id — and nothing in the UI would show it.
	const chatQuery = useQuery({
		...orpc.projects.publishingSuite.cycleChatDeliveries.queryOptions({
			input: {
				projectId,
				organizationId,
				cycleId: expandedCycleId ?? "",
			},
		}),
		enabled: !!expandedCycleId,
	});

	const cycles = query.data?.cycles ?? [];
	const total = query.data?.total ?? 0;
	const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
	// Read from the LIST response, not from the chat query: it says whether the
	// project targets any channel at all, which is what separates "this refresh
	// recorded no outcomes" from "chat was never configured here".
	const chatChannelsConfigured = query.data?.chatChannelsConfigured ?? false;

	// Any control that changes the query has to reset the page. Landing on
	// offset 60 of a filter with four rows shows an empty table that reads as
	// "no refreshes", which is the same lie the error branch below avoids.
	//
	// And it has to close the disclosure, for the same reason one level down: the
	// expanded row is a property of a row on screen. Left open across a page or
	// filter change, `expandedCycleId` names a cycle the new page does not
	// contain — so nothing renders, but the detail query stays `enabled` and
	// keeps fetching a cycle nobody is looking at, and stepping back re-opens a
	// row the user never re-opened.
	const changePage = (next: number) => {
		setPage(next);
		setExpandedCycleId(null);
	};
	const changeStatus = (next: StatusFilter) => {
		setStatus(next);
		changePage(0);
	};
	const changePageSize = (next: PageSize) => {
		setPageSize(next);
		changePage(0);
	};

	let body: React.ReactNode;
	if (query.isPending) {
		body = (
			<p className="text-sm text-muted-foreground">Loading refreshes…</p>
		);
	} else if (query.isError) {
		// BEFORE the empty check, and that order is the whole point: an errored
		// query has undefined data, so falling through would render "No
		// refreshes yet" for what is actually a failed read — hiding exactly
		// what someone opened this table to find.
		body = (
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<span className="text-destructive">
					Could not load the refresh history.
				</span>
				<button
					type="button"
					className="underline underline-offset-2 hover:text-foreground"
					onClick={() => query.refetch()}
				>
					Retry
				</button>
			</div>
		);
	} else if (cycles.length === 0) {
		body = (
			<p className="text-sm text-muted-foreground">
				{status === "all"
					? "No refreshes yet."
					: "No refreshes match this filter."}
			</p>
		);
	} else {
		body = (
			<>
				<div className="overflow-x-auto">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Started</TableHead>
								<TableHead>Duration</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Trigger</TableHead>
								{/* Placed BEFORE Topics, not after it. Topics is a
								    bare right-aligned number and this column holds
								    a word, so putting them side by side recreates
								    the adjacency that made "3" and "Channels" read
								    as one phrase — the defect this table already
								    had once. The number keeps a neighbour that is
								    not a noun.

								    The header carries the RULE, because the column
								    alone cannot explain the case people actually
								    hit: chat arrived and no bell did. */}
								<TableHead title="In-app and email go to the contributors attributed to this refresh's topics — not to everyone in the project. Chat is sent to the project's channels instead and does not depend on attribution.">
									Notified
								</TableHead>
								<TableHead className="text-right">
									Topics
								</TableHead>
								{/* An action column for the disclosure, named for
								    assistive tech but unlabelled on screen. A
								    visible header would describe the rows whose
								    cell is empty, and "no chat column entry" is
								    not something this table knows — the six
								    whole-run gates write no row either way. */}
								<TableHead>
									<span className="sr-only">
										Chat delivery
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{cycles.map((cycle) => {
								const s = describeStatus(cycle.status);
								const outcome = describeOutcome(
									cycle.notificationOutcome,
									cycle,
								);
								// Shown ONLY when it contradicts the label.
								// "Sent" on its own then means every person who
								// was owed a notification got one, and the
								// number appears exactly where that would
								// otherwise be an overstatement — which keeps
								// the column scannable and stops a count that
								// says nothing from competing with one that
								// does. `owed === 0` is not partial: it is the
								// ordinary state for the outcomes that write no
								// ledger row.
								// Optional-chained, unlike `notificationOutcome`
								// above, and for a reason that is NOT "the type
								// might be wrong". A missing scalar renders an
								// empty cell; a missing OBJECT here would throw
								// on property access and take the whole table
								// down. React Query can serve a response cached
								// by the previous deploy, which is a real way
								// for a field to be absent from a payload the
								// current build's types say always has it — and
								// a white screen is a far worse answer to that
								// than a zero.
								const owed =
									cycle.notifiedRecipients?.owed ?? 0;
								const delivered =
									cycle.notifiedRecipients?.delivered ?? 0;
								// Shown ONLY when it contradicts the label.
								// "Sent" on its own then means every person who
								// was owed a notification got one, and the
								// number appears exactly where that would
								// otherwise be an overstatement — which keeps
								// the column scannable and stops a count that
								// says nothing from competing with one that
								// does. `owed === 0` is not partial: it is the
								// ordinary state for the outcomes that write no
								// ledger row.
								const partialReach =
									owed > 0 && delivered < owed;
								const expanded = expandedCycleId === cycle.id;
								// Offered when rows exist, OR when the project
								// targets a channel AND this cycle was eligible
								// for a broadcast at all. Both halves of the
								// second clause are load-bearing.
								//
								// The project clause: the broadcast has six
								// whole-run gates that write NO ledger row, so a
								// zero count alone renders a refused broadcast
								// identically to an unconfigured project.
								//
								// The status clause: the workflow dispatches the
								// broadcast only for a READY cycle, so every
								// NO_TOPICS / INSUFFICIENT_CONTEXT / FAILED /
								// GENERATING row has no deliveries because the
								// activity was never invoked — no refusal, and no
								// aggregate log line to go and read. Without this
								// clause, selecting the "Failed" or "No topics"
								// filter on a chat-configured project puts a
								// confident, wrong causal explanation on EVERY
								// row in the table.
								const hasChat =
									cycle.chatDeliveryCount > 0 ||
									(chatChannelsConfigured &&
										cycle.status === "READY");
								return (
									<Fragment key={cycle.id}>
										<TableRow>
											<TableCell className="whitespace-nowrap text-foreground">
												{formatStarted(cycle.startedAt)}
											</TableCell>
											<TableCell className="whitespace-nowrap text-muted-foreground">
												{formatDuration(
													cycle.startedAt,
													cycle.completedAt,
												)}
											</TableCell>
											<TableCell>
												<Badge status={s.tone}>
													{s.label}
												</Badge>
											</TableCell>
											<TableCell className="text-muted-foreground">
												{cycle.trigger === "manual"
													? "Manual"
													: "Scheduled"}
											</TableCell>
											{/* `cycle.notificationOutcome` is what
											    pins the procedure: the row type is
											    inferred from the oRPC output, so
											    dropping the field there is a
											    type error here rather than a
											    silently blank column. Do not add a
											    `?? ""` — it would defend against
											    something the type system already
											    prevents, and it would let the
											    field go missing unnoticed. */}
											<TableCell
												className={cn(
													"whitespace-nowrap",
													outcome.needsAttention
														? "text-destructive"
														: "text-muted-foreground",
												)}
												title={outcome.detail}
											>
												{outcome.label}
												{/* Separated by a middot and
												    carrying its own unit
												    ("of 5"), never set flush
												    against the label. A bare
												    number touching a word is
												    how this table once made a
												    topic count read as a
												    channel count. */}
												{partialReach ? (
													<span className="ml-1.5 text-xs">
														{`· ${delivered} of ${owed}`}
													</span>
												) : null}
											</TableCell>
											<TableCell className="text-right text-foreground">
												{cycle.topicCount}
											</TableCell>
											{/* SEPARATE CELL, NOT A SUFFIX ON THE
											    COUNT. These two shared one
											    right-aligned numeric cell, so the
											    count and the word rendered as the
											    single phrase "2 Channels" and a
											    reader took the topic count for a
											    channel count. Neither value was
											    wrong; the defect was only that
											    they touched. The number belongs
											    to Topics alone.

											    Worth stating because the logic in
											    this file works hard NOT to assert
											    a delivery fact it cannot support
											    (see `hasChat` above) — and layout
											    put back exactly such an assertion
											    by adjacency. */}
											<TableCell className="text-right">
												{hasChat ? (
													<button
														type="button"
														aria-expanded={expanded}
														aria-controls={`chat-delivery-detail-${cycle.id}`}
														// WCAG 2.5.3 Label in Name: the accessible
														// name must CONTAIN the visible label, so a
														// speech-input user saying "click Channels"
														// activates it. "Show chat channel detail"
														// does not, and fails that.
														aria-label={`${expanded ? "Hide channels" : "Channels"} — chat delivery detail for this refresh`}
														className="text-sm underline underline-offset-2 hover:text-foreground"
														onClick={() =>
															setExpandedCycleId(
																expanded
																	? null
																	: cycle.id,
															)
														}
													>
														{expanded
															? "Hide channels"
															: "Channels"}
													</button>
												) : null}
											</TableCell>
										</TableRow>
										{expanded ? (
											<TableRow
												id={`chat-delivery-detail-${cycle.id}`}
											>
												<TableCell
													// Tracks the header count — seven since the
													// Notified column. Pinned by a test that
													// derives the expectation from the rendered
													// headers, because a stale span here is the
													// one column-count mistake that shows up as
													// nothing worse than a short row.
													colSpan={7}
													className="bg-muted/40"
												>
													{chatQuery.isLoading ? (
														<p className="text-sm text-muted-foreground">
															Loading channel
															detail…
														</p>
													) : chatQuery.isError ? (
														/* BEFORE the empty check, same
														   reason as the outer table: an
														   errored query has undefined
														   data, so falling through would
														   report "no channels" for what
														   is actually a failed read. */
														<div className="flex flex-wrap items-center gap-2 text-sm">
															<span className="text-destructive">
																Could not load
																channel detail.
															</span>
															<button
																type="button"
																className="underline underline-offset-2 hover:text-foreground"
																onClick={() =>
																	chatQuery.refetch()
																}
															>
																Retry
															</button>
														</div>
													) : (chatQuery.data
															?.deliveries
															?.length ?? 0) ===
														0 ? (
														<p className="text-sm text-muted-foreground">
															No per-channel
															outcome was recorded
															for this refresh.
															The broadcast either
															never ran or was
															refused before
															reaching any channel
															— check the worker
															log for the reason.
														</p>
													) : (
														<ul className="space-y-2">
															{chatQuery.data?.deliveries.map(
																(d) => {
																	const ds =
																		formatChatDeliveryStatus(
																			d.status,
																		);
																	return (
																		<li
																			// A channel id is unique only WITHIN a
																			// workspace: two connected workspaces can
																			// surface the same id, so the team id is
																			// part of the key.
																			key={`${d.platform}-${d.externalTeamId}-${d.channelId}`}
																			className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
																		>
																			<span className="font-medium text-foreground">
																				{platformLabel(
																					d.platform,
																				)}
																				{
																					" · "
																				}
																				{
																					d.channelName
																				}
																			</span>
																			<Badge
																				status={
																					ds.variant
																				}
																			>
																				{
																					ds.label
																				}
																			</Badge>
																			{d.reason ? (
																				<span className="text-muted-foreground">
																					{
																						d.reason
																					}
																				</span>
																			) : null}
																		</li>
																	);
																},
															)}
														</ul>
													)}
												</TableCell>
											</TableRow>
										) : null}
									</Fragment>
								);
							})}
						</TableBody>
					</Table>
				</div>
				<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
					<div className="flex items-center gap-2">
						<span>Rows</span>
						<Select
							value={String(pageSize)}
							onValueChange={(v) =>
								changePageSize(Number(v) as PageSize)
							}
						>
							<SelectTrigger
								className="h-8 w-20"
								aria-label="Rows per page"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PAGE_SIZES.map((size) => (
									<SelectItem key={size} value={String(size)}>
										{size}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-center gap-3">
						<span>
							{page * pageSize + 1}–
							{Math.min((page + 1) * pageSize, total)} of {total}
						</span>
						<Button
							variant="outline"
							size="sm"
							disabled={page === 0}
							onClick={() => changePage(Math.max(0, page - 1))}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							size="sm"
							disabled={page >= lastPage}
							onClick={() => changePage(page + 1)}
						>
							Next
						</Button>
					</div>
				</div>
			</>
		);
	}

	return (
		<section className="mt-8" data-onboarding-target="publishing-history">
			<h3 className="editorial-label mb-3">Refresh history</h3>
			{/* Rendered outside the state switch, so the filter stays usable
			    when the current one returns nothing — otherwise the only way
			    out of an empty filter is a reload. */}
			<div
				className="mb-4 flex flex-wrap gap-2"
				role="group"
				aria-label="Filter refreshes by outcome"
			>
				{STATUS_FILTERS.map((chip) => {
					const active = status === chip.value;
					return (
						<button
							key={chip.value}
							type="button"
							aria-pressed={active}
							onClick={() => changeStatus(chip.value)}
							className={cn(
								"rounded-full border px-3 py-1 text-xs font-medium transition-colors",
								active
									? "border-primary bg-primary/10 text-primary"
									: "border-border bg-muted text-muted-foreground hover:text-foreground",
							)}
						>
							{chip.label}
						</button>
					);
				})}
			</div>
			{body}
		</section>
	);
}
