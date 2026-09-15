import { describe, expect, it } from "vitest";
import {
	GET_STARTED_GROUPS,
	GET_STARTED_PAGES,
} from "../../../../modules/saas/get-started/lib/get-started-registry";

/**
 * The sidebar destination is called "Connections"; the drawer used to call it
 * "Integrations" and carried a second, redundant settings card pointing at the
 * very same route. These assertions live here rather than in `drift.test.ts` so
 * that file stays byte-identical.
 *
 * The user-visible labels move; the identifiers must NOT. `tab: "integrations"`
 * is persisted per user as a `seenPages` key, and `anchor: "nav-integrations"`
 * is string-matched against the live sidebar by `drift.test.ts`, so both are
 * pinned below as a guard against a future "tidy-up" rename.
 */

const BASE_PATH = "/app/example-org";

const allItems = GET_STARTED_GROUPS.flatMap((group) => group.items);

describe("Get Started — Connections rename", () => {
	it("exactly one item points at the Connections page, and it reads 'Connections'", () => {
		// The `mcp-servers` card deep-links to `?tab=mcp`, so a bare-path match
		// is what separates the area card from its sibling.
		const bare = allItems.filter(
			(item) =>
				item.href?.({ basePath: BASE_PATH }) ===
				`${BASE_PATH}/connections`,
		);

		expect(bare).toHaveLength(1);
		expect(bare[0]?.label).toBe("Connections");
	});

	// Scoped to items that actually lead to the Connections destination.
	// "Integrations" is still a legitimate label for the sub-kind — it names
	// the on-page tab and the action-integrations group — so a blanket ban on
	// the word would misfire on a future card that genuinely means the
	// sub-kind, and would report it as a container-rename violation.
	it("no item leading to Connections is still labelled 'Integrations'", () => {
		const stale = allItems.filter(
			(item) =>
				item.label === "Integrations" &&
				item
					.href?.({ basePath: BASE_PATH })
					?.startsWith(`${BASE_PATH}/connections`),
		);

		expect(stale).toEqual([]);
	});

	it("the nav card keeps its id and its sidebar anchor", () => {
		const navCard = allItems.find((item) => item.id === "integrations");

		expect(navCard).toBeDefined();
		expect(navCard?.anchor).toBe("nav-integrations");
	});

	it("the page tour keeps the `integrations` tab key that seenPages persists", () => {
		expect(
			GET_STARTED_PAGES.some((page) => page.tab === "integrations"),
		).toBe(true);
	});

	it("the redundant settings card is gone", () => {
		expect(
			allItems.some((item) => item.id === "settings-integrations"),
		).toBe(false);
	});
});
