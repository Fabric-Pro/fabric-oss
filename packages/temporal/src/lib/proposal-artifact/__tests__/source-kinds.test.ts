/**
 * The source kinds retrieval reports (`PROPOSAL_SOURCE_KINDS`, workflow-safe)
 * are the kinds the stored manifest accepts (`PROPOSAL_SOURCE_MANIFEST_KINDS`
 * in `@repo/database`), in the same order (Fizzy #2946). A kind only one side
 * knows would be refused when a run is recorded, or never produced.
 *
 * Checked by the type checker: `types.ts` is imported by workflow code and
 * must not import the database at runtime, and neither does this test.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/lib/proposal-artifact/__tests__/source-kinds.test.ts
 */

import type {
	PROPOSAL_SOURCE_MANIFEST_KINDS,
	ProposalSourceManifestKind,
} from "@repo/database";
import { describe, expect, expectTypeOf, it } from "vitest";
import { PROPOSAL_SOURCE_KINDS, type ProposalSourceKind } from "../types";

describe("PROPOSAL_SOURCE_KINDS", () => {
	it("lists the kinds the stored manifest accepts, in the same order", () => {
		expectTypeOf(PROPOSAL_SOURCE_KINDS).toEqualTypeOf<
			typeof PROPOSAL_SOURCE_MANIFEST_KINDS
		>();
		expectTypeOf<ProposalSourceKind>().toEqualTypeOf<ProposalSourceManifestKind>();
		expect(PROPOSAL_SOURCE_KINDS).toEqual([
			"projectContext",
			"company",
			"summary",
			"other",
		]);
	});
});
