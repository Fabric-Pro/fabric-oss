"use client";

import { Badge } from "@ui/components/badge";
import { InfoIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

type Props = {
	/** The project's Roadmap tab (`?tab=stories`), built the way the caller builds its other project links. */
	roadmapHref: string;
	/** Put on the message itself, so a control can point `aria-describedby` at the copy without the link text. */
	messageId?: string;
	/** Runs before navigating, e.g. to close the dialog the notice sits in. */
	onNavigate?: () => void;
};

/**
 * The one place the Features deprecation message renders: where a Features
 * document is chosen for creation, and on an existing one.
 *
 * Persistent inline text, never a toast: it explains why the type is marked,
 * so it has to be there whenever the type is. The link goes to the Roadmap tab
 * and nowhere more specific — what Roadmap offers from there is Roadmap's to
 * decide, not this notice's.
 */
export function FeaturesDeprecationNotice({
	roadmapHref,
	messageId,
	onNavigate,
}: Props) {
	const t = useTranslations("projects.documents.featuresDeprecation");

	return (
		<div
			role="note"
			className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
		>
			<InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
			<p>
				<span id={messageId}>{t("message")}</span>{" "}
				<Link
					href={roadmapHref}
					onClick={onNavigate}
					className="font-medium text-primary underline-offset-4 hover:underline"
				>
					{t("roadmapLink")}
				</Link>
			</p>
		</div>
	);
}

/**
 * The marker a deprecated document type carries wherever the type is shown.
 * Visible text, so a screen reader announces it with the label it sits next
 * to; a caller that names the type in an `aria-label` must say "deprecated"
 * there too, because the label replaces this text.
 */
export function DeprecatedDocumentTypeBadge() {
	const t = useTranslations("projects.documents.featuresDeprecation");

	return <Badge variant="info">{t("badge")}</Badge>;
}
