/**
 * The words a line uses to tell someone to run a fabric command.
 *
 * A person who ran `npx -y <tarball> instructions init` has no `fabric`, so a
 * line that says `Run: fabric auth login` cannot be run as written. The right
 * words depend on how the CLI was started: `fabric` for the npm build, the
 * `npx` line for the served build run from its tarball, and `node <file>` for
 * that same build run from the copy a session hook keeps.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFabricCommand } from "../src/lib/instructions/doctor.js";
import {
	bundleTarballPath,
	fabricCommand,
	isServedBundle,
	launcherPathText,
	launcherWords,
	pathAsCommandWord,
	setLauncherOrigin,
} from "../src/lib/launcher.js";
import { NO_COMMAND } from "../src/lib/shell-words.js";

const TARBALL = "/cli/fabric-0.5.0-0123456789.tgz";
const ORIGIN = "https://fabric.example.com";
const FROM_NPX = "D:/cache/_npx/ab12cd/node_modules/@fabricorg/cli/fabric.js";
const FROM_COPY = "D:/config/Config/cli/https-fabric.example.com/fabric.mjs";

function servedBundle(options: { tarball?: string; origin?: string } = {}) {
	vi.stubGlobal("__FABRIC_BUNDLE__", true);
	vi.stubGlobal("__FABRIC_BUNDLE_TARBALL__", options.tarball);
	vi.stubGlobal("__FABRIC_BAKED_ORIGIN__", options.origin);
}

afterEach(() => {
	vi.unstubAllGlobals();
	setLauncherOrigin(undefined);
});

describe("a build that is not the served bundle", () => {
	it("says `fabric`, the way every line always did", () => {
		expect(isServedBundle()).toBe(false);
		expect(fabricCommand("auth login")).toBe("fabric auth login");
		expect(launcherPathText()).toBeUndefined();
	});

	it("ignores a tarball name it was somehow given", () => {
		vi.stubGlobal("__FABRIC_BUNDLE_TARBALL__", TARBALL);

		expect(bundleTarballPath()).toBeUndefined();
		expect(fabricCommand("auth login")).toBe("fabric auth login");
	});
});

describe("the served bundle run from its tarball", () => {
	it("names the npx line, on the deployment's own address", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });

		expect(launcherWords(ORIGIN, FROM_NPX)).toEqual([
			"npx",
			"-y",
			`${ORIGIN}${TARBALL}`,
		]);
	});

	it("takes the address from the run when the build did not know one", () => {
		servedBundle({ tarball: TARBALL });
		setLauncherOrigin("https://staging.example.com");

		expect(launcherWords(undefined, FROM_NPX).join(" ")).toBe(
			`npx -y https://staging.example.com${TARBALL}`,
		);
	});

	it("binds a line to the run's deployment with --base-url when a bare command would go elsewhere", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });
		setLauncherOrigin("https://staging.example.com");

		const command = fabricCommand("instructions sync --project p");

		expect(command).toContain(
			`npx -y https://staging.example.com${TARBALL} instructions sync --project p`,
		);
		expect(
			command.endsWith(" --base-url https://staging.example.com"),
		).toBe(true);
	});

	it("adds no --base-url for the address the build is packed for", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });
		setLauncherOrigin(ORIGIN);

		expect(
			fabricCommand("instructions sync --project p").includes(
				"--base-url",
			),
		).toBe(false);
	});

	it("does not say --base-url twice", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });

		expect(
			fabricCommand(
				"auth login --base-url https://staging.example.com",
				"https://staging.example.com",
			).match(/--base-url/g),
		).toHaveLength(1);
	});

	it.each([
		"/cli/fabric-0.5.0.tgz",
		"/cli/fabric-0.5.0-XYZ.tgz",
		"/cli/../fabric-0.5.0-0123456789.tgz",
		"https://evil.example/cli/fabric-0.5.0-0123456789.tgz",
		"/cli/fabric-0.5.0-0123456789.tgz; rm -rf x",
	])("will not print a tarball name of the wrong shape: %s", (tarball) => {
		servedBundle({ tarball, origin: ORIGIN });

		expect(bundleTarballPath()).toBeUndefined();
	});
});

describe("the served bundle run from the copy a hook keeps", () => {
	it("names the npx line, which is short and keeps working after the deployment ships a newer build", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });

		expect(launcherWords(ORIGIN, FROM_COPY)).toEqual([
			"npx",
			"-y",
			`${ORIGIN}${TARBALL}`,
		]);
		expect(
			fabricCommand("instructions sync --project p", ORIGIN),
		).not.toContain("fabric.mjs");
	});

	it("says the same words from the copy as from the tarball, whatever the path of the copy", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });
		const spaced =
			"D:/Dev Config/Config/cli/https-fabric.example.com/fabric.mjs";
		const unsafe =
			"/opt/with$dollar/cli/https-fabric.example.com/fabric.mjs";

		expect(launcherWords(ORIGIN, spaced)).toEqual(
			launcherWords(ORIGIN, FROM_NPX),
		);
		expect(launcherWords(ORIGIN, unsafe)).toEqual(
			launcherWords(ORIGIN, FROM_NPX),
		);
	});

	it("is not a printed file path, so nothing has to be kept from a home-folder scrub", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });

		expect(launcherPathText()).toBeUndefined();
	});
});

describe("the served bundle that never learned where it is served", () => {
	it("runs the file it is, from the copy or anywhere else", () => {
		servedBundle({ origin: ORIGIN });

		expect(launcherWords(ORIGIN, FROM_NPX)).toEqual(["node", FROM_NPX]);
		expect(launcherWords(ORIGIN, FROM_COPY)).toEqual(["node", FROM_COPY]);
	});

	it("quotes a path with a space, so the line is one command", () => {
		servedBundle({ origin: ORIGIN });
		const spaced =
			"D:/Dev Config/Config/cli/https-fabric.example.com/fabric.mjs";

		expect(launcherWords(ORIGIN, spaced)).toEqual(["node", `"${spaced}"`]);
	});

	it("falls back to `fabric` when the file has no spelling a shell reads the same", () => {
		servedBundle({ origin: ORIGIN });
		const unsafe =
			"/opt/with$dollar/cli/https-fabric.example.com/fabric.mjs";

		expect(launcherWords(ORIGIN, unsafe)).toEqual(["fabric"]);
	});

	it("keeps the file path in what a message scrub must leave alone", () => {
		servedBundle({ origin: ORIGIN });

		expect(launcherPathText()?.startsWith("node ")).toBe(true);
	});
});

describe("doctor's pasteable fixes", () => {
	it("start the way this install starts, and quote only the arguments", () => {
		servedBundle({ tarball: TARBALL, origin: ORIGIN });
		setLauncherOrigin(ORIGIN);

		expect(
			buildFabricCommand(
				[
					"instructions",
					"sync",
					"--project",
					"project-1",
					"--dest",
					"a folder",
				],
				"linux",
			),
		).toBe(
			`npx -y ${ORIGIN}${TARBALL} instructions sync --project project-1 --dest 'a folder'`,
		);
	});

	it("are `fabric …` when that is how the CLI is installed", () => {
		expect(buildFabricCommand(["instructions", "check"], "linux")).toBe(
			"fabric instructions check",
		);
	});

	it("spell a Windows folder the way bash, PowerShell and cmd.exe all read it", () => {
		const sync = (dest: string) =>
			buildFabricCommand(
				[
					"instructions",
					"sync",
					"--project",
					"project-1",
					"--dest",
					dest,
				],
				"win32",
			);

		expect(sync("D:\\Temp\\fabric-cmd-aBc123")).toBe(
			"fabric instructions sync --project project-1 --dest D:/Temp/fabric-cmd-aBc123",
		);
		expect(sync("C:\\Users\\Ada O'Neil\\work")).toBe(
			`fabric instructions sync --project project-1 --dest "C:/Users/Ada O'Neil/work"`,
		);
	});

	it("offer no command for a Windows word no shell reads the same", () => {
		expect(
			buildFabricCommand(
				["instructions", "sync", "--dest", "D:\\a$b"],
				"win32",
			),
		).toBeUndefined();
		expect(
			buildFabricCommand(
				["instructions", "sync", "--dest", "D:\\a\nb"],
				"win32",
			),
		).toBeUndefined();
	});
});

describe("a deployment address no command can carry", () => {
	const HOSTILE = [
		"https://a.example.com$(id).x",
		"https://a.example.com&calc.exe",
		"https://a.example.com;ls",
		"https://a.example.com`id`",
		"https://a.example.com'x",
		'https://a.example.com"x',
		"https://a.example.com!x",
		"https://a.example.com~x",
		"https://a.example.com,x",
	].map((address) => new URL(address).origin);

	it.each(HOSTILE)("is not written into the npx line for %s", (origin) => {
		servedBundle({ tarball: TARBALL });
		setLauncherOrigin(origin);

		const command = fabricCommand("instructions sync --project p");

		expect(command).toBe(NO_COMMAND);
		expect(command).not.toContain("a.example.com");
	});

	it.each(HOSTILE)("is not written after --base-url for %s", (origin) => {
		const command = fabricCommand("auth login", origin);

		expect(command).toBe(NO_COMMAND);
		expect(command).not.toContain("a.example.com");
	});

	it("is not in the way of a line that names no deployment other than the default", () => {
		expect(fabricCommand("auth login", "https://fabric.pro")).toBe(
			"fabric auth login",
		);
	});

	it.each(HOSTILE)("leaves doctor no command to offer for %s", (origin) => {
		servedBundle({ tarball: TARBALL });
		setLauncherOrigin(origin);

		expect(
			buildFabricCommand(["instructions", "check"], "linux"),
		).toBeUndefined();
	});

	it("does not keep an address that is plain from being written", () => {
		servedBundle({ tarball: TARBALL });
		setLauncherOrigin("http://localhost:3001");

		expect(fabricCommand("auth login")).toBe(
			`npx -y http://localhost:3001${TARBALL} auth login --base-url http://localhost:3001`,
		);
	});
});

describe("pathAsCommandWord", () => {
	it("leaves a plain path alone", () => {
		expect(pathAsCommandWord("/opt/fabric/cli/fabric.mjs", "linux")).toBe(
			"/opt/fabric/cli/fabric.mjs",
		);
	});

	it("turns a Windows path into forward slashes, which bash and PowerShell both read", () => {
		expect(
			pathAsCommandWord("D:\\config\\Config\\cli\\fabric.mjs", "win32"),
		).toBe("D:/config/Config/cli/fabric.mjs");
	});

	it("quotes only what a shell would split or interpret", () => {
		expect(pathAsCommandWord("D:\\Dev Config\\fabric.mjs", "win32")).toBe(
			'"D:/Dev Config/fabric.mjs"',
		);
		expect(pathAsCommandWord("/opt/a(b)/fabric.mjs", "linux")).toBe(
			'"/opt/a(b)/fabric.mjs"',
		);
		expect(pathAsCommandWord("/opt/o'brien/fabric.mjs", "linux")).toBe(
			`"/opt/o'brien/fabric.mjs"`,
		);
	});

	it.each([
		["a dollar sign", "/opt/a$b/fabric.mjs"],
		["a backtick", "/opt/a`b/fabric.mjs"],
		["a double quote", '/opt/a"b/fabric.mjs'],
		["a history mark", "/opt/a!b/fabric.mjs"],
		["a backslash on POSIX", "/opt/a\\b/fabric.mjs"],
		["a newline", "/opt/a\nb/fabric.mjs"],
		["nothing at all", ""],
	])("gives no spelling for a path with %s", (_label, file) => {
		expect(pathAsCommandWord(file, "linux")).toBeNull();
	});
});
