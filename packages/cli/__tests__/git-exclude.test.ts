import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { excludeLocalFiles } from "../src/lib/instructions/git-exclude.js";

const race = vi.hoisted(() => ({
	beforeOpen: undefined as (() => Promise<void>) | undefined,
	afterOpen: undefined as (() => Promise<void>) | undefined,
	afterRead: undefined as (() => Promise<void>) | undefined,
	noFollow: true,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		constants: {
			...actual.constants,
			get O_NOFOLLOW() {
				return race.noFollow ? actual.constants.O_NOFOLLOW : undefined;
			},
		},
	};
});

vi.mock("../src/lib/instructions/git.js", () => ({
	isIgnored: async () => ({ kind: "ok", value: false }),
	excludeFilePath: async (root: string) => ({
		kind: "ok",
		value: path.join(root, "info", "exclude"),
	}),
}));

// Keep real file operations; only schedule another writer at the vulnerable
// boundaries. The old implementation checks lstat, reads, then reopens to append.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	async function beforeOpen() {
		const change = race.beforeOpen;
		race.beforeOpen = undefined;
		await change?.();
	}
	async function afterRead() {
		const change = race.afterRead;
		race.afterRead = undefined;
		await change?.();
	}
	return {
		...actual,
		lstat: async (file: string, options?: { bigint?: boolean }) => {
			try {
				return await actual.lstat(file, options);
			} finally {
				await beforeOpen();
			}
		},
		readFile: async (file: string, encoding: "utf8") => {
			const text = await actual.readFile(file, encoding);
			await afterRead();
			return text;
		},
		open: async (file: string, flags: number, mode?: number) => {
			await beforeOpen();
			const handle = await actual.open(file, flags, mode);
			const change = race.afterOpen;
			race.afterOpen = undefined;
			await change?.();
			const read = handle.readFile.bind(handle);
			vi.spyOn(handle, "readFile").mockImplementation(async (options) => {
				const text = await read(options);
				await afterRead();
				return text;
			});
			return handle;
		},
	};
});

const roots: string[] = [];
afterEach(async () => {
	race.beforeOpen = undefined;
	race.afterOpen = undefined;
	race.afterRead = undefined;
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "fabric-exclude-race-"));
	roots.push(root);
	await mkdir(path.join(root, "info"));
	return {
		root,
		file: path.join(root, "info", "exclude"),
		victim: path.join(root, "victim"),
		saved: path.join(root, "original-exclude"),
	};
}

function exclude(root: string) {
	return excludeLocalFiles({
		toplevel: root,
		directory: root,
		files: [".codex/hooks.json"],
		deadline: Date.now() + 10_000,
	});
}

describe.each([true, false])(
	"excludeLocalFiles (O_NOFOLLOW: %s)",
	(noFollow) => {
		beforeEach(() => {
			race.noFollow = noFollow;
		});
		it.skipIf(process.platform === "win32").each([true, false])(
			"refuses a substituted symlink before opening (existing: %s)",
			async (existing) => {
				const { root, file, victim } = await fixture();
				await writeFile(victim, "keep this\n");
				if (existing) {
					await writeFile(file, "# local rules\n");
				}
				race.beforeOpen = async () => {
					await rm(file, { force: true });
					await symlink(victim, file);
				};

				const result = await exclude(root);

				expect(await readFile(victim, "utf8")).toBe("keep this\n");
				expect(result).toEqual({
					kind: "failed",
					entries: ["/.codex/hooks.json"],
				});
			},
		);

		it.skipIf(process.platform === "win32")(
			"does not create the target of a substituted dangling symlink",
			async () => {
				const { root, file, victim } = await fixture();
				race.beforeOpen = async () => {
					await symlink(victim, file);
				};

				expect(await exclude(root)).toEqual({
					kind: "failed",
					entries: ["/.codex/hooks.json"],
				});
				await expect(readFile(victim, "utf8")).rejects.toMatchObject({
					code: "ENOENT",
				});
			},
		);

		it.skipIf(process.platform === "win32")(
			"keeps the append on the opened file when its path becomes a symlink",
			async () => {
				const { root, file, victim, saved } = await fixture();
				await writeFile(file, "# local rules");
				await writeFile(victim, "keep this\n");
				race.afterRead = async () => {
					await rename(file, saved);
					await symlink(victim, file);
				};

				const result = await exclude(root);

				expect(await readFile(victim, "utf8")).toBe("keep this\n");
				expect(await readFile(saved, "utf8")).toBe(
					"# local rules\n/.codex/hooks.json\n",
				);
				expect(result).toEqual({
					kind: "added",
					entries: ["/.codex/hooks.json"],
				});
			},
		);

		it.each([true, false])(
			"preserves ordinary appends and creation (existing: %s)",
			async (existing) => {
				const { root, file } = await fixture();
				if (existing) {
					await writeFile(file, "# local rules");
				}

				expect(await exclude(root)).toEqual({
					kind: "added",
					entries: ["/.codex/hooks.json"],
				});
				expect(await readFile(file, "utf8")).toBe(
					existing
						? "# local rules\n/.codex/hooks.json\n"
						: "/.codex/hooks.json\n",
				);
				expect(await exclude(root)).toEqual({ kind: "unchanged" });
			},
		);

		it("refuses a directory in place of the exclude file", async () => {
			const { root, file } = await fixture();
			await mkdir(file);

			expect(await exclude(root)).toEqual({
				kind: "failed",
				entries: ["/.codex/hooks.json"],
			});
		});

		if (!noFollow) {
			it("refuses a different regular file substituted after opening", async () => {
				const { root, file, saved } = await fixture();
				await writeFile(file, "# original\n");
				race.afterOpen = async () => {
					await rename(file, saved);
					await writeFile(file, "# replacement\n");
				};

				expect(await exclude(root)).toEqual({
					kind: "failed",
					entries: ["/.codex/hooks.json"],
				});
				expect(await readFile(file, "utf8")).toBe("# replacement\n");
				expect(await readFile(saved, "utf8")).toBe("# original\n");
			});
		}
	},
);
