/**
 * The Chromium flags every server-side PDF print launches with: the Proposal
 * export and the frame export (Fizzy #2946).
 *
 * - `--no-sandbox`: Chromium's sandbox does not start under the worker
 *   image's default seccomp profile; each caller states what else keeps
 *   the browser contained.
 * - `--disable-dev-shm-usage`: a container's default `/dev/shm` is too
 *   small for Chromium's shared memory and can crash a page; Chromium
 *   writes those files to the temporary directory instead.
 * - `--font-render-hinting=none`: Linux Chromium otherwise hints fonts,
 *   which snaps every glyph advance to a whole pixel; the PDF draws the
 *   unhinted outlines at those rounded positions, so printed words open
 *   gaps between their letters.
 */
export const PRINT_CHROMIUM_ARGS: readonly string[] = [
	"--no-sandbox",
	"--disable-dev-shm-usage",
	"--font-render-hinting=none",
];
