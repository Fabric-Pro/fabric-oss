"use client";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { Pagination } from "@saas/shared/components/Pagination";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import Link from "next/link";
import {
	parseAsBoolean,
	parseAsInteger,
	parseAsString,
	parseAsStringLiteral,
	useQueryState,
} from "nuqs";
import { useEffect } from "react";
import { useDebounceValue } from "usehooks-ts";
import { skillUiError } from "../lib/skill-ui";
import { SkillCard } from "./SkillCard";
import { SkillDetailsSheet } from "./SkillDetailsSheet";
import { SkillImportDialog } from "./SkillImportDialog";
import { SkillsCreateMenu } from "./SkillsCreateMenu";
import { SkillsHero } from "./SkillsHero";

const TABS = ["organization", "builtin", "drafts", "archived"] as const;
const SORTS = ["updatedAt-desc", "name-asc", "useCount-desc"] as const;
const LIMIT = 20;
export function SkillsLibrary({
	organizationId: propOrgId,
}: {
	organizationId?: string;
}) {
	const { organizationId: contextId, basePath } = useOrganizationContext();
	const organizationId = propOrgId ?? contextId;
	const [tab, setTab] = useQueryState(
		"tab",
		parseAsStringLiteral(TABS).withDefault("organization"),
	);
	const [selectedId, setSelectedId] = useQueryState(
		"skill",
		parseAsString.withOptions({ history: "push" }),
	);
	const [search, setSearch] = useQueryState(
		"search",
		parseAsString.withDefault(""),
	);
	const [debounced] = useDebounceValue(search, 300);
	const [sort, setSort] = useQueryState(
		"sort",
		parseAsStringLiteral(SORTS).withDefault("updatedAt-desc"),
	);
	const [rawPage, setPage] = useQueryState(
		"page",
		parseAsInteger.withDefault(1),
	);
	const page = Math.max(1, rawPage);
	const [importOpen, setImportOpen] = useQueryState(
		"import",
		parseAsBoolean.withDefault(false),
	);
	const sortBy =
		sort === "name-asc"
			? "name"
			: sort === "useCount-desc"
				? "useCount"
				: "updatedAt";
	const sortOrder = sort === "name-asc" ? "asc" : "desc";
	const query = useQuery({
		queryKey: ["skills", organizationId, tab, debounced, sort, page],
		queryFn: () =>
			orpcClient.skills.list({
				organizationId: organizationId ?? undefined,
				tab,
				search: debounced || undefined,
				sortBy,
				sortOrder,
				limit: LIMIT,
				offset: (page - 1) * LIMIT,
			}),
		enabled: !!organizationId,
		retry: false,
		placeholderData: (old, previous) =>
			previous?.queryKey[1] === organizationId ? old : undefined,
	});
	const governance = useQuery({
		queryKey: ["skill-governance", organizationId],
		queryFn: () =>
			orpcClient.skills.governance.get({
				organizationId: organizationId ?? undefined,
			}),
		enabled: !!organizationId,
		retry: false,
	});
	const skills = query.isError ? [] : (query.data?.skills ?? []);
	const canCreate = governance.data?.capabilities.canCreate === true;
	const returnParams = new URLSearchParams();
	if (tab !== "organization") {
		returnParams.set("tab", tab);
	}
	if (search) {
		returnParams.set("search", search);
	}
	if (sort !== "updatedAt-desc") {
		returnParams.set("sort", sort);
	}
	if (page > 1) {
		returnParams.set("page", String(page));
	}
	const returnTo = `${basePath}/skills${returnParams.size ? `?${returnParams}` : ""}`;
	useEffect(() => {
		if (
			query.data &&
			!query.isFetching &&
			page > Math.max(1, Math.ceil(query.data.total / LIMIT))
		) {
			void setPage(Math.max(1, Math.ceil(query.data.total / LIMIT)));
		}
	}, [query.data, query.isFetching, page, setPage]);
	if (!organizationId) {
		return (
			<p className="text-sm text-muted-foreground">
				Select an organization to view skills.
			</p>
		);
	}
	return (
		<div className="space-y-5">
			<SkillsHero />
			<Tabs
				value={tab}
				onValueChange={(value) => {
					void setTab(value as typeof tab);
					void setPage(1);
				}}
			>
				<div className="flex flex-wrap items-end justify-between gap-3">
					<TabsList
						aria-label="Skill collections"
						className="flex flex-wrap"
					>
						<TabsTrigger value="organization">
							Organization
						</TabsTrigger>
						<TabsTrigger value="builtin">Built-in</TabsTrigger>
						<TabsTrigger value="drafts">Your drafts</TabsTrigger>
						<TabsTrigger value="archived">Archived</TabsTrigger>
					</TabsList>
					<SkillsCreateMenu
						basePath={basePath}
						disabled={!canCreate}
						onImport={() => void setImportOpen(true)}
					/>
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-3">
					<SearchInput
						aria-label="Search skills"
						data-onboarding-target="skills-search"
						placeholder="Search skills…"
						className="min-w-0 flex-1 sm:max-w-sm"
						value={search}
						onChange={(e) => {
							void setSearch(e.target.value);
							void setPage(1);
						}}
					/>
					<Select
						value={sort}
						onValueChange={(value) => {
							void setSort(value as typeof sort);
							void setPage(1);
						}}
					>
						<SelectTrigger
							aria-label="Sort skills"
							data-onboarding-target="skills-sort"
							className="w-44"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="updatedAt-desc">
								Recently updated
							</SelectItem>
							<SelectItem value="name-asc">Name</SelectItem>
							<SelectItem value="useCount-desc">
								Most used
							</SelectItem>
						</SelectContent>
					</Select>
					<Button variant="ghost" size="sm" asChild>
						<Link href={`${basePath}/settings/skill-governance`}>
							Skill governance
						</Link>
					</Button>
				</div>
				{!governance.isPending && !canCreate && (
					<p className="mt-3 text-sm text-muted-foreground">
						{governance.isError
							? "Creation permissions could not be checked. Refresh to try again."
							: "Your current role or organization policy does not permit creating skills."}
					</p>
				)}
				<TabsContent value={tab} className="mt-5 space-y-4">
					{query.isError ? (
						<Alert variant="error">
							<AlertTitle>Skills could not be loaded</AlertTitle>
							<AlertDescription>
								{skillUiError(query.error)}
								<Button
									type="button"
									variant="link"
									size="sm"
									onClick={() => void query.refetch()}
								>
									Try again
								</Button>
							</AlertDescription>
						</Alert>
					) : query.isPending ? (
						<div aria-busy="true" className="space-y-3">
							<span className="sr-only">Loading skills…</span>
							<Skeleton className="h-20 w-full" />
							<Skeleton className="h-20 w-full" />
						</div>
					) : !skills.length ? (
						<div className="flex flex-col items-center gap-3 py-12 text-center">
							<PuzzleIcon
								className="size-10 text-muted-foreground"
								aria-hidden="true"
							/>
							<h2 className="text-base font-semibold">
								{search
									? "No matching skills"
									: tab === "drafts"
										? "No drafts yet"
										: tab === "archived"
											? "No archived skills"
											: tab === "builtin"
												? "No built-in skills available"
												: "No shared skills yet"}
							</h2>
							<p className="max-w-lg text-sm text-muted-foreground">
								{search
									? "Try another search or collection."
									: tab === "drafts"
										? "Create a skill from a conversation, start with your instructions, or import an existing skill. It stays private until you share it."
										: tab === "archived"
											? "Archived skills appear here and can be restored by their owner."
											: tab === "organization"
												? "Share a reviewed draft with your organization when it is ready."
												: "Built-in skills appear here when provided by your Fabric installation."}
							</p>
							{search && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										void setSearch("");
										void setPage(1);
									}}
								>
									Clear search
								</Button>
							)}
						</div>
					) : (
						<ul className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
							{skills.map((skill) => (
								<SkillCard
									key={skill.id}
									skill={skill}
									onSelect={(id) => void setSelectedId(id)}
								/>
							))}
						</ul>
					)}
					{!query.isError && !!query.data?.total && (
						<Pagination
							totalItems={query.data.total}
							itemsPerPage={LIMIT}
							currentPage={page}
							onChangeCurrentPage={(next) => void setPage(next)}
							navigationLabel="Skill pages"
							goToPageLabel="Go to skill page"
						/>
					)}
					{query.isFetching && !query.isPending && (
						<output className="block text-xs text-muted-foreground">
							Updating skills…
						</output>
					)}
				</TabsContent>
			</Tabs>
			{selectedId && (
				<SkillDetailsSheet
					key={`${organizationId}:${selectedId}`}
					skillId={selectedId}
					returnTo={returnTo}
					onClose={() => void setSelectedId(null)}
				/>
			)}
			{importOpen && (
				<SkillImportDialog
					key={organizationId}
					organizationId={organizationId}
					basePath={basePath}
					onClose={() => void setImportOpen(false)}
				/>
			)}
		</div>
	);
}
