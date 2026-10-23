"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { useTranslations } from "next-intl";
import {
	PROPOSAL_STYLE_DIRECTION_MAX_CHARS,
	PROPOSAL_STYLE_MAX_ACCENTS,
	type SaveFeedbackState,
} from "./proposal-style-model";

/**
 * What the Style tab's last Save came to, under its button: a saved notice
 * that offers to regenerate when the page can, or why nothing was saved. A
 * recipient conflict is said beside the recipient fields instead.
 */
export function SaveFeedback({
	feedback,
	isGenerating,
	onRegenerate,
}: {
	feedback: SaveFeedbackState;
	isGenerating: boolean;
	onRegenerate?: () => void;
}) {
	const t = useTranslations("projects.proposalArtifact.style");

	if (feedback.kind === "saved") {
		return (
			<Alert variant="success" role="status">
				<AlertDescription className="mt-0 flex flex-wrap items-center gap-3">
					<span className="flex-1">{t("saved")}</span>
					{onRegenerate && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={isGenerating}
							onClick={onRegenerate}
						>
							{t("regenerate")}
						</Button>
					)}
				</AlertDescription>
			</Alert>
		);
	}
	if (feedback.kind === "invalid") {
		// A too-long direction is flagged beside the field; colours beside
		// each entry. This line says why nothing was saved.
		return (
			<p role="alert" className="text-destructive text-sm">
				{t(`invalid.${feedback.error}`, {
					max:
						feedback.error === "directionTooLong"
							? PROPOSAL_STYLE_DIRECTION_MAX_CHARS
							: PROPOSAL_STYLE_MAX_ACCENTS,
				})}
			</p>
		);
	}
	if (
		feedback.kind === "styleFailed" ||
		feedback.kind === "recipientFailed"
	) {
		return (
			<p role="alert" className="text-destructive text-sm">
				{t(feedback.kind)}
			</p>
		);
	}
	return null;
}
