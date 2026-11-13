/**
 * The week table opens a day from its header and from any filled cell, and
 * says "today" in words rather than only by tint.
 */

import { WeekTable } from "@saas/time-tracking/components/WeekTable";
import {
	buildWeekTable,
	type TimeEntry,
} from "@saas/time-tracking/lib/time-entry-model";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const entry: TimeEntry = {
	id: "entry-1",
	projectId: "project-a",
	projectName: "Alpha",
	workDate: "2026-11-10",
	timezone: "Europe/Berlin",
	durationMinutes: 150,
	startAt: null,
	stopAt: null,
	activity: "DEVELOPMENT",
	billable: true,
	description: null,
	storyId: null,
	storyIdentifier: null,
	storyTitle: null,
	startStopRequired: false,
	createdAt: "2026-11-10T08:00:00.000Z",
	updatedAt: "2026-11-10T08:00:00.000Z",
};

describe("WeekTable", () => {
	it("opens the day of a filled cell and of a day header", async () => {
		const onOpenDay = vi.fn();
		render(
			<WeekTable
				table={buildWeekTable([entry], "2026-11-09")}
				today="2026-11-11"
				onOpenDay={onOpenDay}
			/>,
		);

		await userEvent.click(screen.getByRole("button", { name: /openCell/ }));
		expect(onOpenDay).toHaveBeenLastCalledWith("2026-11-10");

		const headers = screen.getAllByRole("columnheader");
		// Project, seven days, Total.
		expect(headers).toHaveLength(9);
		await userEvent.click(
			headers[7].querySelector("button") ?? document.body,
		);
		expect(onOpenDay).toHaveBeenLastCalledWith("2026-11-15");
	});

	it("labels today's column in text", () => {
		render(
			<WeekTable
				table={buildWeekTable([entry], "2026-11-09")}
				today="2026-11-11"
				onOpenDay={vi.fn()}
			/>,
		);

		const headers = screen.getAllByRole("columnheader");
		expect(headers[3]).toHaveTextContent("today");
		expect(headers[2]).not.toHaveTextContent("today");
	});

	it("shows row and column totals", () => {
		render(
			<WeekTable
				table={buildWeekTable([entry], "2026-11-09")}
				today="2026-11-11"
				onOpenDay={vi.fn()}
			/>,
		);

		const row = screen.getByRole("row", { name: /Alpha/ });
		expect(row).toHaveTextContent("2h 30m");
		const footer = screen.getAllByRole("row").at(-1);
		expect(footer).toHaveTextContent(/total/i);
		expect(footer).toHaveTextContent("2h 30m");
	});
});
