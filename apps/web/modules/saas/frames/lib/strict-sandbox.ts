/**
 * Every frame's HTML runs in the strict sandbox: scripts and forms but never
 * same-origin, a deny-all CSP, and the page runtime (see
 * `project-frame-srcdoc`). A page written by an unattended run is drawn there
 * with every script removed.
 */
export { isUnattendedFrame } from "@repo/utils/frame-surfaces";
