"use client";

import { Pagination } from "@saas/shared/components/Pagination";
import { orpc } from "@shared/lib/orpc-query-utils";
/**
 * User Activity dashboard shell. Owns range / sort /
 * search / pagination state, fetches via `userActivity.listMembers`,
 * and opens the per-member history drawer. Read-only by design (DV-4).
 */
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Card, CardContent } from "@ui/components/card";
import { Input } from "@ui/components/input";
import { Skeleton } from "@ui/components/skeleton";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { MemberActivityDrawer } from "./MemberActivityDrawer";
import { MemberActivityTable } from "./MemberActivityTable";

const ITEMS_PER_PAGE = 25;

type RangeDays = 7 | 30 | 90;
const RANGE_OPTIONS: Array<{ value: RangeDays; label: string }> = [
	{ value: 7, label: "Last 7 days" },
	{ value: 30, label: "Last 30 days" },
	{ value: 90, label: "Last 90 days" },
];

export function UserActivityView({
	organizationId,
}: {
	organizationId: string;
}) {
	const [rangeDays, setRangeDays] = useState<RangeDays>(30);
	const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
	const [searchInput, setSearchInput] = useState("");
	const [debouncedSearch] = useDebounceValue(searchInput, 300);
	const [currentPage, setCurrentPage] = useState(1);
	const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

	const { data, isPending, isError } = useQuery(
		orpc.userActivity.listMembers.queryOptions({
			input: {
				organizationId,
				rangeDays,
				sortDir,
				query: debouncedSearch,
				limit: ITEMS_PER_PAGE,
				offset: (currentPage - 1) * ITEMS_PER_PAGE,
			},
		}),
	);

	return (
		<Card>
			<CardContent className="flex flex-col gap-4 p-6">
				<div className="flex flex-wrap items-center gap-2">
					<fieldset
						className="m-0 flex items-center gap-1 border-0 p-0"
						aria-label="Activity range"
					>
						{RANGE_OPTIONS.map((option) => (
							<Button
								key={option.value}
								size="sm"
								variant={
									rangeDays === option.value
										? "secondary"
										: "ghost"
								}
								onClick={() => {
									setRangeDays(option.value);
									setCurrentPage(1);
								}}
							>
								{option.label}
							</Button>
						))}
					</fieldset>
					<Input
						type="search"
						id="member-search"
						name="member-search"
						placeholder="Search members…"
						className="ml-auto max-w-xs"
						value={searchInput}
						onChange={(event) => {
							setSearchInput(event.target.value);
							setCurrentPage(1);
						}}
					/>
				</div>

				{isPending ? (
					<div className="flex flex-col gap-2">
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
						<Skeleton className="h-10 w-full" />
					</div>
				) : isError ? (
					<div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
						<XIcon className="size-4" />
						Could not load member activity.
					</div>
				) : !data || data.items.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground">
						No members found.
					</p>
				) : (
					<>
						<MemberActivityTable
							items={data.items}
							sortDir={sortDir}
							onToggleSort={() => {
								setSortDir((dir) =>
									dir === "desc" ? "asc" : "desc",
								);
								setCurrentPage(1);
							}}
							onSelectMember={setSelectedUserId}
						/>
						{data.total > ITEMS_PER_PAGE && (
							<Pagination
								className="mt-2"
								totalItems={data.total}
								itemsPerPage={ITEMS_PER_PAGE}
								currentPage={currentPage}
								onChangeCurrentPage={setCurrentPage}
							/>
						)}
					</>
				)}

				<MemberActivityDrawer
					organizationId={organizationId}
					userId={selectedUserId}
					rangeDays={rangeDays}
					onClose={() => setSelectedUserId(null)}
				/>
			</CardContent>
		</Card>
	);
}
