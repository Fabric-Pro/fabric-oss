/** Appearance only: presentation never changes scripts, tool grants or access. */
export const FRAME_PRESENTATIONS = ["DOCUMENT", "INTERFACE"] as const;
export type FramePresentation = (typeof FRAME_PRESENTATIONS)[number];

export function effectiveFramePresentation(frame: {
	presentation?: FramePresentation;
	sourceRunType?: string | null;
	metadata?: { sourceRunType?: string };
}): FramePresentation {
	// Report output remains a document, including legacy or copied content.
	if (
		frame.sourceRunType === "REPORT_EXECUTION" ||
		frame.metadata?.sourceRunType === "REPORT_EXECUTION"
	) {
		return "DOCUMENT";
	}
	return frame.presentation ?? "DOCUMENT";
}

/** Native interface PDF cannot merge separately sandboxed documents faithfully. */
export function canExportFramePresentationToPdf(frame: {
	presentation?: FramePresentation;
	sourceRunType?: string | null;
	metadata?: { sourceRunType?: string };
	blocks: readonly unknown[];
}): boolean {
	return (
		effectiveFramePresentation(frame) !== "INTERFACE" ||
		frame.blocks.length === 1
	);
}
export const FRAME_INTERFACE_PDF_BLOCK_ERROR =
	"Interface PDF export supports one self-contained block. Combine the interface into one HTML block, or switch to Document presentation to use document styling.";
