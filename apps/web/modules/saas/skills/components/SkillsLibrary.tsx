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
import { cn } from "@ui/lib";
import { ArrowUpDownIcon, PlusIcon, SearchIcon, StarIcon } from "lucide-react";
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
		<div className="space-y-6">
			<SkillsHero />

			{/* Category + Featured Pills */}
			{categories.length > 0 && (
				<div className="flex flex-wrap gap-2">
					<button
						type="button"
						onClick={() => setCategoryFilter("all")}
						className={cn(
							"rounded-full px-4 py-2 font-medium text-sm transition-all",
							categoryFilter === "all" && !isFeatured
								? "bg-primary text-primary-foreground"
								: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
						)}
					>
						All
					</button>
					<button
						type="button"
						onClick={() => {
							setIsFeatured(!isFeatured);
							setCategoryFilter("all");
						}}
						className={cn(
							"rounded-full px-4 py-2 font-medium text-sm transition-all flex items-center gap-1.5",
							isFeatured
								? "bg-amber-500 text-white"
								: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
						)}
					>
						<StarIcon className="h-3.5 w-3.5" />
						Featured
					</button>
					{categories.map((cat) => (
						<button
							key={cat}
							type="button"
							onClick={() => {
								setCategoryFilter(cat);
								setIsFeatured(false);
							}}
							className={cn(
								"rounded-full px-4 py-2 font-medium text-sm transition-all",
								categoryFilter === cat && !isFeatured
									? "bg-primary text-primary-foreground"
									: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
							)}
						>
							{cat}
						</button>
					))}
				</div>
			)}

			{/* Actions Bar */}
			<div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
				<div className="flex flex-1 gap-2 w-full sm:w-auto">
					<div
						data-onboarding-target="skills-search"
						className="relative flex-1 max-w-md"
					>
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search skills..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>

					<Select value={scopeFilter} onValueChange={setScopeFilter}>
						<SelectTrigger className="w-[160px]">
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
							className="w-[170px]"
						>
							<ArrowUpDownIcon className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
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
				</div>

				<Button
					data-onboarding-target="skills-new"
					onClick={() => router.push(`${basePath}/skills/new`)}
				>
					<PlusIcon className="h-4 w-4 mr-2" />
					New Skill
				</Button>
			</div>

			{/* Skills Grid */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : skills.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery ||
						scopeFilter !== "all" ||
						categoryFilter !== "all" ||
						isFeatured
							? "No skills found matching your filters"
							: "No skills yet. Create your first skill to get started!"}
					</p>
					{!searchQuery &&
						scopeFilter === "all" &&
						categoryFilter === "all" &&
						!isFeatured && (
							<Button
								onClick={() =>
									router.push(`${basePath}/skills/new`)
								}
							>
								<PlusIcon className="h-4 w-4 mr-2" />
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
