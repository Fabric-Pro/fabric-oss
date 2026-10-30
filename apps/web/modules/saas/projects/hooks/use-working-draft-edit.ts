"use client";

import { useState } from "react";

/** Keep the version the user edited against, even when polling replaces the saved draft. */
export function useWorkingDraftEdit(
	working: {
		body: string;
		updatedAt: string | Date;
	} | null,
) {
	const [edit, setEdit] = useState<{
		body: string;
		baseline: Date | null;
	} | null>(null);
	const setEditedBody = (body: string | null) => {
		if (body === null || body === (working?.body ?? "")) {
			setEdit(null);
			return;
		}
		setEdit((previous) => ({
			body,
			baseline:
				previous?.baseline ??
				(working ? new Date(working.updatedAt) : null),
		}));
	};
	return {
		editedBody: edit?.body ?? null,
		setEditedBody,
		expectedUpdatedAt: edit
			? edit.baseline
			: working
				? new Date(working.updatedAt)
				: null,
		savedDraftChanged:
			edit !== null &&
			edit.baseline?.getTime() !==
				(working ? new Date(working.updatedAt).getTime() : undefined),
	};
}
