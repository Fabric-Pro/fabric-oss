/**
 * A project setup paused for a ChatGPT plan reset (Fizzy #2770), shown where
 * the setup's progress banner is: named as the project setup, when it
 * resumes and how many documents wait; Cancel calls the setup's own cancel
 * with this run's id; Run now only for an organization admin or owner, an
 * editor is told to ask one. Rendered with the real en and de copy.
 */
import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The global setup echoes keys; this suite resolves the real messages.
vi.mock("next-intl", async () => await vi.importActual("next-intl"));

const mocks = vi.hoisted(() => ({
	cancel: vi.fn(),
	runOnApi: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			existingSetup: {
				pausedRun: {
					get: { queryOptions: vi.fn() },
					cancel: {
						mutationOptions: (options: object) => ({
							mutationFn: mocks.cancel,
							...options,
						}),
					},
					runOnApi: {
						mutationOptions: (options: object) => ({
							mutationFn: mocks.runOnApi,
							...options,
						}),
					},
				},
			},
		},
	},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NextIntlClientProvider } from "next-intl";
import { PausedSetupNotice } from "../../../../modules/saas/projects/components/PausedSetupNotice";

function wrap(children: ReactNode, locale: "en" | "de" = "en") {
	return (
		<QueryClientProvider client={new QueryClient()}>
			<NextIntlClientProvider
				locale={locale}
				messages={locale === "en" ? en : de}
				timeZone="UTC"
			>
				{children}
			</NextIntlClientProvider>
		</QueryClientProvider>
	);
}

// Local wall-clock 14:05, whatever the runner's zone.
const resumesAt = new Date(2026, 9, 12, 14, 5);

const setup = {
	id: "task-1",
	resumesAt,
	pauseCount: 1,
	pendingDocumentCount: 2,
	canRunOnApi: true,
	askAdminToRunOnApi: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cancel.mockResolvedValue({ cancelled: true });
	mocks.runOnApi.mockResolvedValue({ workflowId: "wf-api" });
});

describe("PausedSetupNotice", () => {
	it("names the paused setup, when it resumes and what waits; Cancel cancels this run", async () => {
		const onChanged = vi.fn();
		render(
			wrap(
				<PausedSetupNotice
					projectId="project-1"
					organizationId="org-1"
					setup={setup}
					onChanged={onChanged}
				/>,
			),
		);

		expect(
			screen.getByText(
				"Project setup · Paused — waiting for ChatGPT plan reset · Resumes at 14:05",
			),
		).toBeTruthy();
		expect(screen.getByText(/2 documents are waiting\./)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		expect(mocks.cancel.mock.calls[0][0]).toEqual({
			projectId: "project-1",
			organizationId: "org-1",
			runId: "task-1",
		});
	});

	it("lets an admin run it now on API billing", async () => {
		render(
			wrap(
				<PausedSetupNotice
					projectId="project-1"
					organizationId="org-1"
					setup={setup}
					onChanged={vi.fn()}
				/>,
			),
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Run now on API billing" }),
		);
		await waitFor(() => expect(mocks.runOnApi).toHaveBeenCalled());
		expect(mocks.runOnApi.mock.calls[0][0]).toEqual({
			projectId: "project-1",
			organizationId: "org-1",
			runId: "task-1",
		});
	});

	it("tells an editor to ask an admin, and counts no documents for a setup that writes none", () => {
		render(
			wrap(
				<PausedSetupNotice
					projectId="project-1"
					organizationId="org-1"
					setup={{
						...setup,
						pendingDocumentCount: 0,
						canRunOnApi: false,
						askAdminToRunOnApi: true,
					}}
					onChanged={vi.fn()}
				/>,
			),
		);

		expect(
			screen.queryByRole("button", { name: "Run now on API billing" }),
		).toBeNull();
		expect(
			screen.getByText(
				"Need it sooner? Ask an organization admin to run it now on API billing.",
			),
		).toBeTruthy();
		expect(screen.queryByText(/documents? (is|are) waiting/)).toBeNull();
	});

	it("names the setup in German", () => {
		render(
			wrap(
				<PausedSetupNotice
					projectId="project-1"
					organizationId="org-1"
					setup={setup}
					onChanged={vi.fn()}
				/>,
				"de",
			),
		);

		expect(screen.getByText(/^Projekteinrichtung · /)).toBeTruthy();
	});
});
