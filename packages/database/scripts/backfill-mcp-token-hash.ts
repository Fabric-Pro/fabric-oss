/**
 * Backfill `MCPConfig.accessTokenHash` for existing rows.
 *
 * After the `add_mcp_config_token_hash` migration, every new write computes
 * the hash alongside `encryptedAccessToken`. Existing rows have
 * `accessTokenHash = NULL` and won't resolve in the GitLab MCP shim until
 * this script runs once.
 *
 * Idempotent: rows that already have a hash are skipped. Rows whose
 * `encryptedAccessToken` cannot be decrypted (rotated keys, malformed)
 * are reported but not fatal — they continue to operate via the
 * shim's bearer-fallback path for read-only tools.
 *
 * Run with: pnpm --filter @repo/database tsx scripts/backfill-mcp-token-hash.ts
 */

import { decryptApiKey, hashApiKey } from "@repo/utils";
import { db } from "../prisma/client";

async function main(): Promise<void> {
	console.log("Backfilling mcp_config.accessTokenHash …");

	const candidates = await db.mCPConfig.findMany({
		where: {
			encryptedAccessToken: { not: null },
			accessTokenHash: null,
		},
		select: { id: true, encryptedAccessToken: true },
	});

	console.log(`Found ${candidates.length} rows to backfill`);

	let ok = 0;
	let failed = 0;
	let raced = 0;
	for (const c of candidates) {
		if (!c.encryptedAccessToken) {
			continue;
		}
		try {
			const plaintext = decryptApiKey(c.encryptedAccessToken);
			const hash = hashApiKey(plaintext);
			// Conditional update: only write the hash if (a) it's still null
			// and (b) the ciphertext hasn't rotated since we read it.
			// Without this guard a concurrent token refresh would land its
			// new hash, then this script would clobber it with the stale one.
			const result = await db.mCPConfig.updateMany({
				where: {
					id: c.id,
					accessTokenHash: null,
					encryptedAccessToken: c.encryptedAccessToken,
				},
				data: { accessTokenHash: hash },
			});
			if (result.count === 1) {
				ok++;
			} else {
				raced++;
			}
		} catch (err) {
			failed++;
			console.warn(
				`  skipped ${c.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	console.log(
		`Done: ${ok} backfilled, ${raced} skipped (concurrent refresh), ${failed} failed`,
	);
	await db.$disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
