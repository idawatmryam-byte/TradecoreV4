export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
  }
}

export async function adminApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/admin${path}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("json")
    ? ((await response.json()) as unknown)
    : await response.text();
  if (!response.ok) {
    const record =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : null;
    throw new AdminApiError(
      response.status,
      typeof record?.code === "string" ? record.code : null,
      typeof record?.error === "string"
        ? record.error
        : `Admin API request failed with HTTP ${response.status}`,
    );
  }
  return payload as T;
}

export interface AdminSessionStatus {
  eligible: boolean;
  roles: string[];
  permissions: string[];
  stepUp:
    | { active: true; expiresAt: string }
    | { active: false; expiresAt: null; reason: string };
  mutationsSupported: boolean;
  mutationReason: string;
}
