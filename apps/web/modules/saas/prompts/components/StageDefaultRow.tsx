"use client";

import type { StoryKind } from "@repo/database";
import { Button } from "@ui/components/button";
import { PROJECT_DOC_GEN_AGENT_KEY } from "../lib/agent-keys";
import { type Prompt, PromptCard } from "./PromptCard";

type StageBinding = {
	prompt: Prompt;
	binding: {
		id: string;
		scope: "USER" | "ORG" | "SYSTEM";
		versionId: string;
		isDefault: boolean;
	};
};

type Props = {
	// Stage documentType string (e.g. "PLACEHOLDER", "DRAFT"). Widened from the
	// FeatureStage union so this row component is reusable across feature
	// stage-defaults panels (bug has no per-stage panel post-F-171).
	documentType: string;
	label: string;
	bindings: StageBinding[];
	onRefetch: () => void;
	onPickDefault: (documentType: string) => void;
	/** Forwarded into PromptCard so card actions (Set as Default) land in the
	 *  correct kind-scoped binding bucket. */
	storyKind?: StoryKind;
};

export function StageDefaultRow({
	documentType,
	label,
	bindings,
	onRefetch,
	onPickDefault,
	storyKind,
}: Props) {
	return (
		<div
			role="group"
			aria-labelledby={`stage-${documentType}`}
			className="grid grid-cols-[180px_minmax(0,1fr)] gap-6 items-start"
		>
			<h3
				id={`stage-${documentType}`}
				className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground pt-3"
			>
				{label}
			</h3>

			{bindings.length > 0 ? (
				<div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6">
					{bindings.map(({ prompt, binding }) => (
						<PromptCard
							key={binding.id}
							prompt={{
								...prompt,
								isDefault: binding.isDefault,
								defaultScope: binding.isDefault
									? binding.scope
									: null,
							}}
							onUpdate={onRefetch}
							documentTypeFilter={documentType}
							storyKindContext={storyKind}
							binding={{
								targetKey: PROJECT_DOC_GEN_AGENT_KEY,
								documentType,
								scope: binding.scope,
							}}
						/>
					))}
				</div>
			) : (
				<div className="rounded-lg border bg-muted/40 px-4 py-3 flex items-center justify-between">
					<p className="text-sm text-muted-foreground">
						No prompts bound for this stage.
					</p>
					<Button
						variant="outline"
						size="sm"
						aria-label={`Set default prompt for ${label}`}
						onClick={() => onPickDefault(documentType)}
					>
						Set default…
					</Button>
				</div>
			)}
		</div>
	);
}
