"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
import { CheckIcon, DownloadIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

const PAGE_SIZE = 30;

/**
 * Browse the connected PM tool's work items and import them as Fabric test
 * cases — the UI for the `sync.listPmTestCases` (GET) + `sync.importFromPm`
 * procedures. Server-side searchable + paginated; already-imported tickets show
 * a badge instead of an Import button. Only mounted when the tool supports
 * listing (`canList`) with a board selected, so the list query has a real
 * target (the header button is gated on the same capability).
 */
export function PmImportDialog({
	projectId,
	open,
	onOpenChange,
}: {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useTranslations("projects.testCases");
	const queryClient = useQueryClient();
	const [page, setPage] = useState(1);
	// `search` is the live input; `committedSearch` is what the server query
	// uses — committed on Enter so we don't refetch the PM tool per keystroke.
	const [search, setSearch] = useState("");
	const [committedSearch, setCommittedSearch] = useState("");

	const { data, isLoading, isError, error, isFetching } = useQuery({
		...orpc.projects.testCases.sync.listPmTestCases.queryOptions({
			input: {
				projectId,
				page,
				pageSize: PAGE_SIZE,
				search: committedSearch || undefined,
				includeAlreadySynced: true,
			},
		}),
		enabled: open,
		retry: false,
	});

	const importMutation = useMutation(
		orpc.projects.testCases.sync.importFromPm.mutationOptions({
			onSuccess: (res) => {
				toast.success(
					t("import.imported", { id: res.imported.externalId }),
				);
				// Refresh the browse list (already-synced flag) + the cases list.
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.testCases.sync.listPmTestCases.key(),
				});
				queryClient.invalidateQueries({
					queryKey: orpc.projects.testCases.list.key(),
				});
			},
			onError: (e) =>
				toast.error(t("import.importFailed", { error: e.message })),
		}),
	);

	const tickets = data?.tickets ?? [];
	const runSearch = () => {
		setCommittedSearch(search.trim());
		setPage(1);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("import.title")}</DialogTitle>
					<DialogDescription>{t("import.hint")}</DialogDescription>
				</DialogHeader>
				{/* `min-w-0`: DialogContent is a CSS grid; without this the wrapper
				    is a grid item with `min-width: auto` and expands to the widest
				    (nowrap) ticket title, blowing the dialog past `max-w-lg` and
				    pushing the Import buttons off-screen. Constraining it lets the
				    row titles truncate instead. */}
				<div className="min-w-0 space-y-3">
					<div className="relative">
						<SearchIcon
							aria-hidden="true"
							className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground"
						/>
						<SearchInput
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									runSearch();
								}
							}}
							placeholder={t("import.searchPlaceholder")}
							aria-label={t("import.searchAria")}
							className="h-9 pl-8"
						/>
					</div>

					<ul className="max-h-80 min-h-40 space-y-1.5 overflow-y-auto">
						{isLoading ? (
							<li className="flex items-center justify-center py-12 text-muted-foreground">
								<Loader2Icon className="size-5 animate-spin" />
							</li>
						) : isError ? (
							<li className="px-2 py-10 text-center text-destructive text-sm">
								{error instanceof Error
									? error.message
									: t("import.loadFailed")}
							</li>
						) : tickets.length === 0 ? (
							<li className="px-2 py-10 text-center text-muted-foreground text-sm">
								{t("import.empty")}
							</li>
						) : (
							tickets.map((ticket) => (
								<li
									key={ticket.id}
									className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2"
								>
									<span className="shrink-0 font-mono text-muted-foreground text-xs">
										{ticket.displayId}
									</span>
									<span className="min-w-0 flex-1 truncate text-sm">
										{ticket.title}
									</span>
									{ticket.alreadySynced ? (
										<span className="inline-flex shrink-0 items-center gap-1 rounded bg-muted px-2 py-0.5 text-muted-foreground text-xs">
											<CheckIcon
												className="size-3"
												aria-hidden="true"
											/>
											{t("import.alreadyImported")}
										</span>
									) : (
										<Button
											type="button"
											variant="outline"
											size="sm"
											disabled={importMutation.isPending}
											onClick={() =>
												importMutation.mutate({
													projectId,
													// Import by the display id, not
													// the internal `id`: some tools
													// (Fizzy) list rows by an internal
													// id but fetch/update cards by
													// their display number, and the
													// case stores that as externalId.
													externalId:
														ticket.displayId,
												})
											}
										>
											{importMutation.isPending &&
											importMutation.variables
												?.externalId ===
												ticket.displayId ? (
												<Loader2Icon
													className="mr-1.5 size-3.5 animate-spin"
													aria-hidden="true"
												/>
											) : (
												<DownloadIcon
													className="mr-1.5 size-3.5"
													aria-hidden="true"
												/>
											)}
											{t("import.import")}
										</Button>
									)}
								</li>
							))
						)}
					</ul>

					<div className="flex items-center justify-between gap-2 text-muted-foreground text-xs">
						<span className="tabular-nums">
							{data
								? t("import.pageInfo", {
										page: data.page,
										// `total` is the paginated count (matches
										// `hasNextPage`) — filtered by the active
										// search; `totalOnBoard` would mislead there.
										total: data.total,
									})
								: ""}
						</span>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={page <= 1 || isFetching}
								onClick={() =>
									setPage((p) => Math.max(1, p - 1))
								}
							>
								{t("import.prev")}
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={!data?.hasNextPage || isFetching}
								onClick={() => setPage((p) => p + 1)}
							>
								{t("import.next")}
							</Button>
						</div>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
