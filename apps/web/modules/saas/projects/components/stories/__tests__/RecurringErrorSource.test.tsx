/**
 * Inbox rendering for proposals the recurring-error scan files: the row badge
 * states the frequency (or the cluster size), and the detail panel lists the
 * evidence a reviewer needs to accept the bug — and tolerates metadata it does
 * not recognise instead of throwing inside the inbox.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
