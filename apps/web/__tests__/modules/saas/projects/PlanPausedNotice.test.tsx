/**
 * The paused state of a bulk run waiting for a ChatGPT plan reset (Fizzy
 * #2770): "Paused — waiting for ChatGPT plan reset · resumes at HH:MM", with
 * Cancel always and "Run now on API billing" only when the organization has an
 * AI provider of its own. Rendered with the real en and de copy, so a missing
 * or renamed string fails here.
 */
import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// The global setup echoes keys; this suite resolves the real messages.
vi.mock("next-intl", async () => await vi.importActual("next-intl"));

import { NextIntlClientProvider } from "next-intl";
import { PlanPausedNotice } from "../../../../modules/saas/projects/components/PlanPausedNotice";

function wrap(children: ReactNode, locale: "en" | "de" = "en") {
	return (
		<NextIntlClientProvider
			locale={locale}
			messages={locale === "en" ? en : de}
			timeZone="UTC"
		>
			{children}
		</NextIntlClientProvider>
	);
}

// Local wall-clock 14:05, whatever the runner's zone.
const resumesAt = new Date(2026, 9, 12, 14, 5);

describe("PlanPausedNotice", () => {
	it("says the run is paused and when it resumes, with Cancel and Run now", () => {
		const onCancel = vi.fn();
		const onRunNow = vi.fn();
		render(
			wrap(
				<PlanPausedNotice
					resumesAt={resumesAt}
					canRunOnApi
					onCancel={onCancel}
					onRunNow={onRunNow}
				/>,
			),
		);

		expect(
			screen.getByText(
				"Paused — waiting for ChatGPT plan reset · Resumes at 14:05",
			),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(
			screen.getByRole("button", { name: "Run now on API billing" }),
		);
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onRunNow).toHaveBeenCalledTimes(1);
	});

	it("offers no Run now without an AI provider to bill", () => {
		render(
			wrap(
				<PlanPausedNotice
					resumesAt={resumesAt}
					canRunOnApi={false}
					onCancel={vi.fn()}
					onRunNow={vi.fn()}
				/>,
			),
		);

		expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
		expect(
			screen.queryByRole("button", { name: "Run now on API billing" }),
		).toBeNull();
	});

	it("counts a batch's waiting documents, and reads 'shortly' with no reset time", () => {
		render(
			wrap(
				<PlanPausedNotice
					resumesAt={null}
					pendingDocumentCount={2}
					canRunOnApi={false}
					onCancel={vi.fn()}
					onRunNow={vi.fn()}
				/>,
			),
		);

		expect(screen.getByText(/Resumes shortly/)).toBeTruthy();
		expect(screen.getByText(/2 documents are waiting\./)).toBeTruthy();
	});

	it("tells a non-admin to ask an admin instead of offering Run now", () => {
		render(
			wrap(
				<PlanPausedNotice
					resumesAt={resumesAt}
					canRunOnApi={false}
					askAdminToRunOnApi
					onCancel={vi.fn()}
					onRunNow={vi.fn()}
				/>,
			),
		);

		expect(
			screen.queryByRole("button", { name: "Run now on API billing" }),
		).toBeNull();
		expect(screen.getByText(/Ask an organization admin/)).toBeTruthy();
	});

	it("disables both actions while one is in flight", () => {
		render(
			wrap(
				<PlanPausedNotice
					resumesAt={resumesAt}
					canRunOnApi
					onCancel={vi.fn()}
					onRunNow={vi.fn()}
					runningNow
				/>,
			),
		);

		expect(
			(
				screen.getByRole("button", {
					name: "Cancel",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("fits a toolbar inline, for a paused review or grouping run", () => {
		render(
			wrap(
				<PlanPausedNotice
					inline
					resumesAt={resumesAt}
					canRunOnApi
					onCancel={vi.fn()}
					onRunNow={vi.fn()}
				/>,
			),
		);

		expect(screen.getByRole("status").textContent).toContain(
			"Resumes at 14:05",
		);
		expect(
			screen.getByRole("button", { name: "Run now on API billing" }),
		).toBeTruthy();
	});

	it("has German copy", () => {
		render(
			wrap(
				<PlanPausedNotice
					resumesAt={resumesAt}
					canRunOnApi
					onCancel={vi.fn()}
					onRunNow={vi.fn()}
				/>,
				"de",
			),
		);

		expect(
			screen.getByText(/Pausiert – wartet auf das Zurücksetzen/),
		).toBeTruthy();
		expect(
			screen.getByRole("button", {
				name: "Jetzt über API-Abrechnung ausführen",
			}),
		).toBeTruthy();
	});
});
