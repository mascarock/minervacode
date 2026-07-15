import { MinervaClient } from './api/client.js';
import { getAuthProfile } from './api/auth.js';
import { getPlatformConfig, getDefaultModel } from './api/models.js';
import type { MinervaConfig, SessionInfo } from './types.js';

export async function gatherSessionInfo(
  client: MinervaClient,
  config: MinervaConfig,
): Promise<SessionInfo> {
  const [user, platform, model] = await Promise.all([
    getAuthProfile(client),
    getPlatformConfig(client),
    getDefaultModel(client),
  ]);

  return { user, platform, model, config };
}
