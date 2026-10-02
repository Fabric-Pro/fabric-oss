import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const LOCAL_MODULES = new Set([
	"./parlume-pcm",
	"./parlume-speakers",
	"./parlume-stream-auth",
	"./parlume-transcriber",
	"./parlume-turn-endpoint",
	"./parlume-wake",
]);

/**
 * The Durable Object depends on partyserver's runtime; tests load the bridge
 * through a transpiled CommonJS shim with just enough of that runtime, and
 * every other bridge module as written. Network calls go to `fetch`.
 */
export function loadParlumeModule(
	path: string,
	fetch: (...args: unknown[]) => Promise<Response>,
): Record<string, unknown> {
	const exports: Record<string, unknown> = {};
	const source = ts.transpileModule(
		readFileSync(new URL(path, import.meta.url), "utf8"),
		{
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
			},
		},
	).outputText;
	const require = (id: string) => {
		if (id === "partyserver") {
			return {
				Server: class {
					ctx: unknown;
					env: unknown;
					name = "session-1";
					constructor(ctx: unknown, env: unknown) {
						this.ctx = ctx;
						this.env = env;
					}
				},
			};
		}
		if (LOCAL_MODULES.has(id)) {
			return loadParlumeModule(`${id}.ts`, fetch);
		}
		throw new Error(`Unexpected import: ${id}`);
	};
	runInNewContext(source, {
		exports,
		require,
		ArrayBuffer,
		Uint8Array,
		Date,
		Response,
		URL,
		TextEncoder,
		crypto,
		fetch,
		console: { info() {}, warn() {}, error() {}, log() {} },
		setTimeout,
		clearTimeout,
	});
	return exports;
}
