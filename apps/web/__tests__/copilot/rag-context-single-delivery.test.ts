/**
 * The rag-context payload rides ONE channel, not two (Fizzy #2167).
 *
 * The Feature Assistant used to publish `ragContexts` twice per turn: once via
 * `useCopilotReadable` (landing on `input.context`) and again by mirroring it
 * onto `useCoAgent` state (landing on `input.state.ragContexts`). The agent
 * reads whichever it prefers and discards the other, so the second copy was
 * never read — but it was still serialized onto the wire.
 *
 * For text that was merely wasteful. For an image it was fatal: an attachment
 * travels as a base64 data URL, so a single ~4.8 MB screenshot produced two
 * ~2.3 MB copies and a ~4.6 MB request body, which the hosting platform
 * refused with 413 before the model saw it. Because the entry stays in the
 * conversation's contexts, every later turn — plain text included — was
 * refused too, and the thread could not be recovered.
 *
 * A unit test cannot observe the assembled AG-UI wire payload, so this reads
 * live source instead, mirroring `attachment-surface-drift.test.ts` — the
 * repo's existing pattern for pinning a property of a component that only
 * manifests at runtime. What it defends against is someone re-adding the
 * mirror as "belt and suspenders", which is exactly how it arrived.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = process.cwd();
const REPO_ROOT = join(WEB_ROOT, "..", "..");

const STORY_WORKSPACE = join(
	WEB_ROOT,
	"modules/saas/projects/components/stories/StoryWorkspace.tsx",
);

/** The consumer whose precedence decides which channel is the surviving one. */
const UNIFIED_SERVER = join(
	REPO_ROOT,
	"agents/langchain/project-document-generator/unified-server.ts",
);

function read(path: string): string {
	return readFileSync(path, "utf-8");
}

/**
 * Every `setAgentState(...)`-style call in the source, as the object literal it
 * is given. Matches the ref-indirected form the component actually uses
 * (`setAgentStateRef.current({...})`) as well as a direct call, so re-adding
 * the mirror either way is caught.
 */
function agentStateWrites(source: string): string[] {
	const pattern =
		/setAgentState(?:Ref\.current|\s*)?\(\s*\{([\s\S]{0,400}?)\}\s*(?:as\s+\w+\s*)?\)/g;
	return Array.from(source.matchAll(pattern), (m) => m[1]);
}

describe("rag contexts reach the agent exactly once", () => {
	it("publishes ragContexts through useCopilotReadable", () => {
		// The surviving channel. If this disappears the payload is not being
		// delivered at all, which is a worse bug than delivering it twice.
		expect(read(STORY_WORKSPACE)).toMatch(
			/useCopilotReadable\(\{[\s\S]{0,800}?ragContexts:/,
		);
	});

	it("never mirrors ragContexts onto useCoAgent state as well", () => {
		const writes = agentStateWrites(read(STORY_WORKSPACE));
		// Sanity: the matcher still finds the writes that legitimately exist,
		// so a regex that silently stopped matching cannot pass this suite.
		expect(writes.length).toBeGreaterThan(0);

		const offenders = writes.filter((body) => /\bragContexts\b/.test(body));
		expect(
			offenders,
			"ragContexts is already delivered via useCopilotReadable; mirroring it onto agent state doubles the request body and 413s any turn carrying an image (Fizzy #2167)",
		).toEqual([]);
	});

	it("keeps refreshSpecContexts on its own state field", () => {
		// The legitimate pattern, and the one a future context should copy: a
		// dedicated field, delivered state-only, precisely so it survives the
		// agent's `readable non-empty > state` short-circuit instead of being
		// duplicated across both channels.
		const writes = agentStateWrites(read(STORY_WORKSPACE));
		expect(writes.some((body) => /refreshSpecContexts/.test(body))).toBe(
			true,
		);
	});

	it("still reads the readable channel first on the agent side", () => {
		// Pins the assumption that makes the readable the right survivor. If
		// this precedence is ever inverted, dropping the mirror would stop the
		// contexts reaching the model at all.
		const source = read(UNIFIED_SERVER);
		expect(source).toMatch(/ragContextsFromReadable/);
		expect(source).toMatch(
			/ragContextsFromReadable\s*&&\s*ragContextsFromReadable\.length\s*>\s*0/,
		);
	});
});
