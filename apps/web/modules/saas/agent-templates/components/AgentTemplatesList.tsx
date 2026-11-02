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
import { TemplatePreviewSheet } from "./TemplatePreviewSheet";

const categories = [
	{
		value: "all",
		label: "All Agents",
		icon: LayoutGridIcon,
		color: "text-muted-foreground",
	},
	{
		value: "DATA",
		label: "Data",
		icon: BarChart3Icon,
		color: "text-muted-foreground",
	},
	{
		value: "ENGINEERING",
		label: "Engineering",
		icon: CodeIcon,
		color: "text-muted-foreground",
	},
	{
		value: "SALES",
		label: "Sales",
		icon: BriefcaseIcon,
		color: "text-muted-foreground",
	},
	{
		value: "SUPPORT",
		label: "Support",
		icon: HeadphonesIcon,
		color: "text-muted-foreground",
	},
	{
		value: "MARKETING",
		label: "Marketing",
		icon: MegaphoneIcon,
		color: "text-muted-foreground",
	},
	{
		value: "PRODUCT",
		label: "Product",
		icon: RocketIcon,
		color: "text-muted-foreground",
	},
	{
		value: "KNOWLEDGE",
		label: "Knowledge",
		icon: BookOpenIcon,
		color: "text-muted-foreground",
	},
	{
		value: "PRODUCTIVITY",
		label: "Productivity",
		icon: ZapIcon,
		color: "text-muted-foreground",
	},
	{
		value: "FINANCE",
		label: "Finance",
		icon: WalletIcon,
		color: "text-muted-foreground",
	},
	{
		value: "LEGAL",
		label: "Legal",
		icon: ScaleIcon,
		color: "text-muted-foreground",
	},
	{
		value: "OPERATIONS",
		label: "Operations",
		icon: SettingsIcon,
		color: "text-muted-foreground",
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
		<div className="space-y-4">
			{/* One toolbar: categories on the left, search and actions on
			    the right. The onboarding anchors stay where they were. */}
			<div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
				<div
					data-onboarding-target="agent-templates-category-filter"
					className="flex flex-wrap items-center gap-2"
				>
					{categories.map((cat) => {
						const Icon = cat.icon;
						const selected = categoryFilter === cat.value;
						return (
							<button
								key={cat.value}
								type="button"
								onClick={() => setCategoryFilter(cat.value)}
								aria-pressed={selected}
								className={cn(
									"inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
									selected
										? "border-primary bg-primary/[0.10] text-foreground font-medium dark:bg-primary/[0.20]"
										: "border-border bg-card text-foreground hover:bg-muted/60",
								)}
							>
								<Icon className="size-4 text-foreground" />
								{cat.label}
							</button>
						);
					})}
				</div>

				<div className="flex flex-wrap items-center gap-2 shrink-0">
					<div
						data-onboarding-target="agent-templates-search"
						className="relative w-full sm:w-56"
					>
						<SearchIcon className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<SearchInput
							placeholder="Search templates..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="h-8 pl-8"
						/>
					</div>
					<Button
						data-onboarding-target="agent-templates-create-agent"
						asChild
						variant="primary"
						size="sm"
					>
						<Link
							href={`${basePath.replace("agent-templates", "agents")}/create`}
						>
							<PlusIcon className="size-3.5" />
							Create New Agent
						</Link>
					</Button>
					{user?.role === "admin" && (
						<Button asChild variant="outline" size="sm">
							<Link href={`${basePath}/new`}>
								<PlusIcon className="size-3.5" />
								Create New Template
							</Link>
						</Button>
					)}
				</div>
			</div>

			{/* Content */}
			{isLoading ? (
				<div className="flex justify-center py-16">
					<Spinner className="h-6 w-6" />
				</div>
			) : templates.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
					<SparklesIcon
						className="size-10 text-muted-foreground/45"
						strokeWidth={1.5}
						aria-hidden="true"
					/>
					<div className="space-y-1">
						<p className="text-sm text-muted-foreground">
							{debouncedSearch
								? "No templates match your search"
								: "No templates found"}
						</p>
					</div>
					{user?.role === "admin" && (
						<Button asChild size="sm" variant="outline">
							<Link href={`${basePath}/new`}>
								<PlusIcon className="size-3.5" />
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
