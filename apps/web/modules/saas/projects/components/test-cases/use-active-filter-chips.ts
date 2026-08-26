"use client";

import { useTranslations } from "next-intl";
import {
	AUTOMATION_I18N_KEY,
	PRIORITY_I18N_KEY,
	RESULT_I18N_KEY,
	STATE_I18N_KEY,
} from "./constants";
import { ALL, type TestCasesView } from "./use-test-cases-view";

export type ActiveFilterChip = {
	id: string;
	/** The field being filtered, e.g. "Result". */
	field: string;
	/** The value it is narrowed to, e.g. "Failed". */
	value: string;
	/** Field and value together — for the "remove this one" buttons. */
	label: string;
	onRemove: () => void;
};

/**
 * Every filter currently narrowing the list, as removable chips.
 *
 * One source for two places that must agree: the chip row under the toolbar and
 * the "no cases match" state, which offers the same removals as its way back.
 * Built by asking each filter whether it is set rather than by a hand-kept list,
 * so a filter added to `TestCasesFilters` shows up here the moment it has a
 * label — and a reader is never left with a narrowing they can see the effect of
 * but not the cause.
 *
 * The two id-valued filters (feature, plan) deliberately show the field name
 * only: the list payload carries the id, not the title, and a chip reading
 * "Feature clx7…" is worse than one reading "Feature".
 */
export function useActiveFilterChips(view: TestCasesView): ActiveFilterChip[] {
	const t = useTranslations("projects.testCases");
	const { filters, setFilter } = view;
	const chips: ActiveFilterChip[] = [];

	const push = (
		id: string,
		field: string,
		value: string,
		onRemove: () => void,
	) => {
		chips.push({
			id,
			field,
			value,
			label: `${field}: ${value}`,
			onRemove,
		});
	};

	if (filters.search.trim()) {
		push("search", t("filters.fieldSearch"), filters.search.trim(), () =>
			setFilter("search", ""),
		);
	}
	if (filters.state !== ALL) {
		push(
			"state",
			t("filters.fieldState"),
			t(STATE_I18N_KEY[filters.state]),
			() => setFilter("state", ALL),
		);
	}
	if (filters.priority !== ALL) {
		push(
			"priority",
			t("filters.fieldPriority"),
			t(PRIORITY_I18N_KEY[filters.priority]),
			() => setFilter("priority", ALL),
		);
	}
	if (filters.currentResult !== ALL) {
		push(
			"currentResult",
			t("filters.fieldResult"),
			t(RESULT_I18N_KEY[filters.currentResult]),
			() => setFilter("currentResult", ALL),
		);
	}
	if (filters.automationStatus !== ALL) {
		push(
			"automationStatus",
			t("filters.fieldAutomation"),
			t(AUTOMATION_I18N_KEY[filters.automationStatus]),
			() => setFilter("automationStatus", ALL),
		);
	}
	if (filters.tag?.trim()) {
		push("tag", t("filters.fieldTag"), filters.tag.trim(), () =>
			setFilter("tag", null),
		);
	}
	if (filters.linkedStoryId) {
		push(
			"linkedStoryId",
			t("filters.fieldFeature"),
			t("filters.valueSelected"),
			() => setFilter("linkedStoryId", null),
		);
	}
	if (filters.planId) {
		push("planId", t("filters.fieldPlan"), t("filters.valueSelected"), () =>
			setFilter("planId", null),
		);
	}
	if (filters.externalLinked !== ALL) {
		push(
			"externalLinked",
			t("filters.fieldExternal"),
			t(
				filters.externalLinked
					? "filters.externalLinked"
					: "filters.externalUnlinked",
			),
			() => setFilter("externalLinked", ALL),
		);
	}

	return chips;
}
