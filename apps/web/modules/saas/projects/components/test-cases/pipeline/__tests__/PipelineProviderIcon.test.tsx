/**
 * Every source Fabric ingests must be recognisable in the history.
 *
 * The gap this closes: `AGENTIC_RUN_PROVIDER` is `"fabric-agentic"` and the
 * provider map only knew the four EXTERNAL providers, while an unknown provider
 * renders nothing at all. On a project that runs its cases through Fabric —
 * which is the whole point of the agentic runner — that meant almost every row
 * in the run history had no mark, and the list read as an undifferentiated pile
 * of "executions" with no way to tell what any of them were.
 *
 * The test that matters is therefore the LAST one: the map and the provider tag
 * the writer actually stores must not drift apart again.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	PipelineProviderIcon,
	pipelineProviderLabel,
} from "../PipelineProviderIcon";

describe("PipelineProviderIcon", () => {
	it.each([
		["github-actions", "GitHub Actions"],
		["gitlab-ci", "GitLab CI"],
		["azure-devops", "Azure DevOps"],
		["jira-xray", "Jira (Xray)"],
		["fabric-agentic", "Fabric agentic run"],
	])("renders a labelled mark for %s", (provider, label) => {
		render(<PipelineProviderIcon provider={provider} />);

		expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
	});

	it("renders nothing for a provider it has no mark for", () => {
		// Deliberate: a placeholder glyph reads as a real provider mark and is
		// worse than an absent one. The row still names the provider in text.
		const { container } = render(
			<PipelineProviderIcon provider="teamcity" />,
		);

		expect(container).toBeEmptyDOMElement();
	});

	it("falls back to the raw tag for an unknown provider's label", () => {
		expect(pipelineProviderLabel("teamcity")).toBe("teamcity");
	});

	it("covers the provider tag Fabric's own runs are written with", () => {
		// The drift guard. `AGENTIC_RUN_PROVIDER` in
		// `@repo/database` (queries/projects/agentic-runs.ts) is the writer; this
		// map is the reader. They lived apart and disagreed, silently, because a
		// missing entry renders as nothing rather than as an error.
		//
		// Asserted as a literal rather than imported: importing @repo/database
		// into a component test drags Prisma into the browser bundle, which is a
		// worse problem than restating one string. If this literal ever has to
		// change, the map has to change with it.
		const AGENTIC_RUN_PROVIDER = "fabric-agentic";

		expect(pipelineProviderLabel(AGENTIC_RUN_PROVIDER)).not.toBe(
			AGENTIC_RUN_PROVIDER,
		);
	});
});
