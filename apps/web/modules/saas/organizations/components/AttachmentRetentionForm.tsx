"use client";

import {
	MAX_ATTACHMENT_RETENTION_DAYS,
	MIN_ATTACHMENT_RETENTION_DAYS,
	parseRetentionDaysInput,
} from "@repo/utils/attachment";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { AlertCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const TITLE = "Attachment retention";
const DESCRIPTION =
	"How long attachments removed from a story are kept before they are permanently deleted";

const queryKeyFor = (organizationId: string) =>
	["organizationAttachmentRetention", organizationId] as const;

/**
 * Org-wide default retention window for removed attachments (Fizzy #1749).
 *
 * Projects inherit this unless they set their own window. The value is
 * committed on blur, and deliberately NOT clamped on the way out: an
 * out-of-range entry is sent verbatim so the server — the single validation
 * authority — rejects it and the operator sees why, rather than the browser
 * quietly rewriting what they typed. The project settings form has no clamp
 * either, and the two must not disagree.
 *
 * The placeholder renders the server-supplied `effectiveDefault`; the browser
 * never holds its own copy of the policy default.
 */
export function AttachmentRetentionForm() {
	const queryClient = useQueryClient();
	const { activeOrganization } = useActiveOrganization();
	const organizationId = activeOrganization?.id;

	const { data, isLoading, error } = useQuery({
		queryKey: queryKeyFor(organizationId ?? ""),
		queryFn: async () =>
			orpcClient.organizations.attachmentRetention.get({
				organizationId: organizationId as string,
			}),
		enabled: !!organizationId,
		retry: 1,
	});

	const [value, setValue] = useState<string>("");
	// Read at commit time rather than remembered from onChange: `validity` is
	// live state on the element, and the whole failure mode here is a value that
	// does not describe the entry.
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setValue(data?.attachmentRetentionDays?.toString() ?? "");
	}, [data?.attachmentRetentionDays]);

	const updateMutation = useMutation({
		mutationFn: async (attachmentRetentionDays: number | null) =>
			orpcClient.organizations.attachmentRetention.update({
				organizationId: organizationId as string,
				attachmentRetentionDays,
			}),
		onSuccess: (result) => {
			toast.success(
				result.attachmentRetentionDays === null
					? "Attachment retention now follows the server default"
					: `Attachments are now kept for ${result.attachmentRetentionDays} days after removal`,
				{
					description:
						"The new window applies to already-removed attachments after a 7-day grace period. Deletion cannot be undone.",
				},
			);
			if (organizationId) {
				queryClient.invalidateQueries({
					queryKey: queryKeyFor(organizationId),
				});
			}
		},
		onError: (err) => {
			toast.error(
				err instanceof Error
					? err.message
					: "Failed to update the attachment retention window",
			);
		},
	});

	if (isLoading) {
		return (
			<SettingsItem title={TITLE} description={DESCRIPTION}>
				<div className="text-muted-foreground text-sm">Loading...</div>
			</SettingsItem>
		);
	}

	if (error) {
		return (
			<SettingsItem title={TITLE} description={DESCRIPTION}>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" />
					<span>Failed to load the attachment retention window</span>
				</div>
			</SettingsItem>
		);
	}

	const commit = () => {
		// Send what the user typed. Do NOT clamp AND do not round: an unusable
		// value is a caller error that should surface as one, and silently
		// rewriting 10 to 30 — or 30.5 to 31 — would disagree with the project
		// form, which sends verbatim. The server rejects (`.int()`, `.min()`,
		// `.max()`) and the error reaches a toast.
		//
		// `undefined` means the entry cannot be sent. Two ways to get there, and
		// both end in the same silent data loss, because `null` on this wire
		// means "clear the override": NaN and Infinity serialize to null, and a
		// number input whose entry it could not parse reports `value === ""`
		// while still showing the text — so a blank that means "I typed
		// something unusable" is indistinguishable from one that means "inherit"
		// unless `badInput` is consulted. Hold the field and say so; wiping a
		// configured window under a success toast is the worst available
		// outcome, and it also re-arms the 7-day grace floor.
		const next = parseRetentionDaysInput(value, {
			badInput: inputRef.current?.validity.badInput,
		});
		if (next === undefined) {
			toast.error(
				"Attachment retention must be a number of days, or blank to inherit.",
			);
			return;
		}
		if (next === (data?.attachmentRetentionDays ?? null)) {
			return;
		}
		updateMutation.mutate(next);
	};

	return (
		<SettingsItem title={TITLE} description={DESCRIPTION}>
			<div className="space-y-2">
				<Label htmlFor="organization-attachment-retention">
					Attachment retention (days)
				</Label>
				<Input
					ref={inputRef}
					id="organization-attachment-retention"
					type="number"
					inputMode="numeric"
					min={MIN_ATTACHMENT_RETENTION_DAYS}
					max={MAX_ATTACHMENT_RETENTION_DAYS}
					value={value}
					disabled={updateMutation.isPending || !organizationId}
					placeholder={
						data ? String(data.effectiveDefault) : "Default"
					}
					onChange={(e) => setValue(e.target.value)}
					onBlur={commit}
				/>
				<p className="text-muted-foreground text-xs">
					Applies to every project that does not set its own window.
					Leave blank to use the server default. A change takes effect
					on already-removed attachments after a 7-day grace period,
					and deletion cannot be undone.
				</p>
			</div>
		</SettingsItem>
	);
}
