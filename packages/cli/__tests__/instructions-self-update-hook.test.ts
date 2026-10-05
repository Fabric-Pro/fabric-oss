/**
 * Where the kept copy's self-update sits in a hook run (`run` in
 * `commands/instructions/index.ts`): after the hook has printed what it has to
 * say, never for a person's own command, only for the deployment the hook is
 * bound to, and with at most one line of its own, on stderr. The update's own
 * rules are pinned in `self-update.test.ts`; here it is replaced by a spy.
 */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hookTiming } from "../src/lib/instructions/hook-timing.js";
import type { SelfUpdateOutcome } from "../src/lib/instructions/self-update.js";
import { recordUpgradeNotice } from "../src/lib/user-agent.js";
import {
	makeTree,
	resetInstructionsMocks,
	runCli,
} from "./helpers/instructions-commands.js";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		getPublished: vi.fn(),
		createDownloadUrl: vi.fn(),
		getApiKey: vi.fn<(origin?: string) => string | undefined>(),
		getConfigPath: vi.fn<() => string>(),
		getDefaultContext: vi.fn<() => unknown>(),
		withoutContext: vi.fn(),
		getClient: vi.fn(),
		refreshKeptCopy: vi.fn(),
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

vi.mock("../src/lib/instructions/self-update.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/lib/instructions/self-update.js")
	>()),
	refreshKeptCopy: mocks.refreshKeptCopy,
}));

const ORIGIN = "https://fabric.example.com";
const TARBALL = "/cli/fabric-0.5.0-0123456789.tgz";
const UNPUBLISHED = { published: false, sourceOfTruth: "UPLOAD" } as const;
const NOTHING_PUBLISHED =
	"This project has no published coding instructions yet.\n";
const UPDATED: SelfUpdateOutcome = {
	kind: "updated",
	version: "0.6.0",
	tarball: "/cli/fabric-0.6.0-abcdef0123.tgz",
};
const UPDATED_LINE =
	"fabric: this CLI copy was updated to 0.6.0; it runs from the next session\n";

let config: string;

