"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PuzzleIcon } from "@saas/shared/components/icons/PuzzleIcon";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftIcon,
	BarChart3Icon,
	BookOpenIcon,
	BriefcaseIcon,
	CodeIcon,
	HeadphonesIcon,
	Loader2Icon,
	MegaphoneIcon,
	PlusIcon,
	RocketIcon,
	SaveIcon,
	ScaleIcon,
	SearchIcon,
	SettingsIcon,
	SparklesIcon,
	TagIcon,
	WalletIcon,
	XIcon,
	ZapIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

interface SkillEditorProps {
	skill?: {
		id: string;
		slug: string;
		name: string;
		description: string;
		content: string;
		category: string | null;
		tags: string[];
	};
}

const CATEGORY_OPTIONS = [
	{
		value: "data-analysis",
		label: "Data Analysis",
		icon: BarChart3Icon,
		gradient: "from-blue-500 to-blue-600",
	},
	{
		value: "engineering",
		label: "Engineering",
		icon: CodeIcon,
		gradient: "from-green-500 to-green-600",
	},
	{
		value: "sales",
		label: "Sales",
		icon: BriefcaseIcon,
		gradient: "from-amber-500 to-amber-600",
	},
	{
		value: "support",
		label: "Support",
		icon: HeadphonesIcon,
		gradient: "from-purple-500 to-purple-600",
	},
	{
		value: "marketing",
		label: "Marketing",
		icon: MegaphoneIcon,
		gradient: "from-pink-500 to-pink-600",
	},
	{
		value: "product",
		label: "Product",
		icon: RocketIcon,
		gradient: "from-cyan-500 to-cyan-600",
	},
	{
		value: "research",
		label: "Research",
		icon: SearchIcon,
		gradient: "from-indigo-500 to-indigo-600",
	},
	{
		value: "productivity",
		label: "Productivity",
		icon: ZapIcon,
		gradient: "from-yellow-500 to-yellow-600",
	},
	{
		value: "finance",
		label: "Finance",
		icon: WalletIcon,
		gradient: "from-emerald-500 to-emerald-600",
	},
	{
		value: "legal",
		label: "Legal",
		icon: ScaleIcon,
		gradient: "from-slate-500 to-slate-600",
	},
	{
		value: "operations",
		label: "Operations",
		icon: SettingsIcon,
		gradient: "from-orange-500 to-orange-600",
	},
	{
		value: "knowledge",
		label: "Knowledge",
		icon: BookOpenIcon,
		gradient: "from-teal-500 to-teal-600",
	},
];

const SUGGESTED_TAGS = [
	"data",
	"analysis",
	"automation",
	"reporting",
	"research",
	"writing",
	"coding",
	"communication",
	"planning",
	"strategy",
];

const builderSectionClassName =
	"rounded-2xl border border-border/60 bg-card/60 p-6";

const subtleInputClassName =
	"rounded-xl border border-border/60 bg-background/55 shadow-none";

