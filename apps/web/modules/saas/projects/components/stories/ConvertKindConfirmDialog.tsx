"use client";

/**
 * Confirmation for a BUG ↔ FEATURE type change (Fizzy #2048).
 *
 * THE COPY HERE USED TO BE A LIE. It said "Card content stays as-is — no prompt
 * re-chaining", which was true of the first pass and is the exact behaviour the
 * product owner reversed: a conversion now redrafts the description and the
 * acceptance criteria through the new type's template.
 *
 * "The content will be regenerated" would not have been enough either — it
 * reads as additive, and a user with hand-written acceptance criteria would
 * confirm expecting their text to survive alongside. The copy therefore names
 * all three consequences: the two fields are REPLACED, the current content is
 * used only as reference rather than kept, and the version they have now is
 * recoverable from version history.
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
import { ArrowLeftRightIcon, Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";

interface ConvertKindConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	targetKind: "BUG" | "FEATURE";
	isPending: boolean;
	onConfirm: () => void;
}

export function ConvertKindConfirmDialog({
	open,
	onOpenChange,
	targetKind,
	isPending,
	onConfirm,
}: ConvertKindConfirmDialogProps) {
	const t = useTranslations("projects.stories.convertKind");
	const isBug = targetKind === "BUG";

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{isBug ? t("titleBug") : t("titleFeature")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{isBug ? t("bodyBug") : t("bodyFeature")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel disabled={isPending}>
						{t("cancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						onClick={(e) => {
							e.preventDefault();
							onConfirm();
						}}
						disabled={isPending}
					>
						{isPending ? (
							<>
								<Loader2Icon className="mr-2 size-4 motion-safe:animate-spin" />
								{t("converting")}
							</>
						) : (
							<>
								<ArrowLeftRightIcon className="mr-2 size-4" />
								{isBug ? t("confirmBug") : t("confirmFeature")}
							</>
						)}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
