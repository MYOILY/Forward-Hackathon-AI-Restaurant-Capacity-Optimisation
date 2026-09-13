import type { Bundle, Table } from "../../shared/contracts";

export function monitoringKey(bundle: Bundle, table: Table): string {
  return `tablewatch:monitoring:v1:${bundle.video.sha256.toLowerCase()}:${encodeURIComponent(table.id)}:${table.geometry_sha256?.toLowerCase()}`;
}

export function savedMonitoring(key: string): boolean | undefined {
  try {
    const value = localStorage.getItem(key);
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

export function saveMonitoring(key: string, enabled: boolean): void {
  try {
    localStorage.setItem(key, String(enabled));
  } catch {
    /* The current session still retains the choice when storage is unavailable. */
  }
}

/** Keep raw observations and source identities intact when playback scope changes. */
export function withMonitoring(
  bundle: Bundle,
  choices: Record<string, boolean>,
): Bundle {
  return {
    ...bundle,
    tables: bundle.tables.map((table) => {
      const key = monitoringKey(bundle, table);
      return {
        ...table,
        monitoring_enabled:
          choices[key] ??
          savedMonitoring(key) ??
          table.monitoring_enabled ??
          true,
      };
    }),
  };
}
