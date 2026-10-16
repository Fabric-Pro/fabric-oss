/**
 * Proposal section keys and prose hashes in the worker runtime (Fizzy #2946).
 *
 * The worker stores a run's document prose hash and keys its findings by
 * section; the API and the editor recompute both later. This asserts the
 * same golden fixture `@repo/utils` and the web app assert, so the three
 * runtimes cannot drift apart.
 */

import {
	buildSectionMap,
	documentProseHash,
} from "@repo/utils/proposal-artifact/section-hash";
import { describe, expect, it } from "vitest";
import golden from "../../../../../utils/__tests__/fixtures/proposal-section-hash.golden.json";

describe("proposal section hash golden fixture", () => {
	it.each(golden.cases.map((entry) => [entry.name, entry] as const))(
		"%s",
		(_name, entry) => {
			expect(buildSectionMap(entry.markdown)).toEqual(entry.expected);
			expect(documentProseHash(entry.markdown)).toBe(
				entry.expected.documentProseHash,
			);
		},
	);
});
