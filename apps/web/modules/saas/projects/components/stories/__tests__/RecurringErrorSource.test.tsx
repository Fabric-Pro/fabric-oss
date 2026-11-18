/**
 * Inbox rendering for proposals the recurring-error scan files: the row badge
 * states the frequency (or the cluster size), and the detail panel lists the
 * evidence a reviewer needs to accept the bug — and tolerates metadata it does
 * not recognise instead of throwing inside the inbox.
 */
import de from "@repo/i18n/translations/de.json";
import translations from "@repo/i18n/translations/en.json";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	isRecurringErrorSource,
	RecurringErrorSourceBadge,
	RecurringErrorSourcePanel,
} from "../RecurringErrorSource";

const LOG_METADATA = {
	recurringError: {
		source: "LOG",
		occurrences: 12,
		windowHours: 24,
		affectedUsers: 4,
		components: ["checkout-api", "payments-worker"],
		firstSeen: "2026-10-21T10:00:00Z",
		lastSeen: "2026-10-22T09:00:00Z",
	},
	transcript: "Occurrences: 12 in the last 24 hours",
};

const INCIDENT_METADATA = {
	recurringError: {
		source: "INCIDENT",
		stories: [
			{ id: "s1", identifier: "B-1", title: "Export hangs" },
			{ id: "s2", identifier: "B-2", title: "Export never finishes" },
		],
	},
};

describe("isRecurringErrorSource", () => {
	it("recognises only the scan's two sources", () => {
		expect(isRecurringErrorSource("LOG_MONITOR")).toBe(true);
		expect(isRecurringErrorSource("INCIDENT_CLUSTER")).toBe(true);
		expect(isRecurringErrorSource("TEAMS_CHANNEL")).toBe(false);
	});
});

describe("RecurringErrorSourceBadge", () => {
	it("states the frequency of a log-detected error", () => {
		render(
			<RecurringErrorSourceBadge
				source="LOG_MONITOR"
				sourceMetadata={LOG_METADATA}
			/>,
		);
		expect(
			screen.getByText("Recurring error · 12× in 24h"),
		).toBeInTheDocument();
	});

	it("states the size of a bug-report cluster", () => {
		render(
			<RecurringErrorSourceBadge
				source="INCIDENT_CLUSTER"
				sourceMetadata={INCIDENT_METADATA}
			/>,
		);
		expect(screen.getByText("2 related bug reports")).toBeInTheDocument();
	});

	it("falls back to a plain label when the evidence is missing", () => {
		render(
			<RecurringErrorSourceBadge
				source="LOG_MONITOR"
				sourceMetadata={null}
			/>,
		);
		expect(screen.getByText("Recurring error")).toBeInTheDocument();
	});
});

