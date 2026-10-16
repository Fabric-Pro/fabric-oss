/**
 * Admission for a proposed Living Memory write (ADR-022): one case per problem
 * code, several problems reported together, the digest, and a secret hit that
 * names its rule and never its text. The sync's own rules are the real ones;
 * the facts admission judges are a hand-built snapshot.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => ({
	...(await import(
		"@repo/database/prisma/queries/projects/context-source-path"
	)),
	...(await import(
		"@repo/database/prisma/queries/projects/context-repository-sync-selection"
	)),
}));

import {
	evaluateMemoryWrite,
	type MemoryWriteEntryInput,
	type MemoryWriteSnapshot,
	memoryWriteDigest,
} from "../evaluate";

const OID_SHA1 = "a".repeat(40);
const OID_SHA256 = "b".repeat(64);

function snapshot(
	overrides: Partial<MemoryWriteSnapshot> = {},
): MemoryWriteSnapshot {
	return {
		readOnlyMode: false,
		sync: {
			userId: "user-delegate",
			ref: "main",
			paths: ["docs"],
			excludedPaths: ["docs/drafts"],
			automatic: true,
			automaticPausedReason: null,
		},
		delegateHoldsContextCreate: true,
		target: {
			id: "target-1",
			version: 2,
			folder: "docs/memory",
			mode: "PULL_REQUEST",
		},
		instructionRoots: [],
		managedCount: 10,
		managedKeys: new Set(),
		...overrides,
	};
}

const put = (path: string, content = "# A note\n"): MemoryWriteEntryInput => ({
	path,
	op: "PUT",
	content,
});
const del = (path: string, ifMatchOid = OID_SHA1): MemoryWriteEntryInput => ({
	path,
	op: "DELETE",
	ifMatchOid,
});

function evaluate(
	entries: MemoryWriteEntryInput[],
	state: MemoryWriteSnapshot = snapshot(),
	message = "Add notes",
) {
	return evaluateMemoryWrite(state, {
		projectId: "proj-1",
		targetId: "target-1",
		message,
		entries,
	});
}

const codes = (result: ReturnType<typeof evaluate>) =>
	result.problems.map((problem) => problem.code);

/** A synthetic token, built at run time so no source line is one. */
const githubToken = () => `ghp_${"A1".repeat(18)}`;

describe("a request that is admitted", () => {
	it("is ok, with no problems, the target as it stands and a digest", () => {
		const result = evaluate([
			put("docs/memory/a.md"),
			put("docs/memory/deep/b.json", '{"a":1}'),
			del("docs/memory/old.md"),
		]);

		expect(result).toMatchObject({
			ok: true,
			problems: [],
			target: {
				id: "target-1",
				version: 2,
				folder: "docs/memory",
				mode: "PULL_REQUEST",
				ref: "main",
			},
		});
		expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("accepts both object id lengths as ifMatchOid", () => {
		const result = evaluate([
			{ ...put("docs/memory/a.md"), ifMatchOid: OID_SHA1 },
			{ ...put("docs/memory/b.md"), ifMatchOid: OID_SHA256 },
		]);

		expect(result.ok).toBe(true);
	});

	it("accepts a subject at its bound and a long body below the message bound", () => {
		const message = `${"s".repeat(300)}\n${"body ".repeat(500)}`;

		expect(
			evaluate([put("docs/memory/a.md")], snapshot(), message).ok,
		).toBe(true);
	});
});

describe("the project and the sync", () => {
	it("refuses a project in read-only mode", () => {
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({ readOnlyMode: true }),
		);

		expect(result.ok).toBe(false);
		expect(result.problems).toContainEqual({ code: "READ_ONLY_MODE" });
	});

	it("refuses a project with no sync, and cannot name a target", () => {
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({ sync: null, target: null }),
		);

		expect(result).toMatchObject({ ok: false, target: null, digest: null });
		expect(result.problems).toEqual([
			{ code: "SYNC_NOT_INGESTING", detail: "not-configured" },
		]);
	});

	it("refuses a sync that is not automatic", () => {
		const base = snapshot();
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({
				sync: {
					...(base.sync as NonNullable<typeof base.sync>),
					automatic: false,
				},
			}),
		);

		expect(result.problems).toContainEqual({
			code: "SYNC_NOT_INGESTING",
			detail: "automatic-off",
		});
	});

	it("refuses a sync that automatic runs have paused, naming why", () => {
		const base = snapshot();
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({
				sync: {
					...(base.sync as NonNullable<typeof base.sync>),
					automaticPausedReason: "REF_MISSING",
				},
			}),
		);

		expect(result.problems).toContainEqual({
			code: "SYNC_NOT_INGESTING",
			detail: "REF_MISSING",
		});
	});

	it("refuses when the member automatic runs act as can no longer create", () => {
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({ delegateHoldsContextCreate: false }),
		);

		expect(result.problems).toContainEqual({
			code: "SYNC_DELEGATE_LOST_PERMISSION",
		});
	});
});

