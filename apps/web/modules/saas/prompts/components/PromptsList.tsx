"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	ChevronDownIcon,
	GridIcon,
	InboxIcon,
	ListIcon,
	PlusIcon,
	SearchIcon,
	ShieldCheckIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { CreatePromptMenu } from "./CreatePromptMenu";
import { LoadFailure } from "./LoadFailure";
import { PromptCard } from "./PromptCard";
import { PromptCatalog } from "./PromptCatalog";
import { PromptsHero } from "./PromptsHero";
import { PromptsListView } from "./PromptsListView";

type ViewMode = "grid" | "list";

type Props = {
	organizationId?: string;
};

export function PromptsList({ organizationId }: Props) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const { basePath, userRole } = useOrganizationContext();

	const promptsPath = `${basePath}/prompts`;

	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [scopeFilter, setScopeFilter] = useState<
		"all" | "SYSTEM" | "ORG" | "USER"
	>("all");
	const [viewMode, setViewMode] = useState<ViewMode>("list");
	const [sortBy, setSortBy] = useState<"updatedAt" | "createdAt" | "name">(
		"updatedAt",
	);
	const [unusedOnly, setUnusedOnly] = useState(false);
	const [pageTab, setPageTab] = useState<"prompts" | "actions">("prompts");
	const [page, setPage] = useState(0);
	const [urlReady, setUrlReady] = useState(false);
	const appliedUrl = useRef(false);
	useEffect(() => {
		if (appliedUrl.current) {
			return;
		}
		appliedUrl.current = true;
		setSearchQuery(searchParams.get("search") || "");
		const scope = searchParams.get("scope");
		if (scope === "SYSTEM" || scope === "ORG" || scope === "USER") {
			setScopeFilter(scope);
		}
		if (searchParams.get("view") === "grid") {
			setViewMode("grid");
		}
		const sort = searchParams.get("sort");
		if (sort === "name" || sort === "createdAt") {
			setSortBy(sort);
		}
		setUnusedOnly(searchParams.get("unused") === "1");
		const initialPage = Number(searchParams.get("page"));
		if (Number.isSafeInteger(initialPage) && initialPage >= 0) {
			setPage(Math.min(initialPage, 10000));
		}
		if (
			searchParams.get("tab") === "actions" ||
			searchParams.get("action") ||
			searchParams.get("prompt")
		) {
			setPageTab("actions");
		}
		setUrlReady(true);
	}, [searchParams]);
	useEffect(() => {
		if (!urlReady) {
			return;
		}
		const query = new URLSearchParams(window.location.search);
		for (const [key, value] of Object.entries({
			search: searchQuery,
			scope: scopeFilter === "all" ? "" : scopeFilter,
			view: viewMode === "list" ? "" : viewMode,
			sort: sortBy === "updatedAt" ? "" : sortBy,
			unused: unusedOnly ? "1" : "",
			tab: pageTab === "prompts" ? "" : pageTab,
			page: page ? String(page) : "",
		})) {
			if (value) {
				query.set(key, value);
			} else {
				query.delete(key);
			}
		}
		const url = `${promptsPath}${query.size ? `?${query}` : ""}`;
		if (`${window.location.pathname}${window.location.search}` !== url) {
			window.history.replaceState(window.history.state, "", url);
		}
	}, [
		urlReady,
		searchQuery,
		scopeFilter,
		viewMode,
		sortBy,
		unusedOnly,
		pageTab,
		page,
		promptsPath,
	]);

	const incomingAction = searchParams.get("action");
	const incomingPrompt = searchParams.get("prompt");
	useEffect(() => {
		if (incomingAction || incomingPrompt) {
			setPageTab("actions");
		}
	}, [incomingAction, incomingPrompt]);

	// Fetch prompts with optional scope filter
	// IMPORTANT: Pass null for personal context to prevent session fallback
	const {
		data,
		isPending: isLoading,
		error,
		refetch,
	} = useQuery(
		orpc.prompts.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 50,
				offset: page * 50,
				search: debouncedSearch || undefined,
				scope: scopeFilter === "all" ? undefined : scopeFilter,
				sortBy,
				sortOrder:
					sortBy === "name" ? ("asc" as const) : ("desc" as const),
				unused: unusedOnly || undefined,
			},
		}),
	);

	const prompts = data?.prompts ?? [];

	return (
		<div className="space-y-6">
			<PromptsHero />

			<Tabs
				value={pageTab}
				onValueChange={(v) => setPageTab(v as typeof pageTab)}
			>
				<TabsList data-onboarding-target="prompts-tabs">
					<TabsTrigger value="prompts">Prompts</TabsTrigger>
					<TabsTrigger value="actions">Actions</TabsTrigger>
				</TabsList>

				<TabsContent value="prompts" className="space-y-6">
					{/* Scope tabs (Fizzy #2068 F4): the three scope levels replaced the
			    document-type tabs as the page's primary filter — whose prompt is
			    in force matters more than what type it shapes. */}
					<Tabs
						value={scopeFilter}
						onValueChange={(v) => {
							setScopeFilter(v as typeof scopeFilter);
							setPage(0);
						}}
					>
						<TabsList
							data-onboarding-target="prompts-scope"
							className="flex-wrap h-auto gap-1"
						>
							<TabsTrigger value="all">All</TabsTrigger>
							<TabsTrigger value="SYSTEM">System</TabsTrigger>
							<TabsTrigger value="ORG">My Org</TabsTrigger>
							<TabsTrigger value="USER">My Prompts</TabsTrigger>
						</TabsList>
					</Tabs>

					{/* Actions Bar */}
					{/* Two rows on purpose: finding (search, sort, unused) on the
					    first, going elsewhere (view, defaults, create) on the
					    second. On one row the eight controls fought for width and
					    the search field lost. */}
					<div className="flex flex-col gap-3">
						<div className="flex w-full flex-wrap items-center gap-2">
							{/* Search */}
							<div
								data-onboarding-target="prompts-search"
								className="relative min-w-[16rem] flex-1"
							>
								<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
								<SearchInput
									placeholder="Search prompts..."
									value={searchQuery}
									onChange={(e) => {
										setSearchQuery(e.target.value);
										setPage(0);
									}}
									className="pl-9"
								/>
							</div>

							{/* Sort (Fizzy #2068 F6): modified first by default */}
							<Select
								value={sortBy}
								onValueChange={(v) =>
									setSortBy(v as typeof sortBy)
								}
							>
								<SelectTrigger
									className="w-[180px]"
									aria-label="Sort prompts"
								>
									<SelectValue placeholder="Sort" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="updatedAt">
										Last modified
									</SelectItem>
									<SelectItem value="createdAt">
										Newest first
									</SelectItem>
									<SelectItem value="name">
										Name A to Z
									</SelectItem>
								</SelectContent>
							</Select>

							{/* Unused only (Fizzy #2068 F13): bound to no action */}
							<Button
								variant={unusedOnly ? "default" : "outline"}
								onClick={() => {
									setUnusedOnly((v) => !v);
									setPage(0);
								}}
								aria-pressed={unusedOnly}
							>
								Unused only
							</Button>
						</div>

						{/* Less frequent default management stays in one menu. */}
						<div className="flex flex-wrap items-center justify-end gap-2">
							{/* View Toggle */}
							<div className="flex gap-1 border rounded-md p-1">
								<Button
									variant={
										viewMode === "grid"
											? "default"
											: "ghost"
									}
									size="icon-sm"
									onClick={() => setViewMode("grid")}
									aria-label="Grid view"
									aria-pressed={viewMode === "grid"}
								>
									<GridIcon className="h-4 w-4" />
								</Button>
								<Button
									variant={
										viewMode === "list"
											? "default"
											: "ghost"
									}
									size="icon-sm"
									onClick={() => setViewMode("list")}
									aria-label="List view"
									aria-pressed={viewMode === "list"}
								>
									<ListIcon className="h-4 w-4" />
								</Button>
							</div>

							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button variant="outline">
										Defaults{" "}
										<ChevronDownIcon
											className="ml-2 size-4"
											aria-hidden="true"
										/>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onSelect={() =>
											router.push(
												`${promptsPath}/my-overrides`,
											)
										}
									>
										My Overrides
									</DropdownMenuItem>
									{organizationId && (
										<>
											<DropdownMenuItem
												onSelect={() =>
													router.push(
														`${promptsPath}/governance`,
													)
												}
											>
												<ShieldCheckIcon className="mr-2 size-4" />
												Org Overrides
											</DropdownMenuItem>
											<DropdownMenuItem
												onSelect={() =>
													router.push(
														`${promptsPath}/nominations`,
													)
												}
											>
												<InboxIcon className="mr-2 size-4" />
												Proposed defaults
											</DropdownMenuItem>
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>

							<CreatePromptMenu
								path={promptsPath}
								returnTo={`${promptsPath}?${searchParams.toString()}`}
							/>
						</div>
					</div>

					{/* Prompts Display */}
					{isLoading ? (
						<div className="flex items-center justify-center py-12">
							<Spinner />
						</div>
					) : error && !data ? (
						// Distinct from the empty state below: a failed request
						// telling someone to create their first prompt sends them
						// to fix a library that may be full.
						<LoadFailure
							message="Could not load your prompts."
							onRetry={() => refetch()}
						/>
					) : prompts.length === 0 ? (
						<div className="text-center py-12">
							<p className="text-muted-foreground mb-4">
								{page > 0
									? "No prompts on this page. Go back to the previous page."
									: searchQuery ||
											scopeFilter !== "all" ||
											unusedOnly
										? "No prompts found matching your filters"
										: "No prompts yet. Create your first prompt to get started!"}
							</p>
							{page === 0 &&
								!unusedOnly &&
								!searchQuery &&
								scopeFilter === "all" && (
									<Button
										disabled={
											userRole !== "owner" &&
											userRole !== "admin"
										}
										title="Organization owners and administrators can create shared prompts."
										onClick={() =>
											router.push(`${promptsPath}/new`)
										}
									>
										<PlusIcon className="h-4 w-4 mr-2" />
										Create Your First Prompt
									</Button>
								)}
						</div>
					) : viewMode === "grid" ? (
						<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
							{prompts.map((prompt) => (
								<PromptCard
									key={prompt.id}
									prompt={prompt}
									onUpdate={refetch}
								/>
							))}
						</div>
					) : (
						<PromptsListView prompts={prompts} onUpdate={refetch} />
					)}
					{((data?.total || 0) > 50 || page > 0) && (
						<div className="flex flex-wrap items-center justify-between gap-3">
							<p className="text-sm text-muted-foreground">
								Page {page + 1} · {data?.total} prompts
							</p>
							<div className="flex gap-2">
								<Button
									variant="outline"
									disabled={page === 0 || isLoading}
									onClick={() => setPage((v) => v - 1)}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									disabled={
										(page + 1) * 50 >= (data?.total || 0) ||
										isLoading
									}
									onClick={() => setPage((v) => v + 1)}
								>
									Next
								</Button>
							</div>
						</div>
					)}
				</TabsContent>

				<TabsContent value="actions">
					<PromptCatalog />
				</TabsContent>
			</Tabs>
		</div>
	);
}