export function SkillEditor({ skill }: SkillEditorProps) {
	const router = useRouter();
	const tooltipT = useTranslations("tooltips.agents");
	const queryClient = useQueryClient();
	const { organizationId, basePath } = useOrganizationContext();

	const isEditing = !!skill;

	const [name, setName] = useState(skill?.name ?? "");
	const [slug, setSlug] = useState(skill?.slug ?? "");
	const [description, setDescription] = useState(skill?.description ?? "");
	const [content, setContent] = useState(skill?.content ?? "");
	const [category, setCategory] = useState(skill?.category ?? "");
	const [tagInput, setTagInput] = useState("");
	const [tags, setTags] = useState<string[]>(skill?.tags ?? []);

	const createMutation = useMutation({
		mutationFn: () =>
			orpcClient.skills.create({
				organizationId: organizationId ?? null,
				slug,
				name,
				description,
				content,
				category: category || undefined,
				tags,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			toast.success("Skill created");
			router.push(`${basePath}/skills`);
		},
		onError: (error) => {
			toast.error(error.message || "Failed to create skill");
		},
	});

	const updateMutation = useMutation({
		mutationFn: () =>
			orpcClient.skills.update({
				id: skill?.id ?? "",
				name,
				description,
				content,
				category: category || undefined,
				tags,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["skills"] });
			toast.success("Skill updated");
			router.push(`${basePath}/skills`);
		},
		onError: (error) => {
			toast.error(error.message || "Failed to update skill");
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim()) {
			toast.error("Please enter a skill name");
			return;
		}
		if (!content.trim()) {
			toast.error("Please enter skill content");
			return;
		}
		if (isEditing) {
			updateMutation.mutate();
		} else {
			createMutation.mutate();
		}
	};

	const handleNameChange = (value: string) => {
		setName(value);
		if (!isEditing) {
			setSlug(
				value
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, ""),
			);
		}
	};

	const handleAddTag = () => {
		const trimmed = tagInput.trim();
		if (trimmed && !tags.includes(trimmed)) {
			setTags([...tags, trimmed]);
			setTagInput("");
		}
	};

	const handleRemoveTag = (tag: string) => {
		setTags(tags.filter((t) => t !== tag));
	};

	const handleAddSuggestedTag = (tag: string) => {
		if (!tags.includes(tag)) {
			setTags([...tags, tag]);
		}
	};

	const isSubmitting = createMutation.isPending || updateMutation.isPending;

	const selectedCategory = CATEGORY_OPTIONS.find((c) => c.value === category);

	return (
		<div className="bg-background min-h-screen">
			{/* Sticky action bar */}
			<div className="sticky top-0 z-10 border-b bg-card/95 backdrop-blur-sm">
				<div className="w-full px-6 py-3">
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-3">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() =>
									router.push(`${basePath}/skills`)
								}
								className="gap-1.5"
							>
								<ArrowLeftIcon className="h-4 w-4" />
								Skills
							</Button>
							<div className="h-4 w-px bg-border" />
							<div className="flex items-center gap-2">
								<div className="flex h-8 w-8 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
									<PuzzleIcon className="h-4 w-4" />
								</div>
								<h1 className="text-base font-semibold">
									{isEditing ? "Edit Skill" : "Create Skill"}
								</h1>
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Button variant="outline" asChild>
								<Link href={`${basePath}/skills`}>Cancel</Link>
							</Button>
							<Button
								onClick={handleSubmit}
								disabled={
									isSubmitting ||
									!name.trim() ||
									!content.trim()
								}
								className="bg-primary px-6 text-primary-foreground hover:bg-primary/90"
							>
								{isSubmitting ? (
									<>
										<Loader2Icon className="mr-2 h-4 w-4 animate-spin" />
										Saving...
									</>
								) : (
									<>
										<SaveIcon className="mr-2 h-4 w-4" />
										{isEditing
											? "Update Skill"
											: "Create Skill"}
									</>
								)}
							</Button>
						</div>
					</div>
				</div>
			</div>

			{/* Two-column layout */}
			<div className="flex w-full">
				{/* Main content */}
				<div className="flex-1 overflow-y-auto">
					<form onSubmit={handleSubmit} className="p-8 space-y-8">
						{/* Section 1: Basic Info */}
						<section className={builderSectionClassName}>
							<div className="mb-3">
								<h3 className="text-base font-semibold">
									Basic Information
								</h3>
								<p className="text-sm text-muted-foreground">
									Name and describe what this skill does.
								</p>
							</div>

							<div className="space-y-4">
								{/* Name */}
								<div className="space-y-2">
									<Label
										htmlFor="skill-name"
										className="text-sm font-medium"
									>
										Name
										<span className="text-destructive ml-1">
											*
										</span>
									</Label>
									<div className="flex items-center gap-3">
										<Input
											id="skill-name"
											value={name}
											onChange={(e) =>
												handleNameChange(e.target.value)
											}
											placeholder="e.g., SQL Query Writing"
											className={cn(
												subtleInputClassName,
												"h-11",
											)}
											required
										/>
										{selectedCategory && (
											// Not interactive, so the copy reaches
											// pointer users through the tooltip and
											// everyone else through the `sr-only`
											// child.
											<Tooltip>
												<TooltipTrigger asChild>
													<div
														className={cn(
															"w-11 h-11 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-md shrink-0",
															selectedCategory.gradient,
														)}
													>
														<selectedCategory.icon className="h-5 w-5 text-white" />
														<span className="sr-only">
															{tooltipT(
																"templateCategory",
																{
																	category:
																		selectedCategory.label,
																},
															)}
														</span>
													</div>
												</TooltipTrigger>
												<TooltipContent>
													{tooltipT(
														"templateCategory",
														{
															category:
																selectedCategory.label,
														},
													)}
												</TooltipContent>
											</Tooltip>
										)}
									</div>
								</div>

								{/* Slug (only when creating) */}
								{!isEditing && (
									<div className="space-y-2">
										<Label
											htmlFor="skill-slug"
											className="text-sm font-medium"
										>
											Slug
											<span className="text-destructive ml-1">
												*
											</span>
										</Label>
										<Input
											id="skill-slug"
											value={slug}
											onChange={(e) =>
												setSlug(e.target.value)
											}
											placeholder="e.g., sql-query-writing"
											pattern="^[a-z0-9-]+$"
											required
											className={cn(
												subtleInputClassName,
												"h-11 font-mono text-sm",
											)}
										/>
										<p className="text-xs text-muted-foreground">
											URL-friendly identifier. Only
											lowercase letters, numbers, and
											hyphens.
										</p>
									</div>
								)}

								{/* Description */}
								<div className="space-y-2">
									<Label
										htmlFor="skill-description"
										className="text-sm font-medium"
									>
										Description
										<span className="text-destructive ml-1">
											*
										</span>
									</Label>
									<Textarea
										id="skill-description"
										value={description}
										onChange={(e) =>
											setDescription(e.target.value)
										}
										placeholder="Brief description of what this skill enables agents to do..."
										rows={2}
										required
										className={cn(
											subtleInputClassName,
											"resize-none",
										)}
									/>
								</div>
							</div>
						</section>

						{/* Section 2: Category */}
						<section className={builderSectionClassName}>
							<div className="mb-3">
								<h3 className="text-base font-semibold">
									Category
								</h3>
								<p className="text-sm text-muted-foreground">
									Select the category that best describes this
									skill.
								</p>
							</div>

							<div className="rounded-2xl border border-border/60 bg-card/40 p-5">
								<div className="flex flex-wrap gap-2">
									{CATEGORY_OPTIONS.map((cat) => {
										const Icon = cat.icon;
										const isSelected =
											category === cat.value;
										return (
											<button
												key={cat.value}
												type="button"
												onClick={() =>
													setCategory(
														isSelected
															? ""
															: cat.value,
													)
												}
												className={cn(
													"flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all",
													isSelected
														? "border border-primary/40 bg-primary/10 text-primary shadow-sm"
														: "border border-border/60 bg-background/55 text-muted-foreground hover:border-border hover:bg-background/75 hover:text-foreground",
												)}
											>
												<Icon className="h-4 w-4" />
												{cat.label}
											</button>
										);
									})}
								</div>

								{/* Custom category input */}
								<div className="mt-4 border-t border-border/60 pt-4">
									<p className="mb-2 text-xs text-muted-foreground">
										Or enter a custom category:
									</p>
									<Input
										value={
											CATEGORY_OPTIONS.some(
												(c) => c.value === category,
											)
												? ""
												: category
										}
										onChange={(e) =>
											setCategory(e.target.value)
										}
										placeholder="Custom category..."
										className={cn(
											subtleInputClassName,
											"h-9 text-sm",
										)}
									/>
								</div>
							</div>

							{selectedCategory && (
								<div className="mt-3 flex items-center gap-2">
									<div
										className={cn(
											"w-6 h-6 rounded-lg bg-gradient-to-br flex items-center justify-center",
											selectedCategory.gradient,
										)}
									>
										<selectedCategory.icon className="h-3.5 w-3.5 text-white" />
									</div>
									<span className="text-sm text-muted-foreground">
										Selected:{" "}
										<span className="font-medium text-foreground">
											{selectedCategory.label}
										</span>
									</span>
								</div>
							)}
						</section>

						{/* Section 3: Skill Content */}
						<section className={builderSectionClassName}>
							<div className="flex items-center justify-between mb-3">
								<div>
									<h3 className="text-base font-semibold">
										Skill Content
									</h3>
									<p className="text-sm text-muted-foreground">
										Instructions in Markdown format. This
										content is loaded into agent memory at
										runtime.
									</p>
								</div>
								<Badge
									variant="secondary"
									className="text-xs font-mono"
								>
									Markdown
								</Badge>
							</div>

							<Textarea
								id="skill-content"
								value={content}
								onChange={(e) => setContent(e.target.value)}
								placeholder={
									"# Skill Name\n\n## Overview\nBriefly describe what this skill enables.\n\n## Process\n1. First step...\n2. Second step...\n3. Third step...\n\n## Guidelines\n- Be specific and clear\n- Include examples where helpful"
								}
								rows={20}
								required
								className={cn(
									subtleInputClassName,
									"min-h-[28rem] resize-none p-4 font-mono text-sm",
								)}
							/>

							<div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
								<span>
									{content.length > 0
										? `${content.length} characters`
										: "Supports Markdown headings, lists, code blocks"}
								</span>
								{content.length > 0 && (
									<span>
										~
										{Math.ceil(
											content.split(/\s+/).length / 200,
										)}{" "}
										min read
									</span>
								)}
							</div>
						</section>

						{/* Section 4: Tags */}
						<section className={builderSectionClassName}>
							<div className="mb-3">
								<h3 className="text-base font-semibold flex items-center gap-2">
									<TagIcon className="h-4 w-4 text-muted-foreground" />
									Tags
								</h3>
								<p className="text-sm text-muted-foreground">
									Add tags to make this skill easier to
									discover.
								</p>
							</div>

							<div className="space-y-3">
								{/* Current tags */}
								{tags.length > 0 && (
									<div className="flex flex-wrap gap-1.5">
										{tags.map((tag) => (
											<Badge
												key={tag}
												variant="secondary"
												className="gap-1 rounded-full px-3 py-1 bg-slate-100 dark:bg-slate-800 cursor-pointer group"
												onClick={() =>
													handleRemoveTag(tag)
												}
											>
												{tag}
												<XIcon className="h-3 w-3 ml-0.5 text-muted-foreground group-hover:text-destructive transition-colors" />
											</Badge>
										))}
									</div>
								)}

								{/* Tag input */}
								<div className="flex gap-2">
									<Input
										value={tagInput}
										onChange={(e) =>
											setTagInput(e.target.value)
										}
										placeholder="Add a tag..."
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												e.preventDefault();
												handleAddTag();
											}
										}}
										className={cn(
											subtleInputClassName,
											"h-10",
										)}
									/>
									<Button
										type="button"
										variant="outline"
										onClick={handleAddTag}
										disabled={!tagInput.trim()}
										className="rounded-xl"
									>
										<PlusIcon className="h-4 w-4" />
									</Button>
								</div>

								{/* Suggested tags */}
								<div>
									<p className="text-xs text-muted-foreground mb-2">
										Suggested:
									</p>
									<div className="flex flex-wrap gap-1.5">
										{SUGGESTED_TAGS.filter(
											(t) => !tags.includes(t),
										).map((tag) => (
											<button
												key={tag}
												type="button"
												onClick={() =>
													handleAddSuggestedTag(tag)
												}
												className="text-xs px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-muted-foreground hover:text-foreground transition-colors"
											>
												+ {tag}
											</button>
										))}
									</div>
								</div>
							</div>
						</section>
					</form>
				</div>

				{/* Right sidebar */}
				<div className="w-72 border-l bg-slate-50 dark:bg-slate-900/50 min-h-[calc(100vh-57px)]">
					<div className="sticky top-[57px] p-6">
						{/* Preview card */}
						<div className="mb-6 p-4 rounded-xl bg-white dark:bg-slate-800 border shadow-sm">
							<div className="flex items-center gap-3 mb-3">
								<div
									className={cn(
										"w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-sm",
										selectedCategory
											? selectedCategory.gradient
											: "from-primary/80 to-primary",
									)}
								>
									{selectedCategory ? (
										<selectedCategory.icon className="h-5 w-5 text-white" />
									) : (
										<SparklesIcon className="h-5 w-5 text-white" />
									)}
								</div>
								<div className="min-w-0">
									<p className="font-medium text-sm truncate">
										{name || "Untitled Skill"}
									</p>
									<p className="text-xs text-muted-foreground">
										{selectedCategory?.label ||
											"No category"}
									</p>
								</div>
							</div>
							{description && (
								<p className="text-xs text-muted-foreground line-clamp-3">
									{description}
								</p>
							)}
							{tags.length > 0 && (
								<div className="flex flex-wrap gap-1 mt-3">
									{tags.slice(0, 4).map((tag) => (
										<span
											key={tag}
											className="text-xs px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-muted-foreground"
										>
											{tag}
										</span>
									))}
									{tags.length > 4 && (
										<span className="text-xs text-muted-foreground">
											+{tags.length - 4}
										</span>
									)}
								</div>
							)}
						</div>

						{/* Tips */}
						<div className="flex items-center gap-2 mb-4">
							<div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
								<SparklesIcon className="h-3.5 w-3.5 text-primary" />
							</div>
							<h3 className="font-semibold text-sm">
								Writing Tips
							</h3>
						</div>

						<div className="space-y-4 text-xs text-muted-foreground">
							<div>
								<p className="font-semibold text-foreground mb-1.5">
									Structure your skill:
								</p>
								<ul className="space-y-1.5">
									{[
										"Start with a clear overview section",
										"Break down the process into numbered steps",
										"Add examples for complex steps",
										"Include edge cases and guidelines",
									].map((tip, i) => (
										<li
											key={i}
											className="flex items-start gap-2"
										>
											<span className="text-muted-foreground/50 mt-0.5">
												•
											</span>
											<span>{tip}</span>
										</li>
									))}
								</ul>
							</div>

							<div>
								<p className="font-semibold text-foreground mb-1.5">
									Markdown formatting:
								</p>
								<ul className="space-y-1.5">
									{[
										"Use # headings to organize sections",
										"Use - or 1. for lists",
										"Use ```code``` for code blocks",
										"Use **bold** for emphasis",
									].map((tip, i) => (
										<li
											key={i}
											className="flex items-start gap-2"
										>
											<span className="text-muted-foreground/50 mt-0.5">
												•
											</span>
											<span>{tip}</span>
										</li>
									))}
								</ul>
							</div>

							<div className="pt-4 border-t">
								<p className="font-semibold text-foreground mb-1.5">
									In Practice:
								</p>
								<p>
									Skills are injected into the agent's system
									prompt at runtime. Keep them focused on one
									specific capability for best results.
								</p>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
