"use client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { useTranslations } from "next-intl";
import { useState } from "react";
export function StarterRunDialog({
	open,
	onOpenChange,
	onRun,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRun: (notes: string) => void;
}) {
	const t = useTranslations("workflows.authoring");
	const copy = (key: string, fallback: string) =>
		t.has(key) ? t(key) : fallback;
	const [notes, setNotes] = useState("");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{copy("runNotesTitle", "Run with project notes")}
					</DialogTitle>
					<DialogDescription>
						{copy(
							"runNotesInfo",
							"Supply the notes for this run. The agent uses these notes to prepare its result; it does not look up documents automatically.",
						)}
					</DialogDescription>
				</DialogHeader>
				<Label htmlFor="starter-run-notes">
					{copy("notesLabel", "Project notes")}
				</Label>
				<Textarea
					id="starter-run-notes"
					rows={8}
					maxLength={30000}
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
					placeholder={copy(
						"notesPlaceholder",
						"Paste progress, decisions, risks and source labels…",
					)}
				/>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						{copy("cancel", "Cancel")}
					</Button>
					<Button
						disabled={!notes.trim()}
						onClick={() => onRun(notes.trim())}
					>
						{copy("runWorkflow", "Run workflow")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
