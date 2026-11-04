import { ORPCError } from "@orpc/client";
/**
 * FailedCodeAnalysisNotice — the project page's notice for a failed code
 * analysis (Fizzy #3429). An editor can run the analysis again; a viewer
 * only reads that it failed.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const retry = vi.fn();
const toastError = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			existingSetup: {
				retry: (...args: unknown[]) => retry(...args),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { FailedCodeAnalysisNotice } from "../FailedCodeAnalysisNotice";

function renderNotice(
	props: Partial<React.ComponentProps<typeof FailedCodeAnalysisNotice>> = {},
) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const handlers = {
		onRetried: vi.fn(),
		onDismiss: vi.fn(),
	};
	const view = render(
		<QueryClientProvider client={queryClient}>
			<FailedCodeAnalysisNotice
				projectId="project-1"
				organizationId="org-1"
				canRetry
				{...handlers}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { ...view, ...handlers };
}

beforeEach(() => {
	retry.mockReset();
	toastError.mockReset();
});

describe("FailedCodeAnalysisNotice", () => {
	it("runs the analysis again for an editor and reports back", async () => {
		retry.mockResolvedValue({ workflowId: "wf-1", status: "SCANNING" });
		const { onRetried } = renderNotice();

		expect(screen.getByText("The code analysis failed.")).toBeTruthy();
		await userEvent.click(
			screen.getByRole("button", { name: /run again/i }),
		);

		await waitFor(() => expect(onRetried).toHaveBeenCalledTimes(1));
		expect(retry).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
		});
		expect(toastError).not.toHaveBeenCalled();
	});

	it("shows a toast when the analysis cannot start again", async () => {
		retry.mockRejectedValue(
			new ORPCError("CONFLICT", {
				message: "Project setup is already in progress",
			}),
		);
		const { onRetried } = renderNotice();

		await userEvent.click(
			screen.getByRole("button", { name: /run again/i }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError.mock.calls[0]?.[1]).toMatchObject({
			description: "Project setup is already in progress",
		});
		expect(onRetried).not.toHaveBeenCalled();
	});

	it("never shows the raw text of an unexpected failure", async () => {
		retry.mockRejectedValue(
			new Error("connect ECONNREFUSED 10.0.0.5:5432"),
		);
		renderNotice();

		await userEvent.click(
			screen.getByRole("button", { name: /run again/i }),
		);

		await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
		expect(toastError.mock.calls[0]?.[1]).toMatchObject({
			description: "Something went wrong. Try again in a moment.",
		});
	});

	it("shows a viewer the failure without the button", () => {
		renderNotice({ canRetry: false });

		expect(screen.getByText("The code analysis failed.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /run again/i })).toBeNull();
		expect(retry).not.toHaveBeenCalled();
	});

	it("can be dismissed", async () => {
		const { onDismiss } = renderNotice({ canRetry: false });

		await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("has no accessibility violations", async () => {
		const { container } = renderNotice();

		expect(await axe(container)).toHaveNoViolations();
	});
});
