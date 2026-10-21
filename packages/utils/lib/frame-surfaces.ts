/**
 * The surfaces a frame can belong to. Pure and free of `zod`, so the database
 * queries, the workflow-builder preset and workflow-bundle code all read the
 * same list.
 */
export const FRAME_SURFACES = ["artifact", "workspace"] as const;
export type FrameSurface = (typeof FRAME_SURFACES)[number];

/**
 * The `sourceRunType` the Publish Frame workflow step stamps on the frames it
 * writes. Those runs write a page with nobody watching: they read private data
 * beside data nobody vetted, and a script one was talked into writing would run
 * in front of whoever opens the page next. So such a page is drawn with every
 * script removed, and so is any copy of it, whoever makes the copy.
 */
export const UNATTENDED_FRAME_SOURCE_RUN_TYPE = "workflow";

export function isUnattendedFrame(frame: {
	sourceRunType?: string | null;
}): boolean {
	return frame.sourceRunType === UNATTENDED_FRAME_SOURCE_RUN_TYPE;
}
