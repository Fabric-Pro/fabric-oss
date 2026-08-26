/**
 * DocumentDecisionPrecheckBanner — the document editor's inline decision
 * contradiction warning + "Keep anyway" override.
 *
 * The banner shows only while the async finding is fresh: `status: "conflicts"`
 * AND the judged `checkedContentHash` still matches the document's current
 * content hash. "Keep anyway" logs the override (acknowledge mutation) and
 * clears the banner; a stale or absent finding renders nothing.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const acknowledge = vi.fn();
const toastError = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documents: {
				acknowledgeDecisionPrecheck: (...args: unknown[]) =>
					acknowledge(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { DocumentDecisionPrecheckBanner } from "../DocumentDecisionPrecheckBanner";

const CONTENT_HASH = "hash-abc";

const conflictsPrecheck = (contentHash = CONTENT_HASH) => ({
	checkedAt: "2026-07-10T00:00:00.000Z",
	status: "conflicts" as const,
	checkedContentHash: contentHash,
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres for all persistence",
			natureOfConflict: "Introduces a MongoDB store for events.",
			conflictType: "violates_accepted" as const,
			confidence: 0.9,
		},
	],
});

function renderBanner(
	props: Partial<
		React.ComponentProps<typeof DocumentDecisionPrecheckBanner>
	> = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<DocumentDecisionPrecheckBanner
				projectId="proj_1"
				documentId="doc_1"
				organizationId={null}
				decisionPrecheck={
					"decisionPrecheck" in props
						? props.decisionPrecheck
						: conflictsPrecheck()
				}
				currentContentHash={props.currentContentHash ?? CONTENT_HASH}
				onAcknowledged={props.onAcknowledged}
			/>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	acknowledge.mockReset();
	toastError.mockReset();
	acknowledge.mockResolvedValue({ acknowledged: true });
});

describe("DocumentDecisionPrecheckBanner", () => {
	it("renders the warning on a fresh conflicts result with a matching hash", () => {
		renderBanner();

		expect(
			screen.getByText(/Use Postgres for all persistence/),
		).toBeInTheDocument();
		expect(
			screen.getByText("Introduces a MongoDB store for events."),
		).toBeInTheDocument();
		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("hides the warning when the content hash is stale", () => {
		renderBanner({ currentContentHash: "hash-new" });

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("hides the warning when the finding is absent", () => {
		renderBanner({ decisionPrecheck: null });

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("hides the warning for an ok result", () => {
		renderBanner({
			decisionPrecheck: {
				checkedAt: "2026-07-10T00:00:00.000Z",
				status: "ok",
				checkedContentHash: CONTENT_HASH,
				findings: [],
			},
		});

		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("logs the override via the acknowledge mutation on Keep anyway", async () => {
		const onAcknowledged = vi.fn();
		renderBanner({ onAcknowledged });

		await userEvent.click(
			screen.getByRole("button", { name: /keepAnyway/i }),
		);

		await waitFor(() => {
			expect(acknowledge).toHaveBeenCalledWith({
				projectId: "proj_1",
				documentId: "doc_1",
				organizationId: null,
			});
		});
		await waitFor(() => {
			expect(onAcknowledged).toHaveBeenCalledTimes(1);
		});
		// Banner clears once the override is logged.
		await waitFor(() => {
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		});
	});

	it("surfaces an inline error and a toast when the override fails to log", async () => {
		const onAcknowledged = vi.fn();
		acknowledge.mockRejectedValue(new Error("network blip"));
		renderBanner({ onAcknowledged });

		await userEvent.click(
			screen.getByRole("button", { name: /keepAnyway/i }),
		);

		// AT + sighted users learn the override was NOT recorded: an inline
		// error appears and a toast fires.
		await waitFor(() => {
			expect(screen.getByText("keepAnywayError")).toBeInTheDocument();
		});
		expect(toastError).toHaveBeenCalledWith("keepAnywayError");
		// The warning stays put (not cleared) and success never fired.
		expect(onAcknowledged).not.toHaveBeenCalled();
		expect(
			screen.getByText(/Use Postgres for all persistence/),
		).toBeInTheDocument();
		// The button re-enables so the reviewer can retry.
		expect(
			screen.getByRole("button", { name: /keepAnyway/i }),
		).not.toBeDisabled();
	});

	it("has no axe violations while shown", async () => {
		const { container } = renderBanner();

		expect(await axe(container)).toHaveNoViolations();
	});
});
