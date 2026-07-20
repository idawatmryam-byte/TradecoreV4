import { useQuery } from "@tanstack/react-query";

/** Shape of GET /me/account (the fields the app reads app-wide). */
export interface AccountInfo {
  id: number;
  username: string;
  email: string | null;
  displayName: string | null;
  createdAt: string;
  hasPassword: boolean;
  isDemo: boolean;
  providers: Array<{ provider: string; email: string | null }>;
}

/** The current account, cached app-wide. Used for the read-only DEMO banner
 *  and to disable controls that the server would reject for a demo user. */
export function useAccount() {
  return useQuery<AccountInfo>({
    queryKey: ["me-account"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch("/api/me/account", { credentials: "same-origin" });
      if (!res.ok) throw new Error("account fetch failed");
      return res.json();
    },
  });
}

/** True when the session is the read-only demo account. */
export function useIsDemo(): boolean {
  const { data } = useAccount();
  return data?.isDemo ?? false;
}
