"use client";

import type { ActiveOrganization } from "@repo/auth";
import React from "react";

export const ActiveOrganizationContext = React.createContext<
	| {
			activeOrganization: ActiveOrganization | null;
			activeOrganizationUserRole:
				| ActiveOrganization["members"][number]["role"]
				| null;
			isOrganizationAdmin: boolean;
			loaded: boolean;
			/** True only while the FIRST fetch of the organization named by the
			 * URL is in flight. Distinguishes "not resolved yet" from "there is
			 * no organization" — both of which leave `activeOrganization` null.
			 *
			 * Deliberately not `loaded`, which never flips back once the query
			 * fails and would strand a caller that gates on it. This follows the
			 * query's own `isLoading`, so a failure falls through to whatever the
			 * caller renders without it rather than waiting forever. */
			isResolvingOrganization: boolean;
			/** True while a workspace switch is in flight (until the new
			 * workspace's route commits). Drives the switcher's inline
			 * loading state. */
			isSwitching: boolean;
			/** Target of the in-flight switch: an org slug, or `null` for the
			 * personal workspace. Only meaningful when `isSwitching` is true. */
			switchingToSlug: string | null;
			setActiveOrganization: (
				organizationId: string | null,
			) => Promise<void>;
			refetchActiveOrganization: () => Promise<void>;
	  }
	| undefined
>(undefined);
