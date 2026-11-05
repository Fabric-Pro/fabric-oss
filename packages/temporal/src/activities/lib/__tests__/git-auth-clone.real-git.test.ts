/**
 * `gitAuthForClone` with the real simple-git and real git. A mocked simple-git
 * cannot see its environment guard, which refuses every `GIT_*` variable set
 * through `.env()` unless the options name it. A local bare repository stands
 * in for the remote, and a local HTTP server records what git sends. Skipped
 * cleanly where git is absent.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	GIT_AUTH_OPTIONS,
	gitAuthForClone,
} from "@repo/integrations/repo-auth";
import { simpleGit } from "simple-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TOKEN = "example-token-value";

let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

describe.skipIf(!hasGit)("gitAuthForClone against real git", () => {
	let work: string;
	let remoteUrl: string;
	let server: Server;
	let serverUrl: string;
	const seenAuthorization: (string | undefined)[] = [];

	const git = (args: string[], cwd: string) =>
		execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

	beforeAll(async () => {
		work = await mkdtemp(path.join(tmpdir(), "git-auth-real-git-"));
		git(["init", "--bare", "--initial-branch=main", "remote.git"], work);
		git(["init", "--initial-branch=main", "seed"], work);
		const seed = path.join(work, "seed");
		git(["config", "user.email", "dev@example.com"], seed);
		git(["config", "user.name", "Example"], seed);
		git(["commit", "--allow-empty", "-m", "first"], seed);
		git(["push", path.join(work, "remote.git"), "main"], seed);
		remoteUrl = pathToFileURL(path.join(work, "remote.git")).href;

		server = createServer((request, response) => {
			seenAuthorization.push(request.headers.authorization);
			response.statusCode = 404;
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (!address || typeof address === "string") {
			throw new Error("The test server has no port");
		}
		serverUrl = `http://127.0.0.1:${address.port}/example/repo.git`;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
		await rm(work, { recursive: true, force: true });
	});

	it("clones and fetches through simple-git's guard, leaving no token on disk", async () => {
		const auth = gitAuthForClone("GITHUB", remoteUrl, TOKEN);
		const clonePath = path.join(work, "clone");

		await simpleGit(GIT_AUTH_OPTIONS)
			.env(auth.env)
			.clone(auth.url, clonePath);
		const local = simpleGit({
			baseDir: clonePath,
			...GIT_AUTH_OPTIONS,
		}).env(auth.env);
		await local.fetch("origin");

		expect((await local.revparse(["HEAD"])).trim()).toMatch(
			/^[0-9a-f]{40}$/,
		);
		const config = await readFile(
			path.join(clonePath, ".git", "config"),
			"utf8",
		);
		expect(config).not.toContain(TOKEN);
	});

	it("keeps the certificate settings an operator set", async () => {
		const auth = gitAuthForClone("GITHUB", remoteUrl, TOKEN, {
			...process.env,
			GIT_SSL_CAINFO: "/etc/ssl/example-ca.pem",
			GIT_SSL_CAPATH: "/etc/ssl/example-ca",
		});

		const output = await simpleGit(GIT_AUTH_OPTIONS)
			.env(auth.env)
			.listRemote([auth.url]);

		expect(output).toContain("refs/heads/main");
	});

	it.each([
		["GITHUB", "x-access-token"],
		["GITLAB", "oauth2"],
		["AZURE_DEVOPS", "pat"],
	])(
		"sends a %s token as the Authorization header, not in the URL",
		async (provider, username) => {
			seenAuthorization.length = 0;
			const auth = gitAuthForClone(provider, serverUrl, TOKEN);

			const refusal = await simpleGit(GIT_AUTH_OPTIONS)
				.env(auth.env)
				.listRemote([auth.url])
				.catch((error: unknown) => String(error));

			expect(refusal).not.toContain("environment guard");
			expect(refusal).not.toContain(TOKEN);
			expect(auth.url).not.toContain(TOKEN);
			expect(seenAuthorization).toContain(
				`Basic ${Buffer.from(`${username}:${TOKEN}`).toString("base64")}`,
			);
		},
	);
});
