import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MinervaConfig } from '../types.js';

export const CONFIG_DIR = join(homedir(), '.minervacli');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

export const DEFAULT_BASE_URL = process.env.MINERVA_BASE_URL ?? 'https://chatminerva.org';
export const DEFAULT_MODEL = 'Minerva-7B-32k-Multimodal';

export async function loadConfig(): Promise<MinervaConfig | null> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as MinervaConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: MinervaConfig): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(CONFIG_PATH, 0o600);
}

export async function clearConfig(): Promise<void> {
  try {
    await unlink(CONFIG_PATH);
  } catch {
    // already gone
  }
}

export function isTokenExpired(config: MinervaConfig): boolean {
  const now = Math.floor(Date.now() / 1000);
  return config.expiresAt <= now;
}

export function createConfigFromAuth(
  token: string,
  email: string,
  expiresAt: number,
  model = DEFAULT_MODEL,
  baseUrl = DEFAULT_BASE_URL,
): MinervaConfig {
  return { token, email, expiresAt, model, baseUrl };
}
