"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
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
import { cn } from "@ui/lib";
import {
	ArrowUpDownIcon,
	LayoutGridIcon,
	PlusIcon,
	SearchIcon,
	SparklesIcon,
	StarIcon,
	TrendingUpIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { SkillCard } from "./SkillCard";
import { SkillsHero } from "./SkillsHero";

const sortOptions = [
	{
		label: "Recently Updated",
		value: "updatedAt-desc",
		sortBy: "updatedAt" as const,
		sortOrder: "desc" as const,
	},
	{
		label: "Name",
		value: "name-asc",
		sortBy: "name" as const,
		sortOrder: "asc" as const,
	},
	{
		label: "Popular",
		value: "useCount-desc",
		sortBy: "useCount" as const,
		sortOrder: "desc" as const,
	},
] as const;

type Props = {
	organizationId?: string;
};

export function SkillsLibrary({ organizationId: propOrgId }: Props) {
	const router = useRouter();
	const { organizationId: contextOrgId, basePath } = useOrganizationContext();
	const organizationId = propOrgId ?? contextOrgId;

	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [scopeFilter, setScopeFilter] = useState<string>("all");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [sortValue, setSortValue] = useState<string>("updatedAt-desc");
	const [isFeatured, setIsFeatured] = useState(false);

	const activeSort =
		sortOptions.find((o) => o.value === sortValue) ?? sortOptions[0];

	const { data, isLoading, refetch } = useQuery(
		orpc.skills.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
				scope: isFeatured
					? "SYSTEM"
					: scopeFilter === "all"
						? undefined
						: (scopeFilter as "SYSTEM" | "ORGANIZATION" | "USER"),
				category: categoryFilter === "all" ? undefined : categoryFilter,
				sortBy: activeSort.sortBy,
				sortOrder: activeSort.sortOrder,
			},
		}),
	);

	const skills = data?.skills ?? [];

	// Extract unique categories from loaded skills
	const categories = [
		...new Set(
			skills
				.map((s) => s.category)
				.filter((c): c is string => c !== null),
		),
	];

	return (
		<div className="space-y-4">
			<SkillsHero />

			{/* Filter Pills + Actions Bar (Databricks Workspace DuBois toolbar) */}
			<div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						onClick={() => {
							setCategoryFilter("all");
							setIsFeatured(false);
							setSortValue("updatedAt-desc");
						}}
						aria-pressed={
							categoryFilter === "all" &&
							!isFeatured &&
							sortValue !== "useCount-desc"
						}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
							categoryFilter === "all" &&
								!isFeatured &&
								sortValue !== "useCount-desc"
								? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
								: "border-border bg-card text-foreground hover:bg-muted/60",
						)}
					>
						<SparklesIcon className="size-4 text-foreground" />
						All
					</button>
					<button
						type="button"
						onClick={() => {
							setIsFeatured(!isFeatured);
							setCategoryFilter("all");
						}}
						aria-pressed={isFeatured}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
							isFeatured
								? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
								: "border-border bg-card text-foreground hover:bg-muted/60",
						)}
					>
						<StarIcon className="size-4 text-foreground" />
						Featured
					</button>
					<button
						type="button"
						onClick={() => {
							setIsFeatured(false);
							setCategoryFilter("all");
							setSortValue(
								sortValue === "useCount-desc"
									? "updatedAt-desc"
									: "useCount-desc",
							);
						}}
						aria-pressed={
							!isFeatured &&
							categoryFilter === "all" &&
							sortValue === "useCount-desc"
						}
						className={cn(
							"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
							!isFeatured &&
								categoryFilter === "all" &&
								sortValue === "useCount-desc"
								? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
								: "border-border bg-card text-foreground hover:bg-muted/60",
						)}
					>
						<TrendingUpIcon className="size-4 text-foreground" />
						Popular
					</button>
					{categories.map((cat) => {
						const selected = categoryFilter === cat && !isFeatured;
						return (
							<button
								key={cat}
								type="button"
								onClick={() => {
									setCategoryFilter(cat);
									setIsFeatured(false);
								}}
								aria-pressed={selected}
								className={cn(
									"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
									selected
										? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
										: "border-border bg-card text-foreground hover:bg-muted/60",
								)}
							>
								<LayoutGridIcon className="size-4 text-foreground" />
								{cat}
							</button>
						);
					})}
				</div>

				<div className="flex flex-wrap items-center gap-2 shrink-0">
					<div
						data-onboarding-target="skills-search"
						className="relative w-full sm:w-56"
					>
						<SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
						<SearchInput
							placeholder="Search skills..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="h-8 pl-8"
						/>
					</div>

					<Select value={scopeFilter} onValueChange={setScopeFilter}>
						<SelectTrigger className="h-8 w-[140px]">
							<SelectValue placeholder="Scope" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All Scopes</SelectItem>
							<SelectItem value="SYSTEM">System</SelectItem>
							<SelectItem value="ORGANIZATION">
								Organization
							</SelectItem>
							<SelectItem value="USER">Personal</SelectItem>
						</SelectContent>
					</Select>

					<Select value={sortValue} onValueChange={setSortValue}>
						<SelectTrigger
							data-onboarding-target="skills-sort"
							className="h-8 w-[160px]"
						>
							<ArrowUpDownIcon className="size-3.5 mr-1.5 text-muted-foreground" />
							<SelectValue placeholder="Sort" />
						</SelectTrigger>
						<SelectContent>
							{sortOptions.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									{opt.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>

					<Button
						data-onboarding-target="skills-new"
						size="sm"
						onClick={() => router.push(`${basePath}/skills/new`)}
					>
						<PlusIcon className="size-3.5" />
						New Skill
					</Button>
				</div>
			</div>

			{/* Skills Grid */}
			{isLoading ? (
				<div className="flex items-center justify-center py-16">
					<Spinner />
				</div>
			) : skills.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
					<PuzzleIcon
						className="size-10 text-muted-foreground/45"
						aria-hidden="true"
					/>
					<p className="text-sm text-muted-foreground">
						{searchQuery ||
						scopeFilter !== "all" ||
						categoryFilter !== "all" ||
						isFeatured
							? "No skills found matching your filters"
							: "No skills yet"}
					</p>
					{!searchQuery &&
						scopeFilter === "all" &&
						categoryFilter === "all" &&
						!isFeatured && (
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									router.push(`${basePath}/skills/new`)
								}
							>
								<PlusIcon className="size-3.5" />
								Create Your First Skill
							</Button>
						)}
				</div>
			) : (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
					{skills.map((skill) => (
						<SkillCard
							key={skill.id}
							skill={skill}
							onUpdate={refetch}
						/>
					))}
				</div>
			)}
		</div>
	);
}
