"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { ChevronDownIcon, PlayIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FocusEvent, useEffect, useRef } from "react";
import {
	requestTimerOpen,
	type TimerStartValues,
	useTimer,
	useTimerActions,
} from "../hooks/use-timer";
import { TimerDot } from "./TimerDot";

/**
 * Start a timer on what the page is about. While one already runs it reads
 * "Timer running" instead and offers to open it or, when it times something
 * else, to stop it (through the widget's stop questions) and start this one.
 */
export function StartTimerButton({
	organizationId,
	values,
	size = "default",
	"data-onboarding-target": onboardingTarget,
}: {
	organizationId: string;
	/** What the timer runs on; `null` while the page has no project for it. */
	values: TimerStartValues | null;
	size?: "default" | "sm";
	"data-onboarding-target"?: string;
}) {
	const t = useTranslations("timeTracking.timer");
	const { timer } = useTimer(organizationId);
	const actions = useTimerActions(organizationId);
	const focus = useFocusAcrossSwap(timer !== null);
	const openedPanel = useRef(false);

	if (timer) {
		const timesSomethingElse =
			values !== null &&
			(values.projectId !== timer.projectId ||
				(values.story?.id ?? null) !== timer.storyId);
		return (
			<DropdownMenu>
				<DropdownMenuTrigger asChild ref={focus.ref}>
					<Button
						type="button"
						variant="outline"
						size={size}
						data-onboarding-target={onboardingTarget}
						onFocus={focus.onFocus}
						onBlur={focus.onBlur}
					>
						<TimerDot
							state={
								timer.status === "PAUSED" ? "paused" : "running"
							}
						/>
						{timer.status === "PAUSED"
							? t("pausedButton")
							: t("runningButton")}
						<ChevronDownIcon aria-hidden="true" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					// An item opens the timer's panel, which takes focus. Handing
					// focus back to this trigger then would count as a click
					// outside the panel and close it again. Closed any other way
					// (Escape, a click away), the menu returns focus as usual.
					onCloseAutoFocus={(event) => {
						if (openedPanel.current) {
							event.preventDefault();
							openedPanel.current = false;
						}
					}}
				>
					<DropdownMenuItem
						onSelect={() => {
							openedPanel.current = true;
							requestTimerOpen();
						}}
					>
						{t("openTimer")}
					</DropdownMenuItem>
					{values && timesSomethingElse ? (
						<DropdownMenuItem
							onSelect={() => {
								openedPanel.current = true;
								requestTimerOpen({ startNext: values });
							}}
						>
							{t("switchHere")}
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		);
	}

	return (
		<Button
			ref={focus.ref}
			type="button"
			variant="outline"
			size={size}
			disabled={values === null}
			loading={actions.isStarting}
			onClick={() => {
				if (values) {
					focus.keep();
					void actions.start(values);
				}
			}}
			onFocus={focus.onFocus}
			onBlur={focus.onBlur}
			data-onboarding-target={onboardingTarget}
		>
			<PlayIcon aria-hidden="true" />
			{t("start")}
		</Button>
	);
}

/**
 * Starting or ending the timer swaps Start for "Timer running" and back, and
 * the button that held focus leaves the page with it. When it was the last
 * thing focused here (or Start was just pressed) and focus has fallen to the
 * page body, the replacement takes it. Focus that moved somewhere else stays
 * there.
 *
 * A blur with no new target is not counted as leaving: a removed or disabled
 * button, or a switch to another window, blurs that way too.
 */
function useFocusAcrossSwap(swapKey: boolean) {
	const ref = useRef<HTMLButtonElement>(null);
	const held = useRef(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs on each swap.
	useEffect(() => {
		const active = document.activeElement;
		if (held.current && (active === null || active === document.body)) {
			ref.current?.focus();
		}
	}, [swapKey]);

	return {
		ref,
		keep: () => {
			held.current = true;
		},
		onFocus: () => {
			held.current = true;
		},
		onBlur: (event: FocusEvent<HTMLButtonElement>) => {
			if (event.relatedTarget !== null) {
				held.current = false;
			}
		},
	};
}
