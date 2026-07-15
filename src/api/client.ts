import type { MinervaConfig } from '../types.js';
import { DEFAULT_BASE_URL } from '../auth/store.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class MinervaClient {
  constructor(private config: MinervaConfig) {}

  get baseUrl(): string {
    return this.config.baseUrl || DEFAULT_BASE_URL;
  }

  get token(): string {
    return this.config.token;
  }

  get model(): string {
    return this.config.model;
  }

  updateConfig(config: MinervaConfig): void {
    this.config = config;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.token}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ApiError(`GET ${path} failed`, res.status, body);
    }
    return res.json() as Promise<T>;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(`POST ${path} failed`, res.status, text);
    }
    return res.json() as Promise<T>;
  }

  async postStream(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(`POST ${path} failed`, res.status, text);
    }
    return res;
  }
}
