"use client";

import { NewsletterForm } from "@marketing/shared/components/NewsletterForm";
import { MailIcon } from "lucide-react";
import { useTranslations } from "next-intl";

export function Newsletter() {
	const t = useTranslations();

	return (
		<section className="border-t bg-muted/30 py-16 lg:py-20">
			<div className="container max-w-4xl">
				<div className="rounded-2xl border bg-card p-8 text-center lg:p-12">
					{/* Header */}
					<div className="mb-6">
						<div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-full bg-primary/10">
							<MailIcon className="size-6 text-primary" />
						</div>
						<h2 className="font-bold text-2xl lg:text-3xl">
							{t("newsletter.title")}
						</h2>
						<p className="mx-auto mt-2 max-w-md text-foreground/60">
							{t("newsletter.subtitle")}
						</p>
					</div>

					{/* Form (NewsletterForm renders the privacy note itself) */}
					<div className="mx-auto max-w-md">
						<NewsletterForm />
					</div>
				</div>
			</div>
		</section>
	);
}
