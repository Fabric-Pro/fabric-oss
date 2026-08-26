/**
 * Tests for `AttachmentRetentionForm` — the organization-level attachment
 * retention control (Fizzy #1749).
 *
 * Two behaviours are load-bearing and both are pinned here:
 *
 *   1. The placeholder renders the SERVER-supplied `effectiveDefault`. The
 *      browser must never hold its own copy of the 90-day policy default —
 *      that duplication is exactly what the single-definition-site design
 *      exists to prevent — so a fixture of 120 must show as "120".
 *   2. An out-of-range entry is sent VERBATIM. Clamping 10 up to 30 would
 *      silently rewrite the operator's value, contradict the design's
 *      reject-don't-clamp rule, and disagree with the project settings form,
 *      which has no clamp either. The server is the single validation
 *      authority and its rejection surfaces in a toast.
 *
 * `@tanstack/react-query` is real (a `QueryClientProvider` wrapper) rather
 * than mocked, because the form's commit path runs query -> effect sync ->
 * mutation -> onError, and a mocked `useMutation` would let a broken commit
 * rule pass.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getMock, updateMock, toastErrorMock, toastSuccessMock } = vi.hoisted(
	() => ({
		getMock: vi.fn(),
		updateMock: vi.fn(),
		toastErrorMock: vi.fn(),
		toastSuccessMock: vi.fn(),
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			attachmentRetention: {
				get: (input: unknown) => getMock(input),
				update: (input: unknown) => updateMock(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "org-1", slug: "example-org" },
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => toastSuccessMock(...args),
		error: (...args: unknown[]) => toastErrorMock(...args),
	},
}));

import { AttachmentRetentionForm } from "@saas/organizations/components/AttachmentRetentionForm";

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
	getMock.mockResolvedValue({
		attachmentRetentionDays: null,
		effectiveDefault: 90,
		settingChangedAt: null,
	});
	updateMock.mockResolvedValue({
		success: true,
		attachmentRetentionDays: 180,
	});
});

describe("AttachmentRetentionForm", () => {
	it("shows the server-supplied default as the placeholder and never hardcodes it", async () => {
		getMock.mockResolvedValue({
			attachmentRetentionDays: null,
			effectiveDefault: 120,
			settingChangedAt: null,
		});

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		expect(input).toHaveAttribute("placeholder", "120");
	});

	it("saves an entered value on blur", async () => {
		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		fireEvent.change(input, { target: { value: "180" } });
		fireEvent.blur(input);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ attachmentRetentionDays: 180 }),
			),
		);
	});

	it("clears the override when the field is emptied", async () => {
		getMock.mockResolvedValue({
			attachmentRetentionDays: 180,
			effectiveDefault: 90,
			settingChangedAt: null,
		});

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		fireEvent.change(input, { target: { value: "" } });
		fireEvent.blur(input);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ attachmentRetentionDays: null }),
			),
		);
	});

	it("sends a below-minimum entry unchanged and surfaces the rejection", async () => {
		// Deliberately NOT clamped to 30. Silently rewriting the operator's
		// value would contradict the reject-don't-clamp rule and disagree with
		// the project form, which has no clamp either. The server is the single
		// validation authority.
		updateMock.mockRejectedValue(new Error("Too small"));

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		fireEvent.change(input, { target: { value: "10" } });
		fireEvent.blur(input);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ attachmentRetentionDays: 10 }),
			),
		);
		await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
	});

	it("sends a fractional entry unchanged rather than rounding it", async () => {
		// The same reject-don't-rewrite rule as the below-minimum case, in the
		// axis a clamp assertion cannot reach: the project form sends 30.5
		// verbatim and lets zod's `.int()` refuse it, so rounding to 31 here
		// would silently accept in one surface what the other rejects.
		updateMock.mockRejectedValue(new Error("Expected integer"));

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		fireEvent.change(input, { target: { value: "30.5" } });
		fireEvent.blur(input);

		await waitFor(() =>
			expect(updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ attachmentRetentionDays: 30.5 }),
			),
		);
	});

	it("never puts a non-finite value on the wire", async () => {
		// A type="number" input hands the component "" for an entry it will not
		// parse. Measured in this harness: "abc", "-", "e", "NaN" AND "1e400"
		// all arrive as "", while "30.5" survives. So the NaN/Infinity path is
		// not reachable through this input here, and asserting "update was not
		// called" at the DOM level would be testing jsdom's value-sanitization
		// algorithm rather than any code in this repo.
		//
		// The guard still belongs in parseRetentionDaysInput (unit-tested in
		// @repo/utils, where "1e400" IS reachable), for any caller that hands it
		// text from somewhere other than a number input.
		//
		// What this pins is the half that IS observable here: a blanked entry
		// becomes an explicit null (inherit), and no call ever carries a value
		// that JSON would silently turn into one. The OTHER half — an entry the
		// browser could not parse at all — is unreachable through jsdom and is
		// covered by the badInput test below.
		getMock.mockResolvedValue({
			attachmentRetentionDays: 180,
			effectiveDefault: 90,
			settingChangedAt: null,
		});

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		for (const bad of ["1e400", "abc", "-"]) {
			fireEvent.change(input, { target: { value: bad } });
			fireEvent.blur(input);
		}

		await waitFor(() => expect(updateMock).toHaveBeenCalled());
		for (const [arg] of updateMock.mock.calls) {
			const sent = arg.attachmentRetentionDays;
			expect(sent === null || Number.isFinite(sent)).toBe(true);
		}
	});

	it("refuses to save an entry the browser could not parse, rather than reading it as a clear", async () => {
		// Found on staging, not by any test here. `<input type="number">` reports
		// `value === ""` for an entry it cannot parse while STILL SHOWING the
		// typed text — in Chrome, "1e400" stays visible in the box with `value`
		// blank and `validity.badInput` true. Blank means "inherit" on this
		// wire, so the form saved null: the operator watched their configured
		// 365-day window vanish, under a green "now follows the server default"
		// toast, with 1e400 still on screen. The write also stamps
		// attachmentRetentionDaysUpdatedAt, re-arming the 7-day grace floor.
		//
		// jsdom never sets badInput — it blanks unparseable entries and moves on
		// — so this stubs the one signal that distinguishes "could not parse"
		// from "deliberately cleared". The control is the test above, which
		// blanks the same field with jsdom's real ValidityState (badInput false)
		// and DOES expect the null; if this guard over-fired, that one goes red.
		getMock.mockResolvedValue({
			attachmentRetentionDays: 365,
			effectiveDefault: 90,
			settingChangedAt: null,
		});

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		fireEvent.change(input, { target: { value: "" } });
		Object.defineProperty(input, "validity", {
			configurable: true,
			value: { badInput: true },
		});
		fireEvent.blur(input);

		await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("does not save when the value is unchanged", async () => {
		getMock.mockResolvedValue({
			attachmentRetentionDays: 180,
			effectiveDefault: 90,
			settingChangedAt: null,
		});

		render(<AttachmentRetentionForm />, { wrapper });

		const input = await screen.findByLabelText(/retention/i);
		fireEvent.blur(input);

		await waitFor(() => expect(getMock).toHaveBeenCalled());
		expect(updateMock).not.toHaveBeenCalled();
	});
});
