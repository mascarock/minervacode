import type { MinervaClient } from './client.js';
import type { AuthProfile } from '../types.js';

export async function getAuthProfile(client: MinervaClient): Promise<AuthProfile> {
  return client.get<AuthProfile>('/api/v1/auths/');
}

export async function validateSession(client: MinervaClient): Promise<boolean> {
  try {
    await getAuthProfile(client);
    return true;
  } catch {
    return false;
  }
}
