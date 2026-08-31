/**
 * `ProjectGeneralSettings` — the attachment retention guard (Fizzy #1749).
 *
 * This form and the organization one must agree about what a blank retention
 * field means, because they write the same column through the same cascade.
 * Both parse through `parseRetentionDaysInput`; this file pins the project
 * side of the entry the browser could not parse, which staging found and no
 * jsdom test could reach on its own.
 *
 * `@tanstack/react-query` is real rather than mocked: the guard lives inside
 * `mutationFn`, so a mocked `useMutation` would never run it.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMock, toastErrorMock, toastSuccessMock } = vi.hoisted(() => ({
	updateMock: vi.fn(),
	toastErrorMock: vi.fn(),
	toastSuccessMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			update: (input: unknown) => updateMock(input),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccessMock(...args),
		error: (...args: unknown[]) => toastErrorMock(...args),
	},
}));

import { ProjectGeneralSettings } from "@saas/projects/components/ProjectGeneralSettings";

/** A project with a retention override worth losing. */
const PROJECT = {
	id: "project-1",
	name: "Example project",
	organizationId: "org-1",
	attachmentRetentionDays: 365,
	effectiveAttachmentRetentionDays: 365,
	canEditSettings: true,
};

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	updateMock.mockResolvedValue({ id: PROJECT.id });
});

async function blankTheRetentionField() {
	const input = await screen.findByLabelText(/attachment retention/i);
	fireEvent.change(input, { target: { value: "" } });
	return input;
}

describe("ProjectGeneralSettings — attachment retention", () => {
	it("refuses to save an entry the browser could not parse, rather than reading it as a clear", async () => {
		// `<input type="number">` reports `value === ""` for an entry it cannot
		// parse while still DISPLAYING the typed text — in Chrome, "1e400" stays
		// visible with `value` blank and `validity.badInput` true. Blank means
		// "inherit", which on this wire CLEARS the override, so the save bar
		// appeared and a click deleted a configured 365-day window under a
		// "Project updated" toast with 1e400 still on screen.
		//
		// jsdom never sets badInput, so this stubs it. The control is the test
		// below: the same blanking with jsdom's real ValidityState must still
		// send null, or this guard has simply broken the ability to inherit.
		render(<ProjectGeneralSettings project={PROJECT} />, { wrapper });

		const input = await blankTheRetentionField();
		Object.defineProperty(input, "validity", {
			configurable: true,
			value: { badInput: true },
		});

		fireEvent.click(await screen.findByText("Save Changes"));

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("still clears the override when the field is genuinely blanked", async () => {
		render(<ProjectGeneralSettings project={PROJECT} />, { wrapper });

		await blankTheRetentionField();

		fireEvent.click(await screen.findByText("Save Changes"));

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ attachmentRetentionDays: null }),
			),
		);
	});

	it("sends an ordinary entry verbatim", async () => {
		// The reject-don't-clamp rule, pinned here too so the badInput guard
		// cannot be "fixed" later by sanitizing on the client instead.
		render(<ProjectGeneralSettings project={PROJECT} />, { wrapper });

		const input = await screen.findByLabelText(/attachment retention/i);
		fireEvent.change(input, { target: { value: "10" } });

		fireEvent.click(await screen.findByText("Save Changes"));

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ attachmentRetentionDays: 10 }),
			),
		);
	});
});
