export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(
    path.startsWith("/api/") ? path : `/api${path}`,
    {
      ...init,
      headers: {
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    },
  );
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = data as
      | { detail?: unknown; error?: unknown; message?: unknown }
      | undefined;
    throw new Error(
      String(
        error?.detail ??
          error?.error ??
          error?.message ??
          `TableWatch service returned ${response.status}.`,
      ),
    );
  }
  return data as T;
}
export const jsonBody = (value: unknown) => JSON.stringify(value);
export const imageSource = (value: string) =>
  value.startsWith("data:") ? value : `data:image/jpeg;base64,${value}`;
export const assetPath = (sourceId: string, path: string) =>
  `/api/sources/${encodeURIComponent(sourceId)}/assets/${path.split("/").map(encodeURIComponent).join("/")}`;

export function validLabel(value: string, otherLabels: string[]): string {
  const label = value.trim();
  if ([...label].length < 1 || [...label].length > 40)
    throw new Error("Use a table name with 1–40 characters.");
  if (
    otherLabels.some(
      (other) => other.trim().toLocaleLowerCase() === label.toLocaleLowerCase(),
    )
  )
    throw new Error("Each table needs a unique name.");
  return label;
}
