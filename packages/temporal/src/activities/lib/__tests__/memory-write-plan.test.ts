/**
 * The tip checks of a Living Memory write as pure verdicts (ADR-022): what
 * each path of a batch is judged against what stands in the tree, and how the
 * verdicts become the write's outcome. `memory-write-push.real-git.test.ts`
 * runs the same rules against real git; this pins every branch of the rule,
 * with no git and no clock.
 */
import { describe, expect, it } from "vitest";
import type { PathEntry } from "../memory-write-git";
import {
	type HashedWriteEntry,
	outcomeForVerdicts,
	pathVerdicts,
	writePlanFor,
} from "../memory-write-plan";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const OTHER = "c".repeat(40);

const blob = (oid: string, mode = "100644"): PathEntry => ({
	type: "blob",
	mode,
	oid,
});
const tree = (): PathEntry => ({ type: "tree", mode: "040000", oid: OTHER });

function tip(entries: Record<string, PathEntry | null>) {
	return new Map(Object.entries(entries));
}

const none = () => false;

const put = (
	path: string,
	blobOid: string,
	ifMatchOid: string | null = null,
): HashedWriteEntry => ({ path, op: "PUT", ifMatchOid, blobOid });
const del = (path: string, ifMatchOid: string): HashedWriteEntry => ({
	path,
	op: "DELETE",
	ifMatchOid,
	blobOid: null,
});

describe("pathVerdicts", () => {
	it("passes a create-only PUT of an absent path and a PUT or DELETE of the blob the caller saw", () => {
		const verdicts = pathVerdicts(
			[
				put("docs/new.md", NEW),
				put("docs/old.md", NEW, OLD),
				del("docs/gone.md", OLD),
			],
			tip({
				"docs/new.md": null,
				"docs/old.md": blob(OLD),
				"docs/gone.md": blob(OLD),
			}),
			none,
		);

		expect(verdicts).toEqual([]);
	});

	it("conflicts a create-only PUT of a path that exists, naming the blob there", () => {
		expect(
			pathVerdicts(
				[put("docs/a.md", NEW)],
				tip({ "docs/a.md": blob(OLD) }),
				none,
			),
		).toEqual([
			{ path: "docs/a.md", code: "PATH_EXISTS", currentOid: OLD },
		]);
	});

	it("conflicts a PUT or DELETE of a path that is gone, with no blob", () => {
		expect(
			pathVerdicts(
				[put("docs/a.md", NEW, OLD), del("docs/b.md", OLD)],
				tip({ "docs/a.md": null, "docs/b.md": null }),
				none,
			),
		).toEqual([
			{ path: "docs/a.md", code: "PATH_MISSING", currentOid: null },
			{ path: "docs/b.md", code: "PATH_MISSING", currentOid: null },
		]);
	});

	it("conflicts a PUT or DELETE whose ifMatchOid is not the blob there", () => {
		expect(
			pathVerdicts(
				[put("docs/a.md", NEW, OLD), del("docs/b.md", OLD)],
				tip({ "docs/a.md": blob(OTHER), "docs/b.md": blob(NEW) }),
				none,
			),
		).toEqual([
			{ path: "docs/a.md", code: "IF_MATCH_MISMATCH", currentOid: OTHER },
			{ path: "docs/b.md", code: "IF_MATCH_MISMATCH", currentOid: NEW },
		]);
	});

	it("refuses a path that is a folder, a link or a submodule, and one under a file, whatever the caller knew", () => {
		expect(
			pathVerdicts(
				[
					put("docs/dir", NEW),
					put("docs/link.md", NEW, OLD),
					del("docs/sub", OLD),
					put("docs/file.md/inside.md", NEW),
				],
				tip({
					"docs/dir": tree(),
					"docs/link.md": {
						type: "symlink",
						mode: "120000",
						oid: OLD,
					},
					"docs/sub": { type: "gitlink", mode: "160000", oid: OLD },
					"docs/file.md": blob(OLD),
					"docs/file.md/inside.md": null,
					docs: tree(),
				}),
				none,
			),
		).toEqual([
			{ path: "docs/dir", code: "PATH_NOT_A_FILE" },
			{ path: "docs/link.md", code: "PATH_NOT_A_FILE" },
			{ path: "docs/sub", code: "PATH_NOT_A_FILE" },
			{ path: "docs/file.md/inside.md", code: "PATH_NOT_A_FILE" },
		]);
	});

	it("refuses a path the ignore rules leave out, before it asks whether the path changed", () => {
		expect(
			pathVerdicts(
				[put("docs/private/a.md", NEW), put("docs/ok.md", NEW)],
				tip({ "docs/private/a.md": blob(OLD), "docs/ok.md": null }),
				(path) => path.startsWith("docs/private/"),
			),
		).toEqual([{ path: "docs/private/a.md", code: "PATH_EXCLUDED" }]);
	});

	it("reports one verdict per path, and every path that has one", () => {
		const verdicts = pathVerdicts(
			[put("a.md", NEW), put("b.md", NEW, OLD), put("c.md", NEW)],
			tip({ "a.md": blob(OLD), "b.md": null, "c.md": null }),
			none,
		);

		expect(verdicts.map((verdict) => verdict.path)).toEqual([
			"a.md",
			"b.md",
		]);
	});
});

describe("writePlanFor", () => {
	it("writes a new file 100644 and a replaced file in its own mode, and deletes by path", () => {
		expect(
			writePlanFor(
				[
					put("new.md", NEW),
					put("run.sh", NEW, OLD),
					del("gone.md", OLD),
				],
				tip({
					"new.md": null,
					"run.sh": blob(OLD, "100755"),
					"gone.md": blob(OLD),
				}),
			),
		).toEqual([
			{
				rawPath: "new.md",
				after: { type: "blob", mode: "100644", oid: NEW },
			},
			{
				rawPath: "run.sh",
				after: { type: "blob", mode: "100755", oid: NEW },
			},
			{ rawPath: "gone.md", after: null },
		]);
	});

	it("leaves out a PUT that already holds its bytes", () => {
		expect(
			writePlanFor([put("a.md", OLD, OLD)], tip({ "a.md": blob(OLD) })),
		).toEqual([]);
	});
});

describe("outcomeForVerdicts", () => {
	it("is a conflict when any path changed under the caller, carrying every verdict", () => {
		const verdicts = [
			{ path: "a.md", code: "PATH_EXCLUDED" },
			{ path: "b.md", code: "IF_MATCH_MISMATCH", currentOid: OLD },
		] as const;

		expect(outcomeForVerdicts(verdicts)).toEqual({
			status: "CONFLICT",
			paths: [...verdicts],
		});
	});

	it("is a refusal when every verdict is a path the repository rules out", () => {
		expect(
			outcomeForVerdicts([
				{ path: "a.md", code: "PATH_EXCLUDED" },
				{ path: "b", code: "PATH_NOT_A_FILE" },
			]),
		).toEqual({
			status: "REFUSED",
			code: "PATH_REFUSED",
			paths: [
				{ path: "a.md", code: "PATH_EXCLUDED" },
				{ path: "b", code: "PATH_NOT_A_FILE" },
			],
		});
	});
});
