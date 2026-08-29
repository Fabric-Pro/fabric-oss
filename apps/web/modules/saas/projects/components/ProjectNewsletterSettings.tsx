"use client";

import { buildReleaseWidgetSnippet } from "@marketing/shared/lib/embed-snippet";
import { getBaseUrl } from "@repo/utils";
import { Pagination } from "@saas/shared/components/Pagination";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { Textarea } from "@ui/components/textarea";
import {
	AlertTriangleIcon,
	CheckIcon,
	CopyIcon,
	RefreshCwIcon,
	SendIcon,
	TrashIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectChatChannelButton } from "./ConnectChatChannelButton";
import { NewsletterReviewHighlight } from "./NewsletterReviewHighlight";
import {
	describeReviewFailure,
	describeReviewSuccess,
	type ReviewFeedback,
} from "./newsletter-review-feedback";
import {
	formatChatDeliveryStatus,
	formatNewsletterSendStatus,
	hasExpiredRepoIntegrations,
	isSendsListKeyForProject,
} from "./newsletter-send-status";

type Props = {
	projectId: string;
	organizationId: string | null;
	/** Switch the parent settings page to the Execution tab (where the repository
	 *  integrations live) so the user can reconnect straight from the banner. */
	onNavigateToRepositories?: () => void;
	/** Switch the parent settings page to the tab where Teams/Slack channel
	 *  monitors are linked, so the "connect a channel" CTA can send the user
	 *  straight there when no chat channel is linked yet. */
	onNavigateToChatChannels?: () => void;
	/** Server-side permission is the real enforcement; this only disables the
	 *  controls for a viewer without edit rights. Defaults to `true` so
	 *  existing callers that don't pass it keep behaving as before. */
	canEdit?: boolean;
};

const sectionTitleClass =
	"text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground";

const DAY_OF_WEEK_LABELS = [
	{ value: "0", label: "Sunday" },
	{ value: "1", label: "Monday" },
	{ value: "2", label: "Tuesday" },
	{ value: "3", label: "Wednesday" },
	{ value: "4", label: "Thursday" },
	{ value: "5", label: "Friday" },
	{ value: "6", label: "Saturday" },
];

// 1..28 — kept within every month so a monthly send never lands on a
// non-existent date (mirrors the schema's dayOfMonth max of 28).
const DAY_OF_MONTH_OPTIONS = Array.from({ length: 28 }, (_, i) => `${i + 1}`);

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => `${i}`);

/**
 * Send statuses a WORKER is expected to move on within seconds, so the history
 * table is worth re-reading while one is on screen.
 *
 * `APPROVED` is the one that motivated this: "Approve & send" records the
 * decision synchronously and hands delivery to a Temporal workflow, so the row
 * is genuinely `APPROVED · 0/0` for a moment. Without a second read the panel
 * kept asserting that forever and only a page reload showed `Sent · 1/1`.
 *
 * `PENDING_APPROVAL` is deliberately NOT here. It waits on a person and can sit
 * for days; polling it would be an unbounded background loop that no machine is
 * going to end, which is a different problem from catching up with a worker.
 */
const IN_FLIGHT_SEND_STATUSES = new Set(["PENDING", "APPROVED"]);

const IN_FLIGHT_SEND_POLL_MS = 5000;

/**
 * True when the given `newsletter.sends.list` payload contains a send a worker
 * is still acting on. Tolerant of an absent/loading payload — react-query calls
 * `refetchInterval` before the first result lands.
 */
function hasInFlightSend(data: unknown): boolean {
	const sends = (data as { sends?: { status?: string }[] } | undefined)
		?.sends;
	return (
		Array.isArray(sends) &&
		sends.some((s) => IN_FLIGHT_SEND_STATUSES.has(s?.status ?? ""))
	);
}

// AI-curated summary tiers — mirrors the server-side `detailLevel` enum on
// `newsletter.settings.update` / `newsletter.sends.sendNow` (Task 6).
const DETAIL_LEVEL_OPTIONS: {
	value: "BRIEF" | "STANDARD" | "DETAILED";
	label: string;
	hint: string;
}[] = [
	{
		value: "BRIEF",
		label: "Brief",
		hint: "Top few highlights, one line each",
	},
	{
		value: "STANDARD",
		label: "Standard",
		hint: "Balanced summary (default)",
	},
	{
		value: "DETAILED",
		label: "Detailed",
		hint: "Comprehensive, more technical",
	},
];

// Where release-notes are delivered — mirrors the server-side
// `NEWSLETTER_DELIVERY_DESTINATIONS` enum on `newsletter.settings.update`
// (Task 7/9). "Chat" and "Both" surface the connected-channel picker below.
const DELIVERY_DESTINATION_OPTIONS: {
	value: "EMAIL" | "CHAT" | "BOTH";
	label: string;
	hint: string;
}[] = [
	{
		value: "EMAIL",
		label: "Email",
		hint: "Send to subscribers by email (default)",
	},
	{
		value: "CHAT",
		label: "Chat channel",
		hint: "Post to connected Teams/Slack channels",
	},
	{
		value: "BOTH",
		label: "Both",
		hint: "Email subscribers and post to chat",
	},
];

type NewsletterChatChannel = {
	platform: "TEAMS" | "SLACK";
	teamId: string;
	channelId: string;
	channelName?: string;
};

/** Stable identity for a chat channel, independent of platform-specific field
 *  naming (Teams uses `teamId`, Slack uses `slackTeamId` upstream — both are
 *  normalized to `teamId` before reaching this helper). */
function chatChannelKey(c: {
	platform: string;
	teamId: string;
	channelId: string;
}): string {
	return `${c.platform}:${c.teamId}:${c.channelId}`;
}

// Embeddable-widget appearance: mirrors the server-side allowlist/defaults in
// `resolveReleaseWidgetParams` (embed-params.ts) so the owner preview matches
// exactly what the public iframe renders.
const WIDGET_THEME_OPTIONS = ["light", "dark"] as const;
const WIDGET_FONT_OPTIONS = ["system", "inter", "serif"] as const;
const WIDGET_DENSITY_OPTIONS = ["comfortable", "compact"] as const;
const WIDGET_DEFAULTS = {
	theme: "light" as (typeof WIDGET_THEME_OPTIONS)[number],
	accent: "#9F2A3A",
	font: "system" as (typeof WIDGET_FONT_OPTIONS)[number],
	radius: 12,
	width: "480",
	density: "comfortable" as (typeof WIDGET_DENSITY_OPTIONS)[number],
};

type WidgetAppearance = {
	theme: (typeof WIDGET_THEME_OPTIONS)[number];
	accent: string;
	font: (typeof WIDGET_FONT_OPTIONS)[number];
	radius: number;
	width: string;
	density: (typeof WIDGET_DENSITY_OPTIONS)[number];
};

function formatHourUtc(hour: number): string {
	return `${String(hour).padStart(2, "0")}:00 UTC`;
}

