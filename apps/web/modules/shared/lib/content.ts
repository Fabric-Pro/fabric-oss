import slugify from "slugify";

export function getActivePathFromUrlParam(path: string | string[]) {
	return Array.isArray(path) ? path.join("/") : path || "";
}

export function getLocalizedDocumentWithFallback<
	T extends { path: string; locale: string },
>(documents: T[], path: string, locale: string) {
	return documents
		.filter((doc) => doc.path === path)
		.sort((doc) => (doc.locale === locale ? -1 : 1))[0];
}

export function slugifyHeadline(headline: string) {
	return slugify(headline, {
		lower: true,
		replacement: "-",
		trim: true,
		strict: true,
		remove: /[*+~.()'"!:@]/g,
	});
}
