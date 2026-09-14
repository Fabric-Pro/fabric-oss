"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import {
	FunctionTagSelect,
	type FunctionTagValue,
} from "@saas/shared/components/FunctionTagSelect";
import { UserAvatar } from "@shared/components/UserAvatar";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { LoaderIcon, UsersIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	askNeedsConfirmation,
	type CliConnectionAskResult,
	interpretCliConnectionAskError,
	MAX_HAND_PICKED_RECIPIENTS,
	summarizeCliConnectionAsk,
	tooManyRecipientsMessage,
} from "./lib/cli-connection-nudge";

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/*                                                                             */
/* Hoisted out of the JSX, as `ConnectCliDialog` and `CliConnectionNudge` beside */
/* it do: the wording that needs product sign-off is reviewable in one place.   */
/* English constants rather than `useTranslations`, matching the two surfaces    */
/* this one is mounted with — a single dialog in a localized shell would be the  */
/* odd one out either way, and the folder has already made that call.           */
/* -------------------------------------------------------------------------- */

const DIALOG_TITLE = "Ask a teammate to connect a coding tool";

/**
 * The offer, and the two ways to compose it.
 *
 * "on this project" is load-bearing and repeated below. A function tag is held
 * per project in this data model — there is no organization-wide tag query, and
 * the handler expands tags strictly within the project roster — so copy that
 * said "everyone tagged Developer" would promise an audience the product cannot
 * reach and quietly under-deliver every time.
 */
const DIALOG_DESCRIPTION =
	"Pick the people who work in a terminal, or name a function tag and reach everyone on this project who holds it. Each of them gets a notification linking back here.";

const PEOPLE_LABEL = "People on this project";

const TAGS_LABEL = "Or everyone holding a function tag";

const TAGS_HINT =
	"Function tags are held per project. This reaches the holders on this project, not everyone in the organization.";

/**
 * Said before the send, so the toast afterwards is not the first the sender
 * hears of it (R31 — no surprises in a result the reader cannot re-read).
 *
 * The handler drops anyone whose organization role cannot mint an API key,
 * because connecting a coding tool starts with minting one and a notification
 * they cannot act on is worse than no notification.
 */
const ELIGIBILITY_NOTE =
	"Anyone who cannot create an API key is left out — they would not be able to act on the ask.";

/**
 * Shown, and announced once, the moment a hand-picked selection reaches
 * {@link MAX_HAND_PICKED_RECIPIENTS} — at the point of selection, not after a
 * send the server would only refuse. The tag route has no such warning: naming
 * a tag can resolve to any size, and there is no honest count to guard against
 * before the ask has gone (see `askNeedsConfirmation`'s doc comment). That
 * asymmetry is correct, not an oversight left here.
 */
function recipientCapReachedNote(cap: number): string {
	return `You've reached the limit of ${cap} people for one hand-picked ask. Remove someone to add another, or reach more people through a function tag instead.`;
}

const LOADING_MEMBERS = "Loading the people on this project…";

const MEMBERS_ERROR = "The project's members could not be loaded.";

const NO_MEMBERS = "There is nobody else on this project to ask.";

const SEND_LABEL = "Send the ask";

const SENDING_LABEL = "Sending…";

const CANCEL_LABEL = "Cancel";

/* -------------------------------------------------------------------------- */
/* Confirmation copy                                                           */
/* -------------------------------------------------------------------------- */

const CONFIRM_TITLE = "Confirm this ask";

const CONFIRM_DESCRIPTION =
	"This reaches more than a handful of people. Check it before it goes.";

/**
 * What a tag costs, stated as an unknown rather than as a number.
 *
 * There is no honest number to put here. See `askNeedsConfirmation` for why the
 * one query that could supply one answers a different question — roster holders
 * rather than eligible recipients — and goes quiet when a flag this fan-out does
 * not consult is off.
 */
const CONFIRM_TAG_NOTE =
	"A function tag asks everyone on this project who holds it. Fabric cannot tell you how many people that is until the ask has gone — the count you get back afterwards is the real one.";

function confirmPeopleNote(count: number): string {
	return `You have picked ${count} people. Each one gets their own notification.`;
}

const CONFIRM_SEND_LABEL = "Send it";

const CONFIRM_BACK_LABEL = "Back";

/** Announced when the confirmation step replaces the picker. */
const CONFIRM_ANNOUNCEMENT =
	"Confirm this ask before it is sent. Send it, or go back to change who you picked.";

/**
 * Never the server's own message: this repository is public, and an error
 * string can carry an internal detail that has no business in a toast. The same
 * rule `ConnectCliDialog` and `CliConnectionNudge` state for theirs.
 */
const SEND_ERROR =
	"The ask could not be sent. Try again, or ask your team directly.";

