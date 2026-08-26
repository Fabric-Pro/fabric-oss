"use client";

/**
 * Knowledge-packs editor (G6, optional) — a list of richer "skill" docs (title
 * + free-text content) appended to the scanner prompt as extra context. Knowledge
 * text only: it is never executed, and like custom rules it applies on the NEXT
 * scan and leaves existing findings unchanged (stated in the (i) note).
 *
 * Controlled by the parent, mirroring the custom-rules pattern. New packs get a
 * temporary local id (`new-*`); the server assigns a stable id on save.
 */

import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Textarea } from "@ui/components/textarea";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";
import type { ScanCategory } from "./lib";
import { InfoHint } from "./ScanInfo";

/**
 * Editable knowledge pack (id optional — server assigns for new packs).
 * `appliesTo` is carried for round-trip only; the v1 editor edits title +
 * content (a pack with no `appliesTo` applies to every category). It mirrors the
 * read shape (a single {@link ScanCategory}); the parent wraps it in an array
 * for the `config.update` contract.
 */
export type EditableKnowledgePack = {
	id?: string;
	title: string;
	content: string;
	appliesTo?: ScanCategory;
};

let localPackCounter = 0;
/** Stable-enough local key for a brand-new pack before it has a server id. */
function nextLocalPackId(): string {
	localPackCounter += 1;
	return `new-${localPackCounter}`;
}

export function KnowledgePacksEditor({
	packs,
	disabled,
	onChange,
}: {
	packs: ReadonlyArray<EditableKnowledgePack>;
	disabled?: boolean;
	onChange: (next: EditableKnowledgePack[]) => void;
}) {
	const fieldId = useId();
	const [deleteIndex, setDeleteIndex] = useState<number | null>(null);

	const update = (index: number, patch: Partial<EditableKnowledgePack>) => {
		onChange(packs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
	};

	const addPack = () => {
		onChange([...packs, { id: nextLocalPackId(), title: "", content: "" }]);
	};

	const confirmDelete = () => {
		if (deleteIndex === null) {
			return;
		}
		onChange(packs.filter((_, i) => i !== deleteIndex));
		setDeleteIndex(null);
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="flex items-center gap-1.5">
						<p className="font-medium text-sm">
							Knowledge packs{" "}
							<span className="font-normal text-muted-foreground">
								(optional)
							</span>
						</p>
						<InfoHint label="About knowledge packs" wide>
							<p>
								Extra reference notes appended to the scanner's
								context — a place to add your project's threat
								model, naming conventions, sensitive areas, or
								known-safe patterns so the review is better
								informed.
							</p>
							<p className="mt-1.5">
								Knowledge text only — packs are never executed.
								They{" "}
								<span className="font-medium text-foreground">
									apply on the next scan
								</span>{" "}
								and don't change existing findings.
							</p>
						</InfoHint>
					</div>
					<p className="text-muted-foreground text-xs">
						Reference notes that give the scanner more context about
						this project.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					className="gap-1.5 shrink-0"
					onClick={addPack}
					disabled={disabled}
				>
					<PlusIcon aria-hidden="true" className="size-4" />
					Add pack
				</Button>
			</div>

			{packs.length === 0 ? (
				<p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-center text-muted-foreground text-sm">
					No knowledge packs. Add one to give the scanner extra
					project context.
				</p>
			) : (
				<ul className="space-y-3">
					{packs.map((pack, index) => {
						const titleId = `${fieldId}-title-${index}`;
						const contentId = `${fieldId}-content-${index}`;
						return (
							<li
								key={pack.id ?? `new-${index}`}
								className="space-y-2.5 rounded-lg border border-border bg-background p-3"
							>
								<div className="flex items-start gap-2">
									<div className="grid flex-1 gap-1.5">
										<Label
											htmlFor={titleId}
											className="text-muted-foreground text-xs"
										>
											Title
										</Label>
										<Input
											id={titleId}
											value={pack.title}
											onChange={(e) =>
												update(index, {
													title: e.target.value,
												})
											}
											disabled={disabled}
											maxLength={120}
											placeholder="e.g. Payment flow threat model"
										/>
									</div>
									<Button
										variant="ghost"
										size="icon"
										className="mt-6 shrink-0"
										onClick={() => setDeleteIndex(index)}
										disabled={disabled}
										aria-label={`Remove knowledge pack ${
											pack.title || index + 1
										}`}
									>
										<Trash2Icon
											aria-hidden="true"
											className="size-4 text-destructive"
										/>
									</Button>
								</div>
								<div className="grid gap-1.5">
									<Label
										htmlFor={contentId}
										className="text-muted-foreground text-xs"
									>
										Content
									</Label>
									<Textarea
										id={contentId}
										value={pack.content}
										onChange={(e) =>
											update(index, {
												content: e.target.value,
											})
										}
										disabled={disabled}
										maxLength={8000}
										rows={4}
										placeholder="Reference notes the scanner should consider for this project."
									/>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			<AlertDialog
				open={deleteIndex !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDeleteIndex(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Remove knowledge pack?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This removes the pack from the draft. It is deleted
							permanently when you save your configuration.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDelete}>
							Remove
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