describe("the target", () => {
	it("refuses a target that is not the sync's, without a digest", () => {
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({ target: null }),
		);

		expect(result).toMatchObject({ ok: false, target: null, digest: null });
		expect(result.problems).toEqual([{ code: "TARGET_NOT_FOUND" }]);
	});

	it("refuses a target the sync no longer selects, naming the rule, and still judges the paths", () => {
		const base = snapshot();
		const result = evaluate(
			[put("docs/memory/a.md"), put("docs/memory/b.txt")],
			snapshot({
				sync: {
					...(base.sync as NonNullable<typeof base.sync>),
					paths: ["notes"],
				},
			}),
		);

		expect(result.problems).toContainEqual({
			code: "TARGET_STALE",
			detail: "TARGET_OUTSIDE_SELECTION",
		});
		expect(result.digest).not.toBeNull();
		expect(result.target).toMatchObject({ folder: "docs/memory" });
	});

	it("refuses a target that now overlaps the coding instructions", () => {
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({ instructionRoots: ["docs"] }),
		);

		expect(result.problems).toContainEqual({
			code: "TARGET_STALE",
			detail: "TARGET_OVERLAPS_INSTRUCTIONS",
		});
	});

	it("refuses a target the member has since left out of the sync", () => {
		const base = snapshot();
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot({
				sync: {
					...(base.sync as NonNullable<typeof base.sync>),
					excludedPaths: ["docs/memory"],
				},
			}),
		);

		expect(result.problems).toContainEqual({
			code: "TARGET_STALE",
			detail: "TARGET_EXCLUDED",
		});
	});

	describe("under a whole-repository sync", () => {
		const base = snapshot();
		const wholeRepository = {
			...(base.sync as NonNullable<typeof base.sync>),
			paths: [""],
			excludedPaths: [],
		};
		const withTarget = (folder: string) =>
			snapshot({
				sync: wholeRepository,
				target: {
					id: "target-1",
					version: 2,
					folder,
					mode: "PULL_REQUEST",
				},
			});

		it("admits a folder inside it", () => {
			const result = evaluate(
				[put("docs/ai/a.md"), put("docs/ai/deep/b.md")],
				withTarget("docs/ai"),
			);

			expect(result.ok).toBe(true);
		});

		it.each([
			["the repository root", ""],
			["a CI folder", ".github"],
			["a hidden folder inside a normal one", "docs/.private"],
		])("refuses %s as a reserved target", (_name, folder) => {
			const result = evaluate([put("docs/ai/a.md")], withTarget(folder));

			expect(result.ok).toBe(false);
			expect(result.problems).toContainEqual({
				code: "TARGET_STALE",
				detail: "TARGET_RESERVED",
			});
		});

		it("judges the paths of a reserved root target too, refusing the hidden ones", () => {
			const result = evaluate(
				[put(".github/workflows/ci.yml"), put("docs/a.md")],
				withTarget(""),
			);

			expect(result.problems).toContainEqual({
				path: ".github/workflows/ci.yml",
				code: "PATH_HIDDEN",
			});
			expect(result.problems).not.toContainEqual(
				expect.objectContaining({ path: "docs/a.md" }),
			);
		});

		it("reports a reserved target once, not again for each path below it", () => {
			const result = evaluate(
				[put("docs/.private/x.md")],
				withTarget("docs/.private"),
			);

			expect(result.problems).toEqual([
				{ code: "TARGET_STALE", detail: "TARGET_RESERVED" },
			]);
		});
	});
});

