import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * Interpolating translator — the global setup mock echoes the key, which would
 * hide whether the row actually renders the CI actor's name. Here the values
 * matter (that's the point of "who ran"), so this file substitutes them.
 */
vi.mock("next-intl", () => ({
	useTranslations: () => {
		const t = (key: string, values?: Record<string, unknown>) =>
			values ? `${key}:${Object.values(values).join(",")}` : key;
		t.raw = (key: string) => key;
		return t;
	},
}));

import {
	PipelineProviderIcon,
	pipelineProviderLabel,
} from "../PipelineProviderIcon";
import { PipelineRunRow } from "../PipelineRunRow";
import type { PipelineRun } from "../pipeline-run";

function makeRun(overrides: Partial<PipelineRun> = {}): PipelineRun {
	return {
		id: "run-1",
		provider: "github-actions",
		externalRunId: "30141350916",
		pipelineName: "CI",
		branch: "main",
		commitSha: "abc123def456",
		runUrl: "https://github.com/acme/store/actions/runs/30141350916",
		status: "failure",
		startedAt: new Date().toISOString(),
		durationMs: 192000,
		triggeredByActor: "alice",
		totalCount: 5,
		passedCount: 4,
		failedCount: 1,
		skippedCount: 0,
		otherCount: 0,
		...overrides,
	};
}

describe("PipelineProviderIcon", () => {
	// The feature must work across every repo Fabric ingests from, so each
	// provider tag the sync writes has to resolve to a real, labelled mark.
	it.each([
		["github-actions", "GitHub Actions"],
		["gitlab-ci", "GitLab CI"],
		["azure-devops", "Azure DevOps"],
		["jira-xray", "Jira (Xray)"],
	])("renders a labelled mark for %s", (provider, label) => {
		render(<PipelineProviderIcon provider={provider} />);
		expect(screen.getByRole("img", { name: label })).toBeInTheDocument();
		expect(pipelineProviderLabel(provider)).toBe(label);
	});

	it("renders nothing for a provider it has no mark for", () => {
		const { container } = render(
			<PipelineProviderIcon provider="bitbucket-pipelines" />,
		);
		// No placeholder glyph — the row still names the provider in its metadata.
		expect(container).toBeEmptyDOMElement();
	});
});

describe("PipelineRunRow", () => {
	it("shows the provider mark, pass count and who triggered the run", () => {
		render(<PipelineRunRow run={makeRun()} onOpenDetail={vi.fn()} />);

		expect(
			screen.getByRole("img", { name: "GitHub Actions" }),
		).toBeInTheDocument();
		expect(screen.getByText(/4\/5/)).toBeInTheDocument();
		// The whole point of "who ran": the actor reaches the row.
		expect(screen.getByText("runBy:alice")).toBeInTheDocument();
	});

	it("omits the actor when the provider didn't report one", () => {
		render(
			<PipelineRunRow
				run={makeRun({ triggeredByActor: null })}
				onOpenDetail={vi.fn()}
			/>,
		);

		expect(screen.queryByText(/^runBy:/)).toBeNull();
	});

	it("does not dress a run that reported no tests as a success", () => {
		// Regression: a pipeline that dies before its test step ingests with
		// every count at zero, and the badge tone keyed only on failedCount > 0
		// — so "0/0 passed" rendered GREEN and read as a clean run.
		render(
			<PipelineRunRow
				run={makeRun({ totalCount: 0, passedCount: 0, failedCount: 0 })}
				onOpenDetail={vi.fn()}
			/>,
		);
		// Target the COUNT badge itself, not merely the first span in the row —
		// the provider mark renders one first, and matching that made this
		// assertion pass against the broken component.
		const badge = screen.getByText(/0\/0/);
		expect(badge.className).not.toContain("text-success");
	});

	it("opens the in-Fabric detail when the row is activated", () => {
		const onOpenDetail = vi.fn();
		render(<PipelineRunRow run={makeRun()} onOpenDetail={onOpenDetail} />);

		fireEvent.click(screen.getByRole("button"));

		expect(onOpenDetail).toHaveBeenCalledWith("run-1");
	});

	it("links out to the provider without also opening the detail", () => {
		const onOpenDetail = vi.fn();
		render(<PipelineRunRow run={makeRun()} onOpenDetail={onOpenDetail} />);

		const link = screen.getByRole("link", { name: "openRun" });
		expect(link).toHaveAttribute(
			"href",
			"https://github.com/acme/store/actions/runs/30141350916",
		);

		// Two distinct destinations — following the CI link must not also fire
		// the row's detail handler.
		fireEvent.click(link);
		expect(onOpenDetail).not.toHaveBeenCalled();
	});

	it("renders without a CI link when the provider gave no run URL", () => {
		render(
			<PipelineRunRow
				run={makeRun({ runUrl: null })}
				onOpenDetail={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("link")).toBeNull();
	});
});
