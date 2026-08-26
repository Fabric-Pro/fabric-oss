import type { NewsletterContent } from "@repo/database";

// One published send, projected + validated by the server helper to exactly
// these fields (no internal columns), with `content` already parsed to the typed
// NewsletterContent shape (the archive query excludes PENDING).
type PublicSend = {
	id: string;
	status: string;
	createdAt: Date | string;
	content: NewsletterContent;
};

function formatDate(value: Date | string, locale: string): string {
	const date = typeof value === "string" ? new Date(value) : value;
	if (Number.isNaN(date.getTime())) {
		return "—";
	}
	return date.toLocaleDateString(locale, { dateStyle: "medium" });
}

const sectionLabelClass =
	"flex items-center gap-2 font-sans text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground";

export function ReleaseNotesListPublic({
	sends,
	locale,
	emptyLabel,
	fallbackHeadline,
}: {
	sends: PublicSend[];
	locale: string;
	emptyLabel: string;
	fallbackHeadline: string;
}) {
	if (sends.length === 0) {
		return <p className="text-base text-muted-foreground">{emptyLabel}</p>;
	}

	return (
		<div className="space-y-4">
			{sends.map((send) => {
				const content = send.content;
				const inner = (
					<>
						<div className={sectionLabelClass}>
							<span
								aria-hidden="true"
								className="h-3 w-[3px] shrink-0 bg-primary"
							/>
							<time
								dateTime={new Date(
									send.createdAt,
								).toISOString()}
							>
								{formatDate(send.createdAt, locale)}
							</time>
						</div>
						<h2 className="mt-3 font-serif text-2xl font-normal text-foreground">
							{content.headline || fallbackHeadline}
						</h2>
						{content.intro ? (
							<p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
								{content.intro}
							</p>
						) : null}
					</>
				);

				return (
					<div
						key={send.id}
						className="block rounded-lg border border-border bg-card p-6"
					>
						{inner}
					</div>
				);
			})}
		</div>
	);
}
