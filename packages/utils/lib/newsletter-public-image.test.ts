import { describe, expect, it } from "vitest";
import { newsletterPublicImageContentType } from "./newsletter-public-image";

const hex32 = "0123456789abcdef0123456789abcdef";

describe("newsletterPublicImageContentType", () => {
	it.each([
		[`${hex32}.png`, "image/png"],
		[`${hex32}.jpg`, "image/jpeg"],
		[`${hex32}.jpeg`, "image/jpeg"],
		[`${hex32}${hex32}.png`, "image/png"],
	])("accepts %s as %s", (name, type) => {
		expect(newsletterPublicImageContentType(name)).toBe(type);
	});

	it.each([
		"abc.png",
		`${hex32.toUpperCase()}.png`,
		`${hex32}.gif`,
		`${hex32}.png.html`,
		`../${hex32}.png`,
		`${hex32}/x.png`,
		`${hex32}${hex32}0.png`,
		"",
	])("refuses %s", (name) => {
		expect(newsletterPublicImageContentType(name)).toBeNull();
	});
});