interface RequestCliConnectionDialogProps {
	/** Controlled by the caller. This view never gates its own visibility. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The project whose roster is asked, and whose readiness prompt opened this. */
	projectId: string;
	/**
	 * Passed through to the member read only.
	 *
	 * The handler accepts an `organizationId` and ignores it — every
	 * organization it uses is the project's own, resolved server-side — so this
	 * is sent for shape-consistency with the rest of the readiness namespace and
	 * decides nothing here.
	 */
	organizationId: string | null;
	/** Fired once per ask the server accepted, so the caller can record its funnel step. */
	onAsked?: (result: CliConnectionAskResult) => void;
}

/**
 * Ask teammates to connect a coding CLI (Fizzy #2457).
 *
 * The prompt's second offer. A reader who will not open a terminal themselves —
 * often the organization admin looking at a readiness checklist — can pass the
 * job to whoever on the project would, by name or by the function tag they hold
 * here.
 *
 * Modelled on `NotifyMembersDialog`, which solves the same problem for sharing a
 * story: a checkbox roster from `projects.members.list`, the current user
 * filtered out, and a result phrased from the row count the server actually
 * wrote rather than from the number of people the sender picked. What is added
 * is the tag route and the confirmation step.
 *
 * ## Recipients are PROJECT members
 *
 * Both routes resolve inside the project roster, because that is the only place
 * a function tag exists in this data model. Nothing here can reach an
 * organization member who is not on this project, and the copy does not imply
 * otherwise.
 *
 * ## The result is reported, never predicted
 *
 * The four counts the handler returns are four different facts, and the toast
 * says all of them that apply — see `summarizeCliConnectionAsk`. Someone who
 * already has an unread ask is de-duplicated server-side and is NOT counted as
 * notified again, so "asked N" here means N notification rows were written,
 * not N people picked — and someone whose row simply failed to write is never
 * folded into that same "already asked" bucket.
 *
 * ## The over-cap refusal is distinguished, not retried
 *
 * The server refuses the whole call, rather than truncating it, above its
 * recipient cap — see `interpretCliConnectionAskError`. That refusal is
 * matched by code and answered with the actual numbers and something to do
 * about it; every other failure keeps the generic `SEND_ERROR` copy.
 */
