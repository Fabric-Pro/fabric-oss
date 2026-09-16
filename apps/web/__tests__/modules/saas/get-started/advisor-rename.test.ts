import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	GET_STARTED_GROUPS,
	GET_STARTED_PAGES,
} from "../../../../modules/saas/get-started/lib/get-started-registry";
import {
	ONBOARDING_ANCHORS,
	ONBOARDING_STEPS,
} from "../../../../modules/saas/get-started/lib/tour-steps";

/**
 * The AI assistant is called "Advisor". The guided tour and the drawer both
 * still called it "Nexus" long after the sidebar was renamed (Fizzy #2487).
 * These assertions live here rather than in `drift.test.ts` so that file stays
 * byte-identical.
 *
 * The user-visible copy moves; the identifiers must NOT. "Nexus" survives
 * deliberately as structure — `anchor: "nav-nexus"` is string-matched against
 * the live sidebar by `drift.test.ts`, the registry entry `id: "nexus"` keys
 * drawer progress, and `/nexus` is still a real (legacy) route. Renaming any of
 * them breaks the tour's own targeting for no user-visible gain, so they are
 * pinned below against a future "tidy-up" rename.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../..");

const messages = JSON.parse(
	readFileSync(
		path.resolve(repoRoot, "packages/i18n/translations/en.json"),
		"utf8",
	),
) as Record<string, unknown>;

/** Mirrors `drift.test.ts`'s accessor so the parsed catalogue stays `unknown`. */
function messageAt(dotted: string): unknown {
	return dotted.split(".").reduce<unknown>((acc, key) => {
		if (acc && typeof acc === "object") {
			return (acc as Record<string, unknown>)[key];
		}
		return undefined;
	}, messages);
}

function stringAt(dotted: string): string {
	const value = messageAt(dotted);
	if (typeof value !== "string") {
		throw new Error(
			`expected a string at "${dotted}", got ${typeof value}`,
		);
	}
	return value;
}

const BASE_PATH = "/app/example-org";
const ASSISTANT_HREF = `${BASE_PATH}/agents/fabric-ai`;

const assistantTitle = stringAt("onboarding.tour.steps.assistant.title");
const assistantBody = stringAt("onboarding.tour.steps.assistant.body");
const allItems = GET_STARTED_GROUPS.flatMap((group) => group.items);

describe("Get Started — Advisor rename", () => {
	it("the tour step introduces Advisor by name", () => {
		expect(assistantTitle).toBe("Meet Advisor, your AI assistant");
	});

	it("the tour step body names Advisor and not Nexus", () => {
		expect(assistantBody).toContain("Advisor");
		expect(assistantBody).not.toContain("Nexus");
	});

	// `NavBar` picks the label by feature flag — `aiChatbot` when the unified
	// agent interface is on, `aiChatbotLegacy` when it is off. Pinning only the
	// first would let a revert of the second restore the very mismatch #2487
	// reported, with every other assertion here still green.
	it("both sidebar labels and the tour copy name the same product", () => {
		const label = stringAt("app.menu.aiChatbot");

		expect(stringAt("app.menu.aiChatbotLegacy")).toBe(label);
		expect(assistantTitle).toContain(label);
		expect(assistantBody).toContain(label);
	});

	// Scoped to items that actually lead to the assistant destination, per the
	// container/sub-kind/structure split in
	// docs/solutions/conventions/a-destination-rename-moves-the-href-and-strands-the-label.md.
	// A blanket ban on the word would misfire on the legacy `/nexus` route,
	// and the failure would read like a container-rename violation.
	it("no drawer item leading to the assistant is still labelled 'Nexus'", () => {
		const stale = allItems.filter(
			(item) =>
				item
					.href?.({ basePath: BASE_PATH })
					?.startsWith(ASSISTANT_HREF) &&
				(item.label.includes("Nexus") ||
					item.description.includes("Nexus")),
		);

		expect(stale).toEqual([]);
	});

	// "Nexus" is now purely structural — an anchor, a route slug, a workflow
	// type. It should never reach drawer prose again, so any hit here is a
	// stranded label rather than a legitimate use.
	it("no page-component copy in the drawer says 'Nexus'", () => {
		const stale = GET_STARTED_PAGES.flatMap((page) =>
			page.components
				.filter(
					(component) =>
						component.title.includes("Nexus") ||
						component.body.includes("Nexus"),
				)
				.map((component) => `${page.tab}/${component.id}`),
		);

		expect(stale).toEqual([]);
	});

	it("the assistant drawer entry keeps its id and its sidebar anchor", () => {
		const navCard = allItems.find((item) => item.id === "nexus");

		expect(navCard).toBeDefined();
		expect(navCard?.anchor).toBe("nav-nexus");
		expect(navCard?.href?.({ basePath: BASE_PATH })).toBe(ASSISTANT_HREF);
	});

	it("the tour step still targets the frozen sidebar anchor", () => {
		const step = ONBOARDING_STEPS.find((s) => s.id === "assistant");

		expect(step).toBeDefined();
		expect(ONBOARDING_ANCHORS.navNexus).toBe("nav-nexus");
		expect(step?.target).toMatchObject({
			kind: "anchor",
			anchorId: "nav-nexus",
		});
	});

	// `GetStartedSpotlight` renders `step.title ?? t("onboarding.tour.steps.…")`,
	// so an inline override on the step would silently bypass the renamed
	// catalogue strings and put "Nexus" back on screen with the copy assertions
	// above still passing.
	it("the assistant step has no inline copy shadowing the catalogue", () => {
		const step = ONBOARDING_STEPS.find((s) => s.id === "assistant");

		expect(step?.title).toBeUndefined();
		expect(step?.body).toBeUndefined();
	});
});
