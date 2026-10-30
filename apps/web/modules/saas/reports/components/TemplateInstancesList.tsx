"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { Pagination } from "@saas/shared/components/Pagination";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
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
	CalendarIcon,
	Loader2Icon,
	MoreVerticalIcon,
	PlayIcon,
	SettingsIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { parseAsInteger, useQueryState } from "nuqs";
import { useEffect } from "react";
import { toast } from "sonner";

/**
 * Pagination constants
 * See: rendering-content-visibility rule from Vercel React Best Practices
 */
const ITEMS_PER_PAGE = 10;

type Props = {
	templateId?: string;
	organizationId?: string;
	basePath?: string;
	showTemplateColumn?: boolean;
};

export function TemplateInstancesList({
	templateId,
	organizationId: propOrgId,
	basePath = "/app/report-templates",
	showTemplateColumn = false,
}: Props) {
	// Use effective organization ID to properly handle personal vs org context
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const [currentPage, setCurrentPage] = useQueryState(
		"instancesPage",
		parseAsInteger.withDefault(1),
	);

	const { data, isLoading, refetch, isPlaceholderData } = useQuery({
		...orpc.reports.instances.list.queryOptions({
			input: {
				templateId,
				organizationId,
				limit: ITEMS_PER_PAGE,
				offset: (Math.max(1, currentPage) - 1) * ITEMS_PER_PAGE,
			},
		}),
		placeholderData: keepPreviousData,
	});

	const executeMutation = useMutation(
		orpc.reports.instances.execute.mutationOptions({
			onSuccess: () => {
				toast.success("Execution started");
				refetch();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to execute");
			},
		}),
	);

	const deleteMutation = useMutation(
		orpc.reports.instances.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Instance deleted");
				refetch();
			},
			onError: (error) => {
				toast.error(error.message || "Failed to delete");
			},
		}),
	);

	const instances = data?.instances ?? [];

	const total = data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / ITEMS_PER_PAGE));
	const paginatedInstances = instances;
	useEffect(() => {
		if (
			data &&
			!isPlaceholderData &&
			(currentPage > totalPages || currentPage < 1)
		) {
			void setCurrentPage(
				Math.max(1, Math.min(currentPage, totalPages)),
				{ history: "replace" },
			);
		}
	}, [data, isPlaceholderData, currentPage, totalPages, setCurrentPage]);

	const handleExecute = (instanceId: string) => {
		executeMutation.mutate({ instanceId, organizationId });
	};

	const handleDelete = (id: string) => {
		if (window.confirm("Are you sure you want to delete this instance?")) {
			deleteMutation.mutate({ id, organizationId });
		}
	};

	if (isLoading) {
		return (
			<div className="flex justify-center py-8">
				<Spinner className="h-6 w-6" />
			</div>
		);
	}

	if (instances.length === 0) {
		return (
			<div className="text-center py-8 text-muted-foreground">
				<p>No instances created yet.</p>
				<p className="text-sm mt-1">
					Create an instance to configure and run this template.
				</p>
			</div>
		);
	}

	return (
		<div className="border rounded-lg">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Name</TableHead>
						{showTemplateColumn && <TableHead>Template</TableHead>}
						<TableHead>Status</TableHead>
						<TableHead>Runs</TableHead>
						<TableHead>Last Run</TableHead>
						<TableHead className="w-[100px]">Actions</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{paginatedInstances.map((instance) => (
						<TableRow key={instance.id}>
							<TableCell>
								<div>
									<Link
										href={`${basePath}/instances/${instance.id}`}
										className="font-medium hover:text-primary transition-colors"
									>
										{instance.name}
									</Link>
									{instance.description && (
										<p className="text-sm text-muted-foreground line-clamp-1">
											{instance.description}
										</p>
									)}
								</div>
							</TableCell>
							{showTemplateColumn && (
								<TableCell>
									<Link
										href={`${basePath}/${instance.templateId}`}
										className="text-sm hover:text-primary"
									>
										{instance.templateName}
									</Link>
								</TableCell>
							)}
							<TableCell>
								<Badge
									variant={
										instance.isActive
											? "default"
											: "secondary"
									}
									className="text-xs"
								>
									{instance.isActive ? "Active" : "Paused"}
								</Badge>
								{instance.schedule &&
									instance.scheduleMode !== "OFF" && (
										<Badge
											variant="outline"
											className="text-xs ml-1"
										>
											<CalendarIcon className="w-3 h-3 mr-1" />
											Scheduled
										</Badge>
									)}
							</TableCell>
							<TableCell className="text-muted-foreground">
								{instance.executionCount || 0}
							</TableCell>
							<TableCell className="text-muted-foreground text-sm">
								{(() => {
									const latestStatus =
										instance.latestExecutionStatus;
									if (latestStatus === "PENDING") {
										return (
											<span className="flex items-center gap-1">
												<Loader2Icon className="h-3 w-3 animate-spin" />
												Queued
											</span>
										);
									}
									if (latestStatus === "RUNNING") {
										return (
											<span className="flex items-center gap-1">
												<Loader2Icon className="h-3 w-3 animate-spin" />
												Running
											</span>
										);
									}
									const runTime = instance.lastRunAt;
									if (runTime) {
										return formatDistanceToNow(
											new Date(runTime),
											{ addSuffix: true },
										);
									}
									return "Never";
								})()}
							</TableCell>
							<TableCell>
								<div className="flex items-center gap-1">
									<Button
										size="sm"
										variant="default"
										onClick={() =>
											handleExecute(instance.id)
										}
										disabled={
											!instance.isActive ||
											executeMutation.isPending
										}
									>
										{executeMutation.isPending &&
										executeMutation.variables
											?.instanceId === instance.id ? (
											<Loader2Icon className="h-3.5 w-3.5 animate-spin" />
										) : (
											<PlayIcon className="h-3.5 w-3.5" />
										)}
									</Button>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button variant="ghost" size="sm">
												<MoreVerticalIcon className="h-4 w-4" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end">
											<DropdownMenuItem asChild>
												<Link
													href={`${basePath}/instances/${instance.id}`}
												>
													<SettingsIcon className="mr-2 h-4 w-4" />
													Configure
												</Link>
											</DropdownMenuItem>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onClick={() =>
													handleDelete(instance.id)
												}
												className="text-destructive"
											>
												<TrashIcon className="mr-2 h-4 w-4" />
												Delete
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>

			{total > ITEMS_PER_PAGE && (
				<Pagination
					totalItems={total}
					itemsPerPage={ITEMS_PER_PAGE}
					currentPage={currentPage}
					onChangeCurrentPage={setCurrentPage}
				/>
			)}
		</div>
	);
}
