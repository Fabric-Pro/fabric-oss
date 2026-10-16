/**
 * Which runs write a page with nobody watching. A page one of them wrote is
 * drawn with every script removed (see `buildProjectFrameSrcdoc`): an
 * unattended run reads private data beside data nobody vetted, and a script it
 * was talked into writing would run in front of whoever opens the page next.
 * Pages written in a chat, where a person sees what the agent does, keep theirs.
 *
 * The value is the one the Publish Frame workflow step stamps on the frames it
 * creates.
 */
const UNATTENDED_SOURCE_RUN_TYPES: ReadonlySet<string> = new Set(["workflow"]);

export function isUnattendedFrame(frame: {
	sourceRunType?: string | null;
}): boolean {
	return (
		frame.sourceRunType != null &&
		UNATTENDED_SOURCE_RUN_TYPES.has(frame.sourceRunType)
	);
}

/**
 * Whether a frame's HTML runs in the strict sandbox: scripts and forms but
 * never same-origin, a deny-all CSP, and the page runtime (see
 * `project-frame-srcdoc`).
 *
 * A frame that belongs to a project, lives on a surface (a project's Artifacts
 * tab, an organization Workspace) or was written by an unattended run is
 * agent-written, and may be opened by people other than its author, so it
 * always runs there. So does any frame at all when the person opening it is
 * not its author (`viewerUserId` given): somebody else's script never runs in
 * this app's own origin. Only an author's own frames from before all of this
 * keep the historical renderer, which is a separate change to make.
 */
export function usesStrictSandbox(
	frame: {
		userId?: string | null;
		projectId?: string | null;
		surface?: string | null;
		sourceRunType?: string | null;
	},
	viewerUserId?: string,
): boolean {
	return (
		Boolean(frame.projectId) ||
		Boolean(frame.surface) ||
		isUnattendedFrame(frame) ||
		(viewerUserId !== undefined && frame.userId !== viewerUserId)
	);
}
