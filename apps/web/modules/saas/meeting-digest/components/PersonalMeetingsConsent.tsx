"use client";

/**
 * Opt-in gate and privacy disclosure for personal meetings (#1899, FR2/FR3/FR6).
 *
 * Consent lives in sessionStorage, not the database. That is a privacy
 * decision, not a shortcut: a persisted preference would auto-load personal
 * calendar data on every visit, including on a shared or unattended screen, and
 * would create a durable record of the user's privacy choice. Re-consenting
 * each session is the intended behavior.
 *
 * Copy below is DRAFT pending PM/legal sign-off (tracked as an open question in
 * the design doc). The three FR3 disclosures are load-bearing — do not soften
 * them without re-reading the ticket.
 */
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { useCallback, useEffect, useId, useState } from "react";
import { purgeProject } from "../lib/personal-insights-cache";

export function personalConsentStorageKey(projectId: string): string {
	return `meeting-digest-personal:${projectId}`;
}

export function personalCacheConsentStorageKey(
	userId: string,
	projectId: string,
): string {
	return `meeting-digest-personal-cache:${userId}:${projectId}`;
}

/**
 * Opt-in to caching personal meeting summaries on this device (#2104).
 *
 * Unlike the personal-meetings consent below, this preference lives in
 * localStorage: a cache that survives reload is pointless if the preference
 * authorising it does not. That difference is exactly why this is a SECOND,
 * separate opt-in rather than a reuse of the first — the session-scoped consent
 * promises that nothing is stored, and folding device caching into the same
 * click would be consent by ambiguity.
 *
 * Keyed per user as well as per project: localStorage outlives a session, so
 * two Fabric accounts sharing a browser must not inherit each other's choice.
 *
 * Turning it off purges immediately. The invariant is that cached personal data
 * never outlives the consent that created it.
 */
export function usePersonalInsightsCacheConsent(
	userId: string,
	projectId: string,
) {
	const [cacheEnabled, setCacheEnabled] = useState(false);

	useEffect(() => {
		try {
			setCacheEnabled(
				localStorage.getItem(
					personalCacheConsentStorageKey(userId, projectId),
				) === "true",
			);
		} catch {
			// Private browsing / storage disabled: stay opted out.
			setCacheEnabled(false);
		}
	}, [userId, projectId]);

	const enableCache = useCallback(() => {
		try {
			localStorage.setItem(
				personalCacheConsentStorageKey(userId, projectId),
				"true",
			);
		} catch {
			// Same reasoning as the consent hook below: the user just clicked
			// the button, and failing to record it only means the preference
			// reverts to off later — strictly more private, not less.
		}
		setCacheEnabled(true);
	}, [userId, projectId]);

	const disableCache = useCallback(() => {
		try {
			localStorage.removeItem(
				personalCacheConsentStorageKey(userId, projectId),
			);
		} catch {
			// Nothing to clean up if storage is unavailable.
		}
		// Erase, don't merely stop reading.
		purgeProject(userId, projectId);
		setCacheEnabled(false);
	}, [userId, projectId]);

	return { cacheEnabled, enableCache, disableCache };
}

/**
 * Session-scoped consent state.
 *
 * Reads sessionStorage in an effect rather than during render: the digest is
 * rendered on the server first, where sessionStorage does not exist, and
 * seeding state from it directly would desynchronize hydration. Defaulting to
 * `false` also means the fail-safe direction is "off" (FR2).
 */
export function usePersonalMeetingsConsent(projectId: string) {
	const [consented, setConsented] = useState(false);

	useEffect(() => {
		try {
			setConsented(
				sessionStorage.getItem(personalConsentStorageKey(projectId)) ===
					"true",
			);
		} catch {
			// Private browsing / storage disabled: stay opted out.
			setConsented(false);
		}
	}, [projectId]);

	const enable = useCallback(() => {
		try {
			sessionStorage.setItem(
				personalConsentStorageKey(projectId),
				"true",
			);
		} catch {
			// Deliberate: consent still applies for this session even though we
			// could not record it. This looks like it violates the "fail safe
			// to OFF" rule, and does not — that rule exists to stop us opting
			// someone in WITHOUT consent, and here the user just clicked the
			// button. Failing to persist only means the next visit starts
			// opted out again, which is strictly more private, not less.
			// Blocking instead would make the feature unusable in private
			// browsing while protecting nobody from anything. Do not "fix"
			// this into an early return.
		}
		setConsented(true);
	}, [projectId]);

	const disable = useCallback(() => {
		try {
			sessionStorage.removeItem(personalConsentStorageKey(projectId));
		} catch {
			// Nothing to clean up if storage is unavailable.
		}
		setConsented(false);
	}, [projectId]);

	return { consented, enable, disable };
}