describe("RecurringErrorSourcePanel", () => {
	it("shows frequency, components, users and the full evidence", () => {
		render(
			<RecurringErrorSourcePanel
				source="LOG_MONITOR"
				sourceMetadata={LOG_METADATA}
			/>,
		);
		expect(
			screen.getByText("Detected from recurring application errors"),
		).toBeInTheDocument();
		const summary = screen.getByText(/12 occurrences in 24 hours/);
		expect(summary).toHaveTextContent("checkout-api, payments-worker");
		expect(summary).toHaveTextContent("4 users");
		expect(summary).toHaveTextContent("first seen");
		expect(summary).toHaveTextContent("last seen");
		expect(screen.getByText("See evidence")).toBeInTheDocument();
		expect(
			screen.getByText("Occurrences: 12 in the last 24 hours"),
		).toBeInTheDocument();
	});

	it("lists every consolidated bug report", () => {
		render(
			<RecurringErrorSourcePanel
				source="INCIDENT_CLUSTER"
				sourceMetadata={INCIDENT_METADATA}
			/>,
		);
		expect(screen.getByText("B-1")).toBeInTheDocument();
		expect(screen.getByText("B-2")).toBeInTheDocument();
		expect(screen.queryByText("See evidence")).not.toBeInTheDocument();
	});

	it("renders nothing for other sources", () => {
		const { container } = render(
			<RecurringErrorSourcePanel
				source="TEAMS_CHANNEL"
				sourceMetadata={LOG_METADATA}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("tolerates malformed metadata", () => {
		render(
			<RecurringErrorSourcePanel
				source="INCIDENT_CLUSTER"
				sourceMetadata={{
					recurringError: { stories: [null, 3, { title: "no id" }] },
					transcript: 42,
				}}
			/>,
		);
		expect(
			screen.getByText("Consolidates related open bug reports"),
		).toBeInTheDocument();
		expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
	});
});

const localeState = vi.hoisted(() => ({ locale: "en" as "en" | "de" }));
beforeEach(() => {
	localeState.locale = "en";
});
vi.mock("next-intl", async () => {
	const actual =
		await vi.importActual<typeof import("next-intl")>("next-intl");
	return {
		...actual,
		useTranslations: () =>
			actual.createTranslator({
				locale: localeState.locale,
				messages: localeState.locale === "de" ? de : translations,
				namespace: "projects.recurringErrorSource",
			}),
	};
});
const absence = {
	firstAbsentScanAt: "2026-11-12T10:00:00Z",
	lastAbsentScanAt: "2026-11-13T10:00:00Z",
	scans: 2,
};
it("renders the absence badge and threshold explanation", () => {
	const sourceMetadata = { ...LOG_METADATA, recurringErrorAbsence: absence };
	render(
		<>
			<RecurringErrorSourceBadge
				source="LOG_MONITOR"
				sourceMetadata={sourceMetadata}
			/>
			<RecurringErrorSourcePanel
				source="LOG_MONITOR"
				sourceMetadata={sourceMetadata}
			/>
		</>,
	);
	expect(screen.getByText(/Below threshold/)).toBeInTheDocument();
	expect(
		screen.getByText(/The last 2 scans.*at the threshold/),
	).toBeInTheDocument();
});
it.each([
	undefined,
	null,
	{},
	{ ...absence, scans: 0 },
	{ ...absence, scans: 1.5 },
	{ ...absence, firstAbsentScanAt: "bad" },
	{ ...absence, lastAbsentScanAt: "bad" },
	{ ...absence, firstAbsentScanAt: "2027-01-01" },
])(
	"preserves output for absent or malformed absence %j",
	(recurringErrorAbsence) => {
		const { container } = render(
			<>
				<RecurringErrorSourceBadge
					source="LOG_MONITOR"
					sourceMetadata={{ ...LOG_METADATA, recurringErrorAbsence }}
				/>
				<RecurringErrorSourcePanel
					source="LOG_MONITOR"
					sourceMetadata={{ ...LOG_METADATA, recurringErrorAbsence }}
				/>
			</>,
		);
		expect(container.textContent).not.toContain("Below threshold");
		expect(container.textContent).not.toContain("at the threshold");
		expect(
			screen.getByText("Recurring error · 12× in 24h"),
		).toBeInTheDocument();
	},
);
it("ignores absence on incident proposals", () => {
	render(
		<RecurringErrorSourcePanel
			source="INCIDENT_CLUSTER"
			sourceMetadata={{
				...INCIDENT_METADATA,
				recurringErrorAbsence: absence,
			}}
		/>,
	);
	expect(screen.queryByText(/at the threshold/)).not.toBeInTheDocument();
});

it("uses the latest parseable sighting across own and related errors", () => {
	const latest = "2026-10-25T09:00:00Z";
	render(
		<RecurringErrorSourceBadge
			source="LOG_MONITOR"
			sourceMetadata={{
				...LOG_METADATA,
				recurringErrorAbsence: absence,
				relatedErrors: [
					null,
					3,
					{ recurringError: { lastSeen: "bad" } },
					{ recurringError: { lastSeen: latest } },
					{ recurringError: { lastSeen: "2026-10-20T09:00:00Z" } },
				],
			}}
		/>,
	);
	expect(
		screen.getByText(
			`Below threshold · last seen ${new Date(latest).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
		),
	).toBeInTheDocument();
});
it("uses related sightings when the own date is invalid", () => {
	render(
		<RecurringErrorSourceBadge
			source="LOG_MONITOR"
			sourceMetadata={{
				recurringError: { lastSeen: "bad" },
				recurringErrorAbsence: absence,
				relatedErrors: [
					{ recurringError: { lastSeen: "2026-10-25T09:00:00Z" } },
				],
			}}
		/>,
	);
	expect(screen.getByText(/Below threshold.*Oct 25/)).toBeInTheDocument();
});
it("hides the marker when no sighting parses", () => {
	render(
		<RecurringErrorSourceBadge
			source="LOG_MONITOR"
			sourceMetadata={{
				recurringErrorAbsence: absence,
				recurringError: { lastSeen: "bad" },
				relatedErrors: [{ recurringError: { lastSeen: null } }],
			}}
		/>,
	);
	expect(screen.queryByText(/Below threshold/)).not.toBeInTheDocument();
});
it.each(["en", "de"] as const)(
	"renders real ICU singular and plural output in %s",
	(locale) => {
		localeState.locale = locale;
		const { rerender } = render(
			<RecurringErrorSourcePanel
				source="LOG_MONITOR"
				sourceMetadata={{
					...LOG_METADATA,
					recurringErrorAbsence: { ...absence, scans: 1 },
				}}
			/>,
		);
		expect(
			screen.getByText(
				locale === "en"
					? /The latest scan .*at the threshold/
					: /Der letzte Scan .*erforderlichen Häufigkeit/,
			),
		).toBeInTheDocument();
		rerender(
			<RecurringErrorSourcePanel
				source="LOG_MONITOR"
				sourceMetadata={{
					...LOG_METADATA,
					recurringErrorAbsence: absence,
				}}
			/>,
		);
		expect(
			screen.getByText(
				locale === "en"
					? /The last 2 scans .*at the threshold/
					: /Die letzten 2 Scans .*erforderlichen Häufigkeit/,
			),
		).toBeInTheDocument();
	},
);
