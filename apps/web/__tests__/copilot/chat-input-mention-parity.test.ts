/**
 * Mention parity across the two Loom surfaces that share `ChatInput`.
 *
 * Both Loom Direct and Loom Orchestrator compose the same `ChatInput`, and
 * both already hold the state the mention features need — `attachedProjectId`
 * for file/story lookups and `organizationId` for user lookups. Enabling a
 * mention type is a per-call-site opt-in, so a surface can hold the data and
 * still silently offer none of it.
 *
 * That is exactly what had happened: Orchestrator passed `organizationId` and
 * `enableTemplateMentions` but none of the project- or user-scoped flags, so
 * `@file`, `@story` and `@user` were dead there while working in Direct — even
 * though its own placeholder advertises `@` mentions.
 *
 * Reads live source and asserts against it, mirroring
 * `attachment-surface-drift.test.ts` — the repo's pattern for pinning that a
 * surface still passes what a shared component needs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = process.cwd();

/** The two surfaces that render the shared `ChatInput`. */
const CHAT_INPUT_SURFACES = {
	"Loom Direct": join(
		WEB_ROOT,
		"modules/saas/agents/components/FabricChat/FabricDirectChat.tsx",
	),
	"Loom Orchestrator": join(
		WEB_ROOT,
		"modules/saas/agents/components/FabricChat/FabricTemporalOrchestratorChat.tsx",
	),
} as const;

/**
 * Every mention type `ChatInput` supports, with the prop that turns it on.
 * A surface holding the backing state must opt into all of them or the
 * capability differs by which chat the user happens to be in.
 */
const MENTION_PROPS = [
	"enableFileMentions",
	"enableStoryMentions",
	"enableUserMentions",
	"enableTemplateMentions",
] as const;

function read(path: string): string {
	return readFileSync(path, "utf8");
}

describe("ChatInput mention parity", () => {
	for (const [surface, path] of Object.entries(CHAT_INPUT_SURFACES)) {
		describe(surface, () => {
			const source = read(path);

			for (const prop of MENTION_PROPS) {
				it(`opts into ${prop}`, () => {
					expect(source).toContain(prop);
				});
			}

			it("gates project-scoped mentions on an attached project rather than enabling them unconditionally", () => {
				// Without a project there is nothing to search, so the flags
				// must be derived from `attachedProjectId` and not hardcoded
				// `true` — an always-on picker over an empty scope reads as a
				// broken feature.
				for (const prop of [
					"enableFileMentions",
					"enableStoryMentions",
				]) {
					expect(source).toContain(`${prop}={!!attachedProjectId}`);
				}
			});

			it("gates user mentions on an organization", () => {
				expect(source).toContain(
					"enableUserMentions={!!organizationId}",
				);
			});
		});
	}
});
