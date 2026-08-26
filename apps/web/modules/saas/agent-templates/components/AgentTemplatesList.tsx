"use client";

/**
 * Agent Templates List
 * Gallery with category filtering and template preview sidebar
 */

import { useSession } from "@saas/auth/hooks/use-session";
import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	BarChart3Icon,
	BookOpenIcon,
	BriefcaseIcon,
	CodeIcon,
	HeadphonesIcon,
	LayoutGridIcon,
	MegaphoneIcon,
	PlusIcon,
	RocketIcon,
	ScaleIcon,
	SearchIcon,
	SettingsIcon,
	SparklesIcon,
	WalletIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { useDebounceValue } from "usehooks-ts";
import { AgentTemplateCard } from "./AgentTemplateCard";
import { AgentTemplatesHero } from "./AgentTemplatesHero";
import { TemplatePreviewSheet } from "./TemplatePreviewSheet";

const categories = [
	{
		value: "all",
		label: "All Agents",
		icon: LayoutGridIcon,
		color: "text-slate-600 dark:text-slate-400",
	},
	{
		value: "DATA",
		label: "Data",
		icon: BarChart3Icon,
		color: "text-blue-600 dark:text-blue-400",
	},
	{
		value: "ENGINEERING",
		label: "Engineering",
		icon: CodeIcon,
		color: "text-success dark:text-green-400",
	},
	{
		value: "SALES",
		label: "Sales",
		icon: BriefcaseIcon,
		color: "text-amber-600 dark:text-amber-400",
	},
	{
		value: "SUPPORT",
		label: "Support",
		icon: HeadphonesIcon,
		color: "text-purple-600 dark:text-purple-400",
	},
	{
		value: "MARKETING",
		label: "Marketing",
		icon: MegaphoneIcon,
		color: "text-pink-600 dark:text-pink-400",
	},
	{
		value: "PRODUCT",
		label: "Product",
		icon: RocketIcon,
		color: "text-cyan-600 dark:text-cyan-400",
	},
	{
		value: "KNOWLEDGE",
		label: "Knowledge",
		icon: BookOpenIcon,
		color: "text-indigo-600 dark:text-indigo-400",
	},
	{
		value: "PRODUCTIVITY",
		label: "Productivity",
		icon: ZapIcon,
		color: "text-highlight dark:text-yellow-400",
	},
	{
		value: "FINANCE",
		label: "Finance",
		icon: WalletIcon,
		color: "text-emerald-600 dark:text-emerald-400",
	},
	{
		value: "LEGAL",
		label: "Legal",
		icon: ScaleIcon,
		color: "text-slate-600 dark:text-slate-400",
	},
	{
		value: "OPERATIONS",
		label: "Operations",
		icon: SettingsIcon,
		color: "text-highlight dark:text-orange-400",
	},
];

type Props = {
	organizationId?: string;
	basePath?: string;
};

// Template type for the preview sheet
type AgentTemplate = {
	id: string;
	slug: string;
	name: string;
	displayName: string;
	description: string;
	heroEmojis: string[];
	heroImageUrl?: string | null;
	category: string;
	tags: string[];
	scope: string;
	instructions: string;
	suggestedModel?: string | null;
	isFeatured: boolean;
	useCount: number;
	lastUsedAt: string | null;
	createdAt: string;
};

