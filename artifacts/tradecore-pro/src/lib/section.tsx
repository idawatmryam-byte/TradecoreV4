import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { setSectionGetter } from "@workspace/api-client-react";

/**
 * Trading section — crypto (Binance) and forex (OANDA) are two fully
 * independent trading systems that can both run at once, each with its own
 * config, positions, trade log, decisions and stats. The chosen section is
 * attached as an `X-Section` header to EVERY API request (via the api-client's
 * section getter), so all existing pages become section-scoped without any
 * per-hook changes.
 */
export type Section = "crypto" | "forex";

const STORAGE_KEY = "tradecore.section";

function readStored(): Section {
  if (typeof localStorage === "undefined") return "crypto";
  const v = localStorage.getItem(STORAGE_KEY);
  return v === "forex" ? "forex" : "crypto";
}

// Module-level current section + getter registration. Done at import time so
// the X-Section header is attached from the very first request, before the
// provider has mounted.
let currentSection: Section = readStored();
setSectionGetter(() => currentSection);

/** The active section, for code OUTSIDE the generated API client. */
export function getCurrentSection(): Section {
  return currentSection;
}

/** Headers for RAW fetch() calls to section-scoped endpoints. The generated
 *  client attaches X-Section automatically; anything using plain fetch must
 *  spread this in — a missing header silently falls back to "crypto" on the
 *  server, which is exactly how crypto positions once leaked onto the Forex
 *  dashboard. */
export function sectionHeaders(): Record<string, string> {
  return { "X-Section": currentSection };
}

interface SectionContextValue {
  section: Section;
  setSection: (next: Section) => void;
}

const SectionContext = createContext<SectionContextValue | null>(null);

export function SectionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [section, setSectionState] = useState<Section>(currentSection);

  const setSection = useCallback(
    (next: Section) => {
      if (next === currentSection) return;
      currentSection = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* storage may be unavailable (private mode) — non-fatal */
      }
      setSectionState(next);
      // Every cached query was fetched under the previous section's header;
      // reset them all so the whole app refetches scoped to the new section.
      void queryClient.resetQueries();
    },
    [queryClient],
  );

  const value = useMemo(() => ({ section, setSection }), [section, setSection]);

  return <SectionContext.Provider value={value}>{children}</SectionContext.Provider>;
}

export function useSection(): SectionContextValue {
  const ctx = useContext(SectionContext);
  if (!ctx) throw new Error("useSection must be used within a SectionProvider");
  return ctx;
}
