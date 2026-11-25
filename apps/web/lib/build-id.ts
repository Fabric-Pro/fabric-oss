import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function readGitHead(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

export function resolveCommitSha(
	env: NodeJS.ProcessEnv = process.env,
	readHead: () => string = readGitHead,
): string | null {
	const vercelSha = env.VERCEL_GIT_COMMIT_SHA?.trim();
	if (vercelSha) {
		return vercelSha;
	}
	try {
		return readHead().trim() || null;
	} catch {
		return null;
	}
}

export function createBuildId(
	commitSha: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (!commitSha) {
		return null;
	}
	const pairs = Object.keys(env)
		.filter((name) => name.startsWith("NEXT_PUBLIC_"))
		.sort()
		.map((name) => `${name}=${env[name]}`);
	const suffix = createHash("sha256")
		.update(JSON.stringify(pairs))
		.digest("hex")
		.slice(0, 12);
	return `${commitSha}-${suffix}`;
}
