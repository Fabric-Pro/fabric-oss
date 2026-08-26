"use client";

import { useEffectiveOrganizationId } from "@saas/organizations/hooks";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	BarChart3Icon,
	BriefcaseIcon,
	CodeIcon,
	FileTextIcon,
	LayoutGridIcon,
	MessageSquareIcon,
	PlusIcon,
	SearchIcon,
	SparklesIcon,
	VideoIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { ReportsHero } from "./ReportsHero";
import { ReportTemplateCard } from "./ReportTemplateCard";

const categories = [
	{
		value: "all",
		label: "All Templates",
		icon: LayoutGridIcon,
		color: "text-muted-foreground",
	},
	{
		value: "Video & Audio",
		label: "Video & Audio",
		icon: VideoIcon,
		color: "text-destructive",
	},
	{
		value: "Content Analysis",
		label: "Content Analysis",
		icon: BarChart3Icon,
		color: "text-secondary",
	},
	{
		value: "Development",
		label: "Development",
		icon: CodeIcon,
		color: "text-success dark:text-green-400",
	},
	{
		value: "Communication",
		label: "Communication",
		icon: MessageSquareIcon,
		color: "text-muted-foreground",
	},
	{
		value: "Business",
		label: "Business",
		icon: BriefcaseIcon,
		color: "text-highlight",
	},
];

type Props = {
	organizationId?: string;
	basePath?: string;
};

export function ReportTemplatesList({
	organizationId: propOrgId,
	basePath = "/app/report-templates",
}: Props) {
	const _queryClient = useQueryClient();
	// Use effective organization ID to properly handle personal vs org context
	const organizationId = useEffectiveOrganizationId(propOrgId);
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [selectedTemplate, setSelectedTemplate] = useState<any>(null);

	// Fetch templates
	const { data, isLoading, refetch } = useQuery(
		orpc.reports.templates.list.queryOptions({
			input: {
				organizationId,
				limit: 100,
				offset: 0,
				search: debouncedSearch || undefined,
			},
		}),
	);

	// Fetch integration status
	const { data: integrationData } = useQuery(
		orpc.reports.integrations.status.queryOptions({
			input: { organizationId },
		}),
	);

	// Delete mutation
	const deleteMutation = useMutation(
		orpc.reports.templates.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Template deleted");
				refetch();
			},
			onError: () => {
				toast.error("Failed to delete template");
			},
		}),
	);

	const templates = data?.templates ?? [];
	const configuredIntegrations = integrationData?.mcpServers ?? [];

	// Filter by category
	const filteredTemplates =
		categoryFilter === "all"
			? templates
			: templates.filter((t: any) => t.category === categoryFilter);

	// Group by category for display
	const groupedTemplates = filteredTemplates.reduce(
		(acc: Record<string, any[]>, template: any) => {
			const cat = template.category || "Other";
			if (!acc[cat]) {
				acc[cat] = [];
			}
			acc[cat].push(template);
			return acc;
		},
		{},
	);

	const handleDelete = (id: string) => {
		if (window.confirm("Are you sure you want to delete this template?")) {
			deleteMutation.mutate({ id });
		}
	};

	const handleCreateInstance = (template: any) => {
		setSelectedTemplate(template);
	};

	return (
		<div className="space-y-8">
			<ReportsHero />

			{/* Category Pills - Modern style with icons */}
			<div
				data-onboarding-target="reports-category-filter"
				className="flex flex-wrap justify-center gap-2"
			>
				{categories.map((cat) => {
					const Icon = cat.icon;
					return (
						<button
							key={cat.value}
							type="button"
							onClick={() => setCategoryFilter(cat.value)}
							className={cn(
								"flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all duration-150",
								categoryFilter === cat.value
									? "bg-primary text-primary-foreground"
									: "bg-background hover:bg-muted text-muted-foreground border border-border hover:text-foreground",
							)}
						>
							<Icon
								className={cn(
									"h-4 w-4",
									categoryFilter === cat.value
										? ""
										: cat.color,
								)}
							/>
							{cat.label}
						</button>
					);
				})}
			</div>

			{/* Search & Actions */}
			<div className="flex gap-3 items-center justify-between">
				<div className="relative flex-1 max-w-md">
					<SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search templates..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-10"
					/>
				</div>
				<Button
					data-onboarding-target="reports-new-template"
					asChild
					className="rounded-xl h-11 gap-2"
				>
					<Link href={`${basePath}/new`}>
						<PlusIcon className="h-4 w-4" />
						Custom Template
					</Link>
				</Button>
			</div>

			{/* Content */}
			{isLoading ? (
				<div className="flex justify-center py-16">
					<Spinner className="h-8 w-8" />
				</div>
			) : filteredTemplates.length === 0 ? (
				<div className="text-center py-16 space-y-4">
					<div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center mx-auto">
						<SparklesIcon className="w-8 h-8 text-muted-foreground" />
					</div>
					<div>
						<h3 className="text-base font-medium">
							No templates found
						</h3>
						<p className="text-muted-foreground text-sm">
							{debouncedSearch
								? "No templates match your search"
								: "Get started by creating your first template"}
						</p>
					</div>
					<Button asChild className="rounded-xl gap-2">
						<Link href={`${basePath}/new`}>
							<PlusIcon className="h-4 w-4" />
							Create custom template
						</Link>
					</Button>
				</div>
			) : categoryFilter === "all" ? (
				// Grouped view
				<div className="space-y-10">
					{Object.entries(groupedTemplates).map(
						([category, catTemplates]) => {
							const catInfo = categories.find(
								(c) => c.value === category,
							);
							const CatIcon = catInfo?.icon || FileTextIcon;
							const catColor = catInfo?.color || "text-slate-600";

							return (
								<div key={category}>
									<div className="flex items-center gap-3 mb-5">
										<div
											className={cn(
												"w-8 h-8 rounded-lg border border-border bg-muted/60 flex items-center justify-center",
												catColor,
											)}
										>
											<CatIcon className="h-5 w-5" />
										</div>
										<h3 className="text-base font-medium text-foreground">
											{category}
										</h3>
										<span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded font-medium tabular-nums">
											{catTemplates.length}
										</span>
									</div>
									<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
										{catTemplates.map((template: any) => (
											<ReportTemplateCard
												key={template.id}
												template={template}
												onCreateInstance={
													handleCreateInstance
												}
												onDelete={handleDelete}
												basePath={basePath}
												configuredIntegrations={
													configuredIntegrations
												}
											/>
										))}
									</div>
								</div>
							);
						},
					)}
				</div>
			) : (
				// Flat view for single category
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
					{filteredTemplates.map((template: any) => (
						<ReportTemplateCard
							key={template.id}
							template={template}
							onCreateInstance={handleCreateInstance}
							onDelete={handleDelete}
							basePath={basePath}
							configuredIntegrations={configuredIntegrations}
						/>
					))}
				</div>
			)}

			{/* Create Instance Dialog */}
			{selectedTemplate && (
				<CreateInstanceDialog
					template={selectedTemplate}
					organizationId={organizationId}
					onClose={() => setSelectedTemplate(null)}
					basePath={basePath}
				/>
			)}
		</div>
	);
}