describe("paths", () => {
	it.each([
		["a parent segment", "docs/memory/../x.md"],
		["an empty path", ""],
		["a backslash", "docs\\memory\\a.md"],
		["a leading ./", "./docs/memory/a.md"],
		["a trailing slash", "docs/memory/"],
	])("INVALID_PATH for %s", (_name, path) => {
		expect(evaluate([put(path)]).problems).toContainEqual({
			path,
			code: "INVALID_PATH",
		});
	});

	it("PATH_TOO_LONG for a path no storage key can hold", () => {
		const long = `docs/memory/${"a/".repeat(260)}x.md`;
		const longer = `docs/memory/${"a".repeat(1100)}.md`;

		expect(evaluate([put(long)]).problems).toContainEqual({
			path: long,
			code: "PATH_TOO_LONG",
		});
		expect(evaluate([put(longer)]).problems).toContainEqual({
			path: longer,
			code: "PATH_TOO_LONG",
		});
	});

	it.each([
		["a path in another folder", "docs/other/a.md"],
		["the folder itself", "docs/memory"],
		["a folder that shares a prefix", "docs/memory-2/a.md"],
		["a path above the folder", "docs/a.md"],
	])("PATH_OUTSIDE_TARGET for %s", (_name, path) => {
		expect(evaluate([put(path)]).problems).toEqual([
			{ path, code: "PATH_OUTSIDE_TARGET" },
		]);
	});

	it("DUPLICATE_PATH once for a path named twice, however often", () => {
		const result = evaluate([
			put("docs/memory/a.md"),
			put("docs/memory/a.md", "# Other\n"),
			del("docs/memory/a.md"),
		]);

		expect(
			result.problems.filter(
				(problem) => problem.code === "DUPLICATE_PATH",
			),
		).toEqual([{ path: "docs/memory/a.md", code: "DUPLICATE_PATH" }]);
	});

	it.each([
		["docs/memory/.contextignore"],
		["docs/memory/.ContextIgnore"],
		["docs/memory/sub/.contextignore"],
	])("POLICY_FILE alone for %s, never also hidden", (path) => {
		expect(evaluate([put(path)]).problems).toEqual([
			{ path, code: "POLICY_FILE" },
		]);
	});

	it.each([
		["a hidden folder below the target", "docs/memory/.hidden/a.md"],
		["a hidden folder deeper down", "docs/memory/sub/.private/x/a.md"],
		["a hidden file", "docs/memory/.notes.md"],
		["the CLI's own state", "docs/memory/.fabric/state.json"],
		["a tool-state folder", "docs/memory/.claude/notes.md"],
		["a CI folder", "docs/memory/.github/workflows/ci.yml"],
		["a hidden file with no text extension", "docs/memory/.env"],
	])("PATH_HIDDEN alone for %s", (_name, path) => {
		expect(evaluate([put(path)]).problems).toEqual([
			{ path, code: "PATH_HIDDEN" },
		]);
	});

	it("PATH_HIDDEN for a hidden folder below the target of a whole-repository sync", () => {
		const base = snapshot();
		const result = evaluate(
			[put("docs/ai/.hidden/a.md"), put("docs/ai/ok.md")],
			snapshot({
				sync: {
					...(base.sync as NonNullable<typeof base.sync>),
					paths: [""],
				},
				target: {
					id: "target-1",
					version: 2,
					folder: "docs/ai",
					mode: "PULL_REQUEST",
				},
			}),
		);

		expect(result.problems).toEqual([
			{ path: "docs/ai/.hidden/a.md", code: "PATH_HIDDEN" },
		]);
	});

	it("does not call a dot inside a name hidden", () => {
		expect(
			evaluate([put("docs/memory/v1.2/notes.d/a.md")]).problems,
		).toEqual([]);
	});

	it.each([
		["a folder the defaults leave out", "docs/memory/skills/a.md"],
		["a coding-instructions file", "docs/memory/CLAUDE.md"],
		["a coding-instructions file in any case", "docs/memory/agents.md"],
	])("PATH_EXCLUDED for %s", (_name, path) => {
		expect(evaluate([put(path)]).problems).toContainEqual({
			path,
			code: "PATH_EXCLUDED",
		});
	});

	it("PATH_EXCLUDED for a path under one the member left out", () => {
		const base = snapshot();
		const result = evaluate(
			[put("docs/drafts/x.md")],
			snapshot({
				sync: base.sync,
				target: {
					id: "target-1",
					version: 2,
					folder: "docs",
					mode: "PULL_REQUEST",
				},
			}),
		);

		expect(result.problems).toContainEqual({
			path: "docs/drafts/x.md",
			code: "PATH_EXCLUDED",
		});
	});

	it("judges the defaults relative to the selected path, not to the repository", () => {
		const base = snapshot();
		const result = evaluate(
			[put("skills/memory/a.md")],
			snapshot({
				sync: {
					...(base.sync as NonNullable<typeof base.sync>),
					paths: ["skills"],
				},
				target: {
					id: "target-1",
					version: 2,
					folder: "skills/memory",
					mode: "PULL_REQUEST",
				},
			}),
		);

		expect(result.ok).toBe(true);
	});

	it.each([
		["a binary extension", "docs/memory/chart.png"],
		["no extension", "docs/memory/Makefile"],
		["a script", "docs/memory/run.sh"],
	])("UNSUPPORTED_EXTENSION for %s", (_name, path) => {
		expect(evaluate([put(path)]).problems).toContainEqual({
			path,
			code: "UNSUPPORTED_EXTENSION",
		});
	});

	it("accepts the text extensions in any case", () => {
		const result = evaluate([
			put("docs/memory/A.MD"),
			put("docs/memory/b.yaml"),
			put("docs/memory/c.yml"),
			put("docs/memory/d.markdown"),
			put("docs/memory/e.txt"),
		]);

		expect(result.ok).toBe(true);
	});
});

