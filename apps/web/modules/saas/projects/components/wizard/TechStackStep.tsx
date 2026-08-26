"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Input } from "@ui/components/input";
import { SearchInput } from "@ui/components/search-input";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	SearchIcon,
	SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { TECH_CATEGORIES } from "../../lib/project-constants";

type ProjectFormData = {
	name: string;
	description: string;
	projectTypes: string[];
	icon: string;
	color: string;
	tags: string[];
	techStack: string[];
	features: string[];
	customRequirements: string;
	documents: string[];
	previousDescription: string | null;
	tempContextIds: string[];
};

interface TechStackStepProps {
	formData: ProjectFormData;
	updateFormData: (updates: Partial<ProjectFormData>) => void;
}

export function TechStackStep({
	formData,
	updateFormData,
}: TechStackStepProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [customTech, setCustomTech] = useState("");
	const [openCategories, setOpenCategories] = useState<string[]>([]);
	const [recommendedTechs, setRecommendedTechs] = useState<Set<string>>(
		new Set(),
	);
	const hasAppliedRecommendations = useRef(false);

	// Fetch recommendations based on project types
	const recommendationsQuery = useQuery(
		orpc.wizard.getRecommendations.queryOptions({
			input: {
				projectTypes: formData.projectTypes,
				description: formData.description || undefined,
			},
		}),
	);

	// Apply recommendations when they load (merge with existing selections)
	useEffect(() => {
		if (
			recommendationsQuery.data &&
			formData.projectTypes.length > 0 &&
			!hasAppliedRecommendations.current
		) {
			const newRecommendations = recommendationsQuery.data.techStack;
			setRecommendedTechs(new Set(newRecommendations));

			// Merge with existing selections (don't overwrite)
			const currentSelections = new Set(formData.techStack);
			const merged = new Set([
				...currentSelections,
				...newRecommendations,
			]);

			// Only update if there are new items to add
			if (merged.size > currentSelections.size) {
				updateFormData({ techStack: Array.from(merged) });
				const addedCount = merged.size - currentSelections.size;
				toast.success(
					`Added ${addedCount} recommended technolog${addedCount === 1 ? "y" : "ies"} based on your project type`,
				);
			}

			hasAppliedRecommendations.current = true;
		}
	}, [
		recommendationsQuery.data,
		formData.projectTypes,
		formData.techStack,
		updateFormData,
	]);

	// Reset recommendations flag when project types change
	useEffect(() => {
		hasAppliedRecommendations.current = false;
	}, [JSON.stringify(formData.projectTypes)]);

	const toggleTech = (tech: string) => {
		const newTechStack = formData.techStack.includes(tech)
			? formData.techStack.filter((t) => t !== tech)
			: [...formData.techStack, tech];
		updateFormData({ techStack: newTechStack });
	};

	const addCustomTech = () => {
		if (
			customTech.trim() &&
			!formData.techStack.includes(customTech.trim())
		) {
			updateFormData({
				techStack: [...formData.techStack, customTech.trim()],
			});
			setCustomTech("");
		}
	};

	const toggleCategory = (category: string) => {
		setOpenCategories((prev) =>
			prev.includes(category)
				? prev.filter((c) => c !== category)
				: [...prev, category],
		);
	};

	// Filter technologies based on search
	const filteredCategories = Object.entries(TECH_CATEGORIES).reduce(
		(acc, [category, techs]) => {
			const filtered = techs.filter((tech) =>
				tech.toLowerCase().includes(searchQuery.toLowerCase()),
			);
			if (filtered.length > 0 || !searchQuery) {
				acc[category] = searchQuery ? filtered : techs;
			}
			return acc;
		},
		{} as Record<string, string[]>,
	);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h2 className="text-2xl font-bold">Select Your Tech Stack</h2>
				<p className="text-muted-foreground mt-1">
					Choose the technologies you're using in this project
				</p>
				{formData.projectTypes.length > 0 && (
					<p className="text-sm text-primary mt-2 flex items-center gap-1">
						<SparklesIcon className="h-4 w-4" />
						Recommendations applied based on:{" "}
						{formData.projectTypes.join(", ")}
					</p>
				)}
			</div>

			{/* Search */}
			<div className="relative">
				<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
				<SearchInput
					placeholder="Search technologies..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="pl-10 h-12"
				/>
			</div>

			{/* Technology Categories */}
			<div className="space-y-2">
				{Object.entries(filteredCategories).map(([category, techs]) => {
					const isOpen = openCategories.includes(category);

					return (
						<Collapsible
							key={category}
							open={isOpen}
							onOpenChange={() => toggleCategory(category)}
						>
							<CollapsibleTrigger className="flex items-center justify-between w-full p-4 border rounded-lg hover:bg-accent transition-colors">
								<span className="font-medium text-left">
									{category}
								</span>
								{isOpen ? (
									<ChevronUpIcon className="h-5 w-5 text-muted-foreground" />
								) : (
									<ChevronDownIcon className="h-5 w-5 text-muted-foreground" />
								)}
							</CollapsibleTrigger>
							<CollapsibleContent className="pt-3 pb-1">
								<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 px-4">
									{techs.map((tech) => {
										const isSelected =
											formData.techStack.includes(tech);
										const isRecommended =
											recommendedTechs.has(tech);
										return (
											<Button
												key={tech}
												type="button"
												variant={
													isSelected
														? "default"
														: "outline"
												}
												onClick={() => toggleTech(tech)}
												className="justify-start h-auto py-3 cursor-pointer relative"
											>
												<span className="truncate">
													{tech}
												</span>
												{isRecommended &&
													isSelected && (
														<Badge
															variant="secondary"
															className="absolute -top-2 -right-2 text-xs px-1"
														>
															<SparklesIcon className="h-3 w-3" />
														</Badge>
													)}
											</Button>
										);
									})}
								</div>
							</CollapsibleContent>
						</Collapsible>
					);
				})}
			</div>

			{/* Add Custom Technology */}
			<div className="border rounded-lg p-6 bg-muted/30">
				<div className="space-y-4">
					<div>
						<h3 className="font-semibold text-base">
							Add Custom Technology
						</h3>
						<p className="text-sm text-muted-foreground mt-1">
							Don't see what you're looking for? Add your own
							technologies below.
						</p>
					</div>
					<div className="flex gap-2">
						<Input
							placeholder="e.g., Custom Framework, Internal Tool..."
							value={customTech}
							onChange={(e) => setCustomTech(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addCustomTech();
								}
							}}
							className="flex-1"
						/>
						<Button
							type="button"
							onClick={addCustomTech}
							variant="secondary"
							className="cursor-pointer"
						>
							Add
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
