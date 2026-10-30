"use client";

import { useAdminPath } from "@saas/admin/lib/links";
import { OrganizationLogo } from "@saas/organizations/components/OrganizationLogo";
import { useConfirmationAlert } from "@saas/shared/components/ConfirmationAlertProvider";
import { Pagination } from "@saas/shared/components/Pagination";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	keepPreviousData,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import {
	flexRender,
	getCoreRowModel,
	getPaginationRowModel,
	useReactTable,
} from "@tanstack/react-table";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
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
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronsUpDownIcon,
	EditIcon,
	MoreVerticalIcon,
	PlusIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import {
	parseAsInteger,
	parseAsString,
	parseAsStringLiteral,
	useQueryState,
} from "nuqs";
import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { withQuery } from "ufo";
import { useDebounceValue } from "usehooks-ts";
import { OrganizationTotals } from "./OrganizationTotals";

const ITEMS_PER_PAGE = 10;

export function OrganizationList() {
	const t = useTranslations();
	const { confirm } = useConfirmationAlert();
	const queryClient = useQueryClient();
	// Workspace-aware admin path builder — keeps the org slug when the admin
	// area is viewed under `/app/{slug}/admin`, so org-row links and the
	// "create" button don't bounce the user back to the personal workspace.
	const adminPath = useAdminPath();
	const [currentPage, setCurrentPage] = useQueryState(
		"currentPage",
		parseAsInteger.withDefault(1),
	);
	const [searchTerm, setSearchTerm] = useQueryState(
		"query",
		parseAsString.withDefault(""),
	);
	const format = useFormatter();
	const [status, setStatus] = useQueryState(
		"status",
		parseAsStringLiteral([
			"active",
			"deactivated",
			"all",
		] as const).withDefault("active"),
	);
	const [sort, setSort] = useQueryState(
		"sort",
		parseAsStringLiteral([
			"name",
			"members",
			"projects",
			"createdAt",
		] as const).withDefault("createdAt"),
	);
	const [direction, setDirection] = useQueryState(
		"direction",
		parseAsStringLiteral(["asc", "desc"] as const).withDefault("desc"),
	);
	const [debouncedSearchTerm] = useDebounceValue(searchTerm, 300);

	const organizationEditBasePath = adminPath("/organizations");
	const getOrganizationEditPath = useCallback(
		(id: string) => {
			const searchParams = new URLSearchParams(window.location.search);
			return withQuery(`${organizationEditBasePath}/${id}`, {
				backTo: `${window.location.pathname}${searchParams.size ? `?${searchParams.toString()}` : ""}`,
			});
		},
		[organizationEditBasePath],
	);

	const { data, isLoading, isError, isFetching, isPlaceholderData } =
		useQuery(
			orpc.admin.organizations.list.queryOptions({
				placeholderData: keepPreviousData,
				input: {
					limit: ITEMS_PER_PAGE,
					offset: (Math.max(1, currentPage) - 1) * ITEMS_PER_PAGE,
					query: debouncedSearchTerm,
					status,
					sort,
					direction,
				},
			}),
		);

	useEffect(() => {
		if (currentPage < 1) {
			void setCurrentPage(1, { history: "replace" });
		} else if (!isPlaceholderData && data && data.total > 0) {
			const lastPage = Math.ceil(data.total / ITEMS_PER_PAGE);
			if (currentPage > lastPage) {
				void setCurrentPage(lastPage, { history: "replace" });
			}
		}
	}, [currentPage, data?.total, isPlaceholderData, setCurrentPage]);

	const deleteOrganization = async (id: string) => {
		toast.promise(
			async () => {
				// Deactivates with the standard retention window instead of
				// hard deleting: an organization removed from here is exactly
				// as recoverable as one an owner deleted (Fizzy #2462).
				await orpcClient.admin.organizations.delete({
					organizationId: id,
				});
			},
			{
				loading: t("admin.organizations.deleteOrganization.deleting"),
				success: () => {
					queryClient.invalidateQueries({
						queryKey: orpc.admin.organizations.list.key(),
					});
					queryClient.invalidateQueries({
						queryKey: orpc.admin.hostedAdoption.counts.key(),
					});
					return t("admin.organizations.deleteOrganization.deleted");
				},
				error: t("admin.organizations.deleteOrganization.notDeleted"),
			},
		);
	};

	const columns: ColumnDef<
		NonNullable<typeof data>["organizations"][number]
	>[] = useMemo(
		() => [
			{
				accessorKey: "user",
				header: "",
				accessorFn: (row) => row.name,
				cell: ({
					row: {
						original: {
							id,
							name,
							logo,
							deletedAt,
							scheduledPermanentDeleteAt,
						},
					},
				}) => (
					<div className="flex items-center gap-2">
						<OrganizationLogo name={name} logoUrl={logo} />
						<div className="leading-tight">
							<Link
								href={getOrganizationEditPath(id)}
								className="block font-bold"
							>
								{name}
							</Link>
							{deletedAt && (
								<div>
									<Badge>
										{t(
											"admin.organizations.overview.deactivated",
										)}
									</Badge>
									{scheduledPermanentDeleteAt && (
										<span className="block text-sm text-muted-foreground">
											{t(
												"admin.organizations.overview.purges",
												{
													date: format.dateTime(
														new Date(
															scheduledPermanentDeleteAt,
														),
													),
												},
											)}
										</span>
									)}
								</div>
							)}
						</div>
					</div>
				),
			},
			...(["membersCount", "projectsCount", "createdAt"] as const).map(
				(key) => ({
					accessorKey: key,
					cell: ({
						row,
					}: {
						row: {
							original: NonNullable<
								typeof data
							>["organizations"][number];
						};
					}) => (
						<div
							className={
								key === "createdAt"
									? ""
									: "text-right tabular-nums"
							}
						>
							{key === "createdAt"
								? format.dateTime(
										new Date(row.original.createdAt),
									)
								: format.number(row.original[key])}
						</div>
					),
				}),
			),
			{
				accessorKey: "actions",
				header: "",
				cell: ({
					row: {
						original: { id, deletedAt },
					},
				}) => {
					return (
						<div className="flex flex-row justify-end gap-2">
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										size="icon"
										variant="ghost"
										aria-label={t(
											"admin.organizations.overview.actions",
										)}
									>
										<MoreVerticalIcon className="size-4" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent>
									<DropdownMenuItem asChild>
										<Link
											href={getOrganizationEditPath(id)}
											className="flex items-center"
										>
											<EditIcon className="mr-2 size-4" />
											{t("admin.organizations.edit")}
										</Link>
									</DropdownMenuItem>
									{!deletedAt && (
										<DropdownMenuItem
											onClick={() =>
												confirm({
													title: t(
														"admin.organizations.confirmDelete.title",
													),
													message: t(
														"admin.organizations.confirmDelete.message",
													),
													confirmLabel: t(
														"admin.organizations.confirmDelete.confirm",
													),
													destructive: true,
													onConfirm: () =>
														deleteOrganization(id),
												})
											}
										>
											<span className="flex items-center text-destructive hover:text-destructive">
												<TrashIcon className="mr-2 size-4" />
												{t(
													"admin.organizations.delete",
												)}
											</span>
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					);
				},
			},
		],
		[t, format, getOrganizationEditPath],
	);

	const organizations = useMemo(
		() => data?.organizations ?? [],
		[data?.organizations],
	);

	const table = useReactTable({
		data: organizations,
		getRowId: (row) => row.id,
		columns,
		getCoreRowModel: getCoreRowModel(),
		getPaginationRowModel: getPaginationRowModel(),
		manualPagination: true,
	});

	return (
		<div className="space-y-6">
			<OrganizationTotals />
			<Card className="p-6">
				<div className="mb-4 flex items-center justify-between gap-6">
					<h2 className="font-semibold text-2xl">
						{t("admin.organizations.title")}
					</h2>

					<Button asChild>
						<Link href={adminPath("/organizations/new")}>
							<PlusIcon className="mr-1.5 size-4" />
							{t("admin.organizations.create")}
						</Link>
					</Button>
				</div>
				<Input
					type="search"
					placeholder={t("admin.organizations.search")}
					value={searchTerm}
					aria-label={t("admin.organizations.search")}
					onChange={(e) => {
						setSearchTerm(e.target.value);
						setCurrentPage(1);
					}}
					className="mb-4"
				/>

				<label htmlFor="organization-status">
					{t("admin.organizations.overview.status")}
				</label>
				<Select
					value={status}
					onValueChange={(value: typeof status) => {
						setStatus(value);
						setCurrentPage(1);
					}}
				>
					<SelectTrigger
						id="organization-status"
						className="mb-4 w-48"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(["active", "deactivated", "all"] as const).map(
							(value) => (
								<SelectItem key={value} value={value}>
									{t(`admin.organizations.overview.${value}`)}
								</SelectItem>
							),
						)}
					</SelectContent>
				</Select>
				<div className="rounded-md border">
					<Table aria-busy={isFetching}>
						<TableHeader>
							<TableRow>
								{(
									[
										"name",
										"members",
										"projects",
										"createdAt",
									] as const
								).map((field) => (
									<TableHead
										key={field}
										className={
											field === "members" ||
											field === "projects"
												? "text-right"
												: ""
										}
										aria-sort={
											sort === field
												? direction === "asc"
													? "ascending"
													: "descending"
												: "none"
										}
									>
										<Button
											variant="ghost"
											className={
												sort === field
													? "font-semibold"
													: ""
											}
											onClick={() => {
												setSort(field);
												setDirection(
													sort === field
														? direction === "asc"
															? "desc"
															: "asc"
														: field === "name"
															? "asc"
															: "desc",
												);
												setCurrentPage(1);
											}}
										>
											{t(
												`admin.organizations.overview.${field}`,
											)}
											{sort === field ? (
												direction === "asc" ? (
													<ArrowUpIcon
														aria-hidden="true"
														className="ml-2 size-4"
													/>
												) : (
													<ArrowDownIcon
														aria-hidden="true"
														className="ml-2 size-4"
													/>
												)
											) : (
												<ChevronsUpDownIcon
													aria-hidden="true"
													className="ml-2 size-4 text-muted-foreground"
												/>
											)}
										</Button>
									</TableHead>
								))}
								<TableHead>
									<span className="sr-only">
										{t(
											"admin.organizations.overview.actions",
										)}
									</span>
								</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody
							className={
								data && isFetching ? "opacity-60" : undefined
							}
						>
							{table.getRowModel().rows?.length ? (
								table.getRowModel().rows.map((row) => (
									<TableRow
										key={row.id}
										data-state={
											row.getIsSelected() && "selected"
										}
										className="group"
									>
										{row.getVisibleCells().map((cell) => (
											<TableCell
												key={cell.id}
												className="py-2 group-first:rounded-t-md group-last:rounded-b-md"
											>
												{flexRender(
													cell.column.columnDef.cell,
													cell.getContext(),
												)}
											</TableCell>
										))}
									</TableRow>
								))
							) : (
								<TableRow>
									<TableCell
										colSpan={columns.length}
										className="h-24 text-center"
									>
										{!data && isLoading ? (
											<div className="flex h-full items-center justify-center">
												<Spinner className="mr-2 size-4 text-primary" />
												{t(
													"admin.organizations.loading",
												)}
											</div>
										) : (
											<p
												role={
													isError
														? "alert"
														: undefined
												}
											>
												{t(
													isError
														? "admin.organizations.overview.error"
														: "admin.organizations.overview.empty",
												)}
											</p>
										)}
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</div>

				{!!data?.total && data.total > ITEMS_PER_PAGE && (
					<Pagination
						className="mt-4"
						totalItems={data.total}
						itemsPerPage={ITEMS_PER_PAGE}
						currentPage={currentPage}
						onChangeCurrentPage={setCurrentPage}
					/>
				)}
			</Card>
		</div>
	);
}
