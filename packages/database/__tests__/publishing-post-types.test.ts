import { describe, expect, it } from "vitest";
import {
	POST_TYPE_LABELS,
	postTypeEnumToLabel,
} from "../src/publishing-suite-schema";
import {
	PUBLISHING_POST_TYPE_OPTIONS,
	PUBLISHING_TOPIC_POST_TYPES,
} from "../src/publishing-post-types";

/**
 * The post-type vocabulary exists in two shapes for two different jobs, and
 * neither can absorb the other:
 *
 *   `POST_TYPE_LABELS` (publishing-suite-schema) is what the LLM emits and is
 *   whitelisted fail-closed. That module imports `node:crypto` and the Prisma
 *   client as VALUES, so a browser bundle can never touch it.
 *
 *   `PUBLISHING_POST_TYPE_OPTIONS` (publishing-post-types) is what the database
 *   stores, the API accepts and the settings form renders. Its only Prisma
 *   reference is `import type`, which the compiler erases, so the web layer can
 *   deep-import it.
 *
 * They happen to use the same four words. These tests are what stop that from
 * being a coincidence that decays: add a post type to one and forget the other,
 * and this file goes red rather than the form quietly offering a value the
 * model never produces.
 */
describe("post-type vocabulary", () => {
	it("offers the same labels the LLM whitelist accepts", () => {
		expect(PUBLISHING_POST_TYPE_OPTIONS.map((o) => o.label)).toEqual([
			...POST_TYPE_LABELS,
		]);
	});

	it("offers the same values the API validates against", () => {
		expect(PUBLISHING_POST_TYPE_OPTIONS.map((o) => o.value)).toEqual([
			...PUBLISHING_TOPIC_POST_TYPES,
		]);
	});

	it("maps every offered value to its offered label", () => {
		// Ties the two modules through the function the prompt clause actually
		// calls, so a label added to one side and mapped on the other still has
		// to agree end to end.
		for (const option of PUBLISHING_POST_TYPE_OPTIONS) {
			expect(postTypeEnumToLabel(option.value)).toBe(option.label);
		}
	});
});
