import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	expectPrivateCodeIndexPath,
	readWindowsPathSecurity,
} from "../../__tests__/helpers/code-index-privacy";
import {
	createPrivateCodeIndexDirectory,
	writePrivateCodeIndexFile,
} from "../private-code-index-path";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

describe("private code-index paths", () => {
	let root: string;
	beforeEach(() => {
		root = fs.mkdtempSync(
			path.join(os.tmpdir(), "private-code-path-test-"),
		);
	});
	afterEach(() => {
		vi.resetAllMocks();
		vi.unstubAllEnvs();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("protects a new directory before returning it, including literal shell characters", () => {
		const directory = createPrivateCodeIndexDirectory(
			path.join(root, "private $([not-a-command]) '-"),
		);
		expectPrivateCodeIndexPath(directory, 0o700);
	});

	it("keeps a staged file private after moving it outside its protected directory", () => {
		const directory = createPrivateCodeIndexDirectory(
			path.join(root, "stage-"),
		);
		const staged = path.join(directory, "manifest.json");
		writePrivateCodeIndexFile(staged, "synthetic private fixture");
		const published = path.join(root, "published.json");
		fs.renameSync(staged, published);
		expect(fs.readFileSync(published, "utf8")).toBe(
			"synthetic private fixture",
		);
		expectPrivateCodeIndexPath(published, 0o600);
	});

	it("fails closed and removes only its empty new directory when protection fails", () => {
		if (process.platform === "win32") {
			vi.mocked(childProcess.spawnSync).mockImplementationOnce(() => {
				throw new Error("ACL enforcement unavailable");
			});
		} else {
			vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
				throw new Error("mode enforcement unavailable");
			});
		}
		fs.writeFileSync(path.join(root, "sentinel.txt"), "keep me");
		expect(() =>
			createPrivateCodeIndexDirectory(path.join(root, "stage-")),
		).toThrow("enforcement unavailable");
		expect(fs.readdirSync(root)).toEqual(["sentinel.txt"]);
	});

	it("refuses a pre-existing staged hardlink without changing its target", () => {
		const directory = createPrivateCodeIndexDirectory(
			path.join(root, "stage-"),
		);
		const target = path.join(root, "sentinel.txt");
		fs.writeFileSync(target, "keep me");
		const linked = path.join(directory, "manifest.json");
		fs.linkSync(target, linked);
		expect(() => writePrivateCodeIndexFile(linked, "replace")).toThrow();
		expect(fs.readFileSync(target, "utf8")).toBe("keep me");
	});

	it.runIf(process.platform === "win32")(
		"reports a missing trusted ACL executable with its original cause",
		() => {
			vi.stubEnv("SystemRoot", path.join(root, "missing-system-root"));
			let failure: unknown;
			try {
				createPrivateCodeIndexDirectory(path.join(root, "stage-"));
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(failure).toMatchObject({
				message: expect.stringContaining(
					"Cannot secure private code-index directory",
				),
				cause: { code: "ENOENT" },
			});
			expect(fs.readdirSync(root)).toEqual([]);
		},
	);

	it.runIf(process.platform === "win32")(
		"refuses an existing Windows target without changing its ACL or contents",
		() => {
			const suffix = "00000000-0000-4000-8000-000000000000";
			const prefix = path.join(root, "stage-");
			const existing = `${prefix}${suffix}`;
			fs.mkdirSync(existing);
			fs.writeFileSync(path.join(existing, "sentinel.txt"), "keep me");
			const before = readWindowsPathSecurity(existing);
			vi.mocked(crypto.randomUUID).mockReturnValueOnce(suffix);
			expect(() => createPrivateCodeIndexDirectory(prefix)).toThrow(
				"target already exists",
			);
			expect(readWindowsPathSecurity(existing)).toEqual(before);
			expect(
				fs.readFileSync(path.join(existing, "sentinel.txt"), "utf8"),
			).toBe("keep me");
		},
	);

	it.runIf(process.platform === "win32")(
		"does not delete an ambiguous empty path after a Windows child failure",
		() => {
			vi.mocked(childProcess.spawnSync).mockImplementationOnce(
				(_command, _args, options) => {
					const target = options?.env?.FABRIC_PRIVATE_PATH;
					if (!target) {
						throw new Error("Missing test target");
					}
					fs.mkdirSync(target);
					throw new Error("uncertain directory creation");
				},
			);
			expect(() =>
				createPrivateCodeIndexDirectory(path.join(root, "stage-")),
			).toThrow("uncertain directory creation");
			const remaining = fs.readdirSync(root);
			expect(remaining).toHaveLength(1);
			expect(remaining[0]).toMatch(/^stage-[a-f0-9-]{36}$/);
			expect(fs.readdirSync(path.join(root, remaining[0]))).toEqual([]);
		},
	);

	it.runIf(process.platform === "win32")(
		"refuses a pre-existing directory junction without changing its destination",
		() => {
			const suffix = "00000000-0000-4000-8000-000000000000";
			const prefix = path.join(root, "stage-");
			const destination = path.join(root, "sentinel-directory");
			fs.mkdirSync(destination);
			fs.writeFileSync(path.join(destination, "sentinel.txt"), "keep me");
			fs.symlinkSync(destination, `${prefix}${suffix}`, "junction");
			const before = readWindowsPathSecurity(destination);
			vi.mocked(crypto.randomUUID).mockReturnValueOnce(suffix);
			expect(() => createPrivateCodeIndexDirectory(prefix)).toThrow(
				"target already exists",
			);
			expect(readWindowsPathSecurity(destination)).toEqual(before);
			expect(fs.lstatSync(`${prefix}${suffix}`).isSymbolicLink()).toBe(
				true,
			);
			expect(
				fs.readFileSync(path.join(destination, "sentinel.txt"), "utf8"),
			).toBe("keep me");
		},
	);
});
