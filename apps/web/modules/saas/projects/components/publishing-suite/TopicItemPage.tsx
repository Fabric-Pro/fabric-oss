"use client";

import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TopicDetails } from "./TopicDetails";
import { POST_TYPE_LABELS, TOPIC_STATUSES } from "./topic-shared";

/**
 * The three review tabs this page owns. Kept as a literal union rather than
 * derived from the array below so a typo in `setTab` is a compile error.
 */
type ReviewTab = "summaryQuestions" | "planningAnalysis" | "decisionLog";

const REVIEW_TABS: ReadonlyArray<{ value: ReviewTab; label: string }> = [
	{ value: "summaryQuestions", label: "Summary & Questions" },
	{ value: "planningAnalysis", label: "Planning & Analysis" },
	{ value: "decisionLog", label: "Decision Log" },
];

/**
 * Topic Item Page — review, planning and decision capture for ONE publishing
 * topic (Fizzy #1851, Phase 2A-1).
 *
 * Mirrors the Feature Item Page's UX — a default Summary & Questions tab, a
 * Decision Log, and a tab bar that later phases extend — deliberately WITHOUT
 * mirroring its file structure: `StoryWorkspace.tsx` is 8,485 lines, and
 * reproducing that shape here would trade a page nobody can hold in their head
 * for a superficial symmetry.
 *
 * This slice is the shell. Summary & Questions renders the topic's existing
 * AI-written summary (`pitch`, produced by Phase 1A); questions arrive in
 * 2A-3 and the planning worksheet in 2A-2.
 */
