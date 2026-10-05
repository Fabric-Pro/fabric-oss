/**
 * What the hook has already said (Fizzy #2878): one record per checkout, so a
 * line is printed once per published version and reason, and any trouble with
 * the file means the line is printed again, never that it is lost.
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	forgetNotice,
	isNewNotice,
	noticeFile,
	rememberNotice,
} from "../src/lib/instructions/fast-forward-memory.js";

let file: string;

beforeEach(async () => {
	file = noticeFile(await mkdtemp(path.join(tmpdir(), "fabric-notice-")));
});

const key = (
	overrides: Partial<Parameters<typeof rememberNotice>[1]> = {},
) => ({
	projectId: "project-1",
	publishedVersion: 12,
	reason: "not-safe:dirty",
	...overrides,
});

describe("noticeFile", () => {
	it("is ff-notice.json in a fabric folder of the git common directory", () => {
		expect(noticeFile("/work/rules/.git")).toBe(
			path.join("/work/rules/.git", "fabric", "ff-notice.json"),
		);
	});
});

describe("isNewNotice", () => {
	it("is new when nothing was ever said", async () => {
		expect(await isNewNotice(file, key())).toBe(true);
	});

	it("is not new once said, for the same project, version and reason", async () => {
		await rememberNotice(file, key());

		expect(await isNewNotice(file, key())).toBe(false);
	});

	it.each([
		["another version", { publishedVersion: 13 }],
		["another reason", { reason: "not-safe:wrong-branch" }],
		["another project", { projectId: "project-2" }],
	])("is new again for %s", async (_label, change) => {
		await rememberNotice(file, key());

		expect(await isNewNotice(file, key(change))).toBe(true);
	});

	it.each([
		["not JSON", "this is not json"],
		["JSON of another shape", JSON.stringify({ hello: "world" })],
		["an older format", JSON.stringify({ v: 0, ...key() })],
		["an array", "[]"],
		["nothing", ""],
	])("is new when the file holds %s", async (_label, contents) => {
		await rememberNotice(file, key());
		await writeFile(file, contents);

		expect(await isNewNotice(file, key())).toBe(true);
	});
});

describe("rememberNotice", () => {
	it("writes one record, and the next replaces it", async () => {
		await rememberNotice(file, key());
		await rememberNotice(file, key({ publishedVersion: 13 }));

		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
			v: 1,
			projectId: "project-1",
			publishedVersion: 13,
			reason: "not-safe:dirty",
		});
	});

	it.skipIf(process.platform === "win32")(
		"is readable by its owner only",
		async () => {
			await rememberNotice(file, key());

			expect((await stat(file)).mode & 0o777).toBe(0o600);
		},
	);

	it("never throws when it cannot write", async () => {
		await writeFile(path.dirname(file), "");
		const impossible = path.join(
			path.dirname(file),
			"below",
			"ff-notice.json",
		);

		await expect(
			rememberNotice(impossible, key()),
		).resolves.toBeUndefined();
	});
});

describe("forgetNotice", () => {
	it("makes what was said new again", async () => {
		await rememberNotice(file, key());

		await forgetNotice(file);

		expect(await isNewNotice(file, key())).toBe(true);
	});

	it("is fine when there is nothing to forget", async () => {
		await expect(forgetNotice(file)).resolves.toBeUndefined();
	});
});
