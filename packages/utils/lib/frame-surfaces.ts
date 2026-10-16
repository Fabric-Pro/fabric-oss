/**
 * The surfaces a frame can belong to. Pure and free of `zod`, so the database
 * queries, the workflow-builder preset and workflow-bundle code all read the
 * same list.
 */
export const FRAME_SURFACES = ["artifact", "workspace"] as const;
export type FrameSurface = (typeof FRAME_SURFACES)[number];
