"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Label } from "@ui/components/label";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
import { RefinePromptButton } from "./RefinePromptButton";
import { PromptText } from "./ReportPromptCard";

type Props = {
	/** This report's own system prompt; empty while it uses the template's. */
	customSystemPrompt: string;
	/** The template's system prompt (`fabricConfig.defaultSystemPrompt`). */
	templateSystemPrompt: string | undefined;
	onChange: (value: string) => void;
	readOnly: boolean;
	/** Offers "Refine with AI", in this organization's context. */
	refine?: { organizationId: string | null };
};

/**
 * The system prompt this report runs with, shown in full: its own when it
 * has one, otherwise the template's. Text equal to the template's is not
 * saved as the report's own, so a later template change still applies.
 */
export function ReportSystemPromptCard({
	customSystemPrompt,
	templateSystemPrompt,
	onChange,
	readOnly,
	refine,
}: Props) {
	const templatePrompt = templateSystemPrompt?.trim() ?? "";
	const isCustomized = customSystemPrompt.trim().length > 0;
	// What the person is typing, so the field can be cleared and rewritten;
	// it folds back to the shown prompt when they leave the field.
	const [editing, setEditing] = useState<string | null>(null);
	const value =
		editing ?? (isCustomized ? customSystemPrompt : templatePrompt);
	const change = (next: string) =>
		onChange(next.trim() === templatePrompt ? "" : next);

	return (
		<Card>
			<CardHeader>
				<p className="app-editorial-label">System prompt</p>
				<CardTitle className="text-base">How the AI behaves</CardTitle>
				<CardDescription>
					{templatePrompt
						? "Sets the AI's role and rules for this report. It starts from the template's system prompt."
						: "This template sets no system prompt, so Fabric's built-in report instructions apply, shaped by the Fabric AI settings. Write one to replace them for this report."}
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<Label htmlFor="report-system-prompt">System prompt</Label>
					{isCustomized && (
						<Badge variant="success" className="text-xs">
							Customized
						</Badge>
					)}
					<div className="ml-auto flex items-center gap-1">
						{refine && !readOnly && (
							<RefinePromptButton
								id="report-system-prompt"
								label="System prompt"
								content={value}
								organizationId={refine.organizationId}
								onApply={change}
							/>
						)}
						{isCustomized && !readOnly && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-7 text-xs"
								onClick={() => onChange("")}
							>
								<RotateCcwIcon className="mr-1 h-3 w-3" />
								{templatePrompt
									? "Reset to template"
									: "Use built-in instructions"}
							</Button>
						)}
					</div>
				</div>
				<PromptText
					id="report-system-prompt"
					value={value}
					onChange={(next) => {
						setEditing(next);
						change(next);
					}}
					onBlur={() => setEditing(null)}
					readOnly={readOnly}
					placeholder="Describe the AI's role and rules for this report..."
				/>
			</CardContent>
		</Card>
	);
}
