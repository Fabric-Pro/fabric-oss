"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import {
	CheckCircle2Icon,
	CodeIcon,
	FileTextIcon,
	LayoutIcon,
	LockIcon,
	ServerIcon,
	UsersIcon,
} from "lucide-react";
import { useEffect } from "react";
import {
	DOCUMENT_TIERS,
	getPrerequisiteHint,
	isDocumentAvailable,
} from "./documents";

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

interface DocumentsStepProps {
	formData: ProjectFormData;
	updateFormData: (updates: Partial<ProjectFormData>) => void;
	projectId?: string;
	organizationId?: string;
	/** Document type IDs to exclude from the list (e.g. ["USER_STORY"]) */
	excludeDocTypes?: string[];
}

const DOCUMENT_TYPES = [
	{
		id: "PRD",
		title: "Product Requirements Document",
		description:
			"Benefit hypothesis, requirements, success metrics, and key flows",
		icon: FileTextIcon,
		color: "text-blue-600 dark:text-blue-400",
		bgColor: "bg-blue-100 dark:bg-blue-900/20",
	},
	{
		id: "PROPOSAL",
		title: "Project Proposal",
		description:
			"Benefit hypothesis, scope, deliverables, phases, and success metrics",
		icon: LayoutIcon,
		color: "text-success dark:text-green-400",
		bgColor: "bg-green-100 dark:bg-green-900/20",
	},
	{
		id: "BUSINESS_CASE",
		title: "Business Case",
		description:
			"Decision ask, options considered, recommendation, value, and risks",
		icon: FileTextIcon,
		color: "text-amber-600 dark:text-amber-400",
		bgColor: "bg-amber-100 dark:bg-amber-900/20",
	},
	{
		id: "ARCHITECTURE",
		title: "Technical Architecture",
		description: "System design, components, data flow, and infrastructure",
		icon: CodeIcon,
		color: "text-purple-600 dark:text-purple-400",
		bgColor: "bg-purple-100 dark:bg-purple-900/20",
	},
	{
		id: "TECHNICAL_SPEC",
		title: "Technical Specification",
		description:
			"Detailed technical requirements and implementation details",
		icon: CodeIcon,
		color: "text-highlight dark:text-orange-400",
		bgColor: "bg-orange-100 dark:bg-orange-900/20",
	},
	{
		id: "USER_STORY",
		title: "Features",
		description: "Feature descriptions with acceptance criteria",
		icon: UsersIcon,
		color: "text-cyan-600 dark:text-cyan-400",
		bgColor: "bg-cyan-100 dark:bg-cyan-900/20",
	},
	{
		id: "API_SPEC",
		title: "API Specification",
		description:
			"REST/GraphQL endpoints, request/response schemas, and authentication",
		icon: ServerIcon,
		color: "text-rose-600 dark:text-rose-400",
		bgColor: "bg-rose-100 dark:bg-rose-900/20",
	},
];

