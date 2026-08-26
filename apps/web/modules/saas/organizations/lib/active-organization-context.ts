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
