/**
 * Tests for `summarizeTopicSuggestions` — recommendation-preferences clause
 * splice (Publishing Suite 1C-1b part 2, §7.1(a) / FR8–FR10).
 *
 * Sibling of `role-clause-injection.test.ts` and deliberately shaped like it:
 * `buildTopicSuggestionPrompt()` is untouched, the splice lives in the async
 * activity between the prompt build and the `generateObject()` call, and it is
 * asserted through the prompt `generateObject` actually receives.
 *
 * The clause is built from the snapshot the DISPATCHER captured and the
 * workflow forwards — never from a fresh read of the settings row. A second
 * read would let a mid-run settings edit make this prompt disagree with the
 * `preferencesHash` recorded for the cycle, so the cycle would claim to have
 * run under preferences it did not use.
 */
import { buildPublishingPreferencesSnapshot } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

const generateObject = vi.fn();
const getAIModelWithMetadata = vi.fn();
const logModelUsageAsync = vi.fn();
vi.mock("@repo/ai", () => ({
	generateObject: (...a: unknown[]) => generateObject(...a),
	getAIModelWithMetadata: (...a: unknown[]) => getAIModelWithMetadata(...a),
	logModelUsageAsync: (...a: unknown[]) => logModelUsageAsync(...a),
}));

const { clause } = vi.hoisted(() => ({ clause: vi.fn() }));
vi.mock("@repo/ai/lib/function-tag-context", () => ({
	getProjectFunctionTagClause: clause,
}));

const mockIsCurrentOrgMember = vi.fn();
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		isCurrentOrgMember: (...a: unknown[]) => mockIsCurrentOrgMember(...a),
	};
});

import { summarizeTopicSuggestions } from "../summarize-topic-suggestions";

const trackUsage = vi.fn();
const base = {
	projectId: "proj-a",
	organizationId: null,
	actorUserId: "user-1",
	context: {},
};

beforeEach(() => {
	generateObject.mockReset();
	getAIModelWithMetadata.mockReset();
	logModelUsageAsync.mockReset();
	mockIsCurrentOrgMember.mockReset();
	mockIsCurrentOrgMember.mockResolvedValue(true);
	trackUsage.mockReset();
	clause.mockReset();
	// Role clause OFF by default so these tests observe the preferences splice
	// alone; one case below turns it on to check the two compose.
	clause.mockResolvedValue("");
	getAIModelWithMetadata.mockResolvedValue({
		model: {},
		metadata: { modelString: "test-model", provider: "test" },
		trackUsage,
	});
	generateObject.mockResolvedValue({
		object: { topics: [] },
		usage: { totalTokens: 1 },
	});
});

const promptOf = (call = 0) =>
	(generateObject.mock.calls[call]?.[0] as { prompt: string }).prompt;

describe("summarizeTopicSuggestions — preferences clause (§7.1(a))", () => {
	it("splices the clause into the prompt when the snapshot carries preferences", async () => {
		await summarizeTopicSuggestions({
			...base,
			preferences: buildPublishingPreferencesSnapshot({
				preferredThemes: ["Developer Experience"],
			}),
		});

		expect(promptOf()).toContain("PUBLISHING PREFERENCES");
		expect(promptOf()).toContain("Developer Experience");
	});

	it("leaves the prompt BYTE-IDENTICAL when the snapshot is empty", async () => {
		// FR10 observed one layer up from the clause builder's own empty-string
		// case. Together they make "unchanged behaviour when unconfigured" a
		// property of the shipped prompt rather than of one helper — including
		// the absence of a dangling separator, which a `+ "\n\n" + clause` would
		// leave behind and no `toContain` assertion would ever notice.
		await summarizeTopicSuggestions({
			...base,
			preferences: buildPublishingPreferencesSnapshot({}),
		});
		const withEmptySnapshot = promptOf();

		generateObject.mockClear();
		await summarizeTopicSuggestions(base);
		const withNoSnapshotAtAll = promptOf();

		expect(withEmptySnapshot).toBe(withNoSnapshotAtAll);
		expect(withEmptySnapshot).not.toContain("PUBLISHING PREFERENCES");
	});

	it("builds no clause when the input carries no preferences at all", async () => {
		// The shape an OLD history leaves behind mid-rollout: a workflow started
		// before this slice forwards nothing, and the activity must cope rather
		// than throw on a missing field.
		await summarizeTopicSuggestions(base);

		expect(promptOf()).not.toContain("PUBLISHING PREFERENCES");
	});

	it("echoes preferencesRead on EVERY path, empty and absent guidance included", async () => {
		// The capability echo the workflow gates the preferences fingerprint on.
		// Its job is to answer "did a preference-aware implementation run?", and
		// the workflow reads its ABSENCE as "an old worker took this task" — so
		// the value has to be present even when there is nothing to splice.
		//
		// The trap this pins shut: tying the echo to a NON-EMPTY clause reads as
		// the obvious implementation and is wrong in the common case. Almost no
		// project configures preferences, so the echo would be missing on nearly
		// every run, the workflow would withhold the hash every time, and each of
		// those projects would be handed a corrective regeneration at every due
		// date forever — an expensive loop, triggered by the feature being unused.
		const configured = await summarizeTopicSuggestions({
			...base,
			preferences: buildPublishingPreferencesSnapshot({
				preferredThemes: ["Developer Experience"],
			}),
		});
		expect(configured.preferencesRead).toBe(true);

		const empty = await summarizeTopicSuggestions({
			...base,
			preferences: buildPublishingPreferencesSnapshot({}),
		});
		expect(empty.preferencesRead).toBe(true);

		const oldHistory = await summarizeTopicSuggestions(base);
		expect(oldHistory.preferencesRead).toBe(true);
	});

	it("composes with the role clause rather than replacing it", async () => {
		// Two independent clauses append to the same prompt. A splice that
		// overwrote instead of appending would silently drop FR2's role context,
		// and every FR2 test would still pass because they never set preferences.
		clause.mockResolvedValue("ROLE CONTEXT: sentinel");

		await summarizeTopicSuggestions({
			...base,
			preferences: buildPublishingPreferencesSnapshot({
				preferredThemes: ["Developer Experience"],
			}),
		});

		expect(promptOf()).toContain("ROLE CONTEXT: sentinel");
		expect(promptOf()).toContain("PUBLISHING PREFERENCES");
	});
});
