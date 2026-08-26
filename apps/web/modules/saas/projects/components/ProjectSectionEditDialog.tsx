"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { SearchInput } from "@ui/components/search-input";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	FEATURE_CATEGORIES,
	PROJECT_TYPES,
	TECH_CATEGORIES,
} from "../lib/project-constants";

export type EditSection =
	| "description"
	| "types"
	| "goals"
	| "techStack"
	| "features";

type SectionValues = {
	description: string;
	types: string[];
	goals: string;
	techStack: string[];
	features: string[];
};

type Props = {
	projectId: string;
	organizationId?: string | null;
	section: EditSection | null;
	currentValues: SectionValues;
	onClose: () => void;
	onSaved: () => void;
};

const SECTION_TITLES: Record<EditSection, string> = {
	description: "Edit Description",
	types: "Edit Types",
	goals: "Edit Goals",
	techStack: "Edit Tech Stack",
	features: "Edit Features",
};

// ─── Tag selector (shared by Tech Stack and Features) ────────────────────────

function TagSelector({
	selected,
	onChange,
	categories,
	placeholder,
}: {
	selected: string[];
	onChange: (items: string[]) => void;
	categories: Record<string, string[]>;
	placeholder: string;
}) {
	const [searchQuery, setSearchQuery] = useState("");
	const [customValue, setCustomValue] = useState("");
	const [openCategories, setOpenCategories] = useState<string[]>([]);

	const _allItems = Object.values(categories).flat();

	const filteredCategories = Object.entries(categories).reduce(
		(acc, [cat, items]) => {
			const filtered = items.filter((item) =>
				item.toLowerCase().includes(searchQuery.toLowerCase()),
			);
			if (filtered.length > 0 || !searchQuery) {
				acc[cat] = searchQuery ? filtered : items;
			}
			return acc;
		},
		{} as Record<string, string[]>,
	);

	const toggle = (item: string) => {
		if (selected.includes(item)) {
			onChange(selected.filter((i) => i !== item));
		} else {
			onChange([...selected, item]);
		}
	};

	const addCustom = () => {
		const trimmed = customValue.trim();
		if (trimmed && !selected.includes(trimmed)) {
			onChange([...selected, trimmed]);
			setCustomValue("");
		}
	};

	const toggleCategory = (cat: string) => {
		setOpenCategories((prev) =>
			prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
		);
	};

	// Show open categories when there is a search query
	useEffect(() => {
		if (searchQuery) {
			setOpenCategories(Object.keys(filteredCategories));
		}
	}, [searchQuery]);

	return (
		<div className="space-y-3">
			{/* Selected tags */}
			{selected.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{selected.map((item) => (
						<span
							key={item}
							className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-sm text-primary"
						>
							{item}
							<button
								type="button"
								onClick={() => toggle(item)}
								className="ml-0.5 rounded-full hover:text-primary/70"
							>
								<XIcon className="size-3" />
							</button>
						</span>
					))}
				</div>
			)}

			{/* Search */}
			<div className="relative">
				<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
				<SearchInput
					placeholder={placeholder}
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="pl-9 h-9"
				/>
			</div>

			{/* Scrollable category list */}
			<div className="max-h-60 overflow-y-auto space-y-1 pr-1">
				{Object.entries(filteredCategories).map(([cat, items]) => {
					const isOpen = openCategories.includes(cat);
					return (
						<div
							key={cat}
							className="border rounded-md overflow-hidden"
						>
							<button
								type="button"
								onClick={() => toggleCategory(cat)}
								className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium bg-muted/40 hover:bg-muted/70 transition-colors"
							>
								<span>{cat}</span>
								{isOpen ? (
									<ChevronUpIcon className="size-3.5 text-muted-foreground" />
								) : (
									<ChevronDownIcon className="size-3.5 text-muted-foreground" />
								)}
							</button>
							{isOpen && (
								<div className="flex flex-wrap gap-1.5 p-2">
									{items.map((item) => {
										const isSelected =
											selected.includes(item);
										return (
											<button
												key={item}
												type="button"
												onClick={() => toggle(item)}
												className={cn(
													"rounded-full border px-2.5 py-0.5 text-xs transition-colors",
													isSelected
														? "border-primary/50 bg-primary/15 text-primary font-medium"
														: "border-foreground/20 bg-background text-foreground/70 hover:border-foreground/40 hover:bg-foreground/5",
												)}
											>
												{item}
											</button>
										);
									})}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Custom entry */}
			<div className="flex gap-2">
				<Input
					placeholder={`Add custom ${placeholder.toLowerCase().replace("search ", "")}...`}
					value={customValue}
					onChange={(e) => setCustomValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							addCustom();
						}
					}}
					className="h-9 text-sm"
				/>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={addCustom}
					disabled={
						!customValue.trim() ||
						selected.includes(customValue.trim())
					}
				>
					Add
				</Button>
			</div>
		</div>
	);
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function ProjectSectionEditDialog({
	projectId,
	organizationId,
	section,
	currentValues,
	onClose,
	onSaved,
}: Props) {
	const [description, setDescription] = useState(currentValues.description);
	const [goals, setGoals] = useState(currentValues.goals);
	const [selectedTypes, setSelectedTypes] = useState<string[]>(
		currentValues.types,
	);
	const [selectedTechStack, setSelectedTechStack] = useState<string[]>(
		currentValues.techStack,
	);
	const [selectedFeatures, setSelectedFeatures] = useState<string[]>(
		currentValues.features,
	);

	// Reset local state when dialog opens for a new section or when values change
	useEffect(() => {
		if (section) {
			setDescription(currentValues.description);
			setGoals(currentValues.goals);
			setSelectedTypes(currentValues.types);
			setSelectedTechStack(currentValues.techStack);
			setSelectedFeatures(currentValues.features);
		}
	}, [section, currentValues]);

	const saveMutation = useMutation({
		mutationFn: async () => {
			if (!section) {
				return;
			}

			const patch: Parameters<typeof orpcClient.projects.update>[0] = {
				id: projectId,
				organizationId: organizationId ?? null,
			};

			if (section === "description") {
				patch.description = description;
			}
			if (section === "goals") {
				patch.goals = goals;
			}
			if (section === "types") {
				patch.projectTypes = selectedTypes;
			}
			if (section === "techStack") {
				patch.techStack = selectedTechStack;
			}
			if (section === "features") {
				patch.features = selectedFeatures;
			}

			return await orpcClient.projects.update(patch);
		},
		onSuccess: () => {
			toast.success("Project updated");
			onSaved();
			onClose();
		},
		onError: (error) => {
			toast.error("Failed to update project", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	return (
		<Dialog open={!!section} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{section ? SECTION_TITLES[section] : ""}
					</DialogTitle>
				</DialogHeader>

				<div className="py-2">
					{/* Description */}
					{section === "description" && (
						<Textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Describe your project..."
							rows={6}
							className="resize-none"
						/>
					)}

					{/* Goals */}
					{section === "goals" && (
						<Textarea
							value={goals}
							onChange={(e) => setGoals(e.target.value)}
							placeholder="What are the main goals of this project?"
							rows={5}
							className="resize-none"
						/>
					)}

					{/* Types */}
					{section === "types" && (
						<div className="grid grid-cols-2 gap-2">
							{PROJECT_TYPES.map((type) => {
								const Icon = type.icon;
								const isSelected = selectedTypes.includes(
									type.value,
								);
								return (
									<button
										key={type.value}
										type="button"
										onClick={() => {
											setSelectedTypes((prev) =>
												prev.includes(type.value)
													? prev.filter(
															(t) =>
																t !==
																type.value,
														)
													: [...prev, type.value],
											);
										}}
										className={cn(
											"flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
											isSelected
												? "border-primary/50 bg-primary/10"
												: "border-border hover:border-foreground/30 hover:bg-foreground/5",
										)}
									>
										<div
											className={cn(
												"flex size-8 shrink-0 items-center justify-center rounded-md",
												type.bgColor,
											)}
										>
											<Icon
												className={cn(
													"size-4",
													type.color,
												)}
											/>
										</div>
										<div className="min-w-0">
											<p
												className={cn(
													"text-sm font-medium leading-tight",
													isSelected
														? "text-primary"
														: "text-foreground",
												)}
											>
												{type.label}
											</p>
											<p className="truncate text-xs text-muted-foreground">
												{type.description}
											</p>
										</div>
									</button>
								);
							})}
						</div>
					)}

					{/* Tech Stack */}
					{section === "techStack" && (
						<TagSelector
							selected={selectedTechStack}
							onChange={setSelectedTechStack}
							categories={TECH_CATEGORIES}
							placeholder="Search technologies..."
						/>
					)}

					{/* Features */}
					{section === "features" && (
						<TagSelector
							selected={selectedFeatures}
							onChange={setSelectedFeatures}
							categories={FEATURE_CATEGORIES}
							placeholder="Search features..."
						/>
					)}
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={onClose}
						disabled={saveMutation.isPending}
					>
						Cancel
					</Button>
					<Button
						onClick={() => saveMutation.mutate()}
						disabled={saveMutation.isPending}
					>
						{saveMutation.isPending ? "Saving..." : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
