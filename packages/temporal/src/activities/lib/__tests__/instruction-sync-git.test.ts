import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildGitEnv,
	classifyGitFailure,
	cloneArgs,
	cloneTreeless,
	credentialFreeUrl,
	fetchPinnedCommit,
	GIT_ASKPASS_PATH,
	GIT_SAFE_CONFIG,
	GitCommandError,
	gitUsernameFor,
	isPushWriteRefusal,
	MAX_CLONE_BYTES,
	readBlobCapped,
	redactSecrets,
	runBoundedProcess,
} from "../instruction-sync-git";

const run = promisify(execFile);
let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "sync-git-test-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("constants", () => {
	it("bounds the clone at twice the snapshot total plus 64 MiB of metadata", () => {
		expect(MAX_CLONE_BYTES).toBe(2 * 52_428_800 + 64 * 1024 * 1024);
	});

	it("disables every stored credential helper and every protocol but HTTPS", () => {
		expect(GIT_SAFE_CONFIG).toEqual([
			"-c",
			"credential.helper=",
			"-c",
			"protocol.allow=never",
			"-c",
			"protocol.https.allow=always",
		]);
	});
});

describe("buildGitEnv", () => {
	it("builds the child env from scratch: nothing from the worker leaks but PATH and the proxy/CA variables", () => {
		const env = buildGitEnv({
			home: "/tmp/run-1",
			username: "x-access-token",
			credential: "tok-123",
			host: "github.com",
			source: {
				PATH: "/usr/bin",
				HTTPS_PROXY: "http://proxy.example.com:3128",
				DATABASE_URL: "postgresql://example",
				GIT_DIR: "/elsewhere",
			},
		});
		expect(env).toEqual({
			PATH: "/usr/bin",
			HTTPS_PROXY: "http://proxy.example.com:3128",
			HOME: "/tmp/run-1",
			LC_ALL: "C",
			GIT_TERMINAL_PROMPT: "0",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_LITERAL_PATHSPECS: "1",
			GIT_ASKPASS: GIT_ASKPASS_PATH,
			FABRIC_GIT_USERNAME: "x-access-token",
			FABRIC_GIT_CREDENTIAL: "tok-123",
			FABRIC_GIT_HOST: "github.com",
		});
	});

	it("refuses a credential given without a host (review S3)", () => {
		expect(() =>
			buildGitEnv({ home: "/tmp/run-1", credential: "tok-123" }),
		).toThrow(/host is required/);
	});

	it("refuses a credential given with an empty host (review S3 fix round 2 nit)", () => {
		expect(() =>
			buildGitEnv({
				home: "/tmp/run-1",
				credential: "tok-123",
				host: "",
			}),
		).toThrow(/host is required/);
	});
});

describe("git-askpass.sh", () => {
	it("is tracked executable, answers the username and password prompts naming its host, and answers nothing for a foreign host (review S3)", async () => {
		expect((await stat(GIT_ASKPASS_PATH)).mode & 0o111).not.toBe(0);
		const env = {
			PATH: process.env.PATH,
			FABRIC_GIT_USERNAME: "oauth2",
			FABRIC_GIT_CREDENTIAL: "tok-9",
			FABRIC_GIT_HOST: "gitlab.example.com",
		};
		const user = await run(
			GIT_ASKPASS_PATH,
			["Username for 'https://gitlab.example.com': "],
			{ env },
		);
		const pass = await run(
			GIT_ASKPASS_PATH,
			// Assembled so the literal is not email-shaped for the publication scan.
			[`Password for 'https://oauth2@${"gitlab.example.com"}': `],
			{ env },
		);
		expect(user.stdout).toBe("oauth2\n");
		expect(pass.stdout).toBe("tok-9\n");

		// A prompt naming a different host -- a cross-host redirect, or an
		// HTTPS_PROXY that itself demands auth -- gets an empty answer
		// instead of the repository token.
		const foreign = await run(
			GIT_ASKPASS_PATH,
			["Password for 'https://attacker.example.com': "],
			{ env },
		);
		expect(foreign.stdout).toBe("\n");

		// A userinfo segment forged to CONTAIN the expected host earlier in
		// the prompt cannot bypass an unanchored match: the real authority
		// here is evil.com, at the end, not the spoofed gitlab.example.com in
		// the middle (review S3 fix round 2).
		const spoofed = await run(
			GIT_ASKPASS_PATH,
			// Assembled so the literal is not email-shaped for the publication scan.
			[`Password for 'https://gitlab.example.com'@${"evil.com"}': `],
			{ env },
		);
		expect(spoofed.stdout).toBe("\n");
	});
});