describe("content and conditions", () => {
	const PATH = "docs/memory/a.md";

	it("CONTENT_REQUIRED for a PUT with no content", () => {
		expect(evaluate([{ path: PATH, op: "PUT" }]).problems).toEqual([
			{ path: PATH, code: "CONTENT_REQUIRED" },
		]);
	});

	it("CONTENT_EMPTY for text that is only whitespace", () => {
		expect(evaluate([put(PATH, "  \n\t")]).problems).toEqual([
			{ path: PATH, code: "CONTENT_EMPTY" },
		]);
	});

	it("CONTENT_TOO_LARGE past the file bound, by bytes rather than characters", () => {
		const bound = 2 * 1024 * 1024;

		expect(evaluate([put(PATH, "a".repeat(bound + 1))]).problems).toEqual([
			{ path: PATH, code: "CONTENT_TOO_LARGE" },
		]);
		// 700 000 three-byte characters are under the bound in characters only.
		expect(evaluate([put(PATH, "€".repeat(700_000))]).problems).toEqual([
			{ path: PATH, code: "CONTENT_TOO_LARGE" },
		]);
		expect(evaluate([put(PATH, "a".repeat(bound))]).ok).toBe(true);
	});

	it("CONTENT_NOT_TEXT for text Postgres cannot store", () => {
		expect(evaluate([put(PATH, "a\u0000b")]).problems).toEqual([
			{ path: PATH, code: "CONTENT_NOT_TEXT" },
		]);
	});

	it("DELETE_HAS_CONTENT for a delete that carries content", () => {
		expect(
			evaluate([{ ...del(PATH), content: "# gone\n" }]).problems,
		).toEqual([{ path: PATH, code: "DELETE_HAS_CONTENT" }]);
	});

	it("DELETE_REQUIRES_IF_MATCH for a delete with no ifMatchOid", () => {
		expect(evaluate([{ path: PATH, op: "DELETE" }]).problems).toEqual([
			{ path: PATH, code: "DELETE_REQUIRES_IF_MATCH" },
		]);
	});

	it.each([
		["xyz"],
		["A".repeat(40)],
		["a".repeat(39)],
		["a".repeat(41)],
		[""],
	])("IF_MATCH_INVALID for %j", (ifMatchOid) => {
		expect(evaluate([{ ...put(PATH), ifMatchOid }]).problems).toEqual([
			{ path: PATH, code: "IF_MATCH_INVALID" },
		]);
	});
});

