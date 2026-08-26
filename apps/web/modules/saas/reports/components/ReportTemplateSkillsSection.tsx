"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ui/components/dialog";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	CheckIcon,
	PlusIcon,
	SearchIcon,
	SparklesIcon,
	XIcon,
} from "lucide-react";
import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useState,
} from "react";
import { toast } from "sonner";

type LocalSkill = {
	skillId: string;
	name: string;
	description: string | null;
	category: string | null;
	isRequired: boolean;
	isNew: boolean;
};

interface ReportTemplateSkillsSectionProps {
	templateId: string;
	readonly?: boolean;
}

export interface ReportTemplateSkillsSectionRef {
	saveSkills: () => Promise<void>;
	hasPendingChanges: boolean;
}

export const ReportTemplateSkillsSection = forwardRef<
	ReportTemplateSkillsSectionRef,
	ReportTemplateSkillsSectionProps
>(function ReportTemplateSkillsSection({ templateId, readonly = false }, ref) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();
	const [addDialogOpen, setAddDialogOpen] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
		new Set(),
	);

	const [localSkills, setLocalSkills] = useState<LocalSkill[]>([]);
	const [pendingDetachIds, setPendingDetachIds] = useState<Set<string>>(
		new Set(),
	);
	const [isDirty, setIsDirty] = useState(false);

	const skillsQueryOptions = orpc.reports.templates.skills.list.queryOptions({
		input: {
			templateId,
			organizationId: organizationId ?? null,
		},
	});

	const { data: templateSkillsData, isLoading: skillsLoading } =
		useQuery(skillsQueryOptions);

	const { data: catalogData } = useQuery(
		orpc.skills.list.queryOptions({
			input: {
				organizationId: organizationId ?? null,
				limit: 100,
				isPublished: true,
			},
		}),
	);

	// Sync local skills from server when not dirty
	useEffect(() => {
		if (templateSkillsData?.skills && !isDirty) {
			setLocalSkills(
				templateSkillsData.skills.map((ts) => ({
					skillId: ts.skillId,
					name: ts.skill.name,
					description: ts.skill.description,
					category: ts.skill.category,
					isRequired: ts.isRequired,
					isNew: false,
				})),
			);
		}
	}, [templateSkillsData, isDirty]);

	const hasPendingChanges =
		localSkills.some((s) => s.isNew) || pendingDetachIds.size > 0;

	const saveSkills = useCallback(async () => {
		const toAttach = localSkills.filter((s) => s.isNew);
		const toDetach = [...pendingDetachIds];

		if (toAttach.length === 0 && toDetach.length === 0) {
			return;
		}

		try {
			// Detach removed skills
			for (const skillId of toDetach) {
				await orpcClient.reports.templates.skills.detach({
					templateId,
					organizationId: organizationId ?? null,
					skillId,
				});
			}

			// Attach new skills
			const baseOrder = localSkills.filter((s) => !s.isNew).length;
			for (let i = 0; i < toAttach.length; i++) {
				await orpcClient.reports.templates.skills.attach({
					templateId,
					organizationId: organizationId ?? null,
					skillId: toAttach[i].skillId,
					sortOrder: baseOrder + i,
				});
			}

			// Clear pending state and allow re-sync from server
			setPendingDetachIds(new Set());
			setIsDirty(false);

			// Refetch with exact query key so useEffect re-syncs local state
			await queryClient.invalidateQueries({
				queryKey: skillsQueryOptions.queryKey,
			});
		} catch (error: any) {
			toast.error(error.message || "Failed to save skill changes");
			throw error;
		}
	}, [
		localSkills,
		pendingDetachIds,
		templateId,
		organizationId,
		queryClient,
		skillsQueryOptions.queryKey,
	]);

	useImperativeHandle(
		ref,
		() => ({
			saveSkills,
			hasPendingChanges,
		}),
		[saveSkills, hasPendingChanges],
	);

	const localSkillIds = new Set(localSkills.map((s) => s.skillId));
	const availableSkills = (catalogData?.skills ?? []).filter(
		(s) => !localSkillIds.has(s.id),
	);

	const categories = useMemo(
		() => [
			...new Set(
				availableSkills
					.map((s) => s.category)
					.filter((c): c is string => c !== null && c !== undefined),
			),
		],
		[availableSkills],
	);

	const filteredSkills = useMemo(() => {
		let skills = availableSkills;
		if (categoryFilter !== "all") {
			skills = skills.filter((s) => s.category === categoryFilter);
		}
		if (searchQuery.trim()) {
			const q = searchQuery.toLowerCase();
			skills = skills.filter(
				(s) =>
					s.name.toLowerCase().includes(q) ||
					s.description?.toLowerCase().includes(q) ||
					s.category?.toLowerCase().includes(q),
			);
		}
		return skills;
	}, [availableSkills, searchQuery, categoryFilter]);

	const handleAddSelected = () => {
		const catalog = catalogData?.skills ?? [];
		const newSkills: LocalSkill[] = [];
		for (const skillId of selectedSkillIds) {
			const skill = catalog.find((s) => s.id === skillId);
			if (skill) {
				newSkills.push({
					skillId: skill.id,
					name: skill.name,
					description: skill.description,
					category: skill.category,
					isRequired: true,
					isNew: true,
				});
			}
		}
		setLocalSkills((prev) => [...prev, ...newSkills]);
		setIsDirty(true);
		// If any of these were previously detached, undo the detach
		setPendingDetachIds((prev) => {
			const next = new Set(prev);
			for (const skillId of selectedSkillIds) {
				next.delete(skillId);
			}
			return next;
		});
		setAddDialogOpen(false);
		setSearchQuery("");
		setCategoryFilter("all");
		setSelectedSkillIds(new Set());
	};

	const handleRemoveSkill = (skillId: string) => {
		const skill = localSkills.find((s) => s.skillId === skillId);
		if (!skill) {
			return;
		}

		setLocalSkills((prev) => prev.filter((s) => s.skillId !== skillId));

		// Only track detach for skills already persisted in DB
		if (!skill.isNew) {
			setPendingDetachIds((prev) => new Set(prev).add(skillId));
		}
		setIsDirty(true);
	};

	return (
		<Card>
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="flex items-center gap-2 text-lg">
							<SparklesIcon className="h-5 w-5 text-highlight" />
							Skills
							{hasPendingChanges && (
								<Badge
									variant="outline"
									className="text-xs text-amber-600 border-amber-300"
								>
									Unsaved changes
								</Badge>
							)}
						</CardTitle>
						<CardDescription>
							Skills injected into the AI system prompt during
							report generation
						</CardDescription>
					</div>
					{!readonly && (
						<Dialog
							open={addDialogOpen}
							onOpenChange={(open) => {
								setAddDialogOpen(open);
								if (!open) {
									setSearchQuery("");
									setCategoryFilter("all");
									setSelectedSkillIds(new Set());
								}
							}}
						>
							<DialogTrigger asChild>
								<Button variant="outline" size="sm">
									<PlusIcon className="h-4 w-4 mr-1" />
									Add Skill
								</Button>
							</DialogTrigger>
							<DialogContent className="max-w-lg">
								<DialogHeader>
									<DialogTitle>
										Add Skills to Template
									</DialogTitle>
									<DialogDescription>
										Select skills from the catalog to attach
										to this report template.
									</DialogDescription>
								</DialogHeader>
								<div className="relative">
									<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
									<SearchInput
										placeholder="Search skills..."
										value={searchQuery}
										onChange={(e) =>
											setSearchQuery(e.target.value)
										}
										className="pl-9"
									/>
								</div>
								{categories.length > 0 && (
									<div className="flex flex-wrap gap-1.5">
										<button
											type="button"
											onClick={() =>
												setCategoryFilter("all")
											}
											className={cn(
												"rounded-full px-3 py-1 text-xs font-medium transition-colors",
												categoryFilter === "all"
													? "bg-primary text-primary-foreground"
													: "bg-muted hover:bg-muted/80 text-muted-foreground",
											)}
										>
											All
										</button>
										{categories.map((cat) => (
											<button
												key={cat}
												type="button"
												onClick={() =>
													setCategoryFilter(cat)
												}
												className={cn(
													"rounded-full px-3 py-1 text-xs font-medium transition-colors",
													categoryFilter === cat
														? "bg-primary text-primary-foreground"
														: "bg-muted hover:bg-muted/80 text-muted-foreground",
												)}
											>
												{cat}
											</button>
										))}
									</div>
								)}
								<div className="space-y-2 max-h-80 overflow-y-auto">
									{filteredSkills.length === 0 ? (
										<p className="text-sm text-muted-foreground py-4 text-center">
											{searchQuery.trim() ||
											categoryFilter !== "all"
												? "No skills match your filters."
												: "No additional skills available."}
										</p>
									) : (
										filteredSkills.map((skill) => {
											const isSelected =
												selectedSkillIds.has(skill.id);
											return (
												<button
													key={skill.id}
													type="button"
													onClick={() => {
														setSelectedSkillIds(
															(prev) => {
																const next =
																	new Set(
																		prev,
																	);
																if (
																	next.has(
																		skill.id,
																	)
																) {
																	next.delete(
																		skill.id,
																	);
																} else {
																	next.add(
																		skill.id,
																	);
																}
																return next;
															},
														);
													}}
													className={cn(
														"w-full text-left p-3 rounded-lg border transition-colors",
														isSelected
															? "border-primary bg-primary/5"
															: "hover:bg-muted/50",
													)}
												>
													<div className="flex items-start gap-3">
														<div
															className={cn(
																"mt-0.5 h-4 w-4 shrink-0 rounded border flex items-center justify-center",
																isSelected
																	? "bg-primary border-primary text-primary-foreground"
																	: "border-muted-foreground/30",
															)}
														>
															{isSelected && (
																<CheckIcon className="h-3 w-3" />
															)}
														</div>
														<div className="min-w-0 flex-1">
															<div className="font-medium text-sm">
																{skill.name}
															</div>
															<div className="text-xs text-muted-foreground line-clamp-2 mt-1">
																{
																	skill.description
																}
															</div>
															{skill.category && (
																<Badge
																	variant="secondary"
																	className="text-xs mt-1.5"
																>
																	{
																		skill.category
																	}
																</Badge>
															)}
														</div>
													</div>
												</button>
											);
										})
									)}
								</div>
								{selectedSkillIds.size > 0 && (
									<div className="flex items-center justify-between pt-2 border-t">
										<span className="text-sm text-muted-foreground">
											{selectedSkillIds.size} skill
											{selectedSkillIds.size > 1
												? "s"
												: ""}{" "}
											selected
										</span>
										<Button
											size="sm"
											onClick={handleAddSelected}
										>
											<PlusIcon className="h-4 w-4 mr-1" />
											Add Selected
										</Button>
									</div>
								)}
							</DialogContent>
						</Dialog>
					)}
				</div>
			</CardHeader>
			<CardContent>
				{skillsLoading ? (
					<p className="text-sm text-muted-foreground">Loading...</p>
				) : localSkills.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No skills attached to this template.
					</p>
				) : (
					<div className="space-y-2">
						{localSkills.map((skill) => (
							<div
								key={skill.skillId}
								className={cn(
									"flex items-center justify-between p-3 rounded-lg border",
									skill.isNew
										? "bg-green-50/30 border-green-200/50 dark:bg-green-950/10 dark:border-green-900/30"
										: "bg-amber-50/30 border-amber-200/50 dark:bg-amber-950/10 dark:border-amber-900/30",
								)}
							>
								<div className="flex items-center gap-3 min-w-0">
									<SparklesIcon className="h-4 w-4 text-highlight shrink-0" />
									<div className="min-w-0">
										<span className="font-medium text-sm block truncate">
											{skill.name}
										</span>
										<span className="text-xs text-muted-foreground line-clamp-1">
											{skill.description}
										</span>
									</div>
								</div>
								<div className="flex items-center gap-2 shrink-0">
									{skill.isNew && (
										<Badge
											variant="outline"
											className="text-xs text-success border-green-300"
										>
											New
										</Badge>
									)}
									{skill.isRequired && !skill.isNew && (
										<Badge
											variant="outline"
											className="text-xs"
										>
											Required
										</Badge>
									)}
									{!readonly && (
										<Button
											variant="ghost"
											size="icon-sm"
											onClick={() =>
												handleRemoveSkill(skill.skillId)
											}
										>
											<XIcon className="h-3.5 w-3.5" />
										</Button>
									)}
								</div>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
});