export function AgentTemplatesList({
	organizationId,
	basePath = "/app/agent-templates",
}: Props) {
	const { user } = useSession();
	const _queryClient = useQueryClient();
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedSearch] = useDebounceValue(searchQuery, 300);
	const [categoryFilter, setCategoryFilter] = useState<string>("all");

	// Template preview sheet state
	const [previewOpen, setPreviewOpen] = useState(false);
	const [selectedTemplate, setSelectedTemplate] =
		useState<AgentTemplate | null>(null);

	const handleTemplateClick = (template: AgentTemplate) => {
		setSelectedTemplate(template);
		setPreviewOpen(true);
	};

	// Category type for API
	type AgentTemplateCategory =
		| "DATA"
		| "DESIGN"
		| "ENGINEERING"
		| "FINANCE"
		| "HIRING"
		| "KNOWLEDGE"
		| "LEGAL"
		| "MARKETING"
		| "OPERATIONS"
		| "PRODUCT"
		| "PRODUCT_MANAGEMENT"
		| "PRODUCTIVITY"
		| "SALES"
		| "SUPPORT"
		| "GENERAL";

	// Fetch templates
	const { data, isLoading, refetch } = useQuery(
		orpc.agentTemplates.templates.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 100,
				offset: 0,
				search: debouncedSearch || undefined,
				category:
					categoryFilter !== "all"
						? (categoryFilter as AgentTemplateCategory)
						: undefined,
			},
		}),
	);

	// Delete mutation
	const deleteMutation = useMutation(
		orpc.agentTemplates.templates.delete.mutationOptions({
			onSuccess: () => {
				toast.success("Template deleted");
				// Close the preview sheet and clear selected template
				setPreviewOpen(false);
				setSelectedTemplate(null);
				refetch();
			},
			onError: () => {
				toast.error("Failed to delete template");
			},
		}),
	);

	const templates = data?.templates ?? [];

	// Group by category for "all" view
	const groupedTemplates = templates.reduce(
		(acc: Record<string, any[]>, template: any) => {
			const cat = template.category || "GENERAL";
			if (!acc[cat]) {
				acc[cat] = [];
			}
			acc[cat].push(template);
			return acc;
		},
		{},
	);

	// Order categories for display (featured first)
	const categoryOrder = [
		"DATA",
		"ENGINEERING",
		"SALES",
		"SUPPORT",
		"MARKETING",
		"PRODUCT",
		"KNOWLEDGE",
		"PRODUCTIVITY",
		"FINANCE",
		"LEGAL",
		"OPERATIONS",
		"GENERAL",
	];

	const sortedCategories = Object.keys(groupedTemplates).sort(
		(a, b) => categoryOrder.indexOf(a) - categoryOrder.indexOf(b),
	);

	const handleDelete = (id: string) => {
		if (window.confirm("Are you sure you want to delete this template?")) {
			deleteMutation.mutate({ id });
		}
	};

	const getCategoryInfo = (category: string) => {
		const found = categories.find((c) => c.value === category);
		return (
			found || {
				label: category,
				icon: LayoutGridIcon,
				color: "text-slate-600",
			}
		);
	};

	return (
		<div className="space-y-8">
			<AgentTemplatesHero />

			{/* Section header for templates */}
			<div className="flex items-center gap-3 pt-4 border-t">
				<span
					className="block h-4 w-0.5 shrink-0 bg-primary"
					aria-hidden="true"
				/>
				<p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground select-none">
					Start from a template
				</p>
			</div>

			{/* Category Pills - Modern style with icons */}
			<div
				data-onboarding-target="agent-templates-category-filter"
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
				<div
					data-onboarding-target="agent-templates-search"
					className="relative flex-1 max-w-md"
				>
					<SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
					<SearchInput
						placeholder="Search templates..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="pl-10"
					/>
				</div>
				<div className="flex gap-2">
					<Button
						data-onboarding-target="agent-templates-create-agent"
						asChild
						variant="outline"
					>
						<Link
							href={`${basePath.replace("agent-templates", "agents")}/create`}
						>
							<PlusIcon className="h-4 w-4" />
							Create New Agent
						</Link>
					</Button>
					{user?.role === "admin" && (
						<Button asChild>
							<Link href={`${basePath}/new`}>
								<PlusIcon className="h-4 w-4" />
								Create New Template
							</Link>
						</Button>
					)}
				</div>
			</div>

			{/* Content */}
			{isLoading ? (
				<div className="flex justify-center py-16">
					<Spinner className="h-8 w-8" />
				</div>
			) : templates.length === 0 ? (
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
					{user?.role === "admin" && (
						<Button asChild>
							<Link href={`${basePath}/new`}>
								<PlusIcon className="h-4 w-4" />
								Create New Template
							</Link>
						</Button>
					)}
				</div>
			) : categoryFilter === "all" ? (
				// Grouped view
				<div className="space-y-10">
					{sortedCategories.map((category) => {
						const catTemplates = groupedTemplates[category];
						if (!catTemplates?.length) {
							return null;
						}

						const catInfo = getCategoryInfo(category);
						const CatIcon = catInfo.icon;

						return (
							<div key={category}>
								<div className="flex items-center gap-3 mb-5">
									<div
										className={cn(
											"w-8 h-8 rounded-lg border border-border bg-muted/60 flex items-center justify-center",
											catInfo.color,
										)}
									>
										<CatIcon className="h-5 w-5" />
									</div>
									<h3 className="text-base font-medium text-foreground">
										{catInfo.label}
									</h3>
									<span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded font-medium tabular-nums">
										{catTemplates.length}
									</span>
								</div>
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
									{catTemplates.map((template: any) => (
										<AgentTemplateCard
											key={template.id}
											template={template}
											onDelete={handleDelete}
											basePath={basePath}
											onClick={() =>
												handleTemplateClick(template)
											}
										/>
									))}
								</div>
							</div>
						);
					})}
				</div>
			) : (
				// Flat view for single category
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
					{templates.map((template: any) => (
						<AgentTemplateCard
							key={template.id}
							template={template}
							onDelete={handleDelete}
							basePath={basePath}
							onClick={() => handleTemplateClick(template)}
						/>
					))}
				</div>
			)}

			{/* Template Preview Sheet */}
			<TemplatePreviewSheet
				open={previewOpen}
				onOpenChange={setPreviewOpen}
				template={selectedTemplate}
				basePath={basePath}
			/>
		</div>
	);
}
