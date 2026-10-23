import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const LOCAL_MODULES = new Set([
	"./parlume-aura",
	"./parlume-barge-in",
	"./parlume-chat",
	"./parlume-chat-channel",
	"./parlume-chat-commands",
	"./parlume-pcm",
	"./parlume-realtime",
	"./parlume-realtime-bridge",
	"./parlume-realtime-engine",
	"./parlume-speakers",
	"./parlume-stream-auth",
	"./parlume-suggestions",
	"./parlume-transcriber",
	"./parlume-turn-endpoint",
	"./parlume-voice-floor",
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
		atob,
		btoa,
		Date,
		Response,
		URL,
		TextEncoder,
		TextDecoder,
		crypto,
		fetch,
		console: { info() {}, warn() {}, error() {}, log() {} },
		// The audio outlet ticks for as long as a bot is connected; its timers
		// must not keep a finished test process alive.
		setTimeout: (run: () => void, milliseconds: number) =>
			setTimeout(run, milliseconds).unref(),
		clearTimeout,
	});
	return exports;
}