describe("provider plumbing", () => {
	it("uses the username buildAuthCloneUrl uses for each provider", () => {
		expect(gitUsernameFor("GITHUB")).toBe("x-access-token");
		expect(gitUsernameFor("GITLAB")).toBe("oauth2");
		expect(gitUsernameFor("AZURE_DEVOPS")).toBe("pat");
	});

	it("refuses anything but https", () => {
		expect(
			credentialFreeUrl("http://github.com/example-org/r.git"),
		).toBeNull();
		expect(
			credentialFreeUrl("git@github.com:example-org/r.git"),
		).toBeNull();
		expect(credentialFreeUrl("not a url")).toBeNull();
	});

	// Finding 1: a stored URL may carry a secret outside userinfo, in a query
	// or a fragment. Those are refused, never stripped, so none of it reaches
	// git's argv or `.git/config`. Userinfo is stripped instead: Azure
	// DevOps' Clone button hands out the organization as the URL's userinfo
	// (`https://<org>@<ado host>/...`; the host is not spelled out here so
	// the publication scan does not read the pair as an email address).
	describe.each([
		["GitHub", "https://github.com/example-org/r.git"],
		["GitLab", "https://gitlab.com/example-org/group/r.git"],
		["Azure DevOps", "https://dev.azure.com/org/proj/_git/repo"],
	])("credentialFreeUrl for %s", (_provider, plain) => {
		const host = new URL(plain).host;
		const withUserinfo = plain.replace(`//${host}`, `//user:pw@${host}`);

		it("returns a plain URL unchanged", () => {
			expect(credentialFreeUrl(plain)).toBe(plain);
		});

		it.each([
			["userinfo", withUserinfo],
			["a username alone", withUserinfo.replace("user:pw@", "user@")],
		])("strips %s", (_label, url) => {
			expect(credentialFreeUrl(url)).toBe(plain);
		});

		it.each([
			["a query", `${plain}?token=abc`],
			["an access_token query", `${plain}?access_token=abc`],
			["a fragment", `${plain}#token`],
			["userinfo and a query", `${withUserinfo}?token=abc`],
		])("refuses a URL with %s", (_label, url) => {
			expect(credentialFreeUrl(url)).toBeNull();
		});
	});

	it("strips userinfo from the URL shapes members actually paste", () => {
		// Azure DevOps' Clone button. The userinfo is assembled separately so
		// the literal is not email-shaped for the publication scan.
		expect(
			credentialFreeUrl(
				`https://example-org@${"dev.azure.com"}/example-org/proj/_git/repo`,
			),
		).toBe("https://dev.azure.com/example-org/proj/_git/repo");
		expect(
			credentialFreeUrl(
				`https://user:pw@${"github.com"}/example-org/repo.git`,
			),
		).toBe("https://github.com/example-org/repo.git");
	});

	it("clones treeless, shallow, single-branch, tagless and without a checkout", () => {
		expect(
			cloneArgs({
				url: "https://github.com/example-org/r.git",
				ref: "main",
				dir: "/tmp/run/repo",
			}),
		).toEqual([
			"clone",
			"--quiet",
			"--filter=blob:none",
			"--depth",
			"1",
			"--single-branch",
			"--branch",
			"main",
			"--no-tags",
			"--no-checkout",
			"--",
			"https://github.com/example-org/r.git",
			"/tmp/run/repo",
		]);
	});
});

describe("classifyGitFailure", () => {
	it.each([
		[
			"warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin",
			"ref_missing",
		],
		[
			"remote: Repository not found.\nfatal: repository 'https://github.com/example-org/r.git/' not found",
			"repo_not_found",
		],
		[
			"remote: TF401019: The Git repository with name or identifier r does not exist",
			"repo_not_found",
		],
		[
			"fatal: remote error: upload-pack: not our ref 0123",
			"commit_missing",
		],
		[
			"fatal: unable to access 'https://github.com/': Could not resolve host",
			"other",
		],
	])("%j -> %s", (stderr, expected) => {
		expect(classifyGitFailure(stderr)).toBe(expected);
	});
});

