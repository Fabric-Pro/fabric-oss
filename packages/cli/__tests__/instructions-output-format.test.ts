/**
 * Output format resolution across `fabric instructions check | sync | init`
 * end to end (Fizzy #2539; split by subject from `commands.test.ts` under
 * Fizzy #2698), with the SDK client mocked at the `getClient` boundary.
 *
 * This block spans three commands rather than exercising one (it pins
 * `FABRIC_FORMAT`-vs-`--format` precedence and the table/json/yaml/csv
 * shapes, using whichever command is the simplest vehicle for a given case),
 * so it gets its own file instead of joining `instructions-check.test.ts`,
 * `instructions-sync.test.ts` or `instructions-init.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeSnapshotDigest } from "../src/lib/instructions/manifest.js";
import {
	makeTree,
	manifestEntry,
	resetInstructionsMocks,
	runCli,
	snapshotFor,
	stubBundle,
} from "./helpers/instructions-commands.js";

// `vi.mock` is hoisted above every import in this file, so the mock object
// literal and the two factory bodies stay inline and per-file; only the
// fixtures they don't touch (`runCli`, `makeTree`, …) live in the helper.
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
// Output format
// ---------------------------------------------------------------------------
describe("output format", () => {
	it("honours FABRIC_FORMAT=json without a local flag", async () => {
		const dest = await makeTree();
		process.env.FABRIC_FORMAT = "json";
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
		]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.projectId).toBe("project-1");
		expect(parsed.synced).toBe(false);
	});

	/**
	 * Review round 2, finding 10. `formatFor` re-read `FABRIC_FORMAT` after
	 * asking Commander, so the environment beat an explicit global flag — the
	 * one thing a flag is for.
	 */
	it("lets an explicit --format table beat FABRIC_FORMAT=json", async () => {
		const dest = await makeTree();
		process.env.FABRIC_FORMAT = "json";
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli(
			["check", "--project", "project-1", "--dest", dest],
			["--format", "table"],
		);

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout)).toThrow();
		expect(result.stdout).toContain("Coding instructions");
	});

	it("treats an inherited yaml or csv as text rather than failing", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli(
			["check", "--project", "project-1", "--dest", dest],
			["--format", "yaml"],
		);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Coding instructions");
	});

	it("prints JSON from sync when asked", async () => {
		const dest = await makeTree();
		const manifest = [manifestEntry("AGENTS.md", "hello\n")];
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor(manifest),
			manifest,
		});
		mocks.createDownloadUrl.mockResolvedValue({
			snapshotId: "snap-2",
			digest: computeSnapshotDigest(manifest),
			url: "https://storage.example.com/exports/snap-2.zip",
			expiresInSeconds: 600,
		});
		stubBundle({ "AGENTS.md": "hello\n" });

		const result = await runCli([
			"sync",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout).added).toEqual(["AGENTS.md"]);
		expect(JSON.parse(result.stdout).keptEdited).toEqual([]);
	});

	it("prints JSON from init when asked", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: false,
			sourceOfTruth: "UPLOAD",
		});

		const result = await runCli([
			"init",
			"--project",
			"project-1",
			"--tool",
			"claude-code",
			"--dest",
			dest,
			"--format",
			"json",
		]);

		expect(result.code).toBe(0);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.hookCommand).toBe(
			"fabric instructions check --project project-1 --hook",
		);
		expect(parsed.sync).toBeNull();
	});

	/**
	 * `yaml` and `csv` are real values for the rest of this CLI and these
	 * commands have no such shape, so they print text rather than failing.
	 * Refusing them would be a promise that cannot be kept either: when a
	 * parent and a subcommand declare the same flag, Commander stores the
	 * value on the ROOT, so this never arrives as a local option at all.
	 */
	it("prints text for a format it has no shape for", async () => {
		const dest = await makeTree();
		mocks.getPublished.mockResolvedValue({
			published: true,
			sourceOfTruth: "UPLOAD",
			snapshot: snapshotFor([]),
			manifest: [],
		});

		const result = await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--format",
			"yaml",
		]);

		expect(result.code).toBe(0);
		expect(() => JSON.parse(result.stdout)).toThrow();
	});
});
