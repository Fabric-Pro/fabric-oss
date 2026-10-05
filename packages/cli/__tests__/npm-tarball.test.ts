/**
 * Reading one file out of an npm tarball (`npm-tarball.ts`), in memory: the
 * entry is matched by its exact name, and a hostile or damaged archive is
 * refused before anything is allocated or trusted.
 */
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	readPackedFile,
	TarballError,
} from "../src/lib/instructions/npm-tarball.js";
import { npmTarball, tarOf } from "./helpers/npm-tarball.js";

/**
 * What `npm pack` wrote for a three-file package, as the pack step stages the
 * served build (`scripts/pack-deployment.mjs`): LICENSE, fabric.js and
 * package.json under `package/`.
 */
const REAL_NPM_PACK =
	"H4sIAAAAAAAC/+2Wz0rEMBDGc+5TjPGiIO1kt+mCXgTZw4J60RdI21i6pklptouy7LtLWlEoyl5s/ZffZWBmLmHyzTe1yB5FIaPr1dXy9m5JxgARkziGj/IdbA5kzhNkLEkwBoIMZ3wBBMkEtHYjGoL4BY9ERHiLv4Sb1T1YUdVKBsTz/6hf9f8g0qbMwrUdR/8Lzj/XfzIb6p9hzL3+p+D4KGptE6WljqTegja5DDKjrVEyVKY4of1ygLTVuZL09MKviT+pfxfDtTX6G/zfyWWof+//089fFHKUL3Bg/sx5w2D+PPbzn4RdAEC1qCQ9B3opn7ptH2WqpGeuspWNLY12RQwxZH1281x3/ZXJWyX7XFq6rh3Q/pJw5fD9qqCwD/beOjwej+fn8AK/mkvRABIAAA==";

const LIMITS = { maxUnpackedBytes: 1024 * 1024, maxFileBytes: 512 * 1024 };
const WANTED = "package/fabric.js";
const BUNDLE = '#!/usr/bin/env node\nconsole.log("bundle");\n';

function read(tarball: Uint8Array, limits = LIMITS): string {
	return Buffer.from(readPackedFile(tarball, WANTED, limits)).toString(
		"utf8",
	);
}

function failureOf(run: () => unknown): TarballError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(TarballError);
		return error as TarballError;
	}
	throw new Error("expected the read to fail");
}

describe("an archive npm wrote", () => {
	it("gives the bundle's own bytes", () => {
		const tarball = Buffer.from(REAL_NPM_PACK, "base64");

		expect(read(tarball)).toBe(
			'#!/usr/bin/env node\nconsole.log("sample bundle");\n',
		);
	});
});

describe("an archive of known shape", () => {
	it("gives the file called exactly that, whatever surrounds it", () => {
		const tarball = npmTarball([
			{ name: "package/LICENSE", content: "MIT\n" },
			{ name: "package/fabric.js.map", content: "{}" },
			{ name: "other/package/fabric.js", content: "not this one" },
			{ name: WANTED, content: BUNDLE },
			{ name: "package/package.json", content: "{}" },
		]);

		expect(read(tarball)).toBe(BUNDLE);
	});

	it("reads a file longer than one block, and the entry after it", () => {
		const long = `#!/usr/bin/env node\n${"x".repeat(1500)}\n`;
		const tarball = npmTarball([
			{ name: WANTED, content: long },
			{ name: "package/package.json", content: "{}" },
		]);

		expect(read(tarball)).toBe(long);
	});

	it("does not take a directory for the file", () => {
		const tarball = npmTarball([{ name: WANTED, content: "", type: "5" }]);

		expect(failureOf(() => read(tarball)).kind).toBe("missing");
	});

	it("says the file is missing when the archive does not hold it", () => {
		const tarball = npmTarball([{ name: "package/LICENSE", content: "x" }]);

		expect(failureOf(() => read(tarball)).kind).toBe("missing");
	});

	it("refuses a file that appears twice rather than letting the last win", () => {
		const tarball = npmTarball([
			{ name: WANTED, content: BUNDLE },
			{ name: WANTED, content: "#!/usr/bin/env node\n// another\n" },
		]);

		const failure = failureOf(() => read(tarball));

		expect(failure.kind).toBe("unreadable");
		expect(failure.message).toContain("more than once");
	});
});

describe("an archive that is not what it should be", () => {
	it("refuses bytes that are not gzip", () => {
		expect(
			failureOf(() => read(Buffer.from("<html>not found</html>"))).kind,
		).toBe("unreadable");
	});

	it("refuses gzip around something that is not a tar", () => {
		const tarball = gzipSync(Buffer.alloc(1024, 0x41));

		expect(failureOf(() => read(tarball)).kind).toBe("unreadable");
	});

	it("refuses a header whose checksum is wrong", () => {
		const tar = tarOf([{ name: WANTED, content: BUNDLE }]);
		tar[0] = (tar[0] as number) ^ 0x01;

		expect(failureOf(() => read(gzipSync(tar))).kind).toBe("unreadable");
	});

	it("refuses an archive cut short in the middle of a file", () => {
		const tar = tarOf([{ name: WANTED, content: "x".repeat(2000) }]);

		expect(
			failureOf(() => read(gzipSync(tar.subarray(0, 1024)))).kind,
		).toBe("unreadable");
	});

	it("stops unpacking at the limit instead of allocating whatever the archive claims", () => {
		const tarball = npmTarball([
			{ name: WANTED, content: "y".repeat(64 * 1024) },
		]);

		const failure = failureOf(() =>
			read(tarball, { ...LIMITS, maxUnpackedBytes: 8 * 1024 }),
		);

		expect(failure.kind).toBe("too-large");
	});

	it("refuses a file over its own limit", () => {
		const tarball = npmTarball([
			{ name: WANTED, content: "z".repeat(4096) },
		]);

		const failure = failureOf(() =>
			read(tarball, { ...LIMITS, maxFileBytes: 1024 }),
		);

		expect(failure.kind).toBe("too-large");
	});
});