describe("isPushWriteRefusal", () => {
	const url = "https://github.com/example-org/r.git/";
	const http403 = `fatal: unable to access '${url}': The requested URL returned error: 403`;
	const exit = (stderr: string) =>
		new GitCommandError("exit", 128, stderr, "push");

	it.each([
		// GitHub: an App whose Contents permission is read-only (Fizzy #2563).
		`remote: Write access to repository not granted.\n${http403}`,
		"remote: Write access to repository not granted.",
		// GitHub: a user or token without push rights.
		`remote: Permission to example-org/r.git denied to example-user.\n${http403}`,
		"remote: Permission to example-org/r.git denied to example-user.",
		// GitLab.
		`remote: You are not allowed to push code to this project.\n${http403}`,
		"remote: You are not allowed to push code to this project.",
		"remote: GitLab: You are not allowed to push code to protected branches on this project.",
		// Azure DevOps.
		"remote: TF401027: You need the Git 'GenericContribute' permission to perform this action. Details: identity 'Example Person', scope 'repository'.",
		"remote: TF401027: You need the Git 'ForcePush' permission to perform this action.",
		"remote: TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.",
	])("classifies %j as a write refusal", (stderr) => {
		expect(isPushWriteRefusal(exit(stderr))).toBe(true);
	});

	it.each([
		// Authentication wording wins, even beside a 403: a credential failure.
		`remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for '${url}'`,
		`remote: HTTP Basic: Access denied.\n${http403}`,
		`fatal: could not read Username for '${url}': terminal prompts disabled`,
		`fatal: unable to access '${url}': The requested URL returned error: 401`,
		// GitHub SAML SSO: a credential failure, not a write refusal.
		`remote: The 'example-org' organization has enabled or enforced SAML SSO.\nremote: To access this repository, you must re-authorize the OAuth Application.\n${http403}`,
		// A bare 403 names no write refusal: a quota, an SSO wall or a
		// provider's unrecognised wording is not read as one.
		http403,
		"error: The requested URL returned error: 403 while accessing https://git.example.com/r.git/info/refs",
		`remote: Repository not found.\nfatal: repository '${url}' not found`,
		`fatal: unable to access '${url}': The requested URL returned error: 404`,
		`fatal: unable to access '${url}': The requested URL returned error: 500`,
		`fatal: unable to access '${url}': Could not resolve host: github.com`,
		"",
	])("does not classify %j", (stderr) => {
		expect(isPushWriteRefusal(exit(stderr))).toBe(false);
	});

	it("only classifies a git exit", () => {
		for (const kind of ["timeout", "cancelled", "spawn"] as const) {
			expect(
				isPushWriteRefusal(
					new GitCommandError(kind, null, http403, "push"),
				),
			).toBe(false);
		}
	});
});

describe("redactSecrets", () => {
	it("removes the token and any URL userinfo", () => {
		const out = redactSecrets(
			// Assembled so the literal is not email-shaped for the publication scan.
			`fatal: unable to access 'https://x-access-token:tok-123@${"github.com"}/example-org/r.git/': tok-123`,
			["tok-123"],
		);
		expect(out).not.toContain("tok-123");
		expect(out).not.toContain("x-access-token:");
	});
});

