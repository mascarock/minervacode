import type { MinervaConfig } from '../types.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, createConfigFromAuth } from './store.js';
import { MinervaClient } from '../api/client.js';
import { getAuthProfile } from '../api/auth.js';
import { manualBrowserLogin } from './manual-login.js';

export interface BrowserLoginOptions {
  email?: string;
  password?: string;
  baseUrl?: string;
  headless?: boolean;
  browserOnly?: boolean;
}

type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

async function launchBrowser(
  pw: PlaywrightModule,
  headless: boolean,
): Promise<Awaited<ReturnType<PlaywrightModule['chromium']['launch']>>> {
  const channels = ['chrome', 'msedge'] as const;

  for (const channel of channels) {
    try {
      return await pw.chromium.launch({ channel, headless });
    } catch {
      // try next channel
    }
  }

  return pw.chromium.launch({ headless });
}

async function playwrightAutoLogin(options: BrowserLoginOptions): Promise<MinervaConfig> {
  const pw = await loadPlaywright();
  if (!pw) {
    throw new Error('Playwright is not installed');
  }

  if (!options.email || !options.password) {
    throw new Error('Email and password required for automated login');
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const browser = await launchBrowser(pw, options.headless ?? false);
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/auth`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    const acceptBtn = page.getByRole('button', { name: 'Accept and continue' });
    if (await acceptBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await acceptBtn.click();
      await page.waitForTimeout(500);
    }

    await page.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(options.email);
    await page.getByRole('textbox', { name: /Password/i }).fill(options.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await page.waitForURL((url) => !url.pathname.includes('/auth'), { timeout: 60000 });

    const token = await page.evaluate(() => localStorage.getItem('token'));
    if (!token) {
      throw new Error('Login succeeded but no token found in localStorage');
    }

    const tempConfig = createConfigFromAuth(token, options.email, 0, DEFAULT_MODEL, baseUrl);
    const client = new MinervaClient(tempConfig);
    const profile = await getAuthProfile(client);

    return createConfigFromAuth(
      profile.token,
      profile.email,
      profile.expires_at,
      DEFAULT_MODEL,
      baseUrl,
    );
  } finally {
    await browser.close();
  }
}

export async function browserLogin(options: BrowserLoginOptions = {}): Promise<MinervaConfig> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (options.browserOnly) {
    return manualBrowserLogin(baseUrl);
  }

  if (options.email && options.password) {
    try {
      return await playwrightAutoLogin(options);
    } catch {
      // fall through to system browser
    }
  }

  return manualBrowserLogin(baseUrl);
}

export async function loginWithToken(
  token: string,
  baseUrl = DEFAULT_BASE_URL,
): Promise<MinervaConfig> {
  const tempConfig = createConfigFromAuth(token, '', 0, DEFAULT_MODEL, baseUrl);
  const client = new MinervaClient(tempConfig);
  const profile = await getAuthProfile(client);

  return createConfigFromAuth(
    profile.token,
    profile.email,
    profile.expires_at,
    DEFAULT_MODEL,
    baseUrl,
  );
}
