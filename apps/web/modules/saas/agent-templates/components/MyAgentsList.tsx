"use client";

import { getCategoryIcon } from "@saas/agents/lib/category-icons";
import { RobotIcon } from "@saas/shared/components/icons/RobotIcon";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { SearchInput } from "@ui/components/search-input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ui/components/table";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	EditIcon,
	MoreVerticalIcon,
	PlayIcon,
	PlusIcon,
	SearchIcon,
	SparklesIcon,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";

type Props = {
	organizationId?: string;
	basePath?: string;
};

export function MyAgentsList({
	organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const createAgentPath = `${basePath.replace(/\/agent-templates$/, "/agents")}/create`;

	const { data, isLoading, refetch } = useQuery(
		orpc.agentTemplates.instances.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
			},
		}),
	);

	const deleteMutation = useMutation(
		orpc.agentTemplates.instances.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Agent deleted");
				refetch();
			},
			onError: () => {
				toast.error("Failed to delete agent");
			},
		}),
	);

	const instances = data?.instances ?? [];

	const handleDelete = (id: string) => {
		if (window.confirm("Are you sure you want to delete this agent?")) {
			deleteMutation.mutate({ id });
		}
	};

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Search & Create Button */}
			<div className="flex gap-3 items-center justify-between">
				<div className="relative flex-1 max-w-md">
					<SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search agents..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-10 h-11 rounded-xl bg-slate-100 dark:bg-slate-900 border-0"
					/>
				</div>
				<Button asChild className="rounded-xl h-11 gap-2">
					<Link href={createAgentPath}>
						<PlusIcon className="h-4 w-4" />
						Create Custom Agent
					</Link>
				</Button>
			</div>

			{instances.length === 0 ? (
				<div className="text-center py-16 border rounded-2xl bg-slate-50 dark:bg-slate-900/50">
					<div className="w-16 h-16 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto">
						<RobotIcon className="h-8 w-8 text-muted-foreground" />
					</div>
					<h3 className="text-lg font-semibold mt-4">
						{debouncedSearch
							? "No agents match your search"
							: "No agents yet"}
					</h3>
					<p className="text-muted-foreground text-sm mt-2 mb-6">
						{debouncedSearch
							? "Try adjusting your search query"
							: "Create your first agent from scratch or start from a template"}
					</p>
					<div className="flex items-center justify-center gap-3">
						<Button asChild className="rounded-xl gap-2">
							<Link href={createAgentPath}>
								<PlusIcon className="h-4 w-4" />
								Create Custom Agent
							</Link>
						</Button>
						<Button
							asChild
							variant="outline"
							className="rounded-xl gap-2"
						>
							<Link href={basePath}>
								<SparklesIcon className="h-4 w-4" />
								Browse Templates
							</Link>
						</Button>
					</div>
				</div>
			) : (
				<div className="border rounded-lg">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Agent</TableHead>
								<TableHead>Template</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Runs</TableHead>
								<TableHead>Last Run</TableHead>
								<TableHead className="w-[50px]" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{instances.map((instance: any) => (
								<TableRow key={instance.id}>
									<TableCell>
										<div className="flex items-center gap-3">
											{(() => {
												const {
													icon: CategoryIcon,
													gradient,
												} = getCategoryIcon(
													instance.template?.category,
												);
												return (
													<div
														className={cn(
															"w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-sm flex-shrink-0",
															gradient,
														)}
													>
														<CategoryIcon className="h-5 w-5 text-white" />
													</div>
												);
											})()}
											<div>
												<Link
													href={`${basePath.replace(/\/agent-templates$/, "")}/agents/${instance.id}`}
													className="font-medium hover:text-primary"
												>
													{instance.name}
												</Link>
												{instance.description && (
													<p className="text-sm text-muted-foreground line-clamp-1">
														{instance.description}
													</p>
												)}
											</div>
										</div>
									</TableCell>
									<TableCell>
										<Badge variant="secondary">
											{instance.template?.displayName ||
												"Custom"}
										</Badge>
									</TableCell>
									<TableCell>
										<Badge
											variant={
												instance.status === "ACTIVE"
													? "default"
													: "secondary"
											}
											className={
												instance.status === "ACTIVE"
													? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
													: ""
											}
										>
											{instance.status === "ACTIVE"
												? "Active"
												: instance.status === "ARCHIVED"
													? "Archived"
													: instance.status ===
															"DRAFT"
														? "Draft"
														: (instance.status ??
															"Unknown")}
										</Badge>
									</TableCell>
									<TableCell>
										<span className="text-muted-foreground">
											{instance.runCount || 0}
										</span>
									</TableCell>
									<TableCell>
										<span className="text-sm text-muted-foreground">
											{instance.lastRunAt
												? formatDistanceToNow(
														new Date(
															instance.lastRunAt,
														),
														{
															addSuffix: true,
														},
													)
												: "Never"}
										</span>
									</TableCell>
									<TableCell>
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-8 w-8"
												>
													<MoreVerticalIcon className="h-4 w-4" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem asChild>
													<Link
														href={`${basePath.replace(/\/agent-templates$/, "")}/agents/${instance.id}`}
													>
														<EditIcon className="mr-2 h-4 w-4" />
														Edit
													</Link>
												</DropdownMenuItem>
												<DropdownMenuItem asChild>
													<Link
														href={`${basePath.replace(
															/\/agent-templates$/,
															"",
														)}/nexus?agent=${encodeURIComponent(
															JSON.stringify({
																agentId: `template-instance:${instance.id}`,
																name: instance.name,
																description:
																	instance.description ??
																	"",
															}),
														)}`}
													>
														<PlayIcon className="mr-2 h-4 w-4" />
														Start Chat
													</Link>
												</DropdownMenuItem>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													onClick={() =>
														handleDelete(
															instance.id,
														)
													}
													className="text-destructive"
												>
													<TrashIcon className="mr-2 h-4 w-4" />
													Delete
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
}