describe("object id validation (review S1)", () => {
	// git's parse-options keeps reading options after a non-option argument,
	// so an unvalidated sha/oid is a proven injection sink for fetch,
	// update-ref and cat-file. PATH points nowhere, so a rejection that
	// happened to reach `spawn` would fail differently (a "spawn" kind, not
	// "invalid_argument") and this test would catch it.
	const unspawnableEnv = { PATH: "/does-not-exist" };

	it("refuses fetchPinnedCommit's sha before spawning anything", async () => {
		const error = await fetchPinnedCommit({
			dir,
			sha: "--upload-pack=x",
			env: unspawnableEnv,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitCommandError);
		expect((error as GitCommandError).kind).toBe("invalid_argument");
	});

	it("refuses readBlobCapped's oid before spawning anything", async () => {
		const error = await readBlobCapped({
			dir,
			oid: "--upload-pack=x",
			env: unspawnableEnv,
			maxBytes: 1024,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitCommandError);
		expect((error as GitCommandError).kind).toBe("invalid_argument");
	});
});

describe("cloneTreeless argument safety (review S2)", () => {
	it.each([
		["credentials", `https://user:tok@${"github.com"}/example-org/r.git`],
		["a query", "https://github.com/example-org/r.git?access_token=tok"],
		["a fragment", "https://dev.azure.com/org/proj/_git/repo#tok"],
	])(
		"refuses a URL carrying %s, before spawning anything",
		async (_label, url) => {
			const error = await cloneTreeless({
				cwd: dir,
				url,
				ref: "main",
				dir: path.join(dir, "repo"),
				env: { PATH: "/does-not-exist" },
			}).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(GitCommandError);
			expect((error as GitCommandError).kind).toBe("invalid_argument");
		},
	);
});

describe("runBoundedProcess", () => {
	it("kills the whole process group when the watched directory outgrows its cap", async () => {
		const started = Date.now();
		const error = await runBoundedProcess({
			command: "sh",
			args: ["-c", "head -c 4000000 /dev/zero > big; sleep 5"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			watchDir: dir,
			maxDirBytes: 1_000_000,
			sampleMs: 50,
			label: "test",
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(GitCommandError);
		expect((error as GitCommandError).kind).toBe("disk_limit");
		// `sleep` is a grandchild holding the pipes: only a group kill ends it early.
		expect(Date.now() - started).toBeLessThan(4000);
	});

	it("measures once more at exit, so a burst between samples is still refused", async () => {
		const error = await runBoundedProcess({
			command: "sh",
			args: ["-c", "head -c 2000000 /dev/zero > big"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			watchDir: dir,
			maxDirBytes: 1_000_000,
			sampleMs: 60_000,
			label: "test",
		}).catch((e: unknown) => e);
		expect((error as GitCommandError).kind).toBe("disk_limit");
	});

	it("kills the group when stdout passes its cap", async () => {
		const error = await runBoundedProcess({
			command: "sh",
			args: ["-c", "head -c 200000 /dev/zero; sleep 5"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			maxStdoutBytes: 65_536,
			label: "test",
		}).catch((e: unknown) => e);
		expect((error as GitCommandError).kind).toBe("output_limit");
	});

	it("tells a cancellation from a timeout", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);
		const cancelled = await runBoundedProcess({
			command: "sh",
			args: ["-c", "sleep 5"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			signal: controller.signal,
			label: "test",
		}).catch((e: unknown) => e);
		const timedOut = await runBoundedProcess({
			command: "sh",
			args: ["-c", "sleep 5"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			signal: AbortSignal.timeout(50),
			label: "test",
		}).catch((e: unknown) => e);
		expect((cancelled as GitCommandError).kind).toBe("cancelled");
		expect((timedOut as GitCommandError).kind).toBe("timeout");
	});

	it("reports a non-zero exit with the stderr tail, and a message that carries neither argv nor stderr", async () => {
		const error = (await runBoundedProcess({
			command: "sh",
			args: ["-c", "echo 'fatal: https://tok@example.com' >&2; exit 3"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			label: "clone",
		}).catch((e: unknown) => e)) as GitCommandError;
		expect(error.kind).toBe("exit");
		expect(error.exitCode).toBe(3);
		expect(error.stderrTail).toContain("fatal:");
		expect(error.message).toBe("git clone failed (exit)");
	});

	it("resolves early when the stdout consumer asks to stop", async () => {
		const result = await runBoundedProcess({
			command: "sh",
			args: ["-c", "echo one; sleep 5"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			onStdout: () => "stop",
			label: "test",
		});
		expect(result.stoppedEarly).toBe(true);
	});

	it("feeds stdin and collects stdout", async () => {
		const result = await runBoundedProcess({
			command: "sh",
			args: ["-c", "cat"],
			cwd: dir,
			env: { PATH: process.env.PATH },
			stdin: "hello\n",
			label: "test",
		});
		expect(result.stdout.toString("utf8")).toBe("hello\n");
	});
});
