"use client";

/**
 * Read-only dialog that lists prior `Send by email` actions for a single
 * report artifact. Opens from the History icon in the artifact actions cell
 * of `TemplateInstanceDetail` (Execution History tab) — see
 * packages/api/modules/reports/procedures/artifacts/list-deliveries.ts for the
 * backing query.
 *
 * One row per Send-button click. When a single send went to N recipients,
 * all N appear as badges inside that single row. Supports server-side
 * pagination (Prev/Next) and free-text search across recipient address +
 * message body.
 */

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
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
import { formatDistanceToNow } from "date-fns";
import {
	AlertCircleIcon,
	CheckCircle2Icon,
	ChevronLeftIcon,
	ChevronRightIcon,
	HistoryIcon,
	MailIcon,
	SearchIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

type Props = {
	artifactId: string;
	artifactName: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

/** Page-size options surfaced in the footer Select. First value is the default. */
const PAGE_SIZE_OPTIONS = [10, 15, 25] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];
const DEFAULT_PAGE_SIZE: PageSize = PAGE_SIZE_OPTIONS[0];
const MESSAGE_PREVIEW_MAX = 80;
const SEARCH_DEBOUNCE_MS = 250;

export function ArtifactDeliveryHistoryDialog({
	artifactId,
	artifactName,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const [searchInput, setSearchInput] = useState("");
	const [debouncedSearch, setDebouncedSearch] = useState("");
	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);

	// Debounce search input so we don't fire a query per keystroke.
	useEffect(() => {
		const handle = setTimeout(() => {
			setDebouncedSearch(searchInput.trim());
			setPage(0);
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(handle);
	}, [searchInput]);

	// Reset state when the dialog closes so re-opening starts fresh.
	useEffect(() => {
		if (!open) {
			setSearchInput("");
			setDebouncedSearch("");
			setPage(0);
			setPageSize(DEFAULT_PAGE_SIZE);
		}
	}, [open]);

	const { data, isLoading, isFetching, isError, error } = useQuery(
		orpc.reports.artifacts.listDeliveries.queryOptions({
			input: {
				artifactId,
				organizationId: organizationId ?? null,
				search: debouncedSearch || undefined,
				limit: pageSize,
				offset: page * pageSize,
			},
			enabled: open,
			placeholderData: (previous) => previous,
		}),
	);

	const sends = data?.sends ?? [];
	const total = data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const currentRangeStart = total === 0 ? 0 : page * pageSize + 1;
	const currentRangeEnd = Math.min(total, page * pageSize + sends.length);

	function handlePageSizeChange(next: string) {
		const parsed = Number.parseInt(next, 10);
		if (!PAGE_SIZE_OPTIONS.includes(parsed as PageSize)) {
			return;
		}
		setPageSize(parsed as PageSize);
		setPage(0);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<HistoryIcon className="h-4 w-4" />
						Send history
					</DialogTitle>
					<DialogDescription>
						Past email sends for{" "}
						<span className="font-medium">{artifactName}</span>.
					</DialogDescription>
				</DialogHeader>

				<div className="relative">
					<SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
					<SearchInput
						aria-label="Search history"
						placeholder="Search by recipient email or note…"
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						className="pl-8"
					/>
				</div>

				{isLoading ? (
					<div className="flex items-center justify-center py-8">
						<Spinner />
					</div>
				) : isError ? (
					<div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
						Failed to load history:{" "}
						{error instanceof Error
							? error.message
							: "unknown error"}
					</div>
				) : sends.length === 0 ? (
					<div className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
						<MailIcon className="h-6 w-6 opacity-60" />
						<p>
							{debouncedSearch
								? `No sends match "${debouncedSearch}".`
								: "This report has not been emailed yet."}
						</p>
					</div>
				) : (
					<div className="max-h-[60vh] overflow-y-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Recipients</TableHead>
									<TableHead>Sent by</TableHead>
									<TableHead>When</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Note</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sends.map((send) => {
									const sentAt = new Date(send.sentAt);
									const sentCount = send.recipients.filter(
										(r) => r.status === "SENT",
									).length;
									const failedCount =
										send.recipients.length - sentCount;
									const messagePreview = send.messageBody
										? send.messageBody.length >
											MESSAGE_PREVIEW_MAX
											? `${send.messageBody.slice(0, MESSAGE_PREVIEW_MAX)}…`
											: send.messageBody
										: null;

									return (
										<TableRow key={send.sendId}>
											<TableCell className="max-w-[280px]">
												<div className="flex flex-wrap gap-1">
													{send.recipients.map(
														(r) => (
															<Badge
																key={
																	r.recipientEmail
																}
																variant={
																	r.status ===
																	"SENT"
																		? "secondary"
																		: "destructive"
																}
																className="gap-1"
																title={
																	r.status ===
																	"FAILED"
																		? (r.errorMessage ??
																			undefined)
																		: undefined
																}
															>
																{r.recipientUser
																	?.name ??
																	r.recipientEmail}
															</Badge>
														),
													)}
												</div>
											</TableCell>
											<TableCell className="text-sm">
												{send.sender.name ??
													send.sender.email}
											</TableCell>
											<TableCell
												className="text-xs text-muted-foreground"
												title={sentAt.toLocaleString()}
											>
												{formatDistanceToNow(sentAt, {
													addSuffix: true,
												})}
											</TableCell>
											<TableCell>
												{failedCount === 0 ? (
													<Badge
														variant="secondary"
														className="gap-1"
													>
														<CheckCircle2Icon className="h-3 w-3 text-emerald-600" />
														Sent ({sentCount})
													</Badge>
												) : sentCount === 0 ? (
													<Badge
														variant="destructive"
														className="gap-1"
													>
														<AlertCircleIcon className="h-3 w-3" />
														Failed ({failedCount})
													</Badge>
												) : (
													<Badge
														variant="outline"
														className="gap-1"
													>
														<AlertCircleIcon className="h-3 w-3 text-amber-600" />
														{sentCount} sent,{" "}
														{failedCount} failed
													</Badge>
												)}
											</TableCell>
											<TableCell
												className="max-w-[260px] text-xs text-muted-foreground"
												title={
													send.messageBody ??
													undefined
												}
											>
												{messagePreview ?? (
													<span className="italic opacity-60">
														—
													</span>
												)}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</div>
				)}

				{total > 0 && (
					<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs text-muted-foreground">
						<div className="flex items-center gap-3">
							<div>
								{isFetching && !isLoading && (
									<span className="mr-2 opacity-70">
										Loading…
									</span>
								)}
								Showing{" "}
								<span className="font-medium text-foreground">
									{currentRangeStart}–{currentRangeEnd}
								</span>{" "}
								of{" "}
								<span className="font-medium text-foreground">
									{total}
								</span>
							</div>
							<div className="flex items-center gap-2">
								<span>Rows per page</span>
								<Select
									value={String(pageSize)}
									onValueChange={handlePageSizeChange}
								>
									<SelectTrigger
										className="h-7 w-[72px]"
										aria-label="Rows per page"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{PAGE_SIZE_OPTIONS.map((size) => (
											<SelectItem
												key={size}
												value={String(size)}
											>
												{size}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									setPage((p) => Math.max(0, p - 1))
								}
								disabled={page === 0 || isFetching}
							>
								<ChevronLeftIcon className="h-3 w-3" />
								Prev
							</Button>
							<span>
								Page {page + 1} / {totalPages}
							</span>
							<Button
								variant="outline"
								size="sm"
								onClick={() => setPage((p) => p + 1)}
								disabled={!data?.hasMore || isFetching}
							>
								Next
								<ChevronRightIcon className="h-3 w-3" />
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