export function DocumentsStep({
	formData,
	updateFormData,
	projectId,
	organizationId,
	excludeDocTypes,
}: DocumentsStepProps) {
	// In edit mode, query existing imported documents
	const { data: existingDocsData } = useQuery({
		...orpc.projects.documents.list.queryOptions({
			input: {
				// biome-ignore lint/style/noNonNullAssertion: enabled guard ensures projectId is defined
				projectId: projectId!,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId,
	});

	// Build a map of doc types that have active imported documents
	const importedDocTypes = new Map<
		string,
		{ title: string; source: string }
	>();
	// Types that exist (imported or generated COMPLETE) - count as satisfied for tier availability
	const existingCompleteTypes = new Set<string>();
	if (existingDocsData?.documents) {
		for (const doc of existingDocsData.documents) {
			if (
				(doc.source === "IMPORTED" || doc.source === "EXTERNAL") &&
				doc.isActive &&
				doc.status === "COMPLETE"
			) {
				importedDocTypes.set(doc.type, {
					title: doc.title,
					source: doc.source,
				});
				existingCompleteTypes.add(doc.type);
			}
			if (doc.status === "COMPLETE" && doc.isActive) {
				existingCompleteTypes.add(doc.type);
			}
		}
	}

	// Satisfied types = selected + imported + existing complete (for availability)
	const satisfiedTypes = new Set<string>([
		...formData.documents,
		...importedDocTypes.keys(),
		...existingCompleteTypes,
	]);

	// Filter out excluded document types
	const visibleDocTypes = excludeDocTypes
		? DOCUMENT_TYPES.filter((d) => !excludeDocTypes.includes(d.id))
		: DOCUMENT_TYPES;

	// Types that depend on a given type (for cascading deselect)
	const getDependents = (type: string): string[] => {
		const dependents: string[] = [];
		for (const [t, config] of Object.entries(DOCUMENT_TIERS)) {
			if (config.prerequisites.includes(type)) {
				dependents.push(t);
			}
		}
		return dependents;
	};

	const toggleDocument = (docId: string) => {
		// Don't toggle imported documents
		if (importedDocTypes.has(docId)) {
			return;
		}

		// Check availability before allowing select
		const isAdding = !formData.documents.includes(docId);
		if (isAdding && !isDocumentAvailable(docId, satisfiedTypes)) {
			return;
		}

		let newDocs: string[];
		if (isAdding) {
			newDocs = [...formData.documents, docId];
		} else {
			// Removing: also remove any dependents recursively
			const toRemove = new Set<string>([docId]);
			const collectDependents = (t: string) => {
				for (const dep of getDependents(t)) {
					if (
						formData.documents.includes(dep) &&
						!toRemove.has(dep)
					) {
						toRemove.add(dep);
						collectDependents(dep);
					}
				}
			};
			collectDependents(docId);
			newDocs = formData.documents.filter((d) => !toRemove.has(d));
		}
		updateFormData({ documents: newDocs });
	};

	const selectAll = () => {
		// Only select non-imported visible types that are currently available
		const generatableTypes = visibleDocTypes
			.filter((doc) => !importedDocTypes.has(doc.id))
			.filter((doc) => isDocumentAvailable(doc.id, satisfiedTypes))
			.map((doc) => doc.id);
		updateFormData({ documents: generatableTypes });
	};

	const deselectAll = () => {
		updateFormData({ documents: [] });
	};

	const importedCount = importedDocTypes.size;
	const generatableCount = visibleDocTypes.length - importedCount;

	// Form state validation: remove any selected docs that are no longer available
	// (e.g. from localStorage restore or when existingDocs load changes satisfiedTypes)
	useEffect(() => {
		const baseSatisfied = new Set([
			...importedDocTypes.keys(),
			...existingCompleteTypes,
		]);
		// Build valid set; process in tier order so prereqs are satisfied when checking
		const byTier = [...formData.documents].sort(
			(a, b) =>
				(DOCUMENT_TIERS[a]?.tier ?? 1) - (DOCUMENT_TIERS[b]?.tier ?? 1),
		);
		const validSelected: string[] = [];
		for (const docId of byTier) {
			const satisfied = new Set([...baseSatisfied, ...validSelected]);
			if (isDocumentAvailable(docId, satisfied)) {
				validSelected.push(docId);
			}
		}
		if (validSelected.length !== formData.documents.length) {
			updateFormData({ documents: validSelected });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [existingDocsData?.documents?.length, formData.documents.join(",")]);

	// Phase configuration for visual grouping
	const phases = [
		{
			phase: 1,
			label: "Phase 1: Business Documents",
			description: "Start here — foundation for all other documents",
			docs: visibleDocTypes.filter(
				(d) => (DOCUMENT_TIERS[d.id]?.tier ?? 1) === 1,
			),
		},
		{
			phase: 2,
			label: "Phase 2: Technical Documents",
			description: "Requires at least one Phase 1 document",
			docs: visibleDocTypes.filter(
				(d) => DOCUMENT_TIERS[d.id]?.tier === 2,
			),
		},
		{
			phase: 3,
			label: "Phase 3: Features",
			description: "Requires at least one Phase 2 document",
			docs: visibleDocTypes.filter(
				(d) => DOCUMENT_TIERS[d.id]?.tier === 3,
			),
		},
	].filter((p) => p.docs.length > 0);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h2 className="text-2xl font-bold">Generate Documentation</h2>
				<p className="text-muted-foreground mt-1">
					Select the documents you want to generate for your project
				</p>
			</div>

			{/* Imported documents banner */}
			{importedCount > 0 && (
				<div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
					<div className="flex items-center gap-2 mb-1">
						<CheckCircle2Icon className="h-4 w-4 text-success" />
						<p className="text-sm font-medium text-green-700 dark:text-green-300">
							{importedCount} document
							{importedCount !== 1 ? "s" : ""} imported from
							uploads
						</p>
					</div>
					<p className="text-sm text-success dark:text-green-400">
						Imported documents are ready to use. You can edit them
						from the project page.
					</p>
				</div>
			)}

			{generatableCount > 0 && (
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<Label>Select Documents to Generate (Optional)</Label>
						<div className="flex gap-2">
							<button
								type="button"
								onClick={selectAll}
								className="text-sm text-primary hover:underline cursor-pointer"
							>
								Select All
							</button>
							<span className="text-muted-foreground">|</span>
							<button
								type="button"
								onClick={deselectAll}
								className="text-sm text-primary hover:underline cursor-pointer"
							>
								Deselect All
							</button>
						</div>
					</div>
					<p className="text-sm text-muted-foreground">
						You can generate these documents later from the project
						page
					</p>
				</div>
			)}

			{phases.map((phaseGroup) => (
				<div key={phaseGroup.phase} className="space-y-3">
					<div className="flex items-baseline gap-2">
						<h3 className="text-sm font-semibold text-foreground">
							{phaseGroup.label}
						</h3>
						<p className="text-xs text-muted-foreground">
							{phaseGroup.description}
						</p>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{phaseGroup.docs.map((doc) => {
							const Icon = doc.icon;
							const imported = importedDocTypes.get(doc.id);
							const isImported = !!imported;
							const isAvailable =
								isImported ||
								isDocumentAvailable(doc.id, satisfiedTypes);
							const isSelected =
								isImported ||
								formData.documents.includes(doc.id);
							const prerequisiteHint = getPrerequisiteHint(
								doc.id,
							);

							return (
								<Card
									key={doc.id}
									className={`transition-all ${
										isImported
											? "border-green-500/50 bg-green-50/30 dark:bg-green-900/10"
											: !isAvailable
												? "opacity-60 cursor-not-allowed pointer-events-none"
												: isSelected
													? "border-primary bg-primary/5 cursor-pointer"
													: "hover:border-primary/50 cursor-pointer"
									}`}
									onClick={() =>
										isAvailable &&
										!isImported &&
										toggleDocument(doc.id)
									}
								>
									<CardHeader className="pb-3">
										<div className="flex items-start justify-between">
											<div
												className={`p-2 rounded-lg ${doc.bgColor}`}
											>
												<Icon
													className={`h-5 w-5 ${doc.color}`}
												/>
											</div>
											{isImported ? (
												<Badge
													variant="outline"
													className="text-success border-green-300 bg-green-50 dark:bg-green-900/30"
												>
													<CheckCircle2Icon className="h-3 w-3 mr-1" />
													Imported
												</Badge>
											) : !isAvailable ? (
												<Badge
													variant="secondary"
													className="text-muted-foreground"
													title={prerequisiteHint}
												>
													<LockIcon className="h-3 w-3 mr-1" />
													{prerequisiteHint}
												</Badge>
											) : (
												<Checkbox
													checked={isSelected}
													onCheckedChange={() =>
														toggleDocument(doc.id)
													}
													onClick={(e) =>
														e.stopPropagation()
													}
												/>
											)}
										</div>
										<CardTitle className="text-base">
											{doc.title}
										</CardTitle>
									</CardHeader>
									<CardContent>
										<CardDescription className="text-sm">
											{isImported
												? `Imported: ${imported.title}`
												: doc.description}
										</CardDescription>
									</CardContent>
								</Card>
							);
						})}
					</div>
				</div>
			))}

			{(formData.documents.length > 0 || importedCount > 0) && (
				<div className="p-4 bg-muted rounded-lg">
					<p className="text-sm font-medium mb-2">
						{importedCount > 0 && formData.documents.length > 0
							? `${importedCount} imported, ${formData.documents.length} to generate`
							: importedCount > 0
								? `${importedCount} imported document${importedCount !== 1 ? "s" : ""}`
								: `Selected: ${formData.documents.length} document${formData.documents.length !== 1 ? "s" : ""}`}
					</p>
					<p className="text-sm text-muted-foreground">
						{formData.documents.length > 0
							? "Selected documents will be generated after the project is created. You can review and edit them in the project page."
							: "You can edit imported documents from the project page."}
					</p>
				</div>
			)}
		</div>
	);
}
