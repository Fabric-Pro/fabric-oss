"use client";

/**
 * Who an org-scopable flag is actually on for.
 *
 * Enrolment is stored one row per organization and was edited one organization
 * at a time on `admin/organizations/{id}`, so the allowlist existed without
 * ever being readable as a list — an operator holding a rollout had to
 * remember who was on it. This is the missing direction of that read.
 *
 * The counts load with the panel rather than on expand: "how many
 * organizations have this" is the question an operator scanning the page is
 * asking, and hiding it behind a click would make the common case the
 * expensive one. The list itself is the detail, and it is bounded server-side.
 */
import { useAdminPath } from "@saas/admin/lib/links";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

export function FlagEnrolmentDisclosure({ flagKey }: { flagKey: string }) {
	const adminPath = useAdminPath();
	const [open, setOpen] = useState(false);
	const listId = useId();

	const { data, isLoading, isError } = useQuery(
		orpc.admin.featureFlags.organizations.queryOptions({
			input: { key: flagKey },
		}),
	);

	if (isLoading) {
		return (
			<p className="text-muted-foreground text-xs">
				Checking per-organization overrides…
			</p>
		);
	}

	// Say so rather than rendering "0 · 0". An unreadable table and an empty
	// allowlist look identical in the counts, and only one of them means the
	// operator can safely conclude nobody is enrolled.
	if (isError || !data) {
		return (
			<p className="text-destructive text-xs">
				Couldn't read the per-organization overrides for this flag.
			</p>
		);
	}

	const total = data.enabledCount + data.excludedCount;

	if (total === 0) {
		return (
			<p className="text-muted-foreground text-xs">
				No organization overrides — every organization inherits the
				value above.
			</p>
		);
	}

	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => setOpen((wasOpen) => !wasOpen)}
				aria-expanded={open}
				aria-controls={listId}
				className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
			>
				{open ? (
					<ChevronDownIcon aria-hidden="true" className="size-3" />
				) : (
					<ChevronRightIcon aria-hidden="true" className="size-3" />
				)}
				<span>
					Enrolled: {data.enabledCount} · Excluded:{" "}
					{data.excludedCount}
				</span>
			</button>

			{/* `hidden` rather than unmounting: the list is already fetched, and
			 * collapsing it should not make re-expanding it look like a load. */}
			<div id={listId} hidden={!open} className="mt-2 space-y-1">
				{data.organizations.map((organization) => (
					<div
						key={organization.organizationId}
						className="flex items-center gap-2"
					>
						<span
							aria-hidden="true"
							className={
								organization.enabled
									? "size-1.5 shrink-0 rounded-full bg-secondary"
									: "size-1.5 shrink-0 rounded-full bg-destructive"
							}
						/>
						<Link
							href={adminPath(
								`/organizations/${organization.organizationId}`,
							)}
							className="text-foreground underline-offset-2 hover:underline"
						>
							{organization.name}
						</Link>
						<span className="text-muted-foreground">
							{organization.enabled ? "Enabled" : "Disabled"}
						</span>
					</div>
				))}

				{data.truncated && (
					<p className="text-muted-foreground">
						{/* One expression rather than text split across lines.
						 * JSX does strip a leading newline, so the sentence
						 * renders correctly either way — but a full stop
						 * sitting at the start of a line is one reflow away
						 * from becoming "of 901 . Open", and nothing about the
						 * markup would warn you. Pinned by the exact-text
						 * assertion in this component's test. */}
						{`Showing the first ${data.organizations.length} of ${total}. Open an organization's page to change its value.`}
					</p>
				)}

				{/* The third state is the majority and has no row, so it can
				 * never appear above. Saying so is the difference between "not
				 * listed" and "excluded", which the counts alone do not convey. */}
				<p className="pt-1 text-muted-foreground">
					Every other organization inherits the deployment-wide value.
				</p>
			</div>
		</div>
	);
}
