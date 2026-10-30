"use client";

import { AlertCircle, Code, Trash2, WandSparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode, Ref } from "react";

/**
 * A client-document Proposal's diagram that does not draw (Fizzy #2946).
 * The page says so plainly, without the engine's message, with what the
 * exports do in its place, and offers the ways to fix or remove it. A
 * reader who cannot edit sees the message and the caption only.
 *
 * `omitted`: the exports leave it out, and it takes no figure number.
 * `placeholder`: a kind only the live page draws, which the exports print as
 * a numbered placeholder, so it is a numbered figure here too.
 *
 * Rendered inside the node view's `NodeViewWrapper`, next to its hidden
 * source; the node view owns both.
 */
export function MermaidFailureView({
	labelId,
	caption,
	readOnly,
	variant,
	onEditSource,
	onEditWithInstructions,
	onDelete,
	instructionsTriggerRef,
	children,
}: {
	labelId: string;
	caption: string;
	readOnly: boolean;
	variant: "omitted" | "placeholder";
	onEditSource: () => void;
	/** Absent where Edit with instructions is not offered for the source. */
	onEditWithInstructions?: () => void;
	onDelete: () => void;
	/** Where focus returns when the instruction panel closes. */
	instructionsTriggerRef?: Ref<HTMLButtonElement>;
	/** The instruction panel and the live region, below the message. */
	children?: ReactNode;
}) {
	const tVisuals = useTranslations("projects.proposalArtifact.visuals");
	const tMenu = useTranslations("tooltips.editor.diagramMenu");
	const numbered = variant === "placeholder";
	return (
		// biome-ignore lint/a11y/useSemanticElements: a <fieldset> groups form controls; this names a diagram that could not be drawn
		<div
			role="group"
			aria-labelledby={labelId}
			className={`mermaid-container mermaid-visual mermaid-failure my-4 rounded-lg border border-dashed bg-card overflow-hidden${numbered ? " pa-figure-counted" : ""}`}
			data-diagram-failure={variant}
		>
			<div
				className="flex flex-col gap-1 px-4 py-3"
				contentEditable={false}
			>
				<p
					id={labelId}
					className="flex items-center gap-2 text-sm font-medium text-foreground"
				>
					<AlertCircle
						className="h-4 w-4 shrink-0 text-destructive"
						aria-hidden="true"
					/>
					{tVisuals("failure.title")}
				</p>
				<p className="text-sm text-muted-foreground">
					{tVisuals(
						numbered ? "failure.placeholder" : "failure.exports",
					)}
				</p>
				{/* A numbered figure's caption line carries "Figure n." under
				    the theme, captioned or not. */}
				{(caption || numbered) && (
					<p
						className={`text-sm text-muted-foreground${numbered ? " pa-figure-caption" : ""}`}
					>
						{caption}
					</p>
				)}
				{!readOnly && (
					<div className="mt-2 flex flex-wrap items-center gap-1">
						<button
							type="button"
							onClick={onEditSource}
							className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
						>
							<Code className="h-3.5 w-3.5" aria-hidden="true" />
							{tMenu("editSource")}
						</button>
						{onEditWithInstructions && (
							<button
								ref={instructionsTriggerRef}
								type="button"
								onClick={onEditWithInstructions}
								className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
							>
								<WandSparkles
									className="h-3.5 w-3.5"
									aria-hidden="true"
								/>
								{tMenu("editWithInstructions")}
							</button>
						)}
						<button
							type="button"
							onClick={onDelete}
							className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded text-destructive hover:bg-destructive/10 transition-colors"
						>
							<Trash2
								className="h-3.5 w-3.5"
								aria-hidden="true"
							/>
							{tMenu("delete")}
						</button>
					</div>
				)}
			</div>
			{children}
		</div>
	);
}
