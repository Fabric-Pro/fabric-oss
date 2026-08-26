"use client";

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
import { GridIcon, ListIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import { DeleteTemplateDialog } from "./DeleteTemplateDialog";
import { ExecuteTemplateDialog } from "./ExecuteTemplateDialog";
import { TemplateCard } from "./TemplateCard";
import { TemplatesHero } from "./TemplatesHero";

type ViewMode = "grid" | "list";

type TemplateParameter = {
	name: string;
	type: "string" | "number" | "boolean" | "url" | "selector" | "json";
	description?: string;
	required: boolean;
	defaultValue?: unknown;
};

type AutomationTemplate = {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
	tags: string[];
	isPublic: boolean;
	useCount: number;
	lastUsedAt: Date | string | null;
	createdAt: Date | string;
	updatedAt: Date | string;
	version: number;
	parameters?: TemplateParameter[] | null;
};

type Props = {
	organizationId?: string;
};

export function TemplatesList({ organizationId }: Props) {
	const router = useRouter();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [visibilityFilter, setVisibilityFilter] = useState<string>("all");
	const [viewMode, setViewMode] = useState<ViewMode>("grid");

	// Dialog states
	const [executeTemplate, setExecuteTemplate] =
		useState<AutomationTemplate | null>(null);
	const [deleteTemplate, setDeleteTemplate] =
		useState<AutomationTemplate | null>(null);

	// Fetch templates
	const { data, isLoading } = useQuery(
		orpc.automationTemplates.list.queryOptions({
			input: {
				organizationId,
				limit: 50,
				offset: 0,
				search: debouncedSearch || undefined,
				category: categoryFilter === "all" ? undefined : categoryFilter,
				includePublic:
					visibilityFilter === "all" || visibilityFilter === "public",
			},
		}),
	);

	const templates = (data?.templates ?? []) as AutomationTemplate[];

	// Extract unique categories from templates
	const categories = [
		...new Set(templates.map((t) => t.category).filter(Boolean)),
	] as string[];

	return (
		<div className="space-y-8">
			{/* Hero Section */}
			<TemplatesHero />

			{/* Category Filter Pills */}
			{categories.length > 0 && (
				<div className="flex flex-wrap justify-center gap-2">
					<button
						type="button"
						onClick={() => setCategoryFilter("all")}
						className={cn(
							"rounded-full px-4 py-2 font-medium text-sm transition-all",
							categoryFilter === "all"
								? "bg-primary text-primary-foreground"
								: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
						)}
					>
						All
					</button>
					{categories.map((category) => (
						<button
							key={category}
							type="button"
							onClick={() => setCategoryFilter(category)}
							className={cn(
								"rounded-full px-4 py-2 font-medium text-sm transition-all",
								categoryFilter === category
									? "bg-primary text-primary-foreground"
									: "bg-card hover:bg-card/80 text-foreground/70 hover:text-foreground border",
							)}
						>
							{category}
						</button>
					))}
				</div>
			)}

			{/* Actions Bar */}
			<div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
				<div className="flex flex-1 gap-2 w-full sm:w-auto flex-wrap">
					{/* Search */}
					<div
						data-onboarding-target="automation-templates-search"
						className="relative flex-1 max-w-md"
					>
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<SearchInput
							placeholder="Search templates..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>

					{/* Visibility Filter */}
					<Select
						value={visibilityFilter}
						onValueChange={setVisibilityFilter}
					>
						<SelectTrigger
							data-onboarding-target="automation-templates-visibility"
							className="w-[140px]"
						>
							<SelectValue placeholder="Visibility" />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All</SelectItem>
							<SelectItem value="private">Private</SelectItem>
							<SelectItem value="public">Public</SelectItem>
						</SelectContent>
					</Select>
				</div>

				<div className="flex gap-2 items-center">
					{/* View Toggle */}
					<div className="flex gap-1 border rounded-md p-1">
						<Button
							variant={viewMode === "grid" ? "default" : "ghost"}
							size="icon-sm"
							onClick={() => setViewMode("grid")}
							aria-label="Grid view"
						>
							<GridIcon className="h-4 w-4" />
						</Button>
						<Button
							variant={viewMode === "list" ? "default" : "ghost"}
							size="icon-sm"
							onClick={() => setViewMode("list")}
							aria-label="List view"
						>
							<ListIcon className="h-4 w-4" />
						</Button>
					</div>

					{/* Create Button */}
					<Button
						data-onboarding-target="automation-templates-new"
						onClick={() =>
							router.push("/app/automation-templates/new")
						}
					>
						<PlusIcon className="h-4 w-4 mr-2" />
						New Template
					</Button>
				</div>
			</div>

			{/* Templates Display */}
			{isLoading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner />
				</div>
			) : templates.length === 0 ? (
				<div className="text-center py-12">
					<p className="text-muted-foreground mb-4">
						{searchQuery ||
						categoryFilter !== "all" ||
						visibilityFilter !== "all"
							? "No templates found matching your filters"
							: "No templates yet. Create your first automation template!"}
					</p>
					{!searchQuery &&
						categoryFilter === "all" &&
						visibilityFilter === "all" && (
							<Button
								onClick={() =>
									router.push("/app/automation-templates/new")
								}
							>
								<PlusIcon className="h-4 w-4 mr-2" />
								Create Your First Template
							</Button>
						)}
				</div>
			) : (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
					{templates.map((template) => (
						<TemplateCard
							key={template.id}
							template={template}
							onExecute={setExecuteTemplate}
							onDelete={setDeleteTemplate}
						/>
					))}
				</div>
			)}

			{/* Dialogs */}
			<ExecuteTemplateDialog
				template={executeTemplate}
				open={!!executeTemplate}
				onOpenChange={(open) => !open && setExecuteTemplate(null)}
				organizationId={organizationId}
			/>
			<DeleteTemplateDialog
				template={deleteTemplate}
				open={!!deleteTemplate}
				onOpenChange={(open) => !open && setDeleteTemplate(null)}
				organizationId={organizationId}
			/>
		</div>
	);
}
