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
import { Label } from "@ui/components/label";
import { SearchInput } from "@ui/components/search-input";
import { Textarea } from "@ui/components/textarea";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	SearchIcon,
	SparklesIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FEATURE_CATEGORIES } from "../../lib/project-constants";

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

interface FeaturesStepProps {
	formData: ProjectFormData;
	updateFormData: (updates: Partial<ProjectFormData>) => void;
}

export function FeaturesStep({ formData, updateFormData }: FeaturesStepProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [customFeature, setCustomFeature] = useState("");
	const [openCategories, setOpenCategories] = useState<string[]>([]);
	const [recommendedFeatures, setRecommendedFeatures] = useState<Set<string>>(
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
			const newRecommendations = recommendationsQuery.data.features;
			setRecommendedFeatures(new Set(newRecommendations));

			// Merge with existing selections (don't overwrite)
			const currentSelections = new Set(formData.features);
			const merged = new Set([
				...currentSelections,
				...newRecommendations,
			]);

			// Only update if there are new items to add
			if (merged.size > currentSelections.size) {
				updateFormData({ features: Array.from(merged) });
				const addedCount = merged.size - currentSelections.size;
				toast.success(
					`Added ${addedCount} recommended module${addedCount === 1 ? "" : "s"} based on your project type`,
				);
			}

			hasAppliedRecommendations.current = true;
		}
	}, [
		recommendationsQuery.data,
		formData.projectTypes,
		formData.features,
		updateFormData,
	]);

	// Reset recommendations flag when project types change
	useEffect(() => {
		hasAppliedRecommendations.current = false;
	}, [JSON.stringify(formData.projectTypes)]);

	const toggleFeature = (feature: string) => {
		const newFeatures = formData.features.includes(feature)
			? formData.features.filter((f) => f !== feature)
			: [...formData.features, feature];
		updateFormData({ features: newFeatures });
	};

	const addCustomFeature = () => {
		if (
			customFeature.trim() &&
			!formData.features.includes(customFeature.trim())
		) {
			updateFormData({
				features: [...formData.features, customFeature.trim()],
			});
			setCustomFeature("");
		}
	};

	const toggleCategory = (category: string) => {
		setOpenCategories((prev) =>
			prev.includes(category)
				? prev.filter((c) => c !== category)
				: [...prev, category],
		);
	};

	// Filter features based on search
	const filteredCategories = Object.entries(FEATURE_CATEGORIES).reduce(
		(acc, [category, features]) => {
			const filtered = features.filter((feature) =>
				feature.toLowerCase().includes(searchQuery.toLowerCase()),
			);
			if (filtered.length > 0 || !searchQuery) {
				acc[category] = searchQuery ? filtered : features;
			}
			return acc;
		},
		{} as Record<string, string[]>,
	);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h2 className="text-2xl font-bold">Select Project Modules</h2>
				<p className="text-muted-foreground mt-1">
					Choose the modules and capabilities for your project
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
					placeholder="Search modules..."
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					className="pl-10 h-12"
				/>
			</div>

			{/* Feature Categories */}
			<div className="space-y-2">
				{Object.entries(filteredCategories).map(
					([category, features]) => {
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
										{features.map((feature) => {
											const isSelected =
												formData.features.includes(
													feature,
												);
											const isRecommended =
												recommendedFeatures.has(
													feature,
												);
											return (
												<Button
													key={feature}
													type="button"
													variant={
														isSelected
															? "default"
															: "outline"
													}
													onClick={() =>
														toggleFeature(feature)
													}
													className="justify-start h-auto py-3 text-left cursor-pointer relative"
												>
													<span className="truncate">
														{feature}
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
					},
				)}
			</div>

			{/* Add Custom Feature */}
			<div className="border rounded-lg p-6 bg-muted/30">
				<div className="space-y-4">
					<div>
						<h3 className="font-semibold text-base">
							Add Custom Module
						</h3>
						<p className="text-sm text-muted-foreground mt-1">
							Don't see what you're looking for? Add your own
							modules below.
						</p>
					</div>
					<div className="flex gap-2">
						<Input
							placeholder="e.g., Custom Module, Unique Capability..."
							value={customFeature}
							onChange={(e) => setCustomFeature(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addCustomFeature();
								}
							}}
							className="flex-1"
						/>
						<Button
							type="button"
							onClick={addCustomFeature}
							variant="secondary"
							className="cursor-pointer"
						>
							Add
						</Button>
					</div>
				</div>
			</div>

			{/* Additional Requirements */}
			<div className="border rounded-lg p-6 bg-muted/30">
				<div className="space-y-4">
					<div>
						<Label
							htmlFor="customRequirements"
							className="text-base font-semibold"
						>
							Additional Requirements (Optional)
						</Label>
						<p className="text-sm text-muted-foreground mt-1">
							Describe any additional modules, requirements, or
							specific details about your project.
						</p>
					</div>
					<Textarea
						id="customRequirements"
						placeholder="e.g., Integration with specific services, custom workflows, special requirements..."
						value={formData.customRequirements}
						onChange={(e) =>
							updateFormData({
								customRequirements: e.target.value,
							})
						}
						rows={4}
						className="resize-none"
					/>
				</div>
			</div>
		</div>
	);
}
