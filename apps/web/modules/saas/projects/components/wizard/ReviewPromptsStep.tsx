"use client";

/**
 * Per-document prompt customization for the wizard Review step (D10, carried
 * from the Existing flow). Lets the user pick an AI prompt template and add
 * custom instructions per selected document type; both are optional. The
 * selections flow to `existingSetup.start({ documentPrompts })` in the
 * connected case (TG3).
 *
 * Extracted from `ExistingProjectFlow` so it survives that flow's removal
 * (TG5) and is reused as-is — no reinvention.
 */

import { useOfferedPromptActions } from "@saas/prompts/hooks/use-offered-prompt-actions";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import {
	CodeIcon,
	FileTextIcon,
	LayoutIcon,
	ServerIcon,
	ShieldCheckIcon,
	SparklesIcon,
	UsersIcon,
} from "lucide-react";
import { PromptSelector } from "../../../prompts/components/PromptSelector";
import { ProposalPromptField } from "../proposal-artifact/ProposalPromptField";

type DocumentPrompts = Record<
	string,
	{ promptId?: string; customInstructions?: string }
>;

/** Document type metadata for the Review step. */
const REVIEW_DOC_TYPES: Record<
	string,
	{ title: string; icon: React.ElementType }
> = {
	PRD: { title: "Product Requirements Document", icon: FileTextIcon },
	PROPOSAL: { title: "Project Proposal", icon: LayoutIcon },
	ARCHITECTURE: { title: "Technical Architecture", icon: CodeIcon },
	TECHNICAL_SPEC: { title: "Technical Specification", icon: CodeIcon },
	USER_STORY: { title: "Features", icon: UsersIcon },
	API_SPEC: { title: "API Specification", icon: ServerIcon },
	QA_STRATEGY: { title: "QA Strategy", icon: ShieldCheckIcon },
};

interface ReviewPromptsStepProps {
	documents: string[];
	documentPrompts: DocumentPrompts;
	onDocumentPromptsChange: (prompts: DocumentPrompts) => void;
}

export function ReviewPromptsStep({
	documents,
	documentPrompts,
	onDocumentPromptsChange,
}: ReviewPromptsStepProps) {
	const updatePromptId = (docType: string, promptId: string | undefined) => {
		onDocumentPromptsChange({
			...documentPrompts,
			[docType]: { ...documentPrompts[docType], promptId },
		});
	};

	const updateCustomInstructions = (
		docType: string,
		customInstructions: string,
	) => {
		onDocumentPromptsChange({
			...documentPrompts,
			[docType]: { ...documentPrompts[docType], customInstructions },
		});
	};

	/*
	 * Rows whose prompt is chosen here. Where the Proposal artifact is on, a
	 * Proposal is written from the library's Client proposal (Main) prompt
	 * (Fizzy #2946), so its row offers no choice: "Apply First Prompt to All"
	 * neither takes its prompt from that row nor writes one onto it. With the
	 * gate off this is every row.
	 */
	const { isSuperseded } = useOfferedPromptActions();
	const choosesPrompt = (docType: string) =>
		!isSuperseded("project_document_generator", docType);
	const firstPromptDoc = documents.find(choosesPrompt);
	const firstPromptId =
		firstPromptDoc === undefined
			? undefined
			: documentPrompts[firstPromptDoc]?.promptId;

	const applyFirstPromptToAll = () => {
		if (!firstPromptId) {
			return;
		}
		const updated = { ...documentPrompts };
		for (const docType of documents.filter(choosesPrompt)) {
			updated[docType] = { ...updated[docType], promptId: firstPromptId };
		}
		onDocumentPromptsChange(updated);
	};

	if (documents.length === 0) {
		return null;
	}

	return (
		<Card data-testid="review-prompts-step">
			<CardHeader>
				<div className="mb-2 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
					<SparklesIcon className="h-5 w-5 text-muted-foreground" />
				</div>
				<CardTitle>Customize Prompts</CardTitle>
				<CardDescription>
					Select AI prompt templates and add custom instructions for
					each document. Optional — defaults are used when left blank.
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{documents.length > 1 && (
					<div className="flex items-center justify-between rounded-lg border bg-muted/50 p-4">
						<div className="flex items-center gap-2">
							<SparklesIcon className="h-4 w-4 text-muted-foreground" />
							<span className="text-sm font-medium">
								Bulk Actions
							</span>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={applyFirstPromptToAll}
							disabled={!firstPromptId}
						>
							Apply First Prompt to All
						</Button>
					</div>
				)}

				{documents.map((docType) => {
					const meta = REVIEW_DOC_TYPES[docType] ?? {
						title: docType,
						icon: FileTextIcon,
					};
					const Icon = meta.icon;
					const prompts = documentPrompts[docType] ?? {};
					const promptSelectorField = (
						<div>
							<Label className="mb-2 block text-sm font-medium">
								AI Prompt Template
							</Label>
							<PromptSelector
								agentName="project_document_generator"
								documentType={docType}
								value={prompts.promptId}
								onValueChange={(promptId) =>
									updatePromptId(docType, promptId)
								}
								placeholder="Use default prompt"
								showBindAction
							/>
						</div>
					);

					return (
						<Card
							key={docType}
							className="border-border bg-accent/40"
						>
							<CardHeader>
								<div className="flex items-start gap-3">
									<div className="rounded-lg bg-muted p-2">
										<Icon className="h-5 w-5 text-muted-foreground" />
									</div>
									<div className="flex-1">
										<CardTitle className="text-base">
											{meta.title}
										</CardTitle>
									</div>
								</div>
							</CardHeader>
							<CardContent className="space-y-4">
								{docType === "PROPOSAL" ? (
									<ProposalPromptField
										promptLabel="AI Prompt Template"
										selector={promptSelectorField}
									/>
								) : (
									promptSelectorField
								)}
								<div>
									<Label className="text-sm font-medium">
										Custom Instructions (Optional)
									</Label>
									<Textarea
										value={prompts.customInstructions ?? ""}
										onChange={(e) =>
											updateCustomInstructions(
												docType,
												e.target.value,
											)
										}
										placeholder="Add any specific requirements or focus areas..."
										className="mt-2 min-h-20"
									/>
								</div>
							</CardContent>
						</Card>
					);
				})}
			</CardContent>
		</Card>
	);
}
