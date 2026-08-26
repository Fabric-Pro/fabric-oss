import {
	isAfter,
	startOfDay,
	startOfMonth,
	startOfWeek,
	startOfYear,
	subDays,
	subMonths,
	subWeeks,
} from "date-fns";

type TimeGroup =
	| "pinned"
	| "today"
	| "yesterday"
	| "thisWeek"
	| "lastWeek"
	| "thisMonth"
	| "lastMonth"
	| "thisYear"
	| "lastYear"
	| "older";

export interface GroupedChats<T> {
	group: TimeGroup;
	label: string;
	chats: T[];
}

function getTimeGroup(date: Date | string): TimeGroup {
	const chatDate = new Date(date);
	const now = new Date();

	// Check if same day
	if (startOfDay(chatDate).getTime() === startOfDay(now).getTime()) {
		return "today";
	}

	// Check if yesterday
	const yesterday = startOfDay(subDays(now, 1));
	if (startOfDay(chatDate).getTime() === yesterday.getTime()) {
		return "yesterday";
	}

	// Check if this week
	const thisWeekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday
	if (isAfter(chatDate, thisWeekStart)) {
		return "thisWeek";
	}

	// Check if last week
	const lastWeekStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
	const lastWeekEnd = startOfWeek(now, { weekStartsOn: 1 });
	if (isAfter(chatDate, lastWeekStart) && !isAfter(chatDate, lastWeekEnd)) {
		return "lastWeek";
	}

	// Check if this month
	const thisMonthStart = startOfMonth(now);
	if (isAfter(chatDate, thisMonthStart)) {
		return "thisMonth";
	}

	// Check if last month
	const lastMonthStart = startOfMonth(subMonths(now, 1));
	const lastMonthEnd = startOfMonth(now);
	if (isAfter(chatDate, lastMonthStart) && !isAfter(chatDate, lastMonthEnd)) {
		return "lastMonth";
	}

	// Check if this year
	const thisYearStart = startOfYear(now);
	if (isAfter(chatDate, thisYearStart)) {
		return "thisYear";
	}

	// Check if last year
	const lastYearStart = startOfYear(subDays(now, 365));
	if (isAfter(chatDate, lastYearStart)) {
		return "lastYear";
	}

	// Older
	return "older";
}

function getGroupLabel(group: TimeGroup): string {
	switch (group) {
		case "pinned":
			return "📌 Pinned";
		case "today":
			return "Today";
		case "yesterday":
			return "Yesterday";
		case "thisWeek":
			return "This week";
		case "lastWeek":
			return "Last week";
		case "thisMonth":
			return "This month";
		case "lastMonth":
			return "Last month";
		case "thisYear":
			return "This year";
		case "lastYear":
			return "Last year";
		case "older":
			return "Older";
	}
}

export function groupChatsByTime<
	T extends {
		updatedAt: Date | string;
		createdAt: Date | string;
		pinned?: boolean;
	},
>(chats: T[]): GroupedChats<T>[] {
	const groups = new Map<TimeGroup, T[]>();

	// Initialize all groups
	const allGroups: TimeGroup[] = [
		"pinned",
		"today",
		"yesterday",
		"thisWeek",
		"lastWeek",
		"thisMonth",
		"lastMonth",
		"thisYear",
		"lastYear",
		"older",
	];
	for (const group of allGroups) {
		groups.set(group, []);
	}

	// Group chats
	for (const chat of chats) {
		// Pinned chats go to pinned group regardless of date
		if (chat.pinned) {
			groups.get("pinned")?.push(chat);
		} else {
			const group = getTimeGroup(chat.updatedAt);
			groups.get(group)?.push(chat);
		}
	}

	// Convert to array and filter out empty groups, maintaining order
	return allGroups
		.map((group) => ({
			group,
			label: getGroupLabel(group),
			chats: groups.get(group) ?? [],
		}))
		.filter((g) => g.chats.length > 0);
}
