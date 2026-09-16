/**
 * What a finished Slack channel scan says about itself.
 *
 * This component exists because a scan that found nothing was indistinguishable
 * from a scan that never ran. Clicking "Monitor now" on an up-to-date cursor
 * starts a workflow that examines zero messages, finishes in under a second,
 * and leaves the row exactly as it was — while the only number on that row
 * counts analyzed threads, so it reads 0 whether the scan examined nothing,
 * examined three messages and correctly proposed nothing, or never ran at all.
 * On staging that cost an afternoon of believing the integration was broken.
 *
 * So what is pinned here is the sentence, not that a component rendered.
 */

import type { JobListItem } from "@saas/jobs/hooks/use-jobs";
import { LastScanSummary } from "@saas/projects/components/LastScanSummary";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function job(overrides: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "j1",
		kind: "SLACK_BACKFILL",
		status: "COMPLETED",
		title: "Slack · #eng-sync",
		sourceType: "slackLinkedChannel",
		sourceId: "lc1",
		counts: { messagesScanned: 0, proposalsCreated: 0 },
		steps: [],
		error: null,
		projectId: "p1",
		completedAt: new Date().toISOString(),
		...overrides,
	} as JobListItem;
}

describe("LastScanSummary", () => {
	it("says so out loud when a scan found nothing", () => {
		render(<LastScanSummary job={job()} />);

		// The whole point: "it ran and there was nothing" must be a sentence,
		// not an unchanged row.
		expect(screen.getByText(/no new messages/i)).toBeInTheDocument();
	});

	it("reports what a productive scan found", () => {
		render(
			<LastScanSummary
				job={job({
					counts: { messagesScanned: 2, proposalsCreated: 2 },
				})}
			/>,
		);

		expect(screen.getByText(/2 new messages/i)).toBeInTheDocument();
		expect(screen.getByText(/2 proposals/i)).toBeInTheDocument();
	});

	it("singularizes a single message and a single proposal", () => {
		render(
			<LastScanSummary
				job={job({
					counts: { messagesScanned: 1, proposalsCreated: 1 },
				})}
			/>,
		);

		expect(screen.getByText(/1 new message\b/i)).toBeInTheDocument();
		expect(screen.getByText(/1 proposal\b/i)).toBeInTheDocument();
		expect(screen.queryByText(/messages/i)).not.toBeInTheDocument();
	});

	it("renders nothing before any scan has finished", () => {
		const { container } = render(<LastScanSummary job={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("stays silent while a scan is still running", () => {
		// The spinner beside it owns that moment; two live indicators on one
		// row would compete.
		const { container } = render(
			<LastScanSummary job={job({ status: "RUNNING" })} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("defers to the failure box rather than restating a failure", () => {
		const { container } = render(
			<LastScanSummary
				job={job({ status: "FAILED", error: "channel_not_found" })}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
