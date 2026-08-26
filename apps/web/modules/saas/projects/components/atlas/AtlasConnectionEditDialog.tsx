"use client";

/**
 * Editor for a STAGED (not-yet-saved) connection — the kind + description picker
 * a draw (`onConnect`) or a "+ New connection" opens before the connection is
 * persisted. Host-agnostic: the solo graph and the System map both pass the
 * staged create's endpoint labels, their own connection kinds + localised labels,
 * and the Save / Remove / Cancel handlers.
 *
 * Mirrors the "+ New connection" inline form's inputs (kind Select with a tinted
 * dot per kind + a description Textarea). Tokens only, motion-safe, a11y: the
 * Dialog traps focus and is keyboard-dismissable; the Select carries an
 * aria-label.
 */
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { ArrowRightIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { edgeKindColorVar } from "./atlas-edges";

export interface ConnectionEditTarget {
	/** The staged create's id (its endpoint signature). */
	id: string;
	sourceLabel: string;
	targetLabel: string;
	kind: string;
	description: string;
}

interface AtlasConnectionEditDialogProps {
	/** The staged create being edited, or null when the dialog is closed. */
	target: ConnectionEditTarget | null;
	/** Connection kinds for the Select (solo or system kinds). */
	kindOptions: string[];
	/** Localised label for an edge kind. */
	kindLabel: (kind: string) => string;
	/** Persist the chosen kind + description into the pending create, then close. */
	onSave: (id: string, kind: string, description: string) => void;
	/** Drop the pending create entirely, then close. */
	onRemove: (id: string) => void;
	/** Close without changing the pending create. */
	onCancel: () => void;
}

export function AtlasConnectionEditDialog({
	target,
	kindOptions,
	kindLabel,
	onSave,
	onRemove,
	onCancel,
}: AtlasConnectionEditDialogProps) {
	const t = useTranslations("projects.atlas.connectionEditor");
	const [kind, setKind] = useState<string>(
		target?.kind ?? kindOptions[0] ?? "RELATES_TO",
	);
	const [description, setDescription] = useState(target?.description ?? "");

	// Re-seed the form whenever a different create is opened for editing.
	useEffect(() => {
		if (target) {
			setKind(target.kind);
			setDescription(target.description);
		}
	}, [target]);

	const open = target !== null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) {
					onCancel();
				}
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("title")}</DialogTitle>
					<DialogDescription className="flex flex-wrap items-center gap-1.5 text-foreground">
						<span className="break-words font-medium">
							{target?.sourceLabel}
						</span>
						<ArrowRightIcon
							aria-hidden="true"
							className="size-3.5 shrink-0 text-muted-foreground"
						/>
						<span className="break-words font-medium">
							{target?.targetLabel}
						</span>
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-1">
					<div className="space-y-1.5">
						<Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
							{t("kind")}
						</Label>
						<Select value={kind} onValueChange={setKind}>
							<SelectTrigger aria-label={t("kind")}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{kindOptions.map((option) => (
									<SelectItem key={option} value={option}>
										<span className="flex items-center gap-2">
											<span
												aria-hidden="true"
												className="size-2 rounded-full"
												style={{
													background:
														edgeKindColorVar(
															option,
														),
												}}
											/>
											{kindLabel(option)}
										</span>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="space-y-1.5">
						<Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
							{t("description")}
						</Label>
						<Textarea
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={3}
							placeholder={t("descriptionPlaceholder")}
							className="resize-y text-sm"
						/>
					</div>
				</div>

				<DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => target && onRemove(target.id)}
						className="gap-1.5 text-destructive hover:text-destructive sm:mr-auto"
					>
						<Trash2Icon aria-hidden="true" className="size-4" />
						{t("remove")}
					</Button>
					<div className="flex items-center gap-2 sm:justify-end">
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onCancel}
						>
							{t("cancel")}
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={() =>
								target &&
								onSave(target.id, kind, description.trim())
							}
						>
							{t("save")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
