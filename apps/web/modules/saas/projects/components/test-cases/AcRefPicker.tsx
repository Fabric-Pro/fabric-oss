"use client";

import {
	criterionDisplayText,
	parseAcceptanceCriteria,
} from "@repo/utils/acceptance-criteria";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

/** Long criteria differ late; an ellipsis says the difference is off-screen. */
function truncate(text: string): string {
	return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/** The number a stored ref resolves to, or null for one naming no number. */
function refNumber(ref: string): string | null {
	return ref.match(/\d+/)?.[0] ?? null;
}

function splitRefs(raw: string): string[] {
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * The fallback for a spec the parser cannot read, where there is no criterion
 * list to tick. Several refs are still expressible, comma-separated.
 *
 * Holds the raw text rather than deriving it from `values` on every keystroke:
 * splitting as you type means the comma you just pressed is trimmed away before
 * React re-renders, so the separator can never be entered at all. Splitting is
 * therefore deferred to blur, which is also when the value is persisted.
 */
function FreeTextRefs({
	values,
	onChange,
	onCommit,
	disabled,
	ariaLabel,
}: {
	values: string[];
	onChange: (refs: string[]) => void;
	onCommit?: (refs: string[]) => void;
	disabled?: boolean;
	ariaLabel: string;
}) {
	const [raw, setRaw] = useState(values.join(", "));

	return (
		<Input
			value={raw}
			onChange={(e) => {
				setRaw(e.target.value);
				onChange(splitRefs(e.target.value));
			}}
			onBlur={(e) => onCommit?.(splitRefs(e.target.value))}
			disabled={disabled}
			placeholder="—"
			aria-label={ariaLabel}
			className="h-7 w-[9rem] text-center text-xs"
		/>
	);
}

/**
 * Which acceptance criteria a case verifies — picked from the work item's real
 * criteria rather than typed from memory.
 *
 * This used to be a free-text box, which is why most cases went unmapped: a
 * person authoring a case had nothing to pick from and no way to know what the
 * parent's criteria even were, so the field stayed empty and the traceability
 * matrix reported the case as covering nothing.
 *
 * It then became a single-choice dropdown, which mapped the common case and
 * quietly capped it. Storage holds a LIST — a case proving criteria 1, 3 and 7
 * is counted under each — and AI-drafted cases were already arriving with
 * several. A person authoring by hand could name only one, so the majority
 * authoring path could not express what the minority path already produced, and
 * the matrix under-reported coverage the suite genuinely had. Hence checkboxes:
 * one criterion is still one press, and the second is now possible.
 *
 * Falls back to the free-text field when the parent has no parseable criteria —
 * a case can still record a ref against a spec written in a shape the parser
 * does not recognise, which is better than an empty menu with no way past it.
 */
export function AcRefPicker({
	projectId,
	organizationId,
	storyId,
	identifier,
	values,
	onChange,
	onCommit,
	disabled,
}: {
	projectId: string;
	organizationId: string | null;
	storyId: string;
	/** The work item's identifier, for the accessible name. */
	identifier: string;
	/** Bare refs as stored, e.g. `["2", "AC 5"]`. */
	values: string[];
	onChange: (refs: string[]) => void;
	/** Persist. Absent while creating a case, which has nothing to persist to. */
	onCommit?: (refs: string[]) => void;
	disabled?: boolean;
}) {
	const t = useTranslations("projects.testCases");

	// Shares react-query's cache with anything else reading this story.
	const { data, isPending } = useQuery({
		...orpc.projects.stories.get.queryOptions({
			input: { projectId, storyId, organizationId },
		}),
		staleTime: 60_000,
		retry: false,
	});

	const criteria = useMemo(
		() => parseAcceptanceCriteria(data?.story.acceptanceCriteria),
		[data?.story.acceptanceCriteria],
	);

	const ariaLabel = t("links.acRefAria", { identifier });

	// Match on the number a ref resolves to rather than on the string, so a case
	// linked before this picker existed — carrying "AC 3", "3" or "criterion 3" —
	// still shows its criterion as selected.
	const selectedNumbers = useMemo(() => {
		const known = new Set(criteria.map((c) => String(c.index)));
		return new Set(
			values
				.map(refNumber)
				.filter((n): n is string => n !== null && known.has(n)),
		);
	}, [values, criteria]);

	// Refs that name no criterion the spec still has. Kept rather than dropped:
	// silently discarding one on the next edit would erase the record that
	// somebody had mapped this case at all.
	const staleRefs = useMemo(() => {
		const known = new Set(criteria.map((c) => String(c.index)));
		return values.filter((ref) => {
			const n = refNumber(ref);
			return n === null || !known.has(n);
		});
	}, [values, criteria]);

	// Distinguished from "no criteria": swapping an editable input for a menu
	// while someone is mid-edit drops the change, because only the input commits
	// on blur.
	if (isPending) {
		return (
			<Input
				value={values.join(", ")}
				readOnly
				disabled
				aria-label={ariaLabel}
				className="h-7 w-[9rem] text-center text-xs"
			/>
		);
	}

	if (criteria.length === 0) {
		return (
			<FreeTextRefs
				values={values}
				onChange={onChange}
				onCommit={onCommit}
				disabled={disabled}
				ariaLabel={ariaLabel}
			/>
		);
	}

	/** Toggling writes bare numbers; stale refs ride along untouched. */
	const toggle = (index: number, checked: boolean) => {
		const n = String(index);
		const next = checked
			? [...selectedNumbers, n]
			: [...selectedNumbers].filter((v) => v !== n);
		// Numeric order, so "1, 3, 7" reads the way the spec does rather than in
		// the order somebody happened to tick the boxes.
		const refs = [
			...next.sort((a, b) => Number(a) - Number(b)),
			...staleRefs,
		];
		onChange(refs);
		onCommit?.(refs);
	};

	const label =
		selectedNumbers.size === 0 && staleRefs.length === 0
			? t("links.acNone")
			: [...selectedNumbers]
					.sort((a, b) => Number(a) - Number(b))
					.map((n) => `AC ${n}`)
					.concat(staleRefs.length > 0 ? ["…"] : [])
					.join(", ");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={disabled}
					aria-label={ariaLabel}
					className="h-7 w-[9rem] justify-between px-2 font-normal text-xs"
				>
					<span className="truncate">{label}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-w-[22rem]">
				{criteria.map((criterion) => (
					<DropdownMenuCheckboxItem
						key={criterion.index}
						checked={selectedNumbers.has(String(criterion.index))}
						// Radix closes the menu on select by default, which makes
						// picking a second criterion a second trip through the
						// trigger — the exact thing this control exists to allow.
						onSelect={(event) => event.preventDefault()}
						onCheckedChange={(checked) =>
							toggle(criterion.index, checked === true)
						}
					>
						{t("links.acOption", {
							index: criterion.index,
							text: truncate(
								criterionDisplayText(criterion.text),
							),
						})}
					</DropdownMenuCheckboxItem>
				))}
				{staleRefs.length > 0 && (
					<>
						<DropdownMenuSeparator />
						{/* A ref the spec no longer has a criterion for. Shown rather
						    than collapsed into "not linked", which reads exactly like
						    a case nobody ever mapped and hides that a reference
						    existed. Disabled: it cannot be re-picked, only cleared by
						    editing the spec back. */}
						{staleRefs.map((ref) => (
							<DropdownMenuCheckboxItem
								key={ref}
								checked
								disabled
								onSelect={(event) => event.preventDefault()}
							>
								{t("links.acStale", { ref })}
							</DropdownMenuCheckboxItem>
						))}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
