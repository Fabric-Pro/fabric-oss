import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConfluenceIcon } from "../confluence/icon";
import { DatabricksVectorSearchIcon } from "../databricks-vector-search/icon";
import { GitHubIcon } from "../github/icon";
import { LinearIcon } from "../linear/icon";
import { MicrosoftTeamsIcon } from "../microsoft-teams/icon";
import { NotionIcon } from "../notion/icon";
import { SlackIcon } from "../slack/icon";

/**
 * Regression guard: branded plugin icons must be decorative, not contribute an
 * accessible name. Previously each icon carried `aria-label="Notion"` (or
 * "Slack", etc.) + `role="img"`, which caused screen readers and Playwright's
 * `textContent` to compute the accessible name of a label like
 * `<SlackIcon /> Slack` as "SlackSlack" / "NotionNotion" — see PR fixing the
 * duplicate label in the context-upload wizard.
 *
 * The icons are paired with visible text everywhere they're used, so the
 * correct pattern is `aria-hidden="true" focusable="false"`.
 */
describe("workflow plugin brand icons (a11y)", () => {
	const cases = [
		{ name: "Notion", Component: NotionIcon },
		{ name: "Slack", Component: SlackIcon },
		{ name: "GitHub", Component: GitHubIcon },
		{ name: "Confluence", Component: ConfluenceIcon },
		{
			name: "Databricks Vector Search",
			Component: DatabricksVectorSearchIcon,
		},
		{ name: "Microsoft Teams", Component: MicrosoftTeamsIcon },
		{ name: "Linear", Component: LinearIcon },
	] as const;

	for (const { name, Component } of cases) {
		describe(`${name} icon`, () => {
			it("renders as decorative (aria-hidden, no role/aria-label)", () => {
				const { container } = render(<Component />);
				const svg = container.querySelector("svg");
				expect(svg).not.toBeNull();
				expect(svg?.getAttribute("aria-hidden")).toBe("true");
				expect(svg?.getAttribute("focusable")).toBe("false");
				expect(svg?.hasAttribute("aria-label")).toBe(false);
				expect(svg?.hasAttribute("aria-labelledby")).toBe(false);
				expect(svg?.hasAttribute("role")).toBe(false);
			});

			it("does not contribute its brand name to surrounding text content", () => {
				const { container } = render(
					<span>
						<Component />
						{name}
					</span>,
				);
				const span = container.querySelector("span");
				expect(span?.textContent ?? "").toBe(name);
			});
		});
	}
});
