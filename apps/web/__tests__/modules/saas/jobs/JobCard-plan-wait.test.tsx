/**
 * `JobCard` for a backfill waiting for a ChatGPT plan reset (Fizzy #2770).
 *
 * The row's status reads FAILED — `BackgroundJobStatus` has no waiting member
 * — but nothing failed: the workflow waits for the reset and the resumed run
 * reopens the row. The card must say so neutrally, with the reset time, and
 * must never show the red failure treatment for it.
 *
 * Translations resolve against the real `en.json` / `de.json`, as in
 * `JobCard-queued.test.tsx`, so a missing string fails here.
 */

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { format } from "date-fns";
import { beforeEach, describe, expect, it, vi } from "vitest";

const intl = vi.hoisted(() => ({
	messages: null as unknown,
}));

vi.mock("next-intl", () => {
	const lookup = (path: string): unknown =>
		path
			.split(".")
			.reduce<unknown>(
				(node, key) =>
					node && typeof node === "object"
						? (node as Record<string, unknown>)[key]
						: undefined,
				intl.messages,
			);

	const useTranslations = (namespace: string) => {
		const t = (key: string, values: Record<string, unknown> = {}) => {
			const template = lookup(`${namespace}.${key}`);
			if (typeof template !== "string") {
				throw new Error(`Missing translation: ${namespace}.${key}`);
			}
			return template.replace(/\{(\w+)\}/g, (_all, name: string) =>
				String(values[name] ?? ""),
			);
		};
		t.raw = (key: string) => lookup(`${namespace}.${key}`);
		return t;
	};

	return {
		useTranslations,
		useLocale: () => "en",
		useMessages: () => intl.messages,
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

import { JobCard } from "../../../../modules/saas/jobs/components/JobCard";
import type { JobListItem } from "../../../../modules/saas/jobs/hooks/use-jobs";

const RESUMES_AT = "2026-10-12T14:05:00.000Z";

function waitingBackfill(over: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "job-backfill",
		kind: "SLACK_BACKFILL",
		status: "FAILED",
		title: "Slack · #general",
		sourceType: "slackLinkedChannel",
		sourceId: "chan-1",
		counts: {},
		steps: [],
		error: RESUMES_AT,
		errorClass: "ChatGptPlanWait",
		projectId: "proj-1",
		projectName: "Example Project",
		startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
		completedAt: new Date(Date.now() - 60_000).toISOString(),
		...over,
	};
}

beforeEach(() => {
	intl.messages = en;
});

describe("a backfill waiting for a ChatGPT plan reset", () => {
	it("says it is waiting, and when it resumes, instead of failed", () => {
		const { container } = render(<JobCard job={waitingBackfill()} />);

		expect(screen.getByRole("status")).toHaveAccessibleName("Waiting");
		expect(
			screen.getByText(
				`Waiting for the ChatGPT plan reset · resumes ${format(new Date(RESUMES_AT), "HH:mm")}`,
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Failed")).toBeNull();
		expect(screen.queryByText(RESUMES_AT)).toBeNull();
		expect(container.querySelector(".border-destructive\\/30")).toBeNull();
		expect(container.querySelector(".text-destructive")).toBeNull();
	});

	it("still waits neutrally when the plan did not say when it resets", () => {
		render(<JobCard job={waitingBackfill({ error: "" })} />);

		expect(
			screen.getByText("Waiting for the ChatGPT plan reset"),
		).toBeInTheDocument();
	});

	it("has the German copy", () => {
		intl.messages = de;
		render(<JobCard job={waitingBackfill({ error: null })} />);

		expect(screen.getByRole("status")).toHaveAccessibleName("Wartet");
	});

	it("keeps a real failure red", () => {
		const { container } = render(
			<JobCard
				job={waitingBackfill({
					error: "invalid_auth",
					errorClass: "ActivityFailed",
				})}
			/>,
		);

		expect(screen.getByRole("status")).toHaveAccessibleName("Failed");
		expect(screen.getByText("invalid_auth")).toBeInTheDocument();
		expect(
			container.querySelector(".border-destructive\\/30"),
		).not.toBeNull();
	});
});
