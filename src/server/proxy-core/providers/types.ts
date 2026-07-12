export type ProviderProfileId = 'claude';

export type ProviderEndpoint =
  | 'chat'
  | 'messages'
  | 'responses';

export type ProviderAction =
  | 'generateContent'
  | 'streamGenerateContent'
  | 'countTokens';

export type ProviderRuntimeDescriptor = {
  executor: 'default' | 'gemini-native' | 'claude';
  modelName?: string;
  stream?: boolean;
  action?: ProviderAction;
};

export type PreparedProviderRequest = {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime: ProviderRuntimeDescriptor;
};

export type PrepareProviderRequestInput = {
  endpoint: ProviderEndpoint;
  modelName: string;
  stream: boolean;
  tokenValue: string;
  sitePlatform?: string;
  baseHeaders: Record<string, string>;
  claudeHeaders?: Record<string, string>;
  body: Record<string, unknown>;
  action?: ProviderAction;
};

export type ProviderProfile = {
  id: ProviderProfileId;
  prepareRequest(input: PrepareProviderRequestInput): PreparedProviderRequest;
};
