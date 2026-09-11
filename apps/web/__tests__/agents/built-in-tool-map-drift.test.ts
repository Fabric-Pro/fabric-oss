/**
 * The built-in capability → Fabric tool-id map exists twice, and the copies
 * must agree.
 *
 * `packages/database/prisma/queries/agent-templates.ts` holds the server's copy.
 * `FabricAIClient.tsx` holds a hand-maintained duplicate because a client
 * component cannot import from `@repo/database` without dragging Prisma into
 * the browser bundle.
 *
 * The duplication is deliberate; the drift is not. The client copy is what
 * builds `enabledFabricToolIds` for the request, and `FabricAIClient` only
 * pushes ids it finds in its own map — so an id present on the server and
 * missing on the client is never requested at all. No error, no warning: the
 * tool simply never fires. Fizzy #2473 added `fabric_list_meeting_transcripts`
 * to the server map and all but shipped with the client copy stale, which would
 * have left the fix inert on the very surface the bug was reported against.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_TO_FABRIC_TOOLS } from "@repo/database";
import { describe, expect, it } from "vitest";

const CLIENT_SOURCE = join(
	__dirname,
	"../../modules/saas/agents/components/fabric-ai/FabricAIClient.tsx",
);

/**
 * Pull the client's literal map out of the source text. Reading the text rather
 * than importing keeps React and the rest of the component out of this test —
 * the map is a module-level const in a client component, not an export.
 */
function readClientToolMap(): Record<string, string[]> {
	const source = readFileSync(CLIENT_SOURCE, "utf8");
	const declaration = source.match(
		/BUILT_IN_TO_FABRIC_TOOLS[^=]*=\s*\{([\s\S]*?)\n\};/,
	);
	if (!declaration) {
		throw new Error(
			`Could not find the BUILT_IN_TO_FABRIC_TOOLS literal in ${CLIENT_SOURCE}. ` +
				"If it was renamed or moved, update this guard rather than deleting it.",
		);
	}

	const map: Record<string, string[]> = {};
	const entry = /["']?([a-zA-Z-]+)["']?\s*:\s*\[([^\]]*)\]/g;
	let match: RegExpExecArray | null = entry.exec(declaration[1]);
	while (match !== null) {
		const ids = match[2]
			.split(",")
			.map((id) => id.trim().replace(/^["']|["']$/g, ""))
			.filter((id) => id.length > 0);
		map[match[1]] = ids;
		match = entry.exec(declaration[1]);
	}
	return map;
}

describe("built-in tool map drift (client vs server)", () => {
	it("parses a non-trivial map out of the client component", () => {
		// Guards the guard: a regex that silently matched nothing would make
		// every assertion below vacuously pass.
		const client = readClientToolMap();
		expect(Object.keys(client).length).toBeGreaterThan(5);
	});

	it("maps every server capability to the same tool ids on the client", () => {
		const client = readClientToolMap();

		for (const [capability, serverIds] of Object.entries(
			BUILT_IN_TO_FABRIC_TOOLS,
		)) {
			// A capability with no tool ids has nothing to keep in step.
			if (serverIds.length === 0) {
				continue;
			}
			expect(
				client[capability],
				`Capability "${capability}" is missing from the client copy in FabricAIClient.tsx. ` +
					"Its tools will never be requested.",
			).toBeDefined();
			expect(
				[...(client[capability] ?? [])].sort(),
				`Capability "${capability}" maps to different tool ids on the client than on the server.`,
			).toEqual([...serverIds].sort());
		}
	});

	it("keeps the date-aware meeting lookup on both sides", () => {
		// The specific regression from Fizzy #2473: without this id on the
		// client, a date question falls back to semantic search and the
		// assistant reports meetings that exist as missing.
		expect(BUILT_IN_TO_FABRIC_TOOLS["project-context"]).toContain(
			"fabric_list_meeting_transcripts",
		);
		expect(readClientToolMap()["project-context"]).toContain(
			"fabric_list_meeting_transcripts",
		);
	});
});
