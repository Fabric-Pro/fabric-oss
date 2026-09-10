/**
 * Post-type vocabulary parity (Fizzy #1988, Phase 2D-1, Task 12).
 *
 * `topic-shared.ts`'s `POST_TYPE_LABELS` is an `ReadonlyArray<{ value }>`, not a
 * `Record<PostType, …>`, so growing the Prisma enum can never fail it at compile
 * time — nothing forces the array forward. Restructuring all five shipped call
 * sites into a `Record` is out of this slice; this is the runtime closure
 * instead: every web vocabulary that is supposed to list every post type is
 * asserted set-equal to the one list the database package already pins against
 * the Prisma enum (`packages/database/__tests__/publishing-post-types.test.ts`).
 * Anchored transitively rather than duplicating that pin, so there is one place
 * to edit when the enum grows again.
 *
 * A RUNTIME `expect`, never a type-level assertion: `apps/web/tsconfig.json`
 * excludes `__tests__`, so a `type _Check = …` here would never be checked by
 * `tsc` and would pass silently forever.
 */

// Deep import, matching `PublishingSuiteSettings.tsx:28` and the leaf module's
// own header, so the root `@repo/database` barrel — and the generated Prisma
// client behind it — does not load into the web vitest run.
import { PUBLISHING_TOPIC_POST_TYPES } from "@repo/database/src/publishing-post-types";
import { GENERATION_TAB_POST_TYPES } from "@saas/projects/components/publishing-suite/generation-tab-state";
import { POST_TYPE_OPTIONS } from "@saas/projects/components/publishing-suite/PostTypesDialog";
import { ALL_POST_TYPES } from "@saas/projects/components/publishing-suite/topic-shared";
import { describe, expect, it } from "vitest";

describe("post-type vocabulary parity", () => {
	it("the web vocabularies cover the shared tuple", () => {
		const expected = new Set<string>(PUBLISHING_TOPIC_POST_TYPES);
		expect(new Set<string>(ALL_POST_TYPES)).toEqual(expected);
		expect(new Set<string>(GENERATION_TAB_POST_TYPES)).toEqual(expected);
		expect(new Set<string>(POST_TYPE_OPTIONS.map((o) => o.value))).toEqual(
			expected,
		);
	});
});
