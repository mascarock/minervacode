export interface MinervaConfig {
  token: string;
  email: string;
  expiresAt: number;
  model: string;
  baseUrl: string;
}

export interface AuthProfile {
  id: string;
  name: string;
  email: string;
  token: string;
  token_type: string;
  expires_at: number;
  role: string;
}

export interface PlatformConfig {
  status: boolean;
  name: string;
  version: string;
  features: {
    auth: boolean;
    enable_websocket: boolean;
  };
}

export interface ModelInfo {
  id: string;
  name: string;
  info?: {
    meta?: {
      capabilities?: {
        vision?: boolean;
        file_upload?: boolean;
        web_search?: boolean;
      };
    };
  };
}

export interface ModelsResponse {
  data: ModelInfo[];
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface SessionInfo {
  user: AuthProfile;
  platform: PlatformConfig;
  model: ModelInfo | null;
  config: MinervaConfig;
}
