import type { z } from "zod";
import { db } from "../client";
import type { Prisma } from "../generated/client";
import type { UserSchema } from "../zod";

function userSearchWhere(query?: string) {
	if (!query) {
		return undefined;
	}
	return {
		OR: [
			{ name: { contains: query, mode: "insensitive" as const } },
			{ email: { contains: query, mode: "insensitive" as const } },
		],
	};
}

export async function getUsers({
	limit,
	offset,
	query,
}: {
	limit: number;
	offset: number;
	query?: string;
}) {
	return await db.user.findMany({
		where: userSearchWhere(query),
		take: limit,
		skip: offset,
	});
}

export async function countUsers({ query }: { query?: string }) {
	return await db.user.count({
		where: userSearchWhere(query),
	});
}

export async function getUserById(id: string) {
	return await db.user.findUnique({
		where: {
			id,
		},
	});
}

export async function getUserByEmail(email: string) {
	return await db.user.findUnique({
		where: {
			email,
		},
	});
}

export async function createUser({
	email,
	name,
	role,
	emailVerified,
	onboardingComplete,
}: {
	email: string;
	name: string;
	role: "admin" | "user";
	emailVerified: boolean;
	onboardingComplete: boolean;
}) {
	return await db.user.create({
		data: {
			email,
			name,
			role,
			emailVerified,
			onboardingComplete,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
}

export async function getAccountById(id: string) {
	return await db.account.findUnique({
		where: {
			id,
		},
	});
}

export async function createUserAccount({
	userId,
	providerId,
	accountId,
	hashedPassword,
}: {
	userId: string;
	providerId: string;
	accountId: string;
	hashedPassword?: string;
}) {
	return await db.account.create({
		data: {
			userId,
			accountId,
			providerId,
			password: hashedPassword,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
}

export async function updateUser(
	user: Partial<z.infer<typeof UserSchema>> & { id: string },
) {
	return await db.user.update({
		where: {
			id: user.id,
		},
		// Narrow the cast to the JSON column only: the Zod-inferred user type
		// carries `onboardingTourState` as the read-side `JsonValue`, which
		// Prisma's write-side `InputJsonValue` intentionally does not accept.
		// Spreading + casting just that field keeps every other field
		// type-checked against `UserUpdateInput`.
		data: {
			...user,
			onboardingTourState: user.onboardingTourState as
				| Prisma.InputJsonValue
				| undefined,
		},
	});
}
