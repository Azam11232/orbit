import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

export type DensityMode = 'comfortable' | 'compact';
export type RefreshMode = 'manual' | 'balanced' | 'live';
export type ExplorerPreference = 'basescan' | 'blockscout';

export interface OrbitSettings {
  density: DensityMode;
  refreshMode: RefreshMode;
  explorer: ExplorerPreference;
}

const STORAGE_KEY = 'orbit-settings-v1';
const DEFAULT_SETTINGS: OrbitSettings = {
  density: 'comfortable',
  refreshMode: 'balanced',
  explorer: 'basescan',
};

function readSettings(): OrbitSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(stored) as Partial<OrbitSettings>;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;

    return {
      density: parsed.density === 'compact' ? 'compact' : 'comfortable',
      refreshMode: parsed.refreshMode === 'manual' || parsed.refreshMode === 'live' ? parsed.refreshMode : 'balanced',
      explorer: parsed.explorer === 'blockscout' ? 'blockscout' : 'basescan',
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function applyQuerySettings(client: ReturnType<typeof useQueryClient>, settings: OrbitSettings) {
  const queryDefaults = {
    staleTime: settings.refreshMode === 'manual' ? 5 * 60_000 : settings.refreshMode === 'balanced' ? 60_000 : 30_000,
    refetchOnWindowFocus: settings.refreshMode === 'live',
    refetchOnReconnect: settings.refreshMode !== 'manual',
    refetchInterval: settings.refreshMode === 'live' ? 120_000 : settings.refreshMode === 'balanced' ? 300_000 : false,
  } satisfies {
    staleTime: number;
    refetchOnWindowFocus: boolean;
    refetchOnReconnect: boolean;
    refetchInterval: number | false;
  };

  client.setDefaultOptions({
    queries: {
      ...queryDefaults,
      retry: 1,
    },
  });
}

export function useOrbitSettings() {
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<OrbitSettings>(() => readSettings());

  useEffect(() => {
    applyQuerySettings(queryClient, settings);

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage may be unavailable in protected browsing or constrained environments.
    }

    void queryClient.refetchQueries({ type: 'active' });
  }, [queryClient, settings]);

  const updateSetting = <K extends keyof OrbitSettings>(key: K, value: OrbitSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  return {
    settings,
    updateSetting,
    setDensity: (density: DensityMode) => updateSetting('density', density),
    setRefreshMode: (refreshMode: RefreshMode) => updateSetting('refreshMode', refreshMode),
    setExplorer: (explorer: ExplorerPreference) => updateSetting('explorer', explorer),
    hasStorage: typeof window !== 'undefined' && (() => { try { const key = 'orbit-storage-check'; window.localStorage.setItem(key, '1'); window.localStorage.removeItem(key); return true; } catch { return false; } })(),
  };
}
