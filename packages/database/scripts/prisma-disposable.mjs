/**
 * Reset/reuse local disposable databases, including migration-only schemas.
 * Run from packages/database. Only loopback example_* URLs are accepted;
 * callers must reserve those names for disposable fixtures. Raw Prisma resets
 * only its managed public schema.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

const require = createRequire(import.meta.url);

function localUrl(value, label) {
	if (!value) {
		throw new Error(`${label} is required`);
	}
	const parsed = new URL(value);
	if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
		throw new Error("PostgreSQL URL required");
	}
	if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
		throw new Error("A loopback PostgreSQL host is required");
	}
	if (!/^\/example_[a-z0-9_]+$/.test(parsed.pathname)) {
		throw new Error("Disposable database names must start with example_");
	}
	// Prevent libpq host/service/options parameters from changing the connection
	// target or role after the hostname above has been checked.
	if (parsed.search) {
		throw new Error(
			"URL parameters are not accepted for disposable commands",
		);
	}
	return parsed;
}

export function disposableTarget(mode, env) {
	if (mode !== "diff" && mode !== "reset") {
		throw new Error("Choose reset or diff");
	}
	const direct = localUrl(env.DIRECT_URL, "DIRECT_URL");
	if (mode === "reset") {
		return env.DIRECT_URL;
	}
	const shadow = localUrl(env.SHADOW_DATABASE_URL, "SHADOW_DATABASE_URL");
	const host = (url) =>
		["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
			? "loopback"
			: url.hostname;
	if (
		host(direct) === host(shadow) &&
		(direct.port || "5432") === (shadow.port || "5432") &&
		direct.pathname === shadow.pathname
	) {
		throw new Error(
			"DIRECT_URL and SHADOW_DATABASE_URL must use different databases",
		);
	}
	return env.SHADOW_DATABASE_URL;
}

async function main() {
	const [mode, ...args] = process.argv.slice(2);
	const target = disposableTarget(mode, process.env);
	if (mode === "reset" && (args.length !== 1 || args[0] !== "--force")) {
		throw new Error("Disposable reset requires exactly --force");
	}
	if (mode === "diff" && args.length !== 0) {
		throw new Error("Disposable diff takes no extra arguments");
	}
	const client = new Client({ connectionString: target });
	await client.connect();
	try {
		// This reset removes captured rows too; the URL checks restrict its target
		// to loopback example_* databases reserved for disposable fixtures.
		await client.query("DROP SCHEMA IF EXISTS lakehouse_export CASCADE");
	} finally {
		await client.end();
	}
	const prismaArgs =
		mode === "reset"
			? ["migrate", "reset", "--force"]
			: [
					"migrate",
					"diff",
					"--from-migrations",
					"./prisma/migrations",
					"--to-schema",
					"./prisma/schema.prisma",
					"--script",
					"--exit-code",
				];
	const result = spawnSync(
		process.execPath,
		[require.resolve("prisma/build/index.js"), ...prismaArgs],
		{
			cwd: fileURLToPath(new URL("../", import.meta.url)),
			env: process.env,
			stdio: "inherit",
		},
	);
	if (result.error) {
		throw result.error;
	}
	process.exitCode = result.status ?? 1;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
