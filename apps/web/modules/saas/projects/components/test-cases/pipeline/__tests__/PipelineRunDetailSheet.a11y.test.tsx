/**
 * The run-detail sheet must have an accessible name in EVERY state it can be
 * seen in, not only the one where its data arrived.
 *
 * It opens before the run has loaded, and the visible header that carries the
 * title only renders on success. So the dialog opened unnamed every time, and
 * stayed unnamed for good if the fetch failed — a screen reader announces a
 * dialog with nothing identifying it, and Radix logs it as an error.
 *
 * next-intl is globally key-mocked in vitest.setup.ts, so a translated string
 * surfaces as its key ("detail.srTitle").
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let queryState: {
	data?: unknown;
	isLoading: boolean;
	isError: boolean;
} = { data: undefined, isLoading: true, isError: false };

vi.mock("@tanstack/react-query", () => ({
	useQuery: () => queryState,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			pipelineResults: {
				runDetail: { queryOptions: (o: unknown) => o },
			},
		},
	},
}));

import { PipelineRunDetailSheet } from "../PipelineRunDetailSheet";

function renderSheet() {
	return render(
		<PipelineRunDetailSheet
			projectId="p1"
			runId="run-1"
			open={true}
			onOpenChange={() => {}}
		/>,
	);
}

describe("PipelineRunDetailSheet — accessible name in every state", () => {
	it("names the dialog while the run is still loading", () => {
		queryState = { data: undefined, isLoading: true, isError: false };
		renderSheet();

		// getByRole with a name is exactly what a screen reader resolves.
		expect(
			screen.getByRole("dialog", { name: /detail\.srTitle/ }),
		).toBeInTheDocument();
	});

	it("names the dialog when the run failed to load", () => {
		queryState = { data: undefined, isLoading: false, isError: true };
		renderSheet();

		expect(
			screen.getByRole("dialog", { name: /detail\.srTitle/ }),
		).toBeInTheDocument();
		expect(screen.getByText("detail.loadError")).toBeInTheDocument();
	});
});