describe("MESSAGE_INVALID", () => {
	it.each([
		["empty", "", "empty"],
		["only whitespace", "  \n ", "empty"],
		["over the message bound", "m".repeat(5001), "too-long"],
		[
			"a first line over the subject bound",
			`${"s".repeat(301)}\nbody`,
			"subject-too-long",
		],
	])("refuses a message that is %s", (_name, message, detail) => {
		expect(
			evaluate([put("docs/memory/a.md")], snapshot(), message).problems,
		).toEqual([{ code: "MESSAGE_INVALID", detail }]);
	});

	it.each([
		["Fabric-Commit", "notes\n\nFabric-Commit: cabc12345678"],
		["Fabric-Memory-Write", "notes\n\nFabric-Memory-Write: cabc12345678"],
		["Fabric-Agent", "notes\n\nFabric-Agent: client_1"],
		["a trailer in any case", "notes\n\nfabric-memory-write: cabc12345678"],
		["a trailer with space before the colon", "notes\n\nFabric-Agent : x"],
		["a trailer an indent away", "notes\n\n  Fabric-Agent: x"],
		[
			"a trailer a control character tried to hide",
			"notes\n\nFabric-Mem\u0001ory-Write: cabc12345678",
		],
	])(
		"refuses a message with a line that spells a trailer of Fabric's own (%s)",
		(_name, message) => {
			expect(
				evaluate([put("docs/memory/a.md")], snapshot(), message)
					.problems,
			).toEqual([
				{ code: "MESSAGE_INVALID", detail: "reserved-trailer" },
			]);
		},
	);

	it("accepts a message that merely mentions a trailer in a sentence", () => {
		expect(
			evaluate(
				[put("docs/memory/a.md")],
				snapshot(),
				"Explain the Fabric-Agent: trailer in the docs",
			).problems,
		).toEqual([]);
	});

	it("refuses a message that holds a credential, without quoting it", () => {
		const result = evaluate(
			[put("docs/memory/a.md")],
			snapshot(),
			`rotate ${githubToken()}`,
		);

		expect(result.problems).toEqual([
			{ code: "MESSAGE_INVALID", detail: "secret" },
		]);
		expect(JSON.stringify(result)).not.toContain(githubToken());
	});
});

describe("secrets", () => {
	it("SECRET_DETECTED names the rule that fired and never the text that matched", () => {
		const token = githubToken();
		const result = evaluate([
			put("docs/memory/a.md", `# Notes\ntoken: ${token}\n`),
		]);

		expect(result.problems).toEqual([
			{
				path: "docs/memory/a.md",
				code: "SECRET_DETECTED",
				detail: "github-token",
			},
		]);
		expect(JSON.stringify(result)).not.toContain(token);
		expect(JSON.stringify(result)).not.toContain("A1A1A1");
	});

	it("reports each distinct rule of a file once", () => {
		const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
		const content = [githubToken(), githubToken(), header].join("\n");

		const result = evaluate([put("docs/memory/a.md", content)]);

		expect(result.problems.map((problem) => problem.detail).sort()).toEqual(
			["github-token", "private-key-block"],
		);
	});

	it("says nothing about secrets for a file with none", () => {
		expect(
			codes(evaluate([put("docs/memory/a.md", "No secrets here.\n")])),
		).not.toContain("SECRET_DETECTED");
	});
});

describe("SYNC_LIMIT_EXCEEDED", () => {
	it("refuses when new files would take the sync past what it keeps", () => {
		const result = evaluate(
			[put("docs/memory/a.md"), put("docs/memory/b.md")],
			snapshot({ managedCount: 4_999 }),
		);

		expect(result.problems).toEqual([
			{ code: "SYNC_LIMIT_EXCEEDED", detail: "5000" },
		]);
	});

	it("counts a file the sync already manages as no new row", () => {
		const result = evaluate(
			[put("docs/memory/a.md"), put("docs/memory/b.md")],
			snapshot({
				managedCount: 4_999,
				managedKeys: new Set(["docs/memory/a.md"]),
			}),
		);

		expect(result.ok).toBe(true);
	});

	it("counts neither a delete nor a repeated path as a new row", () => {
		const result = evaluate(
			[
				del("docs/memory/old.md"),
				put("docs/memory/a.md"),
				put("docs/memory/a.md"),
			],
			snapshot({ managedCount: 4_999 }),
		);

		expect(codes(result)).not.toContain("SYNC_LIMIT_EXCEEDED");
	});

	it("accepts a sync exactly full", () => {
		expect(
			evaluate(
				[put("docs/memory/a.md")],
				snapshot({ managedCount: 4_999 }),
			).ok,
		).toBe(true);
	});
});

