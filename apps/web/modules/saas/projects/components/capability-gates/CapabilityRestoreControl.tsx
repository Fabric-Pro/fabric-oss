"use client";

/**
 * The way back from a dismissed warning (Fizzy #1930, FR32 / AC-8).
 *
 * Dismissal is otherwise one-way. "Hide for this project" has no expiry, and
 * the only thing that brings such a warning back on its own is the underlying
 * dependency changing — which is not an action the person can take, or even
 * know is available to them. Without this control a single click permanently
 * removes an explanation, and the person who wants it back has nowhere to go.
 *
 * ## Why it is scoped by capability key rather than by surface
 *
 * The obvious shape would be `<CapabilityRestoreControl surface="documents" />`.
 * The gate payload does not carry a surface: `CapabilityRule.surface` exists
 * server-side and filters the query, but `gateSchema` in the read procedure
 * does not declare it, so oRPC strips it on the way out. Deriving one from the
 * capability key's prefix would work by coincidence today — `security.run-scan`
 * lives on the `security` surface but reports `scan.*` reasons — and would be
 * wrong the first time a rule is named against that pattern.
 *
 * So the host names the capabilities it covers, which it already does to render
 * the banners in the first place. Omitting the prop restores everything on the
 * project, which is the right behaviour for a single global placement.
 */

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { EyeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { type RestoreTarget, useCapabilityGates } from "./useCapabilityGates";

/** How long the restored confirmation stays in the live region. */
const CONFIRMATION_MS = 5_000;

export function CapabilityRestoreControl({
	capabilityKeys,
	className,
}: {
	/** Limit to these capabilities. Omit to cover the whole project. */
	capabilityKeys?: readonly string[];
	className?: string;
}) {
	const t = useTranslations("projects.capabilityGates");
	const { gates, restore, isSessionDismissed } = useCapabilityGates();
	const countId = useId();

	const scope = capabilityKeys ? new Set(capabilityKeys) : null;
	const targets: RestoreTarget[] = [];
	for (const gate of gates.values()) {
		// Dismissed for a duration (stored) or for this session (not stored) —
		// one control brings both back.
		const dismissed = gate.suppressed || isSessionDismissed(gate);
		if (!dismissed || gate.reasonKey === null) {
			continue;
		}
		if (scope && !scope.has(gate.capabilityKey)) {
			continue;
		}
		targets.push({
			capabilityKey: gate.capabilityKey,
			reasonKey: gate.reasonKey,
		});
	}
	const count = targets.length;

	/**
	 * Announce only once the warnings are actually back.
	 *
	 * Set on click and resolved by the count dropping, rather than announcing
	 * optimistically — a restore that failed would otherwise tell a screen-reader
	 * user it had worked while the warnings stayed hidden.
	 */
	const pending = useRef(false);
	const [confirmed, setConfirmed] = useState(false);

	useEffect(() => {
		if (pending.current && count === 0) {
			pending.current = false;
			setConfirmed(true);
		}
	}, [count]);

	useEffect(() => {
		if (!confirmed) {
			return;
		}
		const timer = setTimeout(() => setConfirmed(false), CONFIRMATION_MS);
		return () => clearTimeout(timer);
	}, [confirmed]);

	// Nothing dismissed and nothing just restored: render nothing at all. Not an
	// empty wrapper — one with padding is how "renders nothing" quietly stops
	// being pixel-identical.
	if (count === 0 && !confirmed) {
		return null;
	}

	return (
		<div className={cn("flex items-center gap-2", className)}>
			{count > 0 && (
				<>
					<Button
						type="button"
						size="sm"
						variant="link"
						className="h-auto p-0"
						aria-describedby={countId}
						autoLoading={false}
						onClick={() => {
							pending.current = true;
							restore(capabilityKeys ? targets : undefined);
						}}
					>
						<EyeIcon aria-hidden="true" />
						{t("restore.action")}
					</Button>
					<span
						id={countId}
						className="text-muted-foreground text-xs"
					>
						{t("restore.count", { count })}
					</span>
				</>
			)}
			{/*
			 * Mounted while the control is, so the confirmation lands in a live
			 * region that already existed. A region inserted together with its
			 * own text is announced unreliably, which is the usual way this
			 * pattern is written and the usual reason it stays silent.
			 */}
			<span aria-live="polite" className="sr-only">
				{confirmed ? t("restore.done") : ""}
			</span>
		</div>
	);
}
