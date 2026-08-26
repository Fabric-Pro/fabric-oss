import { expect, test } from "@playwright/test";
import { config } from "@repo/config";

// The docs site only renders on the marketing route. Mirror `home.spec.ts`:
// when marketing is disabled the route is unavailable, so there is nothing to
// assert here.
test.describe("docs integrations footer nav", () => {
	if (config.ui.marketing.enabled) {
		test("footer-nav description wraps to two lines (not single-line clipped) with the sidebar open", async ({
			page,
		}) => {
			// Desktop width keeps the left docs sidebar open, which is the
			// condition that previously clipped the description to one line.
			await page.setViewportSize({ width: 1280, height: 900 });

			// gitlab has both a previous and a next neighbor, so the two-column
			// prev/next footer renders.
			await page.goto("/en/docs/integrations/gitlab");

			const footerDescription = page
				.locator(
					'article[data-docs-section="integrations"] p.text-fd-muted-foreground.truncate',
				)
				.first();

			await expect(footerDescription).toBeVisible();

			const computed = await footerDescription.evaluate((el) => {
				const style = window.getComputedStyle(el);
				return {
					whiteSpace: style.whiteSpace,
					lineClamp:
						style.webkitLineClamp ||
						style.getPropertyValue("-webkit-line-clamp"),
				};
			});

			// The scoped override resets Fumadocs' `truncate` single-line rule
			// (`white-space: nowrap`) to a two-line clamp.
			expect(computed.whiteSpace).not.toBe("nowrap");
			expect(computed.whiteSpace).toBe("normal");
			expect(computed.lineClamp).toBe("2");
		});
	}
});
