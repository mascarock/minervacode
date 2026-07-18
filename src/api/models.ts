import type { MinervaClient } from './client.js';
import type { ModelsResponse, ModelInfo, PlatformConfig } from '../types.js';
import { DEFAULT_MODEL } from '../auth/store.js';

export async function getPlatformConfig(client: MinervaClient): Promise<PlatformConfig> {
  return client.get<PlatformConfig>('/api/config');
}

export async function listModels(client: MinervaClient): Promise<ModelInfo[]> {
  const res = await client.get<ModelsResponse>('/api/models');
  return res.data ?? [];
}

export async function getModel(client: MinervaClient, modelId: string): Promise<ModelInfo | null> {
  const models = await listModels(client);
  return models.find((m) => m.id === modelId) ?? null;
}

export async function getDefaultModel(client: MinervaClient): Promise<ModelInfo | null> {
  return getModel(client, client.model || DEFAULT_MODEL);
}

/** True when Open WebUI advertises web search for this model. */
export function modelSupportsWebSearch(model: ModelInfo | null | undefined): boolean {
  return model?.info?.meta?.capabilities?.web_search === true;
}