describe("every problem is reported, not the first", () => {
	it("reports the whole request's problems together", () => {
		const result = evaluate(
			[
				put("docs/other/a.md"),
				put("docs/memory/img.png", "  "),
				put("docs/memory/skills/b.md", `k: ${githubToken()}`),
				{ path: "docs/memory/c.md", op: "DELETE" },
				put("docs/memory/dup.md"),
				put("docs/memory/dup.md"),
				put("docs/memory/.hidden/e.md"),
			],
			snapshot({ readOnlyMode: true, delegateHoldsContextCreate: false }),
			"",
		);

		expect(result.ok).toBe(false);
		expect(new Set(codes(result))).toEqual(
			new Set([
				"READ_ONLY_MODE",
				"MESSAGE_INVALID",
				"SYNC_DELEGATE_LOST_PERMISSION",
				"PATH_OUTSIDE_TARGET",
				"UNSUPPORTED_EXTENSION",
				"CONTENT_EMPTY",
				"PATH_EXCLUDED",
				"PATH_HIDDEN",
				"SECRET_DETECTED",
				"DELETE_REQUIRES_IF_MATCH",
				"DUPLICATE_PATH",
			]),
		);
	});
});

describe("the digest", () => {
	const base = {
		projectId: "proj-1",
		targetId: "target-1",
		targetVersion: 2,
		message: "Add notes",
	};
	const entries = [
		put("docs/memory/b.md", "# B\n"),
		put("docs/memory/a.md", "# A\n"),
		del("docs/memory/c.md"),
	];

	it("is the same whatever order the entries came in", () => {
		const forward = memoryWriteDigest({ ...base, entries });
		const reversed = memoryWriteDigest({
			...base,
			entries: [...entries].reverse(),
		});

		expect(reversed).toBe(forward);
		expect(evaluate(entries).digest).toBe(
			evaluate([...entries].reverse()).digest,
		);
	});

	it("is the evaluation's digest", () => {
		expect(evaluate(entries).digest).toBe(
			memoryWriteDigest({ ...base, entries }),
		);
	});

	it.each([
		["the project", { projectId: "proj-2" }],
		["the target", { targetId: "target-2" }],
		["the target's version", { targetVersion: 3 }],
		["the message", { message: "Add other notes" }],
	])("changes with %s", (_name, change) => {
		expect(memoryWriteDigest({ ...base, ...change, entries })).not.toBe(
			memoryWriteDigest({ ...base, entries }),
		);
	});

	it.each([
		[
			"a file's content",
			[put("docs/memory/b.md", "# B!\n"), entries[1], entries[2]],
		],
		[
			"a file's path",
			[put("docs/memory/z.md", "# B\n"), entries[1], entries[2]],
		],
		[
			"an operation",
			[
				entries[0],
				entries[1],
				{ ...put("docs/memory/c.md"), ifMatchOid: OID_SHA1 },
			],
		],
		[
			"an ifMatchOid",
			[entries[0], entries[1], del("docs/memory/c.md", OID_SHA256)],
		],
		["a dropped entry", [entries[0], entries[1]]],
	] as Array<[string, MemoryWriteEntryInput[]]>)(
		"changes with %s",
		(_name, changed) => {
			expect(memoryWriteDigest({ ...base, entries: changed })).not.toBe(
				memoryWriteDigest({ ...base, entries }),
			);
		},
	);

	it("hashes the bytes that would be written, so two spellings of one word are two requests", () => {
		const composed = memoryWriteDigest({
			...base,
			entries: [put("docs/memory/a.md", "café")],
		});
		const decomposed = memoryWriteDigest({
			...base,
			entries: [put("docs/memory/a.md", "café")],
		});

		expect(composed).not.toBe(decomposed);
	});
});
