import type { Context } from '@deepseek-ai/cordis';

/** Resolved shape of the `dsh-proxy` settings section / entry config. */
export interface ProxySection {
	enabled?: boolean;
	proxy?: string;
	noProxy?: string[];
	exportEnv?: boolean;
}

/** Undici dispatcher instance type (loose — undici ships its own types). */
export interface DispatcherLike {
	dispatch(options: unknown, handler: unknown): boolean;
	close(): Promise<void>;
	destroy(): Promise<void>;
}

export interface SwitchEngine {
	apply(config: ProxySection): void;
	restore(): void;
}

export const name: string;
export const inject: string[];
export const PROXY_SETTINGS_NAMESPACE: 'dsh-proxy';
export const Config: unknown;

export function matchesNoProxy(hostname: string, port: string | null, rules: string[]): boolean;
export function buildDispatcher(config: ProxySection & { proxy: string }): DispatcherLike;
export function createEngine(logger: unknown): SwitchEngine;
export function apply(ctx: Context, config?: ProxySection): void;