function formatDateTime(value: Date | string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return date.toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

type SubscriberRowData = {
	id: string;
	email: string;
	name?: string | null;
	status: string;
};

/** One subscriber row, shared by the active list and the (revealed)
 *  unsubscribed block so the markup stays in one place. */
function SubscriberRow({
	sub,
	onRemove,
}: {
	sub: SubscriberRowData;
	onRemove: (id: string) => void;
}) {
	return (
		<li className="flex items-center justify-between gap-3 p-3">
			<div className="min-w-0">
				<p className="truncate text-sm text-foreground">{sub.email}</p>
				{sub.name ? (
					<p className="truncate text-xs text-muted-foreground">
						{sub.name}
					</p>
				) : null}
			</div>
			<div className="flex items-center gap-2">
				<Badge
					status={sub.status === "ACTIVE" ? "success" : "secondary"}
				>
					{sub.status === "ACTIVE" ? "Active" : "Unsubscribed"}
				</Badge>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Remove ${sub.email}`}
					onClick={() => onRemove(sub.id)}
				>
					<TrashIcon className="size-4 text-destructive" />
				</Button>
			</div>
		</li>
	);
}

export function ProjectNewsletterSettings({
	projectId,
	organizationId,
	onNavigateToRepositories,
	onNavigateToChatChannels,
	canEdit = true,
}: Props) {
	const queryClient = useQueryClient();
	const orgId = organizationId ?? null;
	const tEmbed = useTranslations("newsletter.embed");

	const PAGE_SIZES = [15, 50, 100] as const;
	// Page size for the active and unsubscribed subscriber rosters below.
	const SUBSCRIBERS_PAGE_SIZE = 10;
	const SEND_FILTERS = [
		{ key: "all", label: "All" },
		{ key: "sent", label: "Sent" },
		{ key: "failed", label: "Failed" },
		{ key: "skipped", label: "Skipped" },
	] as const;
	const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(15);
	const [page, setPage] = useState(0);
	const [sendStatus, setSendStatus] =
		useState<(typeof SEND_FILTERS)[number]["key"]>("all");
	const [showUnsubscribed, setShowUnsubscribed] = useState(false);
	const [activeSubscriberPage, setActiveSubscriberPage] = useState(1);
	const [unsubscribedSubscriberPage, setUnsubscribedSubscriberPage] =
		useState(1);
	// Send-now dialog override — seeded from the persisted setting once it
	// loads (see the effect below), but editable per-send without touching
	// the saved default.
	const [sendNowDetailLevel, setSendNowDetailLevel] = useState<
		"BRIEF" | "STANDARD" | "DETAILED"
	>("STANDARD");
	// Which send-history row has its per-channel chat detail panel open.
	const [expandedSendId, setExpandedSendId] = useState<string | null>(null);

	const settingsQuery = useQuery(
		orpc.newsletter.settings.get.queryOptions({
			input: { projectId, organizationId: orgId },
		}),
	);
	const subscribersQuery = useQuery(
		orpc.newsletter.subscribers.list.queryOptions({
			input: { projectId, organizationId: orgId },
		}),
	);
	const sendsQuery = useQuery({
		...orpc.newsletter.sends.list.queryOptions({
			input: {
				projectId,
				organizationId: orgId,
				limit: pageSize,
				offset: page * pageSize,
				status: sendStatus,
			},
		}),
		// Self-disabling: the predicate reads the freshest payload, so the poll
		// stops on its own the moment the last in-flight send lands.
		refetchInterval: (query: { state: { data: unknown } }) =>
			hasInFlightSend(query.state.data) ? IN_FLIGHT_SEND_POLL_MS : false,
	});
	// Whether the row whose disclosure is open is one a worker is still acting
	// on. The deliveries payload carries no send status of its own, so this is
	// read off the history list rather than from the query's own data.
	const expandedSendInFlight =
		!!expandedSendId &&
		(
			sendsQuery.data as
				| { sends?: { id: string; status: string }[] }
				| undefined
		)?.sends?.some(
			(s) =>
				s.id === expandedSendId &&
				IN_FLIGHT_SEND_STATUSES.has(s.status),
		) === true;
	// Only fetches when a row is expanded — the ledger is read per-send, not
	// per-page, so the history table stays a single query at rest.
	const chatDeliveriesQuery = useQuery({
		...orpc.newsletter.sends.chatDeliveries.queryOptions({
			input: {
				projectId,
				organizationId: orgId,
				sendId: expandedSendId ?? "",
			},
		}),
		enabled: !!expandedSendId,
		// An admin who approves with this open watches the channel list, not
		// the badge: the published-notes row only exists once the workflow has
		// posted it.
		refetchInterval: expandedSendInFlight ? IN_FLIGHT_SEND_POLL_MS : false,
	});
	const pendingQuery = useQuery(
		orpc.newsletter.sends.pending.queryOptions({
			input: { projectId, organizationId: orgId },
		}),
	);
	// Per-send set of highlight indexes the reviewer has marked for removal
	// before approving — keyed by send id so switching between multiple
	// pending drafts (rare, but possible after a missed review window)
	// doesn't clobber an in-progress edit on another draft. The checkbox UI
	// is inverted for display: a highlight is checked (selected) by default,
	// and unchecking it is what adds its index here — so the set still stores
	// the *removed* indexes sent up as `removedHighlightIndexes`.
	const [removedBySend, setRemovedBySend] = useState<
		Record<string, Set<number>>
	>({});
	/**
	 * Single exit for both review mutations. `describeReview*` decides the toast
	 * level and whether the cached list is now stale; this only performs it
	 * (Fizzy #2172). A rejection refreshes the send history too — the row lands
	 * there as REJECTED the moment the decision commits.
	 */
	const applyReviewFeedback = (feedback: ReviewFeedback) => {
		if (feedback.level === "success") {
			toast.success(feedback.message);
		} else if (feedback.level === "info") {
			toast.info(feedback.message);
		} else {
			toast.error(feedback.message);
		}
		if (feedback.refresh) {
			pendingQuery.refetch();
			invalidate("sends");
		}
	};
	const approveSend = useMutation({
		mutationFn: async (v: { sendId: string; removed: number[] }) =>
			orpcClient.newsletter.sends.approve({
				projectId,
				organizationId: orgId,
				sendId: v.sendId,
				removedHighlightIndexes: v.removed,
			}),
		onSuccess: (r) =>
			applyReviewFeedback(describeReviewSuccess("approve", r)),
		onError: (e) =>
			applyReviewFeedback(describeReviewFailure("approve", e)),
	});
	const rejectSend = useMutation({
		mutationFn: async (sendId: string) =>
			orpcClient.newsletter.sends.reject({
				projectId,
				organizationId: orgId,
				sendId,
			}),
		onSuccess: (r) =>
			applyReviewFeedback(describeReviewSuccess("reject", r)),
		onError: (e) => applyReviewFeedback(describeReviewFailure("reject", e)),
	});
	// AC3: no second decision can be submitted while one is in flight. Both
	// mutations gate every review control, not just their own — clicking Approve
	// and then Reject on the same draft raced the two decisions against each
	// other, which is the other way this panel produced the conflict banner.
	const reviewInFlight = approveSend.isPending || rejectSend.isPending;
	const repoIntegrationsQuery = useQuery(
		orpc.projects.repositoryIntegrations.list.queryOptions({
			input: { projectId, organizationId: orgId },
		}),
	);
	const reposExpired = hasExpiredRepoIntegrations(
		repoIntegrationsQuery.data?.integrations ?? [],
	);

	// Delivery destination — read directly off the raw query data (rather than
	// the `s` alias derived further down) so these two queries stay grouped
	// with every other `useQuery` call in this component instead of being
	// called conditionally deep in the render body.
	const deliveryDestination = (settingsQuery.data?.settings
		?.deliveryDestination ?? "EMAIL") as "EMAIL" | "CHAT" | "BOTH";
	const chatSelected =
		deliveryDestination === "CHAT" || deliveryDestination === "BOTH";
	// Read directly off the raw query data for the same reason as
	// `deliveryDestination` above: `requireApproval` (the alias further down,
	// derived from `s`) isn't declared until later in the component, and this
	// value is needed here, ahead of it.
	const requireApprovalSetting =
		settingsQuery.data?.settings?.requireApproval ?? false;
	// The alert picker also needs the linked-channel lists, and a review-gated
	// project may deliver by email — so fetch when EITHER surface wants them.
	const needsLinkedChannels = chatSelected || requireApprovalSetting;
	// Only fetch the connected-channel lists once something on the page wants
	// them — most projects never touch either surface, so skip the two extra
	// requests otherwise.
	const teamsLinkedQuery = useQuery(
		orpc.projects.teamsChannelMonitor.listLinkedChannels.queryOptions({
			input: { projectId, organizationId: orgId },
			enabled: needsLinkedChannels,
		}),
	);
	const slackLinkedQuery = useQuery(
		orpc.projects.slackChannelMonitor.listLinkedChannels.queryOptions({
			input: { projectId, organizationId: orgId },
			enabled: needsLinkedChannels,
		}),
	);
	const linkedChatChannels: NewsletterChatChannel[] = [
		...(teamsLinkedQuery.data ?? []).map((c) => ({
			platform: "TEAMS" as const,
			teamId: c.teamId,
			channelId: c.channelId,
			channelName: c.channelName ?? undefined,
		})),
		...(slackLinkedQuery.data ?? []).map((c) => ({
			platform: "SLACK" as const,
			teamId: c.slackTeamId,
			channelId: c.channelId,
			channelName: c.channelName ?? undefined,
		})),
	];
	const linkedChatChannelsLoaded =
		!teamsLinkedQuery.isLoading && !slackLinkedQuery.isLoading;
	// Both chat-channel pickers below (review alerts, and newsletter delivery)
	// branch on this to choose between a list and an empty state, and both now
	// also render the connect affordance outside that choice.
	const hasLinkedChatChannels = linkedChatChannels.length > 0;

	const invalidate = (key: "settings" | "subscribers" | "sends") => {
		if (key === "sends") {
			return queryClient.invalidateQueries({
				predicate: (q) =>
					isSendsListKeyForProject(q.queryKey, {
						projectId,
						organizationId: orgId,
					}),
			});
		}
		return queryClient.invalidateQueries({
			queryKey:
				key === "settings"
					? orpc.newsletter.settings.get.queryKey({
							input: { projectId, organizationId: orgId },
						})
					: orpc.newsletter.subscribers.list.queryKey({
							input: { projectId, organizationId: orgId },
						}),
		});
	};

	const updateSettings = useMutation(
		orpc.newsletter.settings.update.mutationOptions({
			onSuccess: (_data, variables) => {
				toast.success("Newsletter settings saved");
				invalidate("settings");
				// Enabling the newsletter backfills current project members as
				// ACTIVE subscribers server-side; refresh the list so they show up
				// immediately instead of only after react-query's next refetch.
				if (variables.enabled === true) {
					invalidate("subscribers");
				}
			},
			onError: (e) => toast.error(`Failed to save: ${e.message}`),
		}),
	);

	// Dedicated update mutation for the "Save appearance" action so it can show the
	// embed-specific localized toast (newsletter.embed.saved) instead of the shared
	// generic "settings saved" copy, without affecting the other update call sites.
	const saveAppearanceMutation = useMutation(
		orpc.newsletter.settings.update.mutationOptions({
			onSuccess: () => {
				toast.success(tEmbed("saved"));
				invalidate("settings");
			},
			onError: (e) => toast.error(`Failed to save: ${e.message}`),
		}),
	);

	// Rotating the embed token breaks every previously-pasted snippet; on success
	// we invalidate the settings query so the section re-renders with the new
	// token (and the snippet block rebuilds against it).
	const regenerateToken = useMutation(
		orpc.newsletter.settings.regenerateEmbedToken.mutationOptions({
			onSuccess: () => {
				toast.success(tEmbed("regenerated"));
				invalidate("settings");
			},
			onError: (e) =>
				toast.error(`${tEmbed("regenerateError")}: ${e.message}`),
		}),
	);

	const [emailsText, setEmailsText] = useState("");
	const addSubscribers = useMutation({
		mutationFn: async () => {
			const emails = emailsText
				.split(/[\s,;]+/)
				.map((e) => e.trim())
				.filter(Boolean);
			return orpcClient.newsletter.subscribers.add({
				projectId,
				organizationId: orgId,
				emails,
			});
		},
		onSuccess: (r) => {
			setEmailsText("");
			setActiveSubscriberPage(1);
			toast.success(
				r.added === 1
					? "1 subscriber added"
					: `${r.added} subscribers added`,
			);
			invalidate("subscribers");
		},
		onError: (e) => toast.error(`Failed to add: ${e.message}`),
	});

	const removeSubscriber = useMutation({
		mutationFn: async (id: string) =>
			orpcClient.newsletter.subscribers.remove({
				projectId,
				organizationId: orgId,
				id,
			}),
		onSuccess: () => invalidate("subscribers"),
		onError: (e) => toast.error(`Failed to remove: ${e.message}`),
	});

	const sendNow = useMutation({
		mutationFn: async (detailLevel: "BRIEF" | "STANDARD" | "DETAILED") =>
			orpcClient.newsletter.sends.sendNow({
				projectId,
				organizationId: orgId,
				detailLevel,
			}),
		onSuccess: (r) => {
			toast.success(
				r.inFlight
					? "A send is already in progress"
					: "Newsletter send started",
			);
			setSendStatus("all");
			setPage(0);
			invalidate("sends");
		},
		onError: (e) => toast.error(`Failed to send: ${e.message}`),
	});

	const s = settingsQuery.data?.settings;
	const subscribers = subscribersQuery.data?.subscribers ?? [];
	// Soft-deleted/unsubscribed members persist as rows; hide them from the
	// default admin list (Q8) but keep them viewable behind a reveal toggle.
	const activeSubscribers = subscribers.filter(
		(sub) => sub.status === "ACTIVE",
	);
	const unsubscribedSubscribers = subscribers.filter(
		(sub) => sub.status !== "ACTIVE",
	);
	const unsubscribedCount = unsubscribedSubscribers.length;
	// Client-side pagination over the already-fetched lists so a large member
	// roster doesn't render as one unbounded scroll. Active and unsubscribed page
	// independently. The page is derived-clamped: a concurrent removal that
	// shrinks a list snaps the view back into range without a corrective effect.
	const activeSubscriberPageCount = Math.max(
		1,
		Math.ceil(activeSubscribers.length / SUBSCRIBERS_PAGE_SIZE),
	);
	const currentActiveSubscriberPage = Math.min(
		activeSubscriberPage,
		activeSubscriberPageCount,
	);
	const pagedActiveSubscribers = activeSubscribers.slice(
		(currentActiveSubscriberPage - 1) * SUBSCRIBERS_PAGE_SIZE,
		currentActiveSubscriberPage * SUBSCRIBERS_PAGE_SIZE,
	);
	const unsubscribedSubscriberPageCount = Math.max(
		1,
		Math.ceil(unsubscribedSubscribers.length / SUBSCRIBERS_PAGE_SIZE),
	);
	const currentUnsubscribedSubscriberPage = Math.min(
		unsubscribedSubscriberPage,
		unsubscribedSubscriberPageCount,
	);
	const pagedUnsubscribedSubscribers = unsubscribedSubscribers.slice(
		(currentUnsubscribedSubscriberPage - 1) * SUBSCRIBERS_PAGE_SIZE,
		currentUnsubscribedSubscriberPage * SUBSCRIBERS_PAGE_SIZE,
	);
	const sends = sendsQuery.data?.sends ?? [];
	// Collapse the chat-detail panel as soon as its row leaves the rendered page
	// — a filter switch, a page change, or a refetch that drops it. Covering it
	// here rather than at each setPage/setSendStatus call site catches every
	// case: otherwise the lazily-enabled query stays `enabled` for an off-screen
	// send and keeps refetching on focus/reconnect, and paging back silently
	// reopens a panel the user never reopened.
	useEffect(() => {
		if (expandedSendId && !sends.some((s) => s.id === expandedSendId)) {
			setExpandedSendId(null);
		}
	}, [sends, expandedSendId]);
	const sendsTotal = sendsQuery.data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(sendsTotal / pageSize));

	// Clamp the current page when a concurrent deletion reduces the page count
	// and leaves the user on an out-of-range page (the empty state would render
	// with no pagination controls, stranding the user).
	useEffect(() => {
		if (page > 0 && page >= pageCount) {
			setPage(Math.max(0, pageCount - 1));
		}
	}, [page, pageCount]);

	// While settings are loading we render disabled controls with defaults so
	// the form never flashes empty. `s` resolves to the persisted row or the
	// server-side defaults (disabled, WEEKLY, Monday, 09:00 UTC).
	const enabled = s?.enabled ?? false;
	const requireApproval = s?.requireApproval ?? false;
	const cadence = (s?.cadence ?? "WEEKLY") as "WEEKLY" | "MONTHLY";
	const dayOfWeek = s?.dayOfWeek ?? 1;
	const dayOfMonth = s?.dayOfMonth ?? 1;
	const sendHourUtc = s?.sendHourUtc ?? 9;
	const lookbackDays = s?.lookbackDays ?? null;
	const lookbackPlaceholder = cadence === "MONTHLY" ? "30" : "7";
	const detailLevel = (s?.detailLevel ?? "STANDARD") as
		| "BRIEF"
		| "STANDARD"
		| "DETAILED";
	const settingsDisabled =
		canEdit === false ||
		settingsQuery.isLoading ||
		updateSettings.isPending;

	// Persisted chat delivery targets (F3 re-validates these server-side against
	// the live linked-channel set on every save, so a stale entry here is
	// harmless — it just won't render as checked until the next settings fetch).
	const selectedChatChannels = (s?.chatChannels ??
		[]) as NewsletterChatChannel[];

	const toggleChatChannel = (channel: NewsletterChatChannel) => {
		const targetKey = chatChannelKey(channel);
		const isSelected = selectedChatChannels.some(
			(c) => chatChannelKey(c) === targetKey,
		);
		const next = isSelected
			? selectedChatChannels.filter(
					(c) => chatChannelKey(c) !== targetKey,
				)
			: [...selectedChatChannels, channel];
		updateSettings.mutate({
			projectId,
			organizationId: orgId,
			chatChannels: next,
		});
	};

	// Same cast idiom and the same type the audience list already uses above
	// (`NewsletterChatChannel`) — the two lists are structurally identical on
	// the wire, but kept independent so ticking one never rewrites the other.
	const selectedApprovalChatChannels = (s?.approvalChatChannels ??
		[]) as NewsletterChatChannel[];

	const toggleApprovalChatChannel = (channel: NewsletterChatChannel) => {
		const targetKey = chatChannelKey(channel);
		const isSelected = selectedApprovalChatChannels.some(
			(c) => chatChannelKey(c) === targetKey,
		);
		const next = isSelected
			? selectedApprovalChatChannels.filter(
					(c) => chatChannelKey(c) !== targetKey,
				)
			: [...selectedApprovalChatChannels, channel];
		updateSettings.mutate({
			projectId,
			organizationId: orgId,
			approvalChatChannels: next,
		});
	};

	// Seed the Send-now override from the persisted setting once it loads,
	// without clobbering an in-progress edit on unrelated settings refetches.
	useEffect(() => {
		if (s?.detailLevel) {
			setSendNowDetailLevel(
				s.detailLevel as "BRIEF" | "STANDARD" | "DETAILED",
			);
		}
	}, [s?.detailLevel]);

	// ---- Embeddable widget ----
	const widgetEnabled = s?.publicWidgetEnabled ?? false;
	const embedToken = s?.publicEmbedToken ?? null;
	// The persisted widgetConfig is a free-form JSON record; read the four keys we
	// own off it defensively (a hand-edited / legacy row may omit them).
	const persistedConfig = (s?.publicWidgetConfig ?? null) as Record<
		string,
		unknown
	> | null;
	const [appearance, setAppearance] =
		useState<WidgetAppearance>(WIDGET_DEFAULTS);
	const [copiedSnippet, setCopiedSnippet] = useState(false);

	// Sync local appearance state whenever the persisted settings change (initial
	// load + after a save/regenerate invalidation). Keyed on the stored values so
	// a re-fetch with identical data does not clobber in-progress local edits.
	const storedTheme = s?.publicWidgetTheme ?? null;
	const storedAccent = s?.publicWidgetAccent ?? null;
	const cfgFont =
		typeof persistedConfig?.font === "string" ? persistedConfig.font : null;
	const cfgRadius =
		typeof persistedConfig?.radius === "number"
			? persistedConfig.radius
			: null;
	const cfgWidth =
		typeof persistedConfig?.width === "string"
			? persistedConfig.width
			: null;
	const cfgDensity =
		typeof persistedConfig?.density === "string"
			? persistedConfig.density
			: null;
	useEffect(() => {
		setAppearance({
			theme: (WIDGET_THEME_OPTIONS as readonly string[]).includes(
				storedTheme ?? "",
			)
				? (storedTheme as WidgetAppearance["theme"])
				: WIDGET_DEFAULTS.theme,
			accent: storedAccent ?? WIDGET_DEFAULTS.accent,
			font: (WIDGET_FONT_OPTIONS as readonly string[]).includes(
				cfgFont ?? "",
			)
				? (cfgFont as WidgetAppearance["font"])
				: WIDGET_DEFAULTS.font,
			radius: cfgRadius ?? WIDGET_DEFAULTS.radius,
			width: cfgWidth ?? WIDGET_DEFAULTS.width,
			density: (WIDGET_DENSITY_OPTIONS as readonly string[]).includes(
				cfgDensity ?? "",
			)
				? (cfgDensity as WidgetAppearance["density"])
				: WIDGET_DEFAULTS.density,
		});
	}, [storedTheme, storedAccent, cfgFont, cfgRadius, cfgWidth, cfgDensity]);

	const snippet = embedToken
		? buildReleaseWidgetSnippet(getBaseUrl(), {
				token: embedToken,
				theme: appearance.theme,
				accent: appearance.accent,
				font: appearance.font,
				radius: appearance.radius,
				width: appearance.width,
				density: appearance.density,
			})
		: "";

	const copySnippet = async () => {
		if (!snippet) {
			return;
		}
		try {
			await navigator.clipboard.writeText(snippet);
			setCopiedSnippet(true);
			setTimeout(() => setCopiedSnippet(false), 2000);
		} catch {
			// Clipboard unavailable (e.g. insecure context) — no-op.
		}
	};

	// Mirrors the server-side accent allowlist (#RGB / #RRGGBB). Surfaced inline so
	// the owner gets feedback before the server silently drops an invalid value.
	const accentValid = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(
		appearance.accent,
	);

	const saveAppearance = () => {
		saveAppearanceMutation.mutate({
			projectId,
			organizationId: orgId,
			publicWidgetTheme: appearance.theme,
			publicWidgetAccent: appearance.accent,
			publicWidgetConfig: {
				font: appearance.font,
				radius: appearance.radius,
				width: appearance.width,
				density: appearance.density,
			},
		});
	};

	const trimmedEmailCount = emailsText
		.split(/[\s,;]+/)
		.map((e) => e.trim())
		.filter(Boolean).length;

	// A failed settings read must not fall through to the form. Every field below
	// reads `settingsQuery.data?.settings` with a `??` default, so an error used
	// to render as a fully-populated panel saying the newsletter is off with no
	// subscribers — indistinguishable from a project that simply has not
	// configured one, and the reason a permissions bug went unnoticed until a
	// save failed. Show the failure instead of a confident wrong answer.
	if (settingsQuery.isError) {
		return (
			<Alert variant="error" role="alert">
				<AlertTriangleIcon />
				<AlertTitle>Newsletter settings could not be loaded</AlertTitle>
				<AlertDescription className="space-y-2">
					<p>
						The settings shown here would not reflect this project,
						so they are hidden. This is usually a temporary network
						problem; if it persists, you may not have access to this
						project&apos;s newsletter configuration.
					</p>
					<Button
						variant="outline"
						size="sm"
						onClick={() => settingsQuery.refetch()}
						disabled={settingsQuery.isFetching}
					>
						{settingsQuery.isFetching ? "Retrying…" : "Try again"}
					</Button>
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="space-y-6">
			{reposExpired ? (
				<Alert variant="warning" role="status">
					<AlertTriangleIcon />
					<AlertTitle>Repository credentials expired</AlertTitle>
					<AlertDescription className="space-y-2">
						<p>
							One or more connected repositories have expired
							credentials, so the newsletter can&apos;t detect new
							releases. Reconnect them to resume sending.
						</p>
						{onNavigateToRepositories ? (
							<Button
								variant="outline"
								size="sm"
								onClick={onNavigateToRepositories}
							>
								Reconnect repositories
							</Button>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}

			{/* Enable + cadence */}
			<Card className="bg-card p-6">
				<p className={sectionTitleClass}>Newsletter</p>
				<h3 className="mt-2 text-xl font-semibold text-foreground">
					External release notes
				</h3>
				<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
					Send AI-curated summaries of major user-facing features to
					external stakeholders, either manually or on a recurring
					schedule.
				</p>

				<div className="mt-5 space-y-5">
					<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4">
						<div className="min-w-0">
							<p className="font-medium text-foreground">
								Enable newsletter
							</p>
							<p className="break-words text-sm text-muted-foreground">
								When enabled, the newsletter is distributed on
								the configured cadence.
							</p>
						</div>
						<Switch
							checked={enabled}
							disabled={settingsDisabled}
							aria-label="Enable newsletter"
							onCheckedChange={(checked) =>
								updateSettings.mutate({
									projectId,
									organizationId: orgId,
									enabled: checked,
								})
							}
						/>
					</div>

					<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4">
						<div className="min-w-0">
							<p className="font-medium text-foreground">
								Require review before sending
							</p>
							<p className="break-words text-sm text-muted-foreground">
								Hold each newsletter for a project admin to
								review and approve before it's delivered.
							</p>
						</div>
						<Switch
							checked={requireApproval}
							disabled={settingsDisabled}
							aria-label="Require review before sending"
							onCheckedChange={(checked) =>
								updateSettings.mutate({
									projectId,
									organizationId: orgId,
									requireApproval: checked,
								})
							}
						/>
					</div>

					{requireApproval ? (
						<div className="space-y-2">
							<p className={sectionTitleClass}>
								Review alert channels
							</p>
							{/* This line said the opposite until the flag moved
							    to the registry with an ON default: the picker
							    shipped ahead of dispatch, so it warned that
							    ticking a channel was inert. Kept as it was, it
							    now understates the control in the more
							    dangerous direction — an admin ticks a channel
							    believing nothing happens, and the next held
							    newsletter posts into a team channel. Whichever
							    way it points, this sentence has to track
							    FABRIC_FEATURE_NEWSLETTER_APPROVAL_CHAT.

							    The email clause is hedged on purpose. The
							    reviewer email is conditional three ways —
							    unconfigured mail, an organization project with
							    no slug (no correct link exists), and the
							    per-recipient reviewEmails opt-out — so a flat
							    "and the reviewer email" would promise a
							    delivery this panel cannot make, which is the
							    same defect one paragraph up. Only the
							    precondition an admin can act on is named. */}
							<p className="text-xs text-muted-foreground">
								Each ticked channel receives the review alert as
								soon as a newsletter is held — a third route
								alongside the in-app notification and the
								reviewer email, which needs mail configured.
							</p>
							{hasLinkedChatChannels ? (
								<ul className="divide-y divide-border rounded-xl border border-border">
									{linkedChatChannels.map((channel) => {
										const key = chatChannelKey(channel);
										const checked =
											selectedApprovalChatChannels.some(
												(c) =>
													chatChannelKey(c) === key,
											);
										const label = `${channel.platform}: ${
											channel.channelName ??
											channel.channelId
										}`;
										// A channel in BOTH lists receives the
										// review alert AND the published notes.
										// That is supported: the contract
										// release that dropped the legacy
										// single-channel ledger index is what
										// lets the two coexist on one channel.
										// Before it, this overlap silently
										// broke publication, because the alert
										// claimed the slot first at hold time.
										// Still worth surfacing where the
										// choice is made — the two pickers are
										// ~350 lines apart and neither
										// otherwise mentions the other, so an
										// admin would not otherwise know this
										// channel carries both.
										//
										// `checked` is half the claim. Without
										// it the badge fires on a channel that
										// is only in the audience, where "also"
										// is false — it carries the notes and
										// nothing else — and it reads as though
										// the overlap were already in force
										// before anyone asked for it.
										const alsoInAudience =
											checked &&
											selectedChatChannels.some(
												(c) =>
													chatChannelKey(c) === key,
											);
										return (
											<li
												key={key}
												className="flex items-center gap-3 p-3"
											>
												<label
													htmlFor={`newsletter-approval-chat-channel-${key}`}
													className="flex flex-1 items-center gap-3 text-sm text-foreground"
												>
													<input
														id={`newsletter-approval-chat-channel-${key}`}
														type="checkbox"
														checked={checked}
														disabled={
															settingsDisabled
														}
														aria-label={label}
														onChange={() =>
															toggleApprovalChatChannel(
																channel,
															)
														}
													/>
													<span className="truncate">
														{label}
													</span>
												</label>
												{alsoInAudience ? (
													<span className="shrink-0 text-highlight text-xs">
														Also receives the
														published notes
													</span>
												) : null}
											</li>
										);
									})}
								</ul>
							) : linkedChatChannelsLoaded ? (
								<div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
									<p>
										<strong className="text-foreground">
											Connect a Teams or Slack channel
										</strong>{" "}
										to receive review alerts.
									</p>
									<ConnectChatChannelButton
										onNavigate={onNavigateToChatChannels}
										className="mt-3"
									/>
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									Loading connected channels…
								</p>
							)}
							{/* Outside the ternary above: a project that has
							    already linked a channel renders the list
							    branch, and would otherwise never see a way to
							    link another. */}
							{hasLinkedChatChannels ? (
								<ConnectChatChannelButton
									onNavigate={onNavigateToChatChannels}
								/>
							) : null}
						</div>
					) : null}

					<div className="grid gap-4 sm:grid-cols-2">
						{/* Cadence */}
						<div className="space-y-2">
							<Label htmlFor="newsletter-cadence">Cadence</Label>
							<Select
								value={cadence}
								disabled={settingsDisabled}
								onValueChange={(value) =>
									updateSettings.mutate({
										projectId,
										organizationId: orgId,
										cadence: value as "WEEKLY" | "MONTHLY",
									})
								}
							>
								<SelectTrigger
									id="newsletter-cadence"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="WEEKLY">
										Weekly
									</SelectItem>
									<SelectItem value="MONTHLY">
										Monthly
									</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{/* Day control — weekly vs monthly */}
						{cadence === "WEEKLY" ? (
							<div className="space-y-2">
								<Label htmlFor="newsletter-day-of-week">
									Day of week
								</Label>
								<Select
									value={`${dayOfWeek}`}
									disabled={settingsDisabled}
									onValueChange={(value) =>
										updateSettings.mutate({
											projectId,
											organizationId: orgId,
											dayOfWeek: Number(value),
										})
									}
								>
									<SelectTrigger
										id="newsletter-day-of-week"
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{DAY_OF_WEEK_LABELS.map((d) => (
											<SelectItem
												key={d.value}
												value={d.value}
											>
												{d.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						) : (
							<div className="space-y-2">
								<Label htmlFor="newsletter-day-of-month">
									Day of month
								</Label>
								<Select
									value={`${dayOfMonth}`}
									disabled={settingsDisabled}
									onValueChange={(value) =>
										updateSettings.mutate({
											projectId,
											organizationId: orgId,
											dayOfMonth: Number(value),
										})
									}
								>
									<SelectTrigger
										id="newsletter-day-of-month"
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{DAY_OF_MONTH_OPTIONS.map((d) => (
											<SelectItem key={d} value={d}>
												{d}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						)}

						{/* Send hour (UTC) */}
						<div className="space-y-2">
							<Label htmlFor="newsletter-hour">
								Send hour (UTC)
							</Label>
							<Select
								value={`${sendHourUtc}`}
								disabled={settingsDisabled}
								onValueChange={(value) =>
									updateSettings.mutate({
										projectId,
										organizationId: orgId,
										sendHourUtc: Number(value),
									})
								}
							>
								<SelectTrigger
									id="newsletter-hour"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{HOUR_OPTIONS.map((h) => (
										<SelectItem key={h} value={h}>
											{formatHourUtc(Number(h))}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{/* Lookback window (days) */}
						<div className="space-y-2">
							<Label htmlFor="newsletter-lookback">
								Lookback window (days)
							</Label>
							<Input
								id="newsletter-lookback"
								type="number"
								min={1}
								max={365}
								inputMode="numeric"
								disabled={settingsDisabled}
								defaultValue={lookbackDays ?? ""}
								key={`lookback-${lookbackDays ?? "default"}`}
								placeholder={lookbackPlaceholder}
								onBlur={(e) => {
									const raw = e.target.value.trim();
									const next =
										raw === ""
											? null
											: Math.min(
													365,
													Math.max(
														1,
														Math.round(Number(raw)),
													),
												);
									if (
										raw !== "" &&
										Number.isNaN(Number(raw))
									) {
										return;
									}
									if (next === lookbackDays) {
										return;
									}
									updateSettings.mutate({
										projectId,
										organizationId: orgId,
										lookbackDays: next,
									});
								}}
							/>
							<p className="text-xs text-muted-foreground">
								Minimum days of history each send covers. Leave
								blank to send only what&apos;s new since the
								last send. A value larger than your cadence
								re-includes already-announced releases.
							</p>
						</div>

						{/* Detail level */}
						<div className="space-y-2">
							<Label htmlFor="newsletter-detail-level">
								Detail level
							</Label>
							<Select
								value={detailLevel}
								disabled={settingsDisabled}
								onValueChange={(value) =>
									updateSettings.mutate({
										projectId,
										organizationId: orgId,
										detailLevel: value as
											| "BRIEF"
											| "STANDARD"
											| "DETAILED",
									})
								}
							>
								<SelectTrigger
									id="newsletter-detail-level"
									aria-label="Detail level"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DETAIL_LEVEL_OPTIONS.map((d) => (
										<SelectItem
											key={d.value}
											value={d.value}
										>
											{d.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{
									DETAIL_LEVEL_OPTIONS.find(
										(d) => d.value === detailLevel,
									)?.hint
								}
							</p>
						</div>

						{/* Delivery destination */}
						<div className="space-y-2">
							<Label htmlFor="newsletter-delivery-destination">
								Delivery destination
							</Label>
							<Select
								value={deliveryDestination}
								disabled={settingsDisabled}
								onValueChange={(value) =>
									updateSettings.mutate({
										projectId,
										organizationId: orgId,
										deliveryDestination: value as
											| "EMAIL"
											| "CHAT"
											| "BOTH",
									})
								}
							>
								<SelectTrigger
									id="newsletter-delivery-destination"
									aria-label="Delivery destination"
									className="w-full"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{DELIVERY_DESTINATION_OPTIONS.map((d) => (
										<SelectItem
											key={d.value}
											value={d.value}
										>
											{d.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								{
									DELIVERY_DESTINATION_OPTIONS.find(
										(d) => d.value === deliveryDestination,
									)?.hint
								}
							</p>
						</div>
					</div>

					{chatSelected ? (
						<div className="mt-5 space-y-2">
							<p className={sectionTitleClass}>Chat channels</p>
							{hasLinkedChatChannels ? (
								<ul className="divide-y divide-border rounded-xl border border-border">
									{linkedChatChannels.map((channel) => {
										const key = chatChannelKey(channel);
										const checked =
											selectedChatChannels.some(
												(c) =>
													chatChannelKey(c) === key,
											);
										const label = `${channel.platform}: ${
											channel.channelName ??
											channel.channelId
										}`;
										return (
											<li
												key={key}
												className="flex items-center gap-3 p-3"
											>
												<label
													htmlFor={`newsletter-chat-channel-${key}`}
													className="flex flex-1 items-center gap-3 text-sm text-foreground"
												>
													<input
														id={`newsletter-chat-channel-${key}`}
														type="checkbox"
														checked={checked}
														disabled={
															settingsDisabled
														}
														aria-label={label}
														onChange={() =>
															toggleChatChannel(
																channel,
															)
														}
													/>
													<span className="truncate">
														{label}
													</span>
												</label>
											</li>
										);
									})}
								</ul>
							) : linkedChatChannelsLoaded ? (
								<div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
									<p>
										<strong className="text-foreground">
											Connect a Teams or Slack channel
										</strong>{" "}
										to deliver release notes to chat.
									</p>
									<ConnectChatChannelButton
										onNavigate={onNavigateToChatChannels}
										className="mt-3"
									/>
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									Loading connected channels…
								</p>
							)}
							{/* Outside the ternary above: a project that has
							    already linked a channel renders the list
							    branch, and would otherwise never see a way to
							    link another. */}
							{hasLinkedChatChannels ? (
								<ConnectChatChannelButton
									onNavigate={onNavigateToChatChannels}
								/>
							) : null}
						</div>
					) : null}
				</div>
			</Card>

			{/* Subscribers */}
			<Card className="bg-card p-6">
				<p className={sectionTitleClass}>Audience</p>
				<h3 className="mt-2 text-xl font-semibold text-foreground">
					Subscribers
				</h3>
				<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
					Add external email addresses. Paste multiple addresses
					separated by spaces, commas, or new lines.
				</p>

				<div className="mt-5 space-y-3">
					<div className="space-y-2">
						<Label htmlFor="newsletter-emails">
							Add subscribers
						</Label>
						<Textarea
							id="newsletter-emails"
							value={emailsText}
							onChange={(e) => setEmailsText(e.target.value)}
							placeholder="alice@example.com, bob@example.com"
							rows={3}
						/>
					</div>
					<div className="flex justify-end">
						<Button
							onClick={() => addSubscribers.mutate()}
							loading={addSubscribers.isPending}
							disabled={
								trimmedEmailCount === 0 ||
								addSubscribers.isPending
							}
						>
							Add
							{trimmedEmailCount > 0
								? ` ${trimmedEmailCount}`
								: ""}
						</Button>
					</div>
				</div>

				<div className="mt-5">
					{subscribersQuery.isLoading ? (
						<p className="text-sm text-muted-foreground">
							Loading subscribers…
						</p>
					) : activeSubscribers.length === 0 ? (
						<p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
							No active subscribers yet.
						</p>
					) : (
						<>
							<ul className="divide-y divide-border rounded-xl border border-border">
								{pagedActiveSubscribers.map((sub) => (
									<SubscriberRow
										key={sub.id}
										sub={sub}
										onRemove={(id) =>
											removeSubscriber.mutate(id)
										}
									/>
								))}
							</ul>
							{activeSubscribers.length >
								SUBSCRIBERS_PAGE_SIZE && (
								<Pagination
									className="mt-3"
									totalItems={activeSubscribers.length}
									itemsPerPage={SUBSCRIBERS_PAGE_SIZE}
									currentPage={currentActiveSubscriberPage}
									onChangeCurrentPage={
										setActiveSubscriberPage
									}
									previousLabel="Previous page, active subscribers"
									nextLabel="Next page, active subscribers"
								/>
							)}
						</>
					)}
					{unsubscribedCount > 0 && (
						<>
							<Button
								variant="link"
								size="sm"
								className="mt-2 px-0 text-muted-foreground"
								onClick={() => setShowUnsubscribed((v) => !v)}
								aria-expanded={showUnsubscribed}
								aria-controls="newsletter-unsubscribed-list"
							>
								{showUnsubscribed
									? "Hide unsubscribed"
									: `Show unsubscribed (${unsubscribedCount})`}
							</Button>
							{showUnsubscribed && (
								<div
									id="newsletter-unsubscribed-list"
									className="mt-3"
								>
									<p className={sectionTitleClass}>
										Unsubscribed
									</p>
									<ul className="mt-2 divide-y divide-border rounded-xl border border-border">
										{pagedUnsubscribedSubscribers.map(
											(sub) => (
												<SubscriberRow
													key={sub.id}
													sub={sub}
													onRemove={(id) =>
														removeSubscriber.mutate(
															id,
														)
													}
												/>
											),
										)}
									</ul>
									{unsubscribedSubscribers.length >
										SUBSCRIBERS_PAGE_SIZE && (
										<Pagination
											className="mt-3"
											totalItems={
												unsubscribedSubscribers.length
											}
											itemsPerPage={SUBSCRIBERS_PAGE_SIZE}
											currentPage={
												currentUnsubscribedSubscriberPage
											}
											onChangeCurrentPage={
												setUnsubscribedSubscriberPage
											}
											previousLabel="Previous page, unsubscribed subscribers"
											nextLabel="Next page, unsubscribed subscribers"
										/>
									)}
								</div>
							)}
						</>
					)}
				</div>
			</Card>

			{/* Send now + history */}
			<Card className="bg-card p-6">
				<p className={sectionTitleClass}>Distribution</p>
				<h3 className="mt-2 text-xl font-semibold text-foreground">
					Send &amp; history
				</h3>
				<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
					Manually trigger a send now, or review recent sends below.
				</p>

				<div className="mt-4">
					<AlertDialog>
						<AlertDialogTrigger asChild>
							<Button
								disabled={sendNow.isPending}
								autoLoading={false}
								loading={sendNow.isPending}
							>
								<SendIcon className="size-4" />
								Send now
							</Button>
						</AlertDialogTrigger>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									Send the newsletter now?
								</AlertDialogTitle>
								<AlertDialogDescription>
									This generates an AI-curated summary of
									major features shipped since the last send
									and emails every active subscriber. If no
									major features are found, nobody is emailed.
								</AlertDialogDescription>
							</AlertDialogHeader>
							<div className="space-y-2 py-2">
								<Label htmlFor="newsletter-send-now-detail-level">
									Detail level
								</Label>
								<Select
									value={sendNowDetailLevel}
									disabled={
										settingsQuery.isLoading ||
										sendNow.isPending
									}
									onValueChange={(value) =>
										setSendNowDetailLevel(
											value as
												| "BRIEF"
												| "STANDARD"
												| "DETAILED",
										)
									}
								>
									<SelectTrigger
										id="newsletter-send-now-detail-level"
										aria-label="Detail level"
										className="w-full"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{DETAIL_LEVEL_OPTIONS.map((d) => (
											<SelectItem
												key={d.value}
												value={d.value}
											>
												{d.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<p className="text-xs text-muted-foreground">
									{
										DETAIL_LEVEL_OPTIONS.find(
											(d) =>
												d.value === sendNowDetailLevel,
										)?.hint
									}
								</p>
							</div>
							<AlertDialogFooter>
								<AlertDialogCancel>Cancel</AlertDialogCancel>
								<AlertDialogAction
									onClick={() =>
										sendNow.mutate(sendNowDetailLevel)
									}
								>
									Send now
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</div>

				<div className="mt-4 flex flex-wrap gap-2">
					{SEND_FILTERS.map((f) => (
						<Button
							key={f.key}
							type="button"
							size="sm"
							variant={
								sendStatus === f.key ? "primary" : "outline"
							}
							onClick={() => {
								setSendStatus(f.key);
								setPage(0);
							}}
						>
							{f.label}
						</Button>
					))}
				</div>

				{pendingQuery.data?.sends?.length ? (
					<div className="mt-5 mb-6 space-y-4">
						<p
							className="font-medium text-foreground"
							role="status"
						>
							Awaiting review
						</p>
						{pendingQuery.data.sends.map((p) => {
							const content =
								(p.content as {
									headline?: string;
									intro?: string;
									highlights?: {
										title: string;
										description: string;
									}[];
								} | null) ?? null;
							const removed =
								removedBySend[p.id] ?? new Set<number>();
							const toggle = (i: number) =>
								setRemovedBySend((prev) => {
									const next = new Set(prev[p.id] ?? []);
									if (next.has(i)) {
										next.delete(i);
									} else {
										next.add(i);
									}
									return { ...prev, [p.id]: next };
								});
							return (
								<div
									key={p.id}
									className="rounded-xl border border-border p-4"
								>
									<p className="font-medium text-foreground">
										{content?.headline ?? "Release notes"}
									</p>
									{content?.intro ? (
										<p className="mt-1 text-sm text-muted-foreground">
											{content.intro}
										</p>
									) : null}
									{p.status === "APPROVED" ? (
										// In-flight / recovery: an approved send that
										// is delivering (or was stranded by a start
										// failure). Offer an idempotent re-kick.
										<div className="mt-3 flex items-center gap-3">
											<span className="text-sm text-muted-foreground">
												Sending…
											</span>
											<Button
												size="sm"
												variant="outline"
												disabled={reviewInFlight}
												onClick={() =>
													approveSend.mutate({
														sendId: p.id,
														removed: [],
													})
												}
											>
												Retry send
											</Button>
										</div>
									) : (
										<>
											<p className="mt-3 text-muted-foreground text-xs">
												Unchecking an item leaves it out
												of this issue only — nothing is
												deleted.
											</p>
											<ul className="mt-2 space-y-2">
												{(
													content?.highlights ?? []
												).map((h, i) => (
													<NewsletterReviewHighlight
														key={`${p.id}-${i}`}
														title={h.title}
														description={
															h.description
														}
														excluded={removed.has(
															i,
														)}
														onToggle={() =>
															toggle(i)
														}
													/>
												))}
											</ul>
											<div className="mt-4 flex gap-2">
												<Button
													size="sm"
													variant="primary"
													disabled={reviewInFlight}
													onClick={() =>
														approveSend.mutate({
															sendId: p.id,
															removed:
																Array.from(
																	removed,
																),
														})
													}
												>
													Approve &amp; send
												</Button>
												<Button
													size="sm"
													variant="outline"
													disabled={reviewInFlight}
													onClick={() =>
														rejectSend.mutate(p.id)
													}
												>
													Reject
												</Button>
											</div>
										</>
									)}
								</div>
							);
						})}
					</div>
				) : null}

				<div className="mt-5">
					{sendsQuery.isLoading ? (
						<p className="text-sm text-muted-foreground">
							Loading send history…
						</p>
					) : sends.length === 0 ? (
						<p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
							{sendStatus === "all"
								? "No sends yet."
								: `No ${sendStatus} sends.`}
						</p>
					) : (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Date</TableHead>
										<TableHead>Trigger</TableHead>
										<TableHead>Status</TableHead>
										<TableHead className="text-right">
											{/* Unit-neutral label: recipientCount/sentCount now
											combine email recipients AND chat-channel targets
											(spec 1734), so "Recipients" would misread a channel
											count as a people count for CHAT/BOTH sends. */}
											Delivered
										</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{sends.map((send) => {
										const statusInfo =
											formatNewsletterSendStatus(
												send.status,
												send.skipReason,
												send.requireApproval,
											);
										// A review-gated send can carry APPROVAL delivery rows
										// even when the notes themselves go out by email — that
										// is the normal case for this feature, so the disclosure
										// must open for it too (Fizzy #2203).
										const hasChat =
											send.deliveryDestination ===
												"CHAT" ||
											send.deliveryDestination ===
												"BOTH" ||
											send.requireApproval;
										const isExpanded =
											expandedSendId === send.id;
										return (
											<Fragment key={send.id}>
												<TableRow>
													<TableCell className="whitespace-nowrap text-foreground">
														{formatDateTime(
															send.createdAt,
														)}
													</TableCell>
													<TableCell className="text-muted-foreground">
														{send.trigger ===
														"MANUAL"
															? "Manual"
															: "Scheduled"}
													</TableCell>
													<TableCell>
														<Badge
															status={
																statusInfo.variant
															}
														>
															{statusInfo.label}
														</Badge>
													</TableCell>
													<TableCell className="text-right tabular-nums text-muted-foreground">
														{send.sentCount}/
														{send.recipientCount}
														{send.failedCount >
														0 ? (
															<span className="ml-1 text-destructive">
																(
																{
																	send.failedCount
																}{" "}
																failed)
															</span>
														) : null}
														{hasChat ? (
															<button
																type="button"
																aria-expanded={
																	isExpanded
																}
																aria-controls={`chat-delivery-detail-${send.id}`}
																// WCAG 2.5.3 Label in Name: the accessible name must
																// contain the VISIBLE label so a speech-input user
																// saying "click Channels" can activate the control.
																// "Show chat channel delivery detail" does not
																// contain "Channels" and fails that.
																aria-label={`${isExpanded ? "Hide channels" : "Channels"} — chat delivery detail for this send`}
																className="ml-2 underline underline-offset-2 hover:text-foreground"
																onClick={() =>
																	setExpandedSendId(
																		isExpanded
																			? null
																			: send.id,
																	)
																}
															>
																{isExpanded
																	? "Hide channels"
																	: "Channels"}
															</button>
														) : null}
													</TableCell>
												</TableRow>
												{isExpanded ? (
													<TableRow
														id={`chat-delivery-detail-${send.id}`}
													>
														<TableCell
															colSpan={4}
															className="bg-muted/40"
														>
															{chatDeliveriesQuery.isLoading ? (
																<p className="text-sm text-muted-foreground">
																	Loading
																	channel
																	detail…
																</p>
															) : chatDeliveriesQuery.isError ? (
																/* An errored query has undefined
																   data. Without this branch it
																   would fall through to the empty
																   state and claim no channels were
																   targeted — hiding exactly the
																   kind of failure this panel
																   exists to surface. */
																<div className="flex flex-wrap items-center gap-2 text-sm">
																	<span className="text-destructive">
																		Could
																		not load
																		channel
																		detail.
																	</span>
																	<button
																		type="button"
																		className="underline underline-offset-2 hover:text-foreground"
																		onClick={() =>
																			chatDeliveriesQuery.refetch()
																		}
																	>
																		Retry
																	</button>
																</div>
															) : (chatDeliveriesQuery
																	.data
																	?.deliveries
																	?.length ??
																	0) === 0 ? (
																<p className="text-sm text-muted-foreground">
																	No chat
																	channels
																	were
																	targeted for
																	this send.
																</p>
															) : (
																<ul className="space-y-2">
																	{chatDeliveriesQuery.data?.deliveries.map(
																		(d) => {
																			const ds =
																				formatChatDeliveryStatus(
																					d.status,
																				);
																			return (
																				<li
																					// kind is part of the identity, not decoration: one send can
																					// hold an APPROVAL row and a CONTENT row for the same channel
																					// (alert first, then the approved notes), and duplicate React
																					// keys let reconciliation drop or misassociate a row. The team
																					// id is also part of the key — a channel id is unique only
																					// WITHIN a workspace/team, so two connected workspaces can
																					// surface the same channel id.
																					key={`${d.kind}-${d.platform}-${d.externalTeamId}-${d.channelId}`}
																					className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm"
																				>
																					<span className="font-medium text-foreground">
																						{d.platform ===
																						"SLACK"
																							? "Slack"
																							: "Teams"}
																						{
																							" · "
																						}
																						{
																							d.channelName
																						}
																					</span>
																					<span className="text-muted-foreground">
																						{d.kind ===
																						"APPROVAL"
																							? "Review alert"
																							: "Release notes"}
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
							<div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
								<div className="flex items-center gap-2">
									<span>Rows</span>
									<select
										aria-label="Rows per page"
										className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
										value={pageSize}
										onChange={(e) => {
											setPageSize(
												Number(
													e.target.value,
												) as (typeof PAGE_SIZES)[number],
											);
											setPage(0);
										}}
									>
										{PAGE_SIZES.map((n) => (
											<option key={n} value={n}>
												{n}
											</option>
										))}
									</select>
									<span className="tabular-nums">
										{sendsTotal === 0
											? "0 of 0"
											: `${page * pageSize + 1}–${Math.min(
													(page + 1) * pageSize,
													sendsTotal,
												)} of ${sendsTotal}`}
									</span>
								</div>
								<div className="flex items-center gap-2">
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={page === 0}
										onClick={() =>
											setPage((p) => Math.max(0, p - 1))
										}
										aria-label="Previous page"
									>
										Prev
									</Button>
									<span className="tabular-nums">
										Page {page + 1} of {pageCount}
									</span>
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={page + 1 >= pageCount}
										onClick={() =>
											setPage((p) =>
												Math.min(pageCount - 1, p + 1),
											)
										}
										aria-label="Next page"
									>
										Next
									</Button>
								</div>
							</div>
						</>
					)}
				</div>
			</Card>

			{/* Embed on your site */}
			<Card className="bg-card p-6">
				<p className={sectionTitleClass}>{tEmbed("widgetLabel")}</p>
				<h3 className="mt-2 text-xl font-semibold text-foreground">
					{tEmbed("widgetHeading")}
				</h3>
				<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
					{tEmbed("widgetDescription")}
				</p>

				<div className="mt-5 space-y-5">
					<div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border p-4">
						<div className="min-w-0">
							<p className="font-medium text-foreground">
								{tEmbed("enableLabel")}
							</p>
							<p className="break-words text-sm text-muted-foreground">
								{tEmbed("enableDescription")}
							</p>
						</div>
						<Switch
							checked={widgetEnabled}
							disabled={settingsDisabled}
							aria-label={tEmbed("enableLabel")}
							onCheckedChange={(checked) =>
								updateSettings.mutate({
									projectId,
									organizationId: orgId,
									publicWidgetEnabled: checked,
								})
							}
						/>
					</div>

					{widgetEnabled && embedToken ? (
						<>
							<div className="grid gap-4 sm:grid-cols-2">
								{/* Theme */}
								<div className="space-y-2">
									<Label htmlFor="widget-theme">
										{tEmbed("themeLabel")}
									</Label>
									<Select
										value={appearance.theme}
										onValueChange={(value) =>
											setAppearance((a) => ({
												...a,
												theme: value as WidgetAppearance["theme"],
											}))
										}
									>
										<SelectTrigger
											id="widget-theme"
											className="w-full"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{WIDGET_THEME_OPTIONS.map((opt) => (
												<SelectItem
													key={opt}
													value={opt}
												>
													{tEmbed(`theme_${opt}`)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* Accent color */}
								<div className="space-y-2">
									<Label htmlFor="widget-accent">
										{tEmbed("accentLabel")}
									</Label>
									<div className="flex items-center gap-2">
										<Input
											id="widget-accent"
											type="color"
											className="h-9 w-14 cursor-pointer p-1"
											value={appearance.accent}
											onChange={(e) =>
												setAppearance((a) => ({
													...a,
													accent: e.target.value,
												}))
											}
										/>
										<Input
											type="text"
											inputMode="text"
											aria-label={tEmbed(
												"accentHexLabel",
											)}
											aria-invalid={!accentValid}
											aria-describedby={
												!accentValid
													? "embed-accent-error"
													: undefined
											}
											className="font-mono"
											value={appearance.accent}
											onChange={(e) =>
												setAppearance((a) => ({
													...a,
													accent: e.target.value,
												}))
											}
											placeholder={WIDGET_DEFAULTS.accent}
										/>
									</div>
									{!accentValid ? (
										<p
											id="embed-accent-error"
											className="text-xs text-destructive"
										>
											{tEmbed("accentInvalid")}
										</p>
									) : null}
								</div>

								{/* Font */}
								<div className="space-y-2">
									<Label htmlFor="widget-font">
										{tEmbed("fontLabel")}
									</Label>
									<Select
										value={appearance.font}
										onValueChange={(value) =>
											setAppearance((a) => ({
												...a,
												font: value as WidgetAppearance["font"],
											}))
										}
									>
										<SelectTrigger
											id="widget-font"
											className="w-full"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{WIDGET_FONT_OPTIONS.map((opt) => (
												<SelectItem
													key={opt}
													value={opt}
												>
													{tEmbed(`font_${opt}`)}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>

								{/* Density */}
								<div className="space-y-2">
									<Label htmlFor="widget-density">
										{tEmbed("densityLabel")}
									</Label>
									<Select
										value={appearance.density}
										onValueChange={(value) =>
											setAppearance((a) => ({
												...a,
												density:
													value as WidgetAppearance["density"],
											}))
										}
									>
										<SelectTrigger
											id="widget-density"
											className="w-full"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{WIDGET_DENSITY_OPTIONS.map(
												(opt) => (
													<SelectItem
														key={opt}
														value={opt}
													>
														{tEmbed(
															`density_${opt}`,
														)}
													</SelectItem>
												),
											)}
										</SelectContent>
									</Select>
								</div>

								{/* Corner radius */}
								<div className="space-y-2">
									<Label htmlFor="widget-radius">
										{tEmbed("radiusLabel")}
									</Label>
									<Input
										id="widget-radius"
										type="number"
										min={0}
										max={24}
										inputMode="numeric"
										value={appearance.radius}
										onChange={(e) => {
											const raw = e.target.value.trim();
											if (raw === "") {
												return;
											}
											const next = Math.min(
												24,
												Math.max(
													0,
													Math.round(Number(raw)),
												),
											);
											if (Number.isNaN(next)) {
												return;
											}
											setAppearance((a) => ({
												...a,
												radius: next,
											}));
										}}
									/>
								</div>

								{/* Width */}
								<div className="space-y-2">
									<Label htmlFor="widget-width">
										{tEmbed("widthLabel")}
									</Label>
									<Input
										id="widget-width"
										type="text"
										inputMode="numeric"
										value={appearance.width}
										onChange={(e) =>
											setAppearance((a) => ({
												...a,
												width: e.target.value.trim(),
											}))
										}
										placeholder={WIDGET_DEFAULTS.width}
									/>
									<p className="text-xs text-muted-foreground">
										{tEmbed("widthHint")}
									</p>
								</div>
							</div>

							<div className="flex justify-end">
								<Button
									onClick={saveAppearance}
									loading={saveAppearanceMutation.isPending}
									disabled={saveAppearanceMutation.isPending}
								>
									{tEmbed("save")}
								</Button>
							</div>

							{/* Snippet */}
							<div className="space-y-2">
								<Label htmlFor="widget-snippet">
									{tEmbed("snippetLabel")}
								</Label>
								<div className="relative">
									<pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 pr-24 text-xs">
										<code id="widget-snippet">
											{snippet}
										</code>
									</pre>
									<Button
										type="button"
										onClick={copySnippet}
										variant="outline"
										size="sm"
										aria-label={
											copiedSnippet
												? tEmbed("copied")
												: tEmbed("copy")
										}
										className="absolute right-2 top-2 gap-1"
									>
										{copiedSnippet ? (
											<CheckIcon className="size-3" />
										) : (
											<CopyIcon className="size-3" />
										)}
										{copiedSnippet
											? tEmbed("copied")
											: tEmbed("copy")}
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">
									{tEmbed("instructions")}
								</p>
							</div>

							{/* Regenerate token */}
							<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-4">
								<div className="min-w-0">
									<p className="font-medium text-foreground">
										{tEmbed("regenerateLabel")}
									</p>
									<p className="break-words text-sm text-muted-foreground">
										{tEmbed("regenerateDescription")}
									</p>
								</div>
								<AlertDialog>
									<AlertDialogTrigger asChild>
										<Button
											variant="outline"
											disabled={regenerateToken.isPending}
											loading={regenerateToken.isPending}
										>
											<RefreshCwIcon className="size-4" />
											{tEmbed("regenerate")}
										</Button>
									</AlertDialogTrigger>
									<AlertDialogContent>
										<AlertDialogHeader>
											<AlertDialogTitle>
												{tEmbed(
													"regenerateConfirmTitle",
												)}
											</AlertDialogTitle>
											<AlertDialogDescription>
												{tEmbed(
													"regenerateConfirmBody",
												)}
											</AlertDialogDescription>
										</AlertDialogHeader>
										<AlertDialogFooter>
											<AlertDialogCancel>
												{tEmbed("cancel")}
											</AlertDialogCancel>
											<AlertDialogAction
												onClick={() =>
													regenerateToken.mutate({
														projectId,
														organizationId: orgId,
													})
												}
											>
												{tEmbed("regenerateConfirmCta")}
											</AlertDialogAction>
										</AlertDialogFooter>
									</AlertDialogContent>
								</AlertDialog>
							</div>
						</>
					) : (
						<p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
							{tEmbed("disabledHint")}
						</p>
					)}
				</div>
			</Card>
		</div>
	);
}
