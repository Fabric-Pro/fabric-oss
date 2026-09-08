/**
 * `JobCard` for a generation that is still waiting on its inputs (Fizzy #2199).
 *
 * A document generation dispatched while its project is still ingesting does
 * nothing visible for as long as that takes, which is the stretch that reads as
 * a lost request. The card is the answer, so what is pinned here is the
 * sentence it puts on screen — not that a component rendered.
 *
 * Two things this file exists to stop specifically:
 *
 *  - the vocabulary collision. `stepStatus.pending` used to be the word
 *    "Queued", so a run whose `awaitContext` step was RUNNING showed its
 *    not-yet-started `generate` step as "Queued" — exactly backwards from what
 *    the Documents tab says about the same run;
 *  - a status the panel does not recognise being announced as success. The
 *    badge's untagged fallthrough used to render green for anything that was
 *    neither RUNNING nor FAILED.
 *
 * Translations resolve against the real `en.json` / `de.json` (rather than
 * echoing keys back, as the global setup does) so a missing or renamed string
 * fails here rather than shipping as a raw key in the panel's most prominent
 * line.
 */

import de from "@repo/i18n/translations/de.json";
import en from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const intl = vi.hoisted(() => ({
	/** Swapped by a test to render the same card in another locale. */
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

	const format = (template: string, values: Record<string, unknown>) =>
		template
			.replace(
				/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
				(_all, name: string, one: string, other: string) => {
					const count = Number(values[name] ?? 0);
					return (count === 1 ? one : other).replace(
						"#",
						String(count),
					);
				},
			)
			.replace(/\{(\w+)\}/g, (_all, name: string) =>
				String(values[name] ?? ""),
			);

	const useTranslations = (namespace: string) => {
		const t = (key: string, values: Record<string, unknown> = {}) => {
			const template = lookup(`${namespace}.${key}`);
			// Throwing rather than falling back to the key is the point: a
			// label that renders as `steps.awaitContext` in production is the
			// defect, and a fallback here would hide it.
			if (typeof template !== "string") {
				throw new Error(`Missing translation: ${namespace}.${key}`);
			}
			return format(template, values);
		};
		t.raw = (key: string) => lookup(`${namespace}.${key}`);
		return t;
	};

	return {
		useTranslations,
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => intl.messages,
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

import { JobCard } from "../../../../modules/saas/jobs/components/JobCard";
import type { JobListItem } from "../../../../modules/saas/jobs/hooks/use-jobs";

/** A generation parked on the dependency wait: the row is RUNNING, the work is not. */
function queuedGeneration(over: Partial<JobListItem> = {}): JobListItem {
	return {
		id: "job-gen",
		kind: "DOCUMENT_GENERATION",
		status: "RUNNING",
		title: "Payments PRD",
		sourceType: null,
		sourceId: "doc-1",
		counts: {},
		steps: [
			{ key: "awaitContext", status: "running" },
			{ key: "generate", status: "pending" },
		],
		error: null,
		projectId: "proj-1",
		projectName: "Fabric",
		startedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
		completedAt: null,
		...over,
	};
}

beforeEach(() => {
	intl.messages = en;
});

describe("a generation waiting for its project's context", () => {
	it("names the step it is waiting on, and spins while it does", () => {
		const { container } = render(<JobCard job={queuedGeneration()} />);

		expect(
			screen.getByText("Wait for project context"),
		).toBeInTheDocument();
		// The card is what tells a user the request was not dropped, so the
		// motion has to be on the step that is actually live.
		expect(
			container.querySelectorAll(".motion-safe\\:animate-spin").length,
		).toBeGreaterThan(0);
	});

	it("says what kind of work this is, not the raw enum name", () => {
		render(<JobCard job={queuedGeneration()} />);

		expect(
			screen.getByText("Document generation · Fabric"),
		).toBeInTheDocument();
		expect(screen.queryByText(/DOCUMENT_GENERATION/)).toBeNull();
	});

	/**
	 * The collision this unit was written to end. While `awaitContext` is
	 * RUNNING, the step that has not started is `generate` — and calling THAT
	 * one "Queued" says the opposite of what the Documents tab says about the
	 * same run, where "Queued" means the whole generation is waiting.
	 */
	it("calls a step that has not started 'Not started', never 'Queued'", () => {
		render(<JobCard job={queuedGeneration()} />);

		expect(screen.getByText("Not started")).toBeInTheDocument();
		expect(screen.queryByText("Queued")).toBeNull();
	});

	it("reserves the word 'queued' for the Documents tab, in both locales", () => {
		// Asserted against the translation files rather than the render,
		// because the failure mode is a translator restoring the word in one
		// locale only — which no English-rendering test would ever see.
		expect(en.app.jobs.stepStatus.pending).not.toMatch(/queued/i);
		expect(de.app.jobs.stepStatus.pending).not.toMatch(
			/wartet|warteschlange/i,
		);
	});

	it("resolves its kind and step labels in German too", () => {
		intl.messages = de;

		render(<JobCard job={queuedGeneration()} />);

		expect(
			screen.getByText("Dokumenterstellung · Fabric"),
		).toBeInTheDocument();
		expect(
			screen.getByText("Auf Projektkontext warten"),
		).toBeInTheDocument();
		expect(screen.getByText("Nicht begonnen")).toBeInTheDocument();
	});
});

describe("the status badge", () => {
	it("stays green only for a run that actually completed", () => {
		render(
			<JobCard
				job={queuedGeneration({
					status: "COMPLETED",
					steps: [
						{ key: "awaitContext", status: "completed" },
						{ key: "generate", status: "completed" },
					],
					completedAt: new Date().toISOString(),
				})}
			/>,
		);

		expect(screen.getByRole("status")).toHaveAccessibleName("Completed");
	});

	/**
	 * The badge used to fall through to a green "Completed" for anything that
	 * was neither RUNNING nor FAILED, so a `BackgroundJobStatus` added ahead of
	 * this panel would have been announced as success — the one claim it must
	 * never make about a run it cannot account for.
	 */
	it("renders an unrecognised status as neutral, never as success", () => {
		render(
			<JobCard
				job={queuedGeneration({
					status: "CANCELLED" as JobListItem["status"],
					completedAt: new Date().toISOString(),
				})}
			/>,
		);

		const badge = screen.getByRole("status");
		expect(badge).toHaveAccessibleName("CANCELLED");
		expect(badge.className).not.toMatch(/success/);
		expect(badge.className).toMatch(/border-border/);
	});
});