beforeEach(async () => {
	resetInstructionsMocks(mocks);
	mocks.refreshKeptCopy.mockReset();
	mocks.refreshKeptCopy.mockResolvedValue({
		kind: "skipped",
		reason: "checked-recently",
	} satisfies SelfUpdateOutcome);
	config = await makeTree();
	mocks.getConfigPath.mockReturnValue(path.join(config, "config.json"));
	mocks.getPublished.mockResolvedValue(UNPUBLISHED);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function hookRun(verb: "check" | "sync", ...extra: string[]) {
	const dest = await makeTree();
	return runCli([
		verb,
		"--project",
		"project-1",
		"--dest",
		dest,
		"--hook",
		...extra,
	]);
}

function requestError(status: number) {
	return Object.assign(new Error("request failed"), { status });
}

describe("a hook run bound to a deployment", () => {
	it("asks the kept copy to update once, after its own output is written", async () => {
		let stdoutWhenAsked = "";
		mocks.refreshKeptCopy.mockImplementation(async () => {
			stdoutWhenAsked = vi
				.mocked(process.stdout.write)
				.mock.calls.map((call) => String(call[0]))
				.join("");
			return { kind: "current" } satisfies SelfUpdateOutcome;
		});
		const before = Date.now();

		const result = await hookRun("check", "--base-url", ORIGIN);

		expect(mocks.refreshKeptCopy).toHaveBeenCalledTimes(1);
		expect(stdoutWhenAsked).toBe(NOTHING_PUBLISHED);
		expect(result).toEqual({
			code: 0,
			stdout: NOTHING_PUBLISHED,
			stderr: "",
		});
		const [input] = mocks.refreshKeptCopy.mock.calls[0] as [
			Record<string, unknown>,
		];
		expect(input).toMatchObject({
			origin: ORIGIN,
			configDirectory: config,
			timing: {
				budgetMs: hookTiming.selfUpdateBudgetMs,
				marginMs: hookTiming.selfUpdateMarginMs,
			},
		});
		expect(input.deadlineAt as number).toBeGreaterThanOrEqual(
			before + hookTiming.deadlineMs,
		);
		expect(input.deadlineAt as number).toBeLessThanOrEqual(
			Date.now() + hookTiming.deadlineMs,
		);
	});

	it("hands over the tarball the running build says it is served at", async () => {
		vi.stubGlobal("__FABRIC_BUNDLE__", true);
		vi.stubGlobal("__FABRIC_BUNDLE_TARBALL__", TARBALL);

		await hookRun("check", "--base-url", ORIGIN);

		expect(mocks.refreshKeptCopy.mock.calls[0]?.[0]).toMatchObject({
			runningTarball: TARBALL,
		});
	});

	it("says one line on stderr when the copy was updated, and stdout is as it was", async () => {
		mocks.refreshKeptCopy.mockResolvedValue(UPDATED);

		const result = await hookRun("check", "--base-url", ORIGIN);

		expect(result).toEqual({
			code: 0,
			stdout: NOTHING_PUBLISHED,
			stderr: UPDATED_LINE,
		});
	});

	it("says one line on stderr when the update failed, and still exits 0", async () => {
		mocks.refreshKeptCopy.mockResolvedValue({
			kind: "failed",
			reason: "the deployment could not be reached",
		} satisfies SelfUpdateOutcome);

		const result = await hookRun("check", "--base-url", ORIGIN);

		expect(result).toEqual({
			code: 0,
			stdout: NOTHING_PUBLISHED,
			stderr: "fabric: this CLI copy was not updated (the deployment could not be reached); the earlier copy was kept\n",
		});
	});

	it("says nothing about an update that was skipped or found nothing new", async () => {
		mocks.refreshKeptCopy.mockResolvedValue({
			kind: "current",
		} satisfies SelfUpdateOutcome);

		const result = await hookRun("check", "--base-url", ORIGIN);

		expect(result.stderr).toBe("");
	});

	it("puts the deployment's upgrade line before anything about the update", async () => {
		mocks.getPublished.mockImplementation(async () => {
			recordUpgradeNotice(
				"This CLI is older than the deployment expects.",
			);
			return UNPUBLISHED;
		});
		mocks.refreshKeptCopy.mockResolvedValue(UPDATED);

		const result = await hookRun("check", "--base-url", ORIGIN);

		expect(result.stdout).toBe(
			`${NOTHING_PUBLISHED}This CLI is older than the deployment expects.\n`,
		);
		expect(result.stderr).toBe(UPDATED_LINE);
	});
});

describe("a hook that is refused because this CLI is too old", () => {
	it("asks for the update as well, since a newer copy is the fix", async () => {
		mocks.getPublished.mockImplementation(async () => {
			recordUpgradeNotice(
				"This CLI is older than the deployment expects.",
			);
			throw requestError(426);
		});
		mocks.refreshKeptCopy.mockResolvedValue(UPDATED);

		const result = await hookRun("check", "--base-url", ORIGIN);

		expect(mocks.refreshKeptCopy).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			code: 0,
			stdout: "This CLI is older than the deployment expects.\n",
			stderr: UPDATED_LINE,
		});
	});
});

describe("a run that does not ask for an update", () => {
	it("is a command a person ran, without --hook", async () => {
		const dest = await makeTree();

		await runCli([
			"check",
			"--project",
			"project-1",
			"--dest",
			dest,
			"--base-url",
			ORIGIN,
		]);

		expect(mocks.refreshKeptCopy).not.toHaveBeenCalled();
	});

	it("is a hook that names no deployment", async () => {
		await hookRun("check");

		expect(mocks.refreshKeptCopy).not.toHaveBeenCalled();
	});

	it.each([
		["check", 401],
		["check", 500],
		["sync", 404],
	] as const)(
		"is a %s hook whose own work failed with %i",
		async (verb, status) => {
			mocks.getPublished.mockRejectedValue(requestError(status));

			const result = await hookRun(verb, "--base-url", ORIGIN);

			expect(mocks.refreshKeptCopy).not.toHaveBeenCalled();
			expect(result.code).toBe(0);
		},
	);
});