export function PersonalMeetingsConsent({
	consented,
	onEnable,
	onDisable,
	cacheEnabled = false,
	onToggleCache = () => {},
	showCacheToggle = false,
	importEnabled = false,
}: {
	consented: boolean;
	onEnable: () => void;
	onDisable: () => void;
	cacheEnabled?: boolean;
	onToggleCache?: () => void;
	showCacheToggle?: boolean;
	/**
	 * #2170. Whether this user can add a personal meeting to the project.
	 *
	 * It changes the COPY, not the behaviour, because it changes what is true:
	 * with it off Fabric stores nothing here and the absolute promise below
	 * stands; with it on the user can store a meeting themselves, and a promise
	 * that "nothing is saved to our database" would be a sentence they could
	 * act against on the very next screen. Defaults to false so the strongest
	 * claim is what renders unless a caller says otherwise.
	 */
	importEnabled?: boolean;
}) {
	const disclosureId = useId();
	const cacheDisclosureId = useId();

	if (consented) {
		// <section> rather than a div with role="region": it carries that role
		// implicitly once it has an accessible name, and biome's
		// a11y/useSemanticElements rule warns on the explicit form.
		return (
			<section
				aria-label="Personal meetings"
				className="space-y-2 rounded border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
			>
				<div className="flex items-center justify-between gap-3">
					{/*
					 * Narrowed twice, for the same reason each time: the sentence
					 * has to keep pace with what a user can actually do.
					 *
					 * #2104 scoped it to transcripts, because "…and are never
					 * stored" stopped being true once summaries could be cached
					 * on the device. #2170 qualifies the transcript claim itself,
					 * because importing genuinely stores the transcript and
					 * genuinely shares it with the project. What survives in both
					 * cases is the real guarantee: Fabric does not store these on
					 * its own.
					 */}
					<span>
						{importEnabled
							? "Personal meetings are visible only to you, and their transcripts are never stored — unless you add one to the project yourself."
							: "Personal meetings are visible only to you. Their transcripts are never stored."}
					</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={onDisable}
					>
						Turn off
					</Button>
				</div>

				{showCacheToggle && (
					<div className="flex items-center justify-between gap-3 border-t pt-2">
						<span id={cacheDisclosureId}>
							{cacheEnabled
								? "Summaries are saved in this browser so re-opening a meeting is instant. They never leave your device, and are removed when you turn this off or sign out."
								: "Save summaries in this browser so re-opening a meeting is instant. They stay on your device and are never sent to Fabric."}
						</span>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={onToggleCache}
							aria-describedby={cacheDisclosureId}
						>
							{cacheEnabled
								? "Forget summaries"
								: "Remember summaries"}
						</Button>
					</div>
				)}
			</section>
		);
	}

	return (
		<Alert role="region" aria-label="Personal meetings">
			<AlertTitle>Show your personal meetings</AlertTitle>
			<AlertDescription>
				{/*
				 * Two versions of the same promise, and the difference is who is
				 * doing the storing. Without the import feature Fabric stores
				 * nothing, full stop. With it, the honest claim is that Fabric
				 * still stores nothing by itself — and that the user can choose
				 * otherwise for a specific meeting. Stating the exception here
				 * rather than only in the import dialog matters: this is the
				 * screen where someone decides how much to trust the surface.
				 */}
				<p id={disclosureId} className="mb-3">
					{importEnabled
						? "Personal meetings are fetched from your Microsoft calendar each time you view them. Fabric never stores them on its own, and no one else on this project — including admins — can see them or their content. The one exception is if you add a meeting to the project yourself: that stores its transcript in Fabric and shares it with everyone who has access to the project."
						: "Personal meetings are fetched from your Microsoft calendar each time you view them. Their transcripts are never stored in Fabric — nothing is saved to our database. Only you can see them; no one else on this project, including admins, can see your personal meetings or their content."}
				</p>
				<Button
					type="button"
					size="sm"
					onClick={onEnable}
					aria-describedby={disclosureId}
				>
					Enable personal meetings
				</Button>
			</AlertDescription>
		</Alert>
	);
}
