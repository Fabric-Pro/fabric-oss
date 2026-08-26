"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { useTranslations } from "next-intl";

type Props = {
	/** Start the guided tour. */
	onStartTour: () => void;
	/**
	 * Close without starting the tour. Deliberately writes nothing: the sidebar
	 * badge is gated on the tour status still being untouched, so declining here
	 * is exactly what keeps the standing pointer in place.
	 */
	onDismiss: () => void;
};

/**
 * The first moment a new account sees. One centred choice — take the tour, or
 * go it alone — instead of the area-listing drawer that used to open here,
 * where the tour button sat in a footer below everything else.
 *
 * Purely presentational: it owns no onboarding state and reads no query. The
 * controller decides when it is mounted and what each action does, which is why
 * the one-shot behaviour needs no new flag — the existing first-login marker
 * already records that this surface has fired.
 */
export function GetStartedWelcomeDialog({ onStartTour, onDismiss }: Props) {
	const t = useTranslations();

	return (
		<Dialog
			open
			onOpenChange={(next) => {
				// Esc / outside click resolves to declining, not to starting a
				// tour the user never asked for.
				if (!next) {
					onDismiss();
				}
			}}
		>
			<DialogContent className="sm:max-w-[420px]">
				<DialogHeader>
					<DialogTitle>
						{t("onboarding.tour.welcome.title")}
					</DialogTitle>
					<DialogDescription>
						{t("onboarding.tour.welcome.body")}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="sm:justify-between">
					<Button type="button" variant="ghost" onClick={onDismiss}>
						{t("onboarding.tour.welcome.dismiss")}
					</Button>
					<Button type="button" onClick={onStartTour}>
						{t("onboarding.tour.welcome.start")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