export function TopicItemPage({
	projectId,
	topicId,
	organizationId,
	canEdit,
}: {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
}) {
	const basePath = useBasePath();
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<ReviewTab>("summaryQuestions");

	const topicQuery = useQuery(
		orpc.projects.publishingSuite.getTopic.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
	);
	const topic = topicQuery.data?.topic;

	// 1D's FR4 makes expanding a row "opening" it, which writes the read
	// marker. Opening the whole page is the strongest form of opening there
	// is, so it must not be the one that does not count.
	//
	// The ref guard is load-bearing: `topic` is a fresh object on every
	// refetch, and the mutation's own `invalidateQueries` triggers one, so
	// without it a successful write re-enters this effect and writes again in
	// a loop.
	const markedRead = useRef(false);

	const setReadState = useMutation(
		orpc.projects.publishingSuite.setTopicReadState.mutationOptions({
			onSuccess: () => {
				// The Inbox's unread dot is rendered from the LIST query, not
				// this one, so marking read here has to invalidate that list or
				// the user returns to a row still showing as unread.
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.publishingSuite.listTopics.queryKey(
						{ input: { projectId, organizationId } },
					),
				});
			},
			onError: () => {
				// Same message the Inbox row shows for this exact write — the
				// marker is cosmetic, but failing it silently leaves the unread
				// dot stale with nothing to explain why.
				toast.error(
					"We couldn't update that topic's read state. Please try again.",
				);
				// Release the guard. It exists to stop a write LOOP, not to
				// make one failure permanent for the life of the mount: a
				// failed write does not invalidate the list, so `topic` keeps
				// its identity and this effect will not re-fire on its own —
				// only a genuine refetch (a refocus, or navigating back) gets
				// to try again.
				markedRead.current = false;
			},
		}),
	);
	useEffect(() => {
		if (!topic || topic.isRead || markedRead.current) {
			return;
		}
		markedRead.current = true;
		setReadState.mutate({
			projectId,
			topicId,
			organizationId,
			read: true,
		});
	}, [topic, projectId, topicId, organizationId, setReadState.mutate]);

	const backHref = `${basePath}/projects/${projectId}/publishing`;

	if (topicQuery.isPending) {
		return (
			<output
				className="flex h-64 items-center justify-center text-muted-foreground text-sm"
				aria-live="polite"
			>
				Loading topic…
			</output>
		);
	}

	if (topicQuery.isError || !topic) {
		// UC1 alternate flow. A topic in ANOTHER project produces the same
		// NOT_FOUND the API gives a missing one, so this state deliberately
		// cannot distinguish the two — saying "you lack access" would confirm
		// the topic exists.
		return (
			<div className="space-y-4 p-6">
				<BackLink href={backHref} />
				<h1 className="font-serif text-2xl">Topic not found</h1>
				<p className="text-muted-foreground text-sm">
					This topic may have been deleted, or it belongs to another
					project.
				</p>
			</div>
		);
	}

	const statusLabel =
		TOPIC_STATUSES.find((s) => s.value === topic.status)?.label ??
		topic.status;

	return (
		<div className="space-y-6 p-6">
			<div className="space-y-3">
				<BackLink href={backHref} />
				<p className="editorial-label">Publishing topic</p>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<h1 className="font-serif font-normal text-3xl leading-tight">
						{topic.title}
					</h1>
					<span
						className="shrink-0 rounded-full border border-border bg-muted px-3 py-1 text-muted-foreground text-xs"
						data-testid="topic-status"
					>
						{statusLabel}
					</span>
				</div>
				{topic.angle ? (
					<p className="text-muted-foreground text-sm">
						{topic.angle}
					</p>
				) : null}
				{topic.declineReason ? (
					<p className="border-destructive border-l-2 pl-3 text-muted-foreground text-sm">
						{topic.declineReason}
					</p>
				) : null}
			</div>

			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as ReviewTab)}
				className="space-y-4"
			>
				<TabsList aria-label="Topic review">
					{REVIEW_TABS.map((t) => (
						<TabsTrigger key={t.value} value={t.value}>
							{t.label}
						</TabsTrigger>
					))}
				</TabsList>

				<TabsContent value="summaryQuestions" className="space-y-6">
					{topic.pitch ? (
						<p className="max-w-3xl text-foreground text-sm leading-relaxed">
							{topic.pitch}
						</p>
					) : (
						<EmptyState>This topic has no summary yet.</EmptyState>
					)}
					{/* The metadata block is `TopicDetails`, the SAME component
					    the Inbox row mounts — not a copy of it. The two views
					    show the same fields, so a second implementation would
					    drift the first time either changed. */}
					<TopicDetails
						topic={topic}
						canEdit={canEdit}
						isPending={false}
						onEditUrl={() => undefined}
						onEditPostTypes={() => undefined}
					/>
					<EmptyState>
						Open questions arrive with the planning worksheet.
					</EmptyState>
				</TabsContent>

				<TabsContent value="planningAnalysis">
					<EmptyState>
						No planning analysis yet. Generating one is coming in
						the next release.
					</EmptyState>
				</TabsContent>

				<TabsContent value="decisionLog">
					<EmptyState>
						No decisions recorded for this topic yet.
					</EmptyState>
				</TabsContent>
			</Tabs>

			<GenerationTabsPlaceholder />
		</div>
	);
}

function BackLink({ href }: { href: string }) {
	return (
		<Link
			href={href}
			className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
		>
			<ArrowLeftIcon className="size-4" aria-hidden="true" />
			Back to Publishing Suite
		</Link>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}

/**
 * FR48–FR51: the shell for the content types later phases will generate.
 *
 * Driven off `POST_TYPE_LABELS` — the same fixed-order rendering of the
 * `PublishingTopicPostType` enum the Inbox row uses — so Phase 2B/2C activate
 * a tab by shipping its feature, with no edit to a second hand-maintained list
 * that could disagree with the enum (DV15).
 *
 * Every trigger is `disabled`. FR50 forbids exposing functional generation UI
 * in 2A, and a tab a user can activate is a promise this phase cannot keep.
 * The `Tabs` value matches no trigger, so no panel is selected.
 */
function GenerationTabsPlaceholder() {
	return (
		<div className="space-y-2">
			<p className="editorial-label">Content generation</p>
			<Tabs value="__none__">
				<TabsList
					aria-label="Content generation"
					className="flex-wrap opacity-70"
				>
					{POST_TYPE_LABELS.map((t) => (
						<TabsTrigger key={t.value} value={t.value} disabled>
							{t.label}
							<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
								Coming soon
							</span>
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
		</div>
	);
}
