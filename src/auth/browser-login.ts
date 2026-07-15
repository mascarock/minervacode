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
}

type PlaywrightModule = typeof import('playwright');

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

async function playwrightAutoLogin(
  pw: PlaywrightModule,
  options: Required<Pick<BrowserLoginOptions, 'email' | 'password'>> & BrowserLoginOptions,
): Promise<MinervaConfig> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  // Try system Chrome first (best reCAPTCHA compatibility), then Edge, then bundled Chromium
  const channels = ['chrome', 'msedge', null] as const;
  let lastError: Error | null = null;

  for (const channel of channels) {
    try {
      const launchOpts = channel
        ? { channel, headless: options.headless ?? false }
        : { headless: options.headless ?? false };

      const browser = await pw.chromium.launch(launchOpts);
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
        if (!token) throw new Error('Login succeeded but no token in localStorage');

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
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw lastError ?? new Error('All browser launch attempts failed');
}

export async function browserLogin(options: BrowserLoginOptions = {}): Promise<MinervaConfig> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

  if (!options.email || !options.password) {
    return manualBrowserLogin(baseUrl);
  }

  const pw = await loadPlaywright();
  if (!pw) {
    // Playwright not installed — open system browser and ask user to paste token
    return manualBrowserLogin(baseUrl);
  }

  try {
    return await playwrightAutoLogin(pw, {
      email: options.email,
      password: options.password,
      baseUrl,
      headless: options.headless,
    });
  } catch {
    // Chrome/Playwright failed — fall back to system browser
    return manualBrowserLogin(baseUrl);
  }
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
