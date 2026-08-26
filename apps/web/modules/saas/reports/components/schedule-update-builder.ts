export type ScheduleMode = "INHERITED" | "CUSTOM" | "OFF";
export type ScheduleFrequency =
	| "daily"
	| "weekly"
	| "biweekly"
	| "monthly"
	| "quarterly";

export interface ScheduleUpdateState {
	dirty: boolean;
	mode: ScheduleMode;
	frequency: ScheduleFrequency;
	dayOfWeek: number; // 0=Sun..6=Sat, used for weekly/biweekly
	dayOfMonth: number; // 1..31, used for monthly/quarterly
	hour: number;
	minute: number;
	timezone: string;
}

export type ScheduleUpdatePayload =
	| { mode: "inherit" }
	| { mode: "off" }
	| {
			mode: "custom";
			schedule: {
				frequency: ScheduleFrequency;
				dayOfWeek?: number;
				dayOfMonth?: number;
				hour: number;
				minute: number;
				timezone: string;
			};
	  };

export function buildScheduleUpdate(
	state: ScheduleUpdateState,
): ScheduleUpdatePayload | undefined {
	if (!state.dirty) {
		return undefined;
	}
	if (state.mode === "OFF") {
		return { mode: "off" };
	}
	if (state.mode === "INHERITED") {
		return { mode: "inherit" };
	}
	// CUSTOM
	const needsDayOfWeek =
		state.frequency === "weekly" || state.frequency === "biweekly";
	const needsDayOfMonth =
		state.frequency === "monthly" || state.frequency === "quarterly";
	return {
		mode: "custom",
		schedule: {
			frequency: state.frequency,
			...(needsDayOfWeek ? { dayOfWeek: state.dayOfWeek } : {}),
			...(needsDayOfMonth ? { dayOfMonth: state.dayOfMonth } : {}),
			hour: state.hour,
			minute: state.minute,
			timezone: state.timezone,
		},
	};
}
