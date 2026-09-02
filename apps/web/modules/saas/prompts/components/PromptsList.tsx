"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
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
	const { basePath } = useOrganizationContext();

	const promptsPath = `${basePath}/prompts`;
	const [searchQuery, setSearchQuery] = useState("");
	// Apply the `?search=` deep-link filter on mount so links (e.g. the project
	// AI-settings "Customize these prompts in the Prompt Library" link) arrive
	// pre-filtered. Done in an effect, not a useState initializer: under SSR
	// `useSearchParams()` is empty, so an initializer would capture "" and never
	// update once the client hydrates with the real query string.
	const appliedUrlSearch = useRef(false);
	useEffect(() => {
		if (appliedUrlSearch.current) {
			return;
		}
		const initial = searchParams.get("search");
		if (initial) {
			setSearchQuery(initial);
			appliedUrlSearch.current = true;
		}
	}, [searchParams]);
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [scopeFilter, setScopeFilter] = useState<
		"all" | "SYSTEM" | "ORG" | "USER"
	>("all");
	const [viewMode, setViewMode] = useState<ViewMode>("grid");
	// Fizzy #2068 (F6): most recently modified first, per the PM's ask.
	const [sortBy, setSortBy] = useState<"updatedAt" | "createdAt" | "name">(
		"updatedAt",
	);
	// Fizzy #2068 (F13): prompts bound to no action at all.
	const [unusedOnly, setUnusedOnly] = useState(false);
	// Fizzy #2068 (F4): the page's primary split. "Prompts" is the library;
	// "Actions" is the same browse-by-action grid the catalog page serves.
	const [pageTab, setPageTab] = useState<"prompts" | "actions">("prompts");

	// Fetch prompts with optional scope filter
	// IMPORTANT: Pass null for personal context to prevent session fallback
	const { data, isLoading, error, refetch } = useQuery(
		orpc.prompts.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 50,
				offset: 0,
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

	// Deep-links that name an action or a prompt (?action=, ?prompt= — the FR8
	// notification link and the FR14 selector link) are answers to "show me the
	// actions view", so arriving with one opens that tab directly.
	const appliedDeepLink = useRef(false);
	useEffect(() => {
		if (appliedDeepLink.current) {
			return;
		}
		if (searchParams.get("action") || searchParams.get("prompt")) {
			setPageTab("actions");
			appliedDeepLink.current = true;
		}
	}, [searchParams]);

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
						onValueChange={(v) =>
							setScopeFilter(v as typeof scopeFilter)
						}
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
					<div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
						<div className="flex flex-1 gap-2 w-full sm:w-auto flex-wrap">
							{/* Search */}
							<div
								data-onboarding-target="prompts-search"
								className="relative flex-1 max-w-md"
							>
								<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
								<SearchInput
									placeholder="Search prompts..."
									value={searchQuery}
									onChange={(e) =>
										setSearchQuery(e.target.value)
									}
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
								size="sm"
								onClick={() => setUnusedOnly((v) => !v)}
								aria-pressed={unusedOnly}
							>
								Unused only
							</Button>
						</div>

						{/* Wraps like its sibling above: in an org context this row
						    carries the view toggle plus four labelled buttons, which
						    overflows a phone viewport on one line. */}
						<div className="flex flex-wrap gap-2 items-center">
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
								>
									<ListIcon className="h-4 w-4" />
								</Button>
							</div>

							{/* My personal defaults across all actions (F8). Personal
					    defaults follow the user across organizations, so unlike
					    Org Overrides this is not gated on an org context. */}
							<Button
								variant="outline"
								onClick={() =>
									router.push(`${promptsPath}/my-overrides`)
								}
							>
								My Overrides
							</Button>

							{/* Org-wide coverage. Personal context has no org to govern. */}
							{organizationId && (
								<>
									<Button
										variant="outline"
										onClick={() =>
											router.push(
												`${promptsPath}/governance`,
											)
										}
									>
										<ShieldCheckIcon className="mr-2 h-4 w-4" />
										Org Overrides
									</Button>
									<Button
										variant="outline"
										onClick={() =>
											router.push(
												`${promptsPath}/nominations`,
											)
										}
									>
										<InboxIcon className="mr-2 h-4 w-4" />
										Proposed defaults
									</Button>
								</>
							)}

							{/* Create Button */}
							<Button
								data-onboarding-target="prompts-new"
								onClick={() =>
									router.push(`${promptsPath}/new`)
								}
							>
								<PlusIcon className="h-4 w-4 mr-2" />
								New Prompt
							</Button>
						</div>
					</div>

					{/* Prompts Display */}
					{isLoading ? (
						<div className="flex items-center justify-center py-12">
							<Spinner />
						</div>
					) : error ? (
						// Distinct from the empty state below: a failed request
						// telling someone to create their first prompt sends them
						// to fix a library that may be full.
						<div
							className="space-y-4 py-12 text-center"
							role="alert"
						>
							<p className="text-muted-foreground text-sm">
								Could not load your prompts.
							</p>
							<Button variant="outline" onClick={() => refetch()}>
								Try again
							</Button>
						</div>
					) : prompts.length === 0 ? (
						<div className="text-center py-12">
							<p className="text-muted-foreground mb-4">
								{searchQuery || scopeFilter !== "all"
									? "No prompts found matching your filters"
									: "No prompts yet. Create your first prompt to get started!"}
							</p>
							{!searchQuery && scopeFilter === "all" && (
								<Button
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
									prompt={prompt as any}
									onUpdate={refetch}
								/>
							))}
						</div>
					) : (
						<PromptsListView
							prompts={prompts as any}
							onUpdate={refetch}
						/>
					)}
				</TabsContent>

				<TabsContent value="actions">
					<PromptCatalog />
				</TabsContent>
			</Tabs>
		</div>
	);
}
