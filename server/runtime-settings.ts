export type RuntimeProfile = 'safe' | 'performance';
export type BrowserIdleMinutes = 5 | 10 | 20;

export type RuntimeSettings = {
  profile: RuntimeProfile;
  browserIdleMinutes: BrowserIdleMinutes;
};

export const defaultRuntimeSettings: RuntimeSettings = { profile: 'safe', browserIdleMinutes: 10 };

export function normalizeRuntimeSettings(input: Partial<RuntimeSettings>): RuntimeSettings {
  const profile: RuntimeProfile = input.profile === 'performance' ? 'performance' : 'safe';
  const idle = Number(input.browserIdleMinutes);
  const browserIdleMinutes: BrowserIdleMinutes = idle === 5 || idle === 20 ? idle : 10;
  return { profile, browserIdleMinutes };
}

