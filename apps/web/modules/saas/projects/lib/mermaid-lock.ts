/**
 * mermaid.js keeps one global configuration, and `initialize` replaces it.
 * Every render that sets it — the editor's live diagram, the regular export,
 * and the Glossy export — runs through this one queue, so no two ever
 * interleave between `initialize` and `render`, and each restores the
 * configuration it replaced before the next one starts.
 *
 * Kept free of imports so the editor's Mermaid node view can share it
 * without pulling the export renderers into its bundle.
 */
let mermaidQueue: Promise<unknown> = Promise.resolve();

export function withMermaidLock<T>(task: () => Promise<T>): Promise<T> {
	const run = mermaidQueue.then(task, task);
	mermaidQueue = run.catch(() => undefined);
	return run;
}