export function RequestCliConnectionDialog({
	open,
	onOpenChange,
	projectId,
	organizationId,
	onAsked,
}: RequestCliConnectionDialogProps) {
	const { user } = useSession();
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [tags, setTags] = useState<FunctionTagValue[]>([]);
	/**
	 * The confirmation step, held as its own flag rather than derived from the
	 * selection. `askNeedsConfirmation` says whether a confirmation is OWED;
	 * this says whether one is on screen, and only a click sets it. Deriving it
	 * would put the reader back in the confirmation the moment they removed one
	 * tag and added another.
	 */
	const [confirming, setConfirming] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const confirmSendRef = useRef<HTMLButtonElement>(null);
	const sendRef = useRef<HTMLButtonElement>(null);

	// Reset every transient piece each time the view opens, the way
	// `NotifyMembersDialog` does: a half-composed ask from last time is not a
	// draft anybody asked to keep.
	useEffect(() => {
		if (open) {
			setSelectedIds(new Set());
			setTags([]);
			setConfirming(false);
			setAnnouncement("");
		}
	}, [open]);

	const membersQuery = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
	});

	/**
	 * The roster minus the viewer, one row per person.
	 *
	 * `members.list` already returns only the creator plus accepted, unexpired
	 * members — the same set the handler allow-lists every explicit id against,
	 * so a selection made here cannot be refused for naming an outsider. Only
	 * the current user is dropped: asking yourself to do the thing you are
	 * looking at is not an error, it is just nothing, and the server skips it
	 * too.
	 *
	 * The de-dup by `userId` is load-bearing, not defensive filler:
	 * `getProjectMembers` synthesises a creator row and then appends every
	 * accepted `ProjectMember` row with no check against it, so a creator who
	 * also holds an accepted self-invite comes back TWICE with the same
	 * `userId`. `joinRosterFunctionTags` documents the same gap and de-dups it
	 * with a `seen` set for the same reason — a duplicate here would render two
	 * checkbox rows sharing one React key, and ticking either would visibly
	 * tick both. First occurrence wins, same as that helper, which keeps the
	 * synthesised creator row (roster order puts it first) over the
	 * self-invite's.
	 */
	const selectableMembers = useMemo(() => {
		const members = membersQuery.data?.members ?? [];
		const seen = new Set<string>();
		const deduped: typeof members = [];
		for (const member of members) {
			if (member.userId === user?.id || seen.has(member.userId)) {
				continue;
			}
			seen.add(member.userId);
			deduped.push(member);
		}
		return deduped;
	}, [membersQuery.data, user?.id]);

	const askMutation = useMutation(
		orpc.projects.readiness.requestCliConnection.mutationOptions({
			onSuccess: (result) => {
				const { tone, message } = summarizeCliConnectionAsk(result);
				// `info` for an ask that reached nobody. Nothing went wrong, so
				// it is not an error — but saying it in the success register
				// would be the interface telling the sender their team had been
				// asked when it had not.
				if (tone === "success") {
					toast.success(message);
				} else {
					toast.info(message);
				}
				onAsked?.(result);
				onOpenChange(false);
			},
			onError: (error) => {
				// The over-cap refusal FIRST: it is not the generic failure
				// below, it will not resolve on a retry, and the reader was
				// told a tag's true size cannot be known until the ask has
				// gone — landing on "Try again" here would be a dead end.
				const refusal = interpretCliConnectionAskError(error);
				const message =
					refusal.kind === "tooManyRecipients"
						? tooManyRecipientsMessage(
								refusal.recipientCount,
								refusal.maxRecipients,
							)
						: SEND_ERROR;
				if (refusal.kind === "other") {
					// Never the server's own message for anything else: this
					// repository is public, and an unmatched error string can
					// carry an internal detail that has no business in a
					// toast. The over-cap refusal above is composed from
					// numbers, never from the server's prose, so it has no
					// such risk.
					console.error(
						"Failed to ask teammates to connect a coding tool",
						error,
					);
				}
				toast.error(message);
				// Back to the picker rather than stranded on a confirmation
				// whose question has already been answered.
				setConfirming(false);
				setAnnouncement(message);
			},
		}),
	);

	// Keyboard continuity across the step change: the control that was pressed
	// unmounts with the picker, and without this the reader is dropped on
	// `document.body` and has to tab back into the dialog to answer it.
	useEffect(() => {
		if (confirming) {
			confirmSendRef.current?.focus();
		}
	}, [confirming]);

	const selection = useMemo(
		() => ({
			userIds: Array.from(selectedIds),
			functionTags: tags,
		}),
		[selectedIds, tags],
	);

	const hasSelection =
		selection.userIds.length > 0 || selection.functionTags.length > 0;

	/**
	 * Whether one more hand-picked id would exceed the cap the server enforces
	 * on the resolved recipient list. Read from the CURRENT selection, not from
	 * inside the state updater below: this drives what is disabled and
	 * announced on THIS render, and `selectedIds` is already this render's
	 * value.
	 */
	const atRecipientCap = selectedIds.size >= MAX_HAND_PICKED_RECIPIENTS;

	const toggle = (userId: string) => {
		// Refuse the (cap + 1)th id here, at the point of selection, rather
		// than composing a request the server can only refuse outright — see
		// `recipientCapReachedNote`. Unchecking always goes through: freeing a
		// slot must never be blocked by the cap that slot is subject to.
		if (!selectedIds.has(userId) && atRecipientCap) {
			setAnnouncement(
				recipientCapReachedNote(MAX_HAND_PICKED_RECIPIENTS),
			);
			return;
		}
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(userId)) {
				next.delete(userId);
			} else {
				next.add(userId);
			}
			return next;
		});
	};

	const send = () => {
		askMutation.mutate({
			projectId,
			organizationId,
			userIds: selection.userIds,
			functionTags: selection.functionTags,
		});
	};

	const handleSend = () => {
		if (!hasSelection) {
			return;
		}
		if (askNeedsConfirmation(selection)) {
			setConfirming(true);
			setAnnouncement(CONFIRM_ANNOUNCEMENT);
			return;
		}
		send();
	};

	const handleBack = () => {
		setConfirming(false);
		setAnnouncement("");
		// Hand focus back to the control that raised the confirmation.
		window.requestAnimationFrame(() => sendRef.current?.focus());
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{confirming ? CONFIRM_TITLE : DIALOG_TITLE}
					</DialogTitle>
					<DialogDescription>
						{confirming ? CONFIRM_DESCRIPTION : DIALOG_DESCRIPTION}
					</DialogDescription>
				</DialogHeader>

				{/* One polite live region, kept mounted across the step change
				    so assistive technology has something to observe rather than
				    a node appearing mid-announcement. Same treatment as
				    `ConnectCliDialog`'s copy announcements. */}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>

				{confirming ? (
					<div className="space-y-2 text-sm">
						{selection.functionTags.length > 0 ? (
							<p>{CONFIRM_TAG_NOTE}</p>
						) : null}
						{selection.userIds.length > 0 ? (
							<p className="text-muted-foreground">
								{confirmPeopleNote(selection.userIds.length)}
							</p>
						) : null}
						<p className="text-muted-foreground">
							{ELIGIBILITY_NOTE}
						</p>
					</div>
				) : (
					<div className="space-y-4">
						<div className="space-y-2">
							<Label id="cli-ask-people-label">
								{PEOPLE_LABEL}
							</Label>
							<div className="max-h-56 overflow-y-auto rounded-md border">
								{membersQuery.isLoading ? (
									<div className="flex items-center justify-center gap-2 p-6 text-muted-foreground text-sm">
										<LoaderIcon
											aria-hidden="true"
											className="size-4 animate-spin motion-reduce:animate-none"
										/>
										{LOADING_MEMBERS}
									</div>
								) : membersQuery.isError ? (
									<div className="flex flex-col items-center gap-2 p-6 text-center text-muted-foreground text-sm">
										<UsersIcon
											aria-hidden="true"
											className="size-5"
										/>
										{MEMBERS_ERROR}
									</div>
								) : selectableMembers.length === 0 ? (
									<div className="flex flex-col items-center gap-2 p-6 text-center text-muted-foreground text-sm">
										<UsersIcon
											aria-hidden="true"
											className="size-5"
										/>
										{NO_MEMBERS}
									</div>
								) : (
									<ul
										aria-labelledby="cli-ask-people-label"
										className="divide-y"
									>
										{selectableMembers.map((member) => {
											const checked = selectedIds.has(
												member.userId,
											);
											// Disabled rather than merely
											// silent: a reachable control that
											// does nothing when pressed reads
											// as broken. Never disables a
											// CHECKED box — freeing a slot by
											// unchecking one must always work.
											const disabled =
												!checked && atRecipientCap;
											const displayName =
												member.user.name ??
												member.user.email;
											return (
												<li key={member.userId}>
													{/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox below is the control this label wraps; it renders a native input through Radix. */}
													<label
														className={cn(
															"flex cursor-pointer items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/40",
															checked &&
																"bg-muted/30",
															disabled &&
																"cursor-not-allowed opacity-50 hover:bg-transparent",
														)}
													>
														<Checkbox
															aria-label={`Ask ${displayName}`}
															checked={checked}
															disabled={disabled}
															onCheckedChange={() =>
																toggle(
																	member.userId,
																)
															}
														/>
														<UserAvatar
															avatarUrl={
																member.user
																	.image
															}
															className="size-7"
															name={displayName}
														/>
														<span className="min-w-0 flex-1">
															<span className="block truncate font-medium text-sm">
																{displayName}
															</span>
															<span className="block truncate text-muted-foreground text-xs">
																{member.isGuest
																	? "Guest"
																	: member
																			.user
																			.email}
															</span>
														</span>
													</label>
												</li>
											);
										})}
									</ul>
								)}
							</div>
							{/* Persistent, not just announced: the live region
							    above fires once, on the click that hits the
							    cap, and a reader who arrives at this state
							    any other way — tabbing in, reopening the
							    picker — needs the same explanation sitting on
							    the page. */}
							{atRecipientCap ? (
								<p className="text-muted-foreground text-xs">
									{recipientCapReachedNote(
										MAX_HAND_PICKED_RECIPIENTS,
									)}
								</p>
							) : null}
						</div>

						<div className="space-y-2">
							<Label htmlFor="cli-ask-function-tags">
								{TAGS_LABEL}
							</Label>
							<FunctionTagSelect
								aria-label={TAGS_LABEL}
								id="cli-ask-function-tags"
								onChange={setTags}
								value={tags}
							/>
							<p className="text-muted-foreground text-xs">
								{TAGS_HINT}
							</p>
						</div>

						<p className="text-muted-foreground text-xs">
							{ELIGIBILITY_NOTE}
						</p>
					</div>
				)}

				<DialogFooter>
					{confirming ? (
						<>
							<Button
								autoLoading={false}
								onClick={handleBack}
								type="button"
								variant="outline"
							>
								{CONFIRM_BACK_LABEL}
							</Button>
							<Button
								autoLoading={false}
								disabled={askMutation.isPending}
								onClick={send}
								ref={confirmSendRef}
								type="button"
							>
								{askMutation.isPending
									? SENDING_LABEL
									: CONFIRM_SEND_LABEL}
							</Button>
						</>
					) : (
						<>
							<Button
								autoLoading={false}
								onClick={() => onOpenChange(false)}
								type="button"
								variant="outline"
							>
								{CANCEL_LABEL}
							</Button>
							<Button
								autoLoading={false}
								disabled={
									!hasSelection || askMutation.isPending
								}
								onClick={handleSend}
								ref={sendRef}
								type="button"
							>
								{askMutation.isPending
									? SENDING_LABEL
									: SEND_LABEL}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
