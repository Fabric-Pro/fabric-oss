/**
 * End-to-end HTTP verification of the registry endpoint.
 *
 * Goes one layer above `verify-mcp-cache-e2e.ts`: hits the live Next.js dev
 * server's oRPC handler with a real session cookie, mutates `mcp_server` in
 * the DB, and confirms the *HTTP response* reflects the new value on the
 * next request. This is the highest-fidelity proof of AC1 short of a
 * browser-driven test.
 *
 * Requires the dev server to be running and reachable at FABRIC_API_BASE
 * (defaults to http://127.0.0.1:3010) and FABRIC_SESSION_COOKIE to contain
 * the auth cookie string from a logged-in user.
 *
 * Run:
 *   FABRIC_API_BASE=http://127.0.0.1:3010 \
 *   FABRIC_SESSION_COOKIE="fabric.session_data=...; fabric.session_token=..." \
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- \
 *     tsx scripts/verify-mcp-cache-http.ts
 */

import { db } from "../prisma/client";

const BASE = process.env.FABRIC_API_BASE ?? "http://127.0.0.1:3010";
const COOKIE = process.env.FABRIC_SESSION_COOKIE ?? "";

let failures = 0;

function pass(name: string, detail: string) {
	console.log(`  ✓ ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
	failures++;
	console.log(`  ✗ ${name} — ${detail}`);
}

interface RegistryRow {
	id: string;
	key: string;
	description: string | null;
	isSystemProvided: boolean;
}

async function callRegistry(): Promise<RegistryRow[]> {
	const res = await fetch(`${BASE}/api/rpc/mcp/registry/list`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: COOKIE,
		},
		body: JSON.stringify({ input: {} }),
	});
	if (!res.ok) {
		throw new Error(
			`POST /api/rpc/mcp/registry/list → ${res.status}: ${await res.text()}`,
		);
	}
	const body = (await res.json()) as { json?: RegistryRow[] } | RegistryRow[];
	return Array.isArray(body) ? body : (body.json ?? []);
}

async function main() {
	console.log("\n=== MCP registry cache — HTTP layer ===\n");
	console.log("Base:", BASE);

	if (!COOKIE) {
		fail(
			"FABRIC_SESSION_COOKIE",
			"missing — set the cookie header from a logged-in session",
		);
		process.exit(1);
	}

	const sample = await db.mCPServer.findFirst({
		where: { isSystemProvided: true, isImplemented: true },
		select: { id: true, key: true, description: true },
	});
	if (!sample) {
		console.log("[skip] No implemented system server present.");
		process.exit(0);
	}

	const original = sample.description;
	const updated = `[http-cache-test ${Date.now()}]`;
	console.log(
		`Sample: ${sample.key}\n  original description: ${JSON.stringify(original)}\n`,
	);

	// 1. First HTTP call — should succeed, returns current rows
	const first = await callRegistry();
	const firstHit = first.find((r) => r.id === sample.id);
	if (firstHit) {
		pass(
			"first HTTP call returned the row",
			`${first.length} servers total`,
		);
	} else {
		fail("first HTTP call", "sample row missing from response");
		process.exit(1);
	}

	// 2. Mutate the description directly in the DB (simulates a migration)
	const t0 = Date.now();
	await db.mCPServer.update({
		where: { id: sample.id },
		data: { description: updated },
	});
	const writeMs = Date.now() - t0;
	pass("DB write committed", `${writeMs}ms (Prisma update)`);

	// 3. Immediate second HTTP call — must reflect the new description.
	//    This is the user-visible behavior: "open MCP page, see fresh data".
	const second = await callRegistry();
	const secondHit = second.find((r) => r.id === sample.id);
	if (secondHit?.description === updated) {
		pass(
			"AC1 (HTTP layer): next request returns the new description",
			`response contains ${JSON.stringify(updated)}`,
		);
	} else {
		fail(
			"AC1 (HTTP layer): stale description still served",
			`expected ${JSON.stringify(updated)}, got ${JSON.stringify(secondHit?.description)}`,
		);
	}

	// 4. Restore original so reruns are idempotent
	await db.mCPServer.update({
		where: { id: sample.id },
		data: { description: original },
	});
	pass("cleanup", "restored original description");

	console.log(
		failures === 0
			? "\n✓ HTTP-layer AC1 verified.\n"
			: `\n✗ ${failures} assertion(s) failed.\n`,
	);
	process.exit(failures === 0 ? 0 : 1);
}

main()
	.catch((err) => {
		console.error("[verify-mcp-cache-http] crashed:", err);
		process.exit(1);
	})
	.finally(async () => {
		await db.$disconnect();
	});
