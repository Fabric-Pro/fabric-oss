import { describe, expect, it } from "vitest";
import { describeCronSchedule } from "../cron-description";

const TZ = "Europe/Berlin";

describe("describeCronSchedule", () => {
	it.each([
		["0 9 * * 1", "every Monday at 09:00 (Europe/Berlin)"],
		["30 8 * * 1-5", "every weekday at 08:30 (Europe/Berlin)"],
		["0 9 * * 1,5", "every Monday and Friday at 09:00 (Europe/Berlin)"],
		["0 6 * * 0", "every Sunday at 06:00 (Europe/Berlin)"],
		["0 6 * * 7", "every Sunday at 06:00 (Europe/Berlin)"],
		["0 7 * * *", "every day at 07:00 (Europe/Berlin)"],
		["0 7,19 * * *", "every day at 07:00 and 19:00 (Europe/Berlin)"],
		["0 9 1 * *", "on day 1 of every month at 09:00 (Europe/Berlin)"],
		["*/30 * * * *", "every 30 minutes (Europe/Berlin)"],
		["15 * * * *", "every hour at minute 15 (Europe/Berlin)"],
	])("reads %s", (cron, expected) => {
		expect(describeCronSchedule(cron, TZ)).toBe(expected);
	});

	it.each([
		"0 9 1 6 *",
		"0 9 1 * 1",
		"0 0 9 * * 1",
		"@weekly",
		"0 9 * * MON",
	])("quotes %s as written rather than describing it wrongly", (cron) => {
		expect(describeCronSchedule(cron, TZ)).toBe(`cron "${cron}" (${TZ})`);
	});
});
