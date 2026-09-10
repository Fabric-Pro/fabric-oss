import { PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY } from "@repo/utils/publishing-suggestion-prompt";
import { describe, expect, it } from "vitest";
import { PublishingTopicPostType } from "../prisma/generated/client";
import { PUBLISHING_DRAFT_POST_TYPES_DISPLAY_ORDER } from "../prisma/queries/projects/publishing-drafts";
import {
	PUBLISHING_POST_TYPE_OPTIONS,
	PUBLISHING_TOPIC_POST_TYPES,
} from "../src/publishing-post-types";
import {
	POST_TYPE_LABELS,
	postTypeEnumToLabel,
	postTypeLabelToEnum,
} from "../src/publishing-suite-schema";

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
 * They happen to use the same words. These tests are what stop that from being
 * a coincidence that decays: add a post type to one and forget the other, and
 * this file goes red rather than the form quietly offering a value the model
 * never produces.
 *
 * A third shape sits upstream of `POST_TYPE_LABELS`: the Topic Suggestion
 * prompt, which names the whitelist to the model in prose. That one is pinned
 * at the bottom of this file, for the reason its own describe block gives.
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

describe("every post-type vocabulary is exhaustive against the Prisma enum", () => {
	// Anchored on the enum, not on a hand-written array: this fails on the
	// value the ENUM gained, rather than on the value a human remembered to add.
	const values = new Set<string>(Object.values(PublishingTopicPostType));

	it("PUBLISHING_TOPIC_POST_TYPES covers the enum", () => {
		expect(new Set<string>(PUBLISHING_TOPIC_POST_TYPES)).toEqual(values);
	});

	it("PUBLISHING_POST_TYPE_OPTIONS covers the enum", () => {
		expect(
			new Set<string>(PUBLISHING_POST_TYPE_OPTIONS.map((o) => o.value)),
		).toEqual(values);
	});

	it("POST_TYPE_LABELS covers the enum once mapped", () => {
		expect(
			new Set<string>(
				POST_TYPE_LABELS.map((l) => postTypeLabelToEnum(l)),
			),
		).toEqual(values);
	});

	it("the draft display order covers the enum", () => {
		expect(
			new Set<string>(PUBLISHING_DRAFT_POST_TYPES_DISPLAY_ORDER),
		).toEqual(values);
	});
});

/**
 * The Topic Suggestion prompt declares the whitelist to the model in prose
 * (Fizzy #1988, Phase 2D slice 1).
 *
 * This is the one place where a mismatch is completely silent in BOTH
 * directions. `normalizeTopicEnrichment` drops an unrecognised
 * `postTypeRecommendations` row with a bare `continue` — no throw, no log, no
 * counter — so a prompt naming a label the whitelist does not carry burns
 * tokens on a recommendation that vanishes, and a whitelist carrying a label
 * the prompt never names produces a type the model is simply never asked for.
 * Either way the cycle succeeds, every other test passes, and the feature is
 * dark. The nearest miss available is real: the Planning & Analysis prompt says
 * "Webinar or Demo Script" and the whitelist says "Webinar / Demo Script".
 *
 * Only this prompt is pinned. Planning & Analysis returns free strings for its
 * `contentTypes`, whitelisted against nothing, so there is no vocabulary there
 * to keep in step.
 */
describe("the Topic Suggestion prompt names exactly the whitelist", () => {
	// The prompt's own delimiters, so a reworded clause fails the parse loudly
	// instead of matching a shorter span and passing on a subset.
	const OPEN = "chosen ONLY from this exact set — ";
	const CLOSE = ' — "theme" is';

	function declaredSet(): string[] {
		const body = PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY;
		const start = body.indexOf(OPEN);
		const end = body.indexOf(CLOSE, start);
		if (start === -1 || end === -1) {
			throw new Error(
				"The suggestion prompt's post-type set is no longer delimited as this test expects — re-read the clause before changing these delimiters",
			);
		}
		return [
			...body.slice(start + OPEN.length, end).matchAll(/"([^"]+)"/g),
		].map((m) => m[1] as string);
	}

	it("declares the whitelist, in order", () => {
		expect(declaredSet()).toEqual([...POST_TYPE_LABELS]);
	});

	it("lets the model recommend as many formats as there are formats", () => {
		// The bound is prose, not schema: `postTypeRecommendations` carries no
		// `.max()`. A bound below the size of the vocabulary would forbid
		// recommending every type that genuinely fits, and nothing would report
		// it. The derived `suggestedPostTypes` array IS capped, at
		// `POST_TYPE_LABELS.length`, so this is also the ceiling that keeps the
		// prompt inside what the schema will accept.
		const bound = /an array of 1 to (\d+) objects/.exec(
			PUBLISHING_TOPIC_SUGGESTION_FALLBACK_BODY,
		);
		expect(bound).not.toBeNull();
		expect(Number(bound?.[1])).toBe(POST_TYPE_LABELS.length);
	});
});
