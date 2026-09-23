"use client";

/**
 * Why a Roadmap action is disabled, in words (Fizzy #2204, #2208; AC-14,
 * AC-20).
 *
 * A gate's title and body are always separate elements, never one joined
 * sentence, so the body reads exactly as approved (FR37).
 *
 * `EntryPointReasonGuard` is for toolbar buttons: a natively disabled button
 * leaves the tab order and its tooltip with it, so a blocked action is
 * `aria-disabled` instead, stays focusable, and points `aria-describedby` at
 * a screen-reader copy of the reason that is always in the DOM.
 */

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactElement, type ReactNode, useId } from "react";
import type { CapabilityGateView } from "../../../lib/capability-gate-view";
import { useCapabilityGates } from "../../capability-gates/useCapabilityGates";
import type { EntryPointReason } from "./entry-point-states";

type GateLinkTarget = Parameters<
	ReturnType<typeof useCapabilityGates>["linkFor"]
>[0];

interface ReasonCopy {
	/** A gate's headline; null for the one-sentence reasons. */
	title: string | null;
	body: string;
	action: { label: string; target: GateLinkTarget } | null;
}

function useEntryPointReasonCopy(reason: EntryPointReason): ReasonCopy {
	const t = useTranslations("projects.stories.startBuilding.reason");
	const tRecommend = useTranslations("projects.recommendations");
	const tGates = useTranslations("projects.capabilityGates");

	switch (reason.kind) {
		case "permission":
			return { title: null, body: t("permission"), action: null };
		case "running":
			return { title: null, body: t("running"), action: null };
		case "recommending":
			return { title: null, body: tRecommend("running"), action: null };
		case "not-connected":
			return {
				title: null,
				body: t("notConnected"),
				action: {
					label: t("notConnectedAction"),
					target: "integrations",
				},
			};
		case "gate": {
			const { view } = reason;
			return {
				title: tGates(view.title),
				body: tGates(view.body, view.params),
				action:
					view.ctaKind === "navigate" &&
					view.ctaTarget &&
					view.ctaLabel
						? {
								label: tGates(view.ctaLabel),
								target: view.ctaTarget,
							}
						: null,
			};
		}
	}
}

/** The reason as text, plus its fix as a link when there is one. */
export function EntryPointReasonText({
	reason,
	id,
	className,
	withAction = true,
}: {
	reason: EntryPointReason;
	id?: string;
	className?: string;
	/** False where a link could not be reached (a tooltip, a hidden copy). */
	withAction?: boolean;
}) {
	const { title, body, action } = useEntryPointReasonCopy(reason);
	const { linkFor } = useCapabilityGates();
	const link = withAction && action ? linkFor(action.target) : null;

	return (
		<span
			id={id}
			className={cn("block text-muted-foreground text-xs", className)}
		>
			{title && (
				<span className="block font-medium text-foreground">
					{title}
				</span>
			)}
			<span className="block">{body}</span>
			{action && link && (
				<span className="block">
					{"href" in link ? (
						<Link
							href={link.href}
							className="font-medium text-primary underline underline-offset-2"
						>
							{action.label}
						</Link>
					) : (
						<button
							type="button"
							onClick={link.onSelect}
							className="font-medium text-primary underline underline-offset-2"
						>
							{action.label}
						</button>
					)}
				</span>
			)}
		</span>
	);
}

/** Props a guarded button spreads onto itself. */
interface ReasonGuardProps {
	"aria-disabled"?: true;
	"aria-describedby"?: string;
}

/**
 * A toolbar action that explains itself when it cannot run.
 *
 * The caller still owns its button and must skip its own handler while
 * `reason` is set; the guard only supplies the accessible wiring and the
 * tooltip.
 */
export function EntryPointReasonGuard({
	reason,
	hint,
	children,
}: {
	reason: EntryPointReason | null;
	/** The tooltip while the action is available. */
	hint?: ReactNode;
	children: (guard: ReasonGuardProps) => ReactElement;
}) {
	const reasonId = useId();
	const guard: ReasonGuardProps = reason
		? { "aria-disabled": true, "aria-describedby": reasonId }
		: {};
	const button = children(guard);

	return (
		<>
			{reason || hint ? (
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent className="max-w-xs">
						{reason ? (
							<EntryPointReasonText
								reason={reason}
								withAction={false}
							/>
						) : (
							hint
						)}
					</TooltipContent>
				</Tooltip>
			) : (
				button
			)}
			{reason && (
				<EntryPointReasonText
					id={reasonId}
					reason={reason}
					withAction={false}
					className="sr-only"
				/>
			)}
		</>
	);
}

/**
 * A gate's title and body as two lines, for a menu item that is blocked.
 * Plain text only: a menu item cannot hold another control.
 */
export function GateReasonLines({ view }: { view: CapabilityGateView }) {
	const tGates = useTranslations("projects.capabilityGates");
	return (
		<>
			<span className="block text-muted-foreground text-xs">
				{tGates(view.title)}
			</span>
			<span className="block text-muted-foreground text-xs">
				{tGates(view.body, view.params)}
			</span>
		</>
	);
}
