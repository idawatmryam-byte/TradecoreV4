/**
 * TradeCore Pro — section resolver
 *
 * Crypto and Forex are two fully independent trading sections a user can run
 * at the same time (see engineRegistry). The frontend attaches an `X-Section`
 * header to every request (via the api-client's section getter); this
 * middleware validates it onto `req.section`, defaulting to "crypto" so any
 * request without the header behaves exactly as before sectioning existed.
 *
 * Registered AFTER requireAuth so it only runs on authenticated routes.
 */
import type { NextFunction, Request, Response } from "express";
import { isSection, type Section } from "../lib/engineRegistry";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The trading section this request targets (crypto | forex).
       *  Defaults to "crypto" when the X-Section header is absent/invalid. */
      section?: Section;
    }
  }
}

export function resolveSection(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.header("x-section");
  req.section = isSection(raw) ? raw : "crypto";
  next();
}
