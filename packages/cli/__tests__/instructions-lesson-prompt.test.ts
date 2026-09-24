/**
 * `fabric instructions lesson-prompt` — the Stop hook's CLI wiring — end to
 * end (Fizzy #2539; split by subject from `commands.test.ts` under Fizzy
 * #2698), with the SDK client mocked at the `getClient` boundary.
 *
 * This complements, rather than duplicates, `lesson-prompt.test.ts`: that
 * file pins `runLessonPrompt` and its helpers directly (payload parsing,
 * transcript counting, the marker file, and the hook's own silent-failure
 * cases); this file drives the same command through the full CLI — stdin,
 * `--hook`, and `FABRIC_DEBUG` — the way `bin/fabric.ts` actually wires it.
 */
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetInstructionsMocks,
	runCli,
} from "./helpers/instructions-commands.js";

// `vi.mock` is hoisted above every import in this file, so the mock object
// literal and the two factory bodies stay inline and per-file; only the
// fixtures they don't touch (`runCli`, …) live in the helper. Nothing here
// asserts on `mocks` directly, but the command module still imports the
// modules these calls intercept, and the real ones would reach the network.
const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<() => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
	},
}));

vi.mock("../src/lib/config.js", () => ({
	getApiKey: mocks.getApiKey,
	getConfigPath: mocks.getConfigPath,
	getBaseUrl: () => undefined,
	getDefaultContext: mocks.getDefaultContext,
	getOutputFormat: () => "table",
}));

vi.mock("../src/lib/client.js", () => {
	const client = {
		instructions: {
			getPublished: mocks.getPublished,
			createDownloadUrl: mocks.createDownloadUrl,
		},
		// The real `FabricClient.withoutContext()` returns a sibling with no
		// ambient org/personal default. Here it returns the same stub and
		// records that it was asked for.
		withoutContext: () => {
			mocks.withoutContext();
			return client;
		},
	};
	return {
		getClient: (overrides: unknown) => {
			mocks.getClient(overrides);
			return client;
		},
	};
});

beforeEach(() => {
	resetInstructionsMocks(mocks);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// lesson-prompt (Stop hook wiring — see __tests__/lesson-prompt.test.ts for
// the unit tests behind runLessonPrompt itself)
// ---------------------------------------------------------------------------
describe("fabric instructions lesson-prompt", () => {
	/**
	 * `process.stdin` is a lazily-created, configurable property on `process`
	 * rather than a plain field, so it can be swapped for a fixed-content
	 * stream and restored afterward without touching the real one.
	 */
	function withStdin(text: string): () => void {
		const stream = Readable.from([Buffer.from(text, "utf8")]);
		const original = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			value: stream,
			configurable: true,
			enumerable: true,
		});
		return () => {
			if (original) {
				Object.defineProperty(process, "stdin", original);
			}
		};
	}

	it("prints nothing and exits 0 when stop_hook_active is true", async () => {
		const restoreStdin = withStdin(
			JSON.stringify({
				session_id: "session-1",
				transcript_path: "/nonexistent.jsonl",
				stop_hook_active: true,
				hook_event_name: "Stop",
			}),
		);
		try {
			const result = await runCli([
				"lesson-prompt",
				"--project",
				"p",
				"--hook",
			]);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		} finally {
			restoreStdin();
		}
	});

	/**
	 * `FABRIC_DEBUG=1` turns on `debugLog` inside `runLessonPrompt`, and a
	 * transcript path that does not exist is exactly the "could not read
	 * transcript" branch that logs. The never-fail contract still has to
	 * hold with debug logging on: at most one line on stderr, nothing on
	 * stdout, exit 0.
	 */
	it("logs at most one debug line and prints nothing under FABRIC_DEBUG", async () => {
		const restoreStdin = withStdin(
			JSON.stringify({
				session_id: "session-1",
				transcript_path: "/nonexistent-transcript.jsonl",
				stop_hook_active: false,
				hook_event_name: "Stop",
			}),
		);
		process.env.FABRIC_DEBUG = "1";
		try {
			const result = await runCli([
				"lesson-prompt",
				"--project",
				"project-1",
				"--hook",
			]);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
			expect(
				result.stderr === "" ||
					result.stderr.split("\n").filter(Boolean).length <= 1,
			).toBe(true);
		} finally {
			restoreStdin();
			delete process.env.FABRIC_DEBUG;
		}
	});
});
