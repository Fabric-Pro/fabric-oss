/**
 * Diagram layout off the worker's event loop (Fizzy #2946).
 *
 * beautiful-mermaid lays a diagram out synchronously, and a fence a document
 * author writes can take tens of seconds to lay out. On the worker's own
 * thread that would stall every queue the process polls, heartbeats
 * included, and no timer could stop it. So the export lays its diagrams out
 * in a worker thread of its own: each diagram has a wall-clock limit, and a
 * diagram that runs past it is abandoned by terminating the thread, and the
 * next diagram gets a fresh thread. The thread also has its own heap limit.
 *
 * The thread imports the engine by its file URL: the package is ESM-only
 * and the worker runs as CommonJS, so the entry is read from the package's
 * own `exports` map rather than resolved by name.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { RenderOptions } from "beautiful-mermaid";

/**
 * Why a layout was abandoned: it ran past its limit or no time was left
 * (`timeLimit`), or the thread failed or could not start (`thread`).
 */
export type DiagramLayoutAbandonment = "timeLimit" | "thread";

/**
 * One diagram's layout: its SVG, or null when there is none. `abandoned`
 * says the null came from the thread, not the source, and why. A source the
 * engine refused (or an engine that cannot load) is not abandoned.
 */
export type DiagramLayoutResult =
	| { svg: string; abandoned: false }
	| { svg: null; abandoned: false | DiagramLayoutAbandonment };

/** Lays one diagram out. */
export interface DiagramLayout {
	/** The diagram's SVG or why there is none. Never rejects. */
	render(
		source: string,
		options: RenderOptions,
		timeoutMs: number,
	): Promise<DiagramLayoutResult>;
	/** Stops the thread, if one is running. */
	close(): Promise<void>;
}

/** The heap one layout thread may use. */
const LAYOUT_HEAP_MB = 512;

/**
 * The thread's whole program: import the engine once, then answer each
 * diagram by id. A refusal or an error answers null; the parent decides
 * what a missing answer means.
 */
const LAYOUT_THREAD_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const engine = import(workerData.entry);
engine.catch(() => undefined);
parentPort.on("message", (task) => {
	engine.then(
		(mermaid) => {
			let svg = null;
			try {
				svg = mermaid.renderMermaidSVG(task.source, task.options);
			} catch {
				svg = null;
			}
			parentPort.postMessage({ id: task.id, svg: typeof svg === "string" ? svg : null });
		},
		() => parentPort.postMessage({ id: task.id, svg: null }),
	);
});
`;

/**
 * beautiful-mermaid's ESM entry as a file URL, from the copy this package
 * declares (`packages/temporal/node_modules/beautiful-mermaid`).
 */
export function beautifulMermaidEntryUrl(): string {
	const packageDir = join(
		__dirname,
		"..",
		"..",
		"..",
		"node_modules",
		"beautiful-mermaid",
	);
	const manifest = JSON.parse(
		readFileSync(join(packageDir, "package.json"), "utf8"),
	) as { exports?: { "."?: { import?: unknown } } };
	const entry = manifest.exports?.["."]?.import;
	if (typeof entry !== "string") {
		throw new Error("beautiful-mermaid declares no ESM entry");
	}
	return pathToFileURL(resolve(packageDir, entry)).href;
}

/**
 * A layout backed by worker threads, one at a time. `entry` is the engine
 * module's URL; tests pass a stand-in.
 */
export function openDiagramLayout(
	entry: string = beautifulMermaidEntryUrl(),
): DiagramLayout {
	let thread: Worker | null = null;
	let nextId = 0;

	const spawn = (): Worker => {
		const worker = new Worker(LAYOUT_THREAD_SOURCE, {
			eval: true,
			workerData: { entry },
			resourceLimits: { maxOldGenerationSizeMb: LAYOUT_HEAP_MB },
		});
		// A thread can fail while no render waits on it: past a render's
		// limit, or idle between diagrams. An error nobody listens for
		// would be thrown on this thread's event loop and take the whole
		// worker down, so every thread is heard for its whole life, and one
		// that failed or ended is never handed another diagram.
		const retire = () => {
			if (thread === worker) {
				thread = null;
			}
		};
		worker.on("error", retire);
		worker.once("exit", retire);
		return worker;
	};

	return {
		render(source, options, timeoutMs) {
			if (timeoutMs <= 0) {
				return Promise.resolve({ svg: null, abandoned: "timeLimit" });
			}
			if (thread === null) {
				try {
					thread = spawn();
				} catch {
					return Promise.resolve({ svg: null, abandoned: "thread" });
				}
			}
			const current = thread;
			const id = ++nextId;
			return new Promise((resolveRender) => {
				let settled = false;
				const settle = (
					svg: string | null,
					abandon: false | DiagramLayoutAbandonment,
				) => {
					if (settled) {
						return;
					}
					settled = true;
					clearTimeout(timer);
					current.off("message", onMessage);
					current.off("error", onFailure);
					current.off("exit", onFailure);
					if (abandon) {
						if (thread === current) {
							thread = null;
						}
						void current.terminate().catch(() => undefined);
					}
					resolveRender(
						svg === null
							? { svg: null, abandoned: abandon }
							: { svg, abandoned: false },
					);
				};
				const onMessage = (message: {
					id?: unknown;
					svg?: unknown;
				}) => {
					if (message?.id === id) {
						settle(
							typeof message.svg === "string"
								? message.svg
								: null,
							false,
						);
					}
				};
				const onFailure = () => settle(null, "thread");
				const timer = setTimeout(
					() => settle(null, "timeLimit"),
					timeoutMs,
				);
				current.on("message", onMessage);
				current.once("error", onFailure);
				current.once("exit", onFailure);
				current.postMessage({ id, source, options });
			});
		},
		async close() {
			const current = thread;
			thread = null;
			await current?.terminate().catch(() => undefined);
		},
	};
}
