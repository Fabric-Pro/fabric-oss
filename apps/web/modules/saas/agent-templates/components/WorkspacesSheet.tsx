"use client";

/**
 * Workspaces Sheet
 * Side drawer for selecting existing workspaces to attach to an agent
 * Allows agents to access data from workspaces for RAG
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Card } from "@ui/components/card";
import { ScrollArea } from "@ui/components/scroll-area";
import { SearchInput } from "@ui/components/search-input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { cn } from "@ui/lib";
import {
	BookOpenIcon,
	CheckCircle2Icon,
	FileTextIcon,
	FolderIcon,
	Loader2Icon,
	SearchIcon,
	UserIcon,
} from "lucide-react";
import { useState } from "react";

/**
 * Document filter per workspace.
 * Empty documentIds = all documents included.
 */
export interface WorkspaceDocumentFilter {
	workspaceId: string;
	/** Specific document IDs to include. Empty/undefined = all documents. */
	documentIds?: string[];
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string;
	selectedWorkspaceIds: string[];
	onSelectionChange: (ids: string[]) => void;
	/** Optional: document-level filtering per workspace */
	documentFilters?: WorkspaceDocumentFilter[];
	onDocumentFiltersChange?: (filters: WorkspaceDocumentFilter[]) => void;
};

export function WorkspacesSheet({
	open,
	onOpenChange,
	organizationId,
	selectedWorkspaceIds,
	onSelectionChange,
	documentFilters,
	onDocumentFiltersChange,
}: Props) {
	const [searchQuery, setSearchQuery] = useState("");
	const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<
		string | null
	>(null);

	// Fetch user's workspaces
	const { data: workspacesData, isLoading } = useQuery({
		queryKey: ["workspaces-for-agent", organizationId, searchQuery],
		queryFn: async () => {
			return await orpcClient.documentWorkspaces.list({
				organizationId: organizationId ?? null,
				limit: 50,
				status: "ACTIVE",
				search: searchQuery || undefined,
				includeShared: true,
			});
		},
		enabled: open,
	});

	const workspaces = workspacesData?.workspaces ?? [];

	// Fetch documents for expanded workspace
	const { data: documentsData } = useQuery({
		queryKey: [
			"workspace-documents-for-agent",
			expandedWorkspaceId,
			organizationId,
		],
		queryFn: async () => {
			if (!expandedWorkspaceId) {
				return null;
			}
			return await orpcClient.documentWorkspaces.documents.list({
				workspaceId: expandedWorkspaceId,
				limit: 100,
			});
		},
		enabled: !!expandedWorkspaceId,
	});

	const expandedDocuments = (documentsData as any)?.documents ?? [];

	const getDocumentFilter = (workspaceId: string) =>
		documentFilters?.find((f) => f.workspaceId === workspaceId);

	const handleToggleDocument = (workspaceId: string, documentId: string) => {
		if (!onDocumentFiltersChange) {
			return;
		}

		const existing = getDocumentFilter(workspaceId);
		const currentIds = existing?.documentIds ?? [];

		let newIds: string[];
		if (currentIds.includes(documentId)) {
			newIds = currentIds.filter((id) => id !== documentId);
		} else {
			newIds = [...currentIds, documentId];
		}

		const newFilters = (documentFilters ?? []).filter(
			(f) => f.workspaceId !== workspaceId,
		);
		if (newIds.length > 0) {
			newFilters.push({ workspaceId, documentIds: newIds });
		}
		onDocumentFiltersChange(newFilters);
	};

	const handleToggleWorkspace = (workspaceId: string) => {
		if (selectedWorkspaceIds.includes(workspaceId)) {
			onSelectionChange(
				selectedWorkspaceIds.filter((id) => id !== workspaceId),
			);
		} else {
			onSelectionChange([...selectedWorkspaceIds, workspaceId]);
		}
	};

	const handleSelectAll = () => {
		const allIds = workspaces.map((w) => w.id);
		onSelectionChange(allIds);
	};

	const handleClearSelection = () => {
		onSelectionChange([]);
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-full sm:max-w-xl flex flex-col p-0">
				<SheetHeader className="px-6 pt-6 pb-4 border-b">
					<SheetTitle className="text-xl">
						Select Workspaces
					</SheetTitle>
					<SheetDescription>
						Choose workspaces to give your agent access to for
						knowledge retrieval (RAG)
					</SheetDescription>
				</SheetHeader>

				{/* Search */}
				<div className="px-6 py-4 border-b bg-muted/30">
					<div className="relative">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search workspaces..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-10 bg-background"
						/>
					</div>
				</div>

				<ScrollArea className="flex-1">
					<div className="p-6">
						{/* Loading state */}
						{isLoading && (
							<div className="flex items-center justify-center py-12">
								<Loader2Icon className="h-8 w-8 animate-spin text-muted-foreground" />
							</div>
						)}

						{/* Empty state */}
						{!isLoading && workspaces.length === 0 && (
							<div className="text-center py-12">
								<FolderIcon className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
								<p className="text-muted-foreground mb-2">
									{searchQuery
										? "No workspaces match your search"
										: "No workspaces found"}
								</p>
								<p className="text-sm text-muted-foreground">
									Create a workspace first to add documents
									for your agent to access.
								</p>
							</div>
						)}

						{/* Workspace list */}
						{!isLoading && workspaces.length > 0 && (
							<div className="space-y-3">
								{/* Quick actions */}
								<div className="flex items-center justify-between mb-4">
									<span className="text-sm text-muted-foreground">
										{workspaces.length} workspace
										{workspaces.length !== 1 ? "s" : ""}{" "}
										available
									</span>
									<div className="flex gap-2">
										<Button
											variant="ghost"
											size="sm"
											onClick={handleSelectAll}
											disabled={
												selectedWorkspaceIds.length ===
												workspaces.length
											}
										>
											Select all
										</Button>
										<Button
											variant="ghost"
											size="sm"
											onClick={handleClearSelection}
											disabled={
												selectedWorkspaceIds.length ===
												0
											}
										>
											Clear
										</Button>
									</div>
								</div>

								{workspaces.map((workspace) => {
									const isSelected =
										selectedWorkspaceIds.includes(
											workspace.id,
										);

									return (
										<Card
											key={workspace.id}
											className={cn(
												"p-4 cursor-pointer hover:border-primary/50 transition-colors",
												isSelected &&
													"border-emerald-500/50 bg-emerald-50/50 dark:bg-emerald-950/20",
											)}
											onClick={() =>
												handleToggleWorkspace(
													workspace.id,
												)
											}
										>
											<div className="flex items-start gap-3">
												<div
													className={cn(
														"p-2.5 rounded-lg shrink-0",
														isSelected
															? "bg-emerald-100 dark:bg-emerald-900/50"
															: "bg-muted",
													)}
												>
													{workspace.type ===
													"PERSONAL" ? (
														<UserIcon
															className={cn(
																"h-5 w-5",
																isSelected
																	? "text-emerald-600 dark:text-emerald-400"
																	: "text-muted-foreground",
															)}
														/>
													) : (
														<FolderIcon
															className={cn(
																"h-5 w-5",
																isSelected
																	? "text-emerald-600 dark:text-emerald-400"
																	: "text-muted-foreground",
															)}
														/>
													)}
												</div>
												<div className="flex-1 min-w-0">
													<div className="flex items-center gap-2">
														<p className="font-medium truncate">
															{workspace.name}
														</p>
														{isSelected && (
															<CheckCircle2Icon className="h-4 w-4 text-emerald-500 shrink-0" />
														)}
														{workspace.type ===
															"PERSONAL" && (
															<Badge
																variant="outline"
																className="text-xs shrink-0"
															>
																Personal
															</Badge>
														)}
													</div>
													{workspace.description && (
														<p className="text-sm text-muted-foreground line-clamp-1 mt-0.5">
															{
																workspace.description
															}
														</p>
													)}
													<div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
														<span className="flex items-center gap-1">
															<FileTextIcon className="h-3 w-3" />
															{
																workspace.documentCount
															}{" "}
															document
															{workspace.documentCount !==
															1
																? "s"
																: ""}
														</span>
														{workspace.owner && (
															<span className="flex items-center gap-1">
																<UserIcon className="h-3 w-3" />
																{workspace.isOwner
																	? "You"
																	: workspace
																			.owner
																			.name ||
																		"Unknown"}
															</span>
														)}
														{/* Document filter toggle */}
														{isSelected &&
															onDocumentFiltersChange &&
															workspace.documentCount >
																0 && (
																<button
																	type="button"
																	className="ml-auto text-primary hover:underline"
																	onClick={(
																		e,
																	) => {
																		e.stopPropagation();
																		setExpandedWorkspaceId(
																			expandedWorkspaceId ===
																				workspace.id
																				? null
																				: workspace.id,
																		);
																	}}
																>
																	{getDocumentFilter(
																		workspace.id,
																	)
																		?.documentIds
																		?.length
																		? `${getDocumentFilter(workspace.id)?.documentIds?.length} selected`
																		: expandedWorkspaceId ===
																				workspace.id
																			? "Hide docs"
																			: "Filter docs"}
																</button>
															)}
													</div>

													{/* Expanded document list */}
													{expandedWorkspaceId ===
														workspace.id &&
														isSelected && (
															<div className="mt-3 border-t pt-3 space-y-1.5">
																<p className="text-xs text-muted-foreground mb-2">
																	Select
																	specific
																	documents to
																	include
																	(none
																	selected =
																	all
																	included):
																</p>
																{expandedDocuments.map(
																	(
																		doc: any,
																	) => {
																		const filter =
																			getDocumentFilter(
																				workspace.id,
																			);
																		const isDocSelected =
																			filter?.documentIds?.includes(
																				doc.id,
																			) ??
																			false;

																		return (
																			<div
																				key={
																					doc.id
																				}
																				className="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 text-sm"
																			>
																				<input
																					type="checkbox"
																					checked={
																						isDocSelected
																					}
																					onClick={(
																						e,
																					) =>
																						e.stopPropagation()
																					}
																					onChange={() =>
																						handleToggleDocument(
																							workspace.id,
																							doc.id,
																						)
																					}
																					className="rounded border-border"
																				/>
																				<FileTextIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
																				<span className="truncate">
																					{doc.filename ||
																						doc.title ||
																						"Untitled"}
																				</span>
																			</div>
																		);
																	},
																)}
																{expandedDocuments.length ===
																	0 && (
																	<p className="text-xs text-muted-foreground italic py-2">
																		Loading
																		documents...
																	</p>
																)}
															</div>
														)}
												</div>
											</div>
										</Card>
									);
								})}
							</div>
						)}
					</div>
				</ScrollArea>

				<SheetFooter className="border-t px-6 py-4 bg-muted/30">
					<div className="flex items-center justify-between w-full">
						<div className="flex items-center gap-2">
							<BookOpenIcon className="h-4 w-4 text-primary" />
							<span className="text-sm font-medium">
								{selectedWorkspaceIds.length} workspace
								{selectedWorkspaceIds.length !== 1 ? "s" : ""}{" "}
								selected
							</span>
						</div>
						<div className="flex gap-3">
							<Button
								variant="outline"
								onClick={() => onOpenChange(false)}
							>
								Cancel
							</Button>
							<Button
								onClick={() => onOpenChange(false)}
								className="bg-emerald-500 hover:bg-emerald-600"
							>
								Add workspaces
							</Button>
						</div>
					</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
