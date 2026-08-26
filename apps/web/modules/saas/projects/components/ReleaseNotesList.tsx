"use client";

import type { NewsletterContent } from "@repo/database";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { formatNewsletterSendStatus } from "./newsletter-send-status";
import { ReleaseNoteDetailModal } from "./ReleaseNoteDetailModal";
import { navigateToProjectSettingsTab } from "./settings-tab-navigation";

type Props = {
	project: {
		id: string;
		organizationId?: string | null;
		userRole?: string | null;
		/** Resolved via the permission matrix (PROJECT_SETTINGS_EDIT) by projects.get —
		 *  covers org admins who hold the capability without an explicit project role. */
		canEditSettings?: boolean;
	};
};

// One Release Notes row. `content` is null for PENDING (being prepared) sends and
// non-null for SENT/PARTIAL — the server projects exactly { id, status, createdAt,
// content } (no internal fields).
type MemberSend = {
	id: string;
	status: string;
	createdAt: Date | string;
	content: NewsletterContent | null;
};

const PAGE_SIZES = [15, 50, 100] as const;

const sectionTitleClass =
	"text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground";

function formatDate(value: Date | string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return date.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function ReleaseNotesList({ project }: Props) {
	// The project's own org id is authoritative: for a personal project it is null,
	// and falling back to the active-org context id (when an org is selected) would
	// send the wrong tenant and make memberList 404 (mirrors ProjectNewsletterSettings).
	const orgId = project.organizationId ?? null;
	// Capability first (covers org admins without a project role), role as fallback.
	const canEdit =
		project.canEditSettings === true ||
		project.userRole === "owner" ||
		project.userRole === "project_admin";

	const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(15);
	const [page, setPage] = useState(0);
	const [selected, setSelected] = useState<MemberSend | null>(null);

	const { data, isLoading } = useQuery(
		orpc.newsletter.sends.memberList.queryOptions({
			input: {
				projectId: project.id,
				organizationId: orgId,
				limit: pageSize,
				offset: page * pageSize,
			},
		}),
	);

	const sends = (data?.sends ?? []) as MemberSend[];
	const total = data?.total ?? 0;
	const pageCount = Math.max(1, Math.ceil(total / pageSize));

	// Clamp the current page when a concurrent change reduces the page count and
	// leaves the user on an out-of-range page (mirrors ProjectNewsletterSettings).
	useEffect(() => {
		if (page > 0 && page >= pageCount) {
			setPage(Math.max(0, pageCount - 1));
		}
	}, [page, pageCount]);

	return (
		<div className="space-y-6">
			<Card
				data-onboarding-target="release-notes-panel"
				className="bg-card p-6"
			>
				<div className="flex items-start justify-between gap-3">
					<div>
						<p className={sectionTitleClass}>Newsletter</p>
						<div className="mt-2 flex items-center gap-1.5">
							<h2 className="font-serif text-2xl font-normal text-foreground">
								Release Notes
							</h2>
							<PageTourButton pageId="release-notes" />
						</div>
						<p className="mt-2 max-w-2xl text-sm text-muted-foreground">
							AI-curated summaries of the major features shipped
							in this project, newest first.
						</p>
					</div>
					{canEdit ? (
						<Button
							data-onboarding-target="release-notes-settings"
							variant="ghost"
							size="icon-sm"
							aria-label="Newsletter settings"
							onClick={() =>
								navigateToProjectSettingsTab(
									project.id,
									"newsletter",
								)
							}
						>
							<SettingsIcon className="size-4" />
						</Button>
					) : null}
				</div>

				<div className="mt-5">
					{isLoading ? (
						<p className="text-sm text-muted-foreground">
							Loading release notes…
						</p>
					) : sends.length === 0 ? (
						<p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
							No release notes yet.
						</p>
					) : (
						<ul className="space-y-3">
							{sends.map((send) => {
								// PENDING rows carry no content — render a muted,
								// non-clickable "being prepared" row.
								if (!send.content) {
									const statusInfo =
										formatNewsletterSendStatus(send.status);
									return (
										<li
											key={send.id}
											className="rounded-xl border border-dashed border-border bg-muted/40 p-4"
										>
											<p className="text-sm text-muted-foreground">
												A new update is being prepared…
											</p>
											<p className="mt-1 text-xs text-muted-foreground">
												{statusInfo.label} ·{" "}
												{formatDate(send.createdAt)}
											</p>
										</li>
									);
								}
								const content = send.content;
								return (
									<li key={send.id}>
										<button
											type="button"
											onClick={() => setSelected(send)}
											className="w-full rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-accent"
										>
											<p className="font-serif text-lg font-normal text-foreground">
												{content.headline}
											</p>
											<p className="mt-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">
												{formatDate(send.createdAt)}
											</p>
											{content.intro ? (
												<p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
													{content.intro}
												</p>
											) : null}
										</button>
									</li>
								);
							})}
						</ul>
					)}

					{total > 0 ? (
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
									{`${page * pageSize + 1}–${Math.min(
										(page + 1) * pageSize,
										total,
									)} of ${total}`}
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
					) : null}
				</div>
			</Card>

			<ReleaseNoteDetailModal
				open={selected !== null}
				onOpenChange={(open) => {
					if (!open) {
						setSelected(null);
					}
				}}
				content={selected?.content ?? null}
				dateLabel={
					selected ? formatDate(selected.createdAt) : undefined
				}
			/>
		</div>
	);
}
