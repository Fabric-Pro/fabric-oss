/**
 * Upstash Redis Session Store
 *
 * Production-ready session storage using Upstash Redis.
 * Supports distributed deployments with automatic expiration.
 */

import { Redis } from "@upstash/redis";
import type { McpSession, SessionCreateInput, SessionStore } from "./types";

const SESSION_PREFIX = "mcp:session:";
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export class UpstashSessionStore implements SessionStore {
	private redis: Redis;

	constructor(redis?: Redis) {
		this.redis = redis ?? Redis.fromEnv();
	}

	private getKey(sessionId: string): string {
		return `${SESSION_PREFIX}${sessionId}`;
	}

	private generateSessionId(): string {
		return crypto.randomUUID();
	}

	async create(input: SessionCreateInput): Promise<McpSession> {
		const sessionId = this.generateSessionId();
		const nowIso = new Date().toISOString();
		const expiresAt = new Date(
			Date.now() + SESSION_TTL_SECONDS * 1000,
		).toISOString();

		const session: McpSession = {
			sessionId,
			userId: input.userId,
			organizationId: input.organizationId ?? null,
			userName: input.userName,
			email: input.email,
			role: input.role,
			createdAt: nowIso,
			expiresAt,
			lastActivityAt: nowIso,
			protocolVersion: input.protocolVersion ?? "2025-06-18",
		};

		const key = this.getKey(sessionId);
		await this.redis.set(key, JSON.stringify(session), {
			ex: SESSION_TTL_SECONDS,
		});

		return session;
	}

	async get(sessionId: string): Promise<McpSession | null> {
		const key = this.getKey(sessionId);
		const data = await this.redis.get<string>(key);

		if (!data) {
			return null;
		}

		const session = typeof data === "string" ? JSON.parse(data) : data;

		return {
			...session,
		} as McpSession;
	}

	async update(
		sessionId: string,
		updates: Partial<McpSession>,
	): Promise<McpSession | null> {
		const existing = await this.get(sessionId);
		if (!existing) {
			return null;
		}

		const updated: McpSession = {
			...existing,
			...updates,
			sessionId, // Ensure sessionId cannot be changed
			lastActivityAt: new Date().toISOString(),
		};

		const key = this.getKey(sessionId);
		const ttl = await this.redis.ttl(key);
		await this.redis.set(key, JSON.stringify(updated), {
			ex: ttl > 0 ? ttl : SESSION_TTL_SECONDS,
		});

		return updated;
	}

	async delete(sessionId: string): Promise<boolean> {
		const key = this.getKey(sessionId);
		const result = await this.redis.del(key);
		return result > 0;
	}

	async touch(sessionId: string): Promise<void> {
		const key = this.getKey(sessionId);
		const existing = await this.get(sessionId);
		if (existing) {
			existing.lastActivityAt = new Date().toISOString();
			await this.redis.set(key, JSON.stringify(existing), {
				ex: SESSION_TTL_SECONDS,
			});
		}
	}
}

// Singleton instance for convenience
let defaultStore: UpstashSessionStore | null = null;

export function getSessionStore(): UpstashSessionStore {
	if (!defaultStore) {
		defaultStore = new UpstashSessionStore();
	}
	return defaultStore;
}
