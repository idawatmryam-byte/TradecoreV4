import { randomUUID } from "crypto";
import {
  and,
  desc,
  eq,
  lte,
  ne,
  sql,
  type InferSelectModel,
} from "drizzle-orm";
import {
  brainVersionsTable,
  db,
  tradingMandateAuthorizationsTable,
  tradingMandateDecisionClaimsTable,
  tradingMandateEventsTable,
  tradingMandateStatesTable,
  tradingMandateUsageTable,
  tradingMandatesTable,
} from "@workspace/db";
import { sha256Fingerprint } from "../intelligence/canonical";
import {
  TRADING_MANDATE_SCHEMA_VERSION,
  TradingMandateCoreSchema,
  TradingMandateStateSchema,
  TradingMandateTermsSchema,
  canonicalizeTradingMandateTerms,
  evaluateRestrictedLiveEntry,
  tradingMandateFingerprint,
  type MandateEvaluation,
  type RestrictedLiveEvidence,
  type TradingMandateCore,
  type TradingMandateState,
  type TradingMandateTerms,
} from "./contracts";

type MandateRecord = InferSelectModel<typeof tradingMandatesTable>;
type StateRecord = InferSelectModel<typeof tradingMandateStatesTable>;

export class MandateConflictError extends Error {
  readonly status = 409;
}

export class MandateNotFoundError extends Error {
  readonly status = 404;
}

export interface TradingMandateView {
  id: number;
  mandateKey: string;
  revision: number;
  replacesMandateId: number | null;
  userId: number;
  tenantId: string;
  section: "crypto" | "forex";
  lifecycleState: TradingMandateState;
  fingerprint: string;
  terms: TradingMandateTerms;
  changeReason: string;
  approvingHumanId: number | null;
  authorizationMethod: "PASSWORD_STEP_UP" | "BASIC_REAUTH" | null;
  authorizedAt: string | null;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

function termsFromRecord(record: MandateRecord): TradingMandateTerms {
  return TradingMandateTermsSchema.parse({
    brainVersionId: record.brainVersionId,
    brainVersion: record.brainVersion,
    brainFingerprint: record.brainFingerprint,
    accountIds: record.accountIds,
    exchanges: record.exchanges,
    markets: record.markets,
    symbols: record.symbols,
    strategies: record.strategies,
    models: record.models,
    settlementCurrency: record.settlementCurrency,
    monetaryScale: record.monetaryScale,
    maximumPerTradeRisk: record.maximumPerTradeRisk,
    maximumPositionNotional: record.maximumPositionNotional,
    maximumAggregateExposure: record.maximumAggregateExposure,
    maximumLeverageBps: record.maximumLeverageBps,
    maximumConcurrentPositions: record.maximumConcurrentPositions,
    maximumConcurrentOrders: record.maximumConcurrentOrders,
    dailyLossLimit: record.dailyLossLimit,
    weeklyLossLimit: record.weeklyLossLimit,
    monthlyLossLimit: record.monthlyLossLimit,
    maximumDrawdownBps: record.maximumDrawdownBps,
    tradingHours: record.tradingHours,
    effectiveAt: record.effectiveAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    canaryAllocation: record.canaryAllocation,
    automaticSuspension: record.automaticSuspension,
    fallbackPolicy: record.fallbackPolicy,
  });
}

function coreFromRecord(record: MandateRecord): TradingMandateCore {
  return TradingMandateCoreSchema.parse({
    schemaVersion: TRADING_MANDATE_SCHEMA_VERSION,
    mandateKey: record.mandateKey,
    revision: record.revision,
    replacesMandateId: record.replacesMandateId,
    userId: record.userId,
    tenantId: record.tenantId,
    section: record.section,
    terms: termsFromRecord(record),
    changeReason: record.changeReason,
  });
}

function toView(record: MandateRecord, state: StateRecord): TradingMandateView {
  return {
    id: record.id,
    mandateKey: record.mandateKey,
    revision: record.revision,
    replacesMandateId: record.replacesMandateId,
    userId: record.userId,
    tenantId: record.tenantId,
    section: record.section as "crypto" | "forex",
    lifecycleState: TradingMandateStateSchema.parse(state.state),
    fingerprint: record.fingerprint,
    terms: termsFromRecord(record),
    changeReason: record.changeReason,
    approvingHumanId: state.approvingHumanId,
    authorizationMethod: state.authorizationMethod as
      | "PASSWORD_STEP_UP"
      | "BASIC_REAUTH"
      | null,
    authorizedAt: state.authorizedAt?.toISOString() ?? null,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: state.updatedAt.toISOString(),
  };
}

async function appendEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    clientRequestId: string;
    mandateId: number;
    userId: number;
    section: "crypto" | "forex";
    eventType: string;
    actorType: "HUMAN" | "SYSTEM";
    actorUserId?: number;
    fromState?: TradingMandateState;
    toState?: TradingMandateState;
    reasonCode: string;
    reason: string;
    fingerprint?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(tradingMandateEventsTable).values({
    eventKey: sha256Fingerprint({
      type: input.eventType,
      userId: input.userId,
      mandateId: input.mandateId,
      clientRequestId: input.clientRequestId,
    }),
    mandateId: input.mandateId,
    userId: input.userId,
    section: input.section,
    eventType: input.eventType,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    reasonCode: input.reasonCode,
    reason: input.reason,
    fingerprint: input.fingerprint ?? null,
    payload: input.payload ?? null,
  });
}

async function loadLocked(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: { mandateId: number; userId: number; section: "crypto" | "forex" },
): Promise<{ mandate: MandateRecord; state: StateRecord }> {
  const [row] = await tx
    .select({ mandate: tradingMandatesTable, state: tradingMandateStatesTable })
    .from(tradingMandatesTable)
    .innerJoin(
      tradingMandateStatesTable,
      eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
    )
    .where(
      and(
        eq(tradingMandatesTable.id, input.mandateId),
        eq(tradingMandatesTable.userId, input.userId),
        eq(tradingMandatesTable.section, input.section),
      ),
    )
    .limit(1)
    .for("update");
  if (!row) throw new MandateNotFoundError("Trading mandate not found");
  return row;
}

export async function expireTradingMandates(
  userId: number,
  section: "crypto" | "forex",
  now = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const expired = await tx
      .select({
        mandate: tradingMandatesTable,
        state: tradingMandateStatesTable,
      })
      .from(tradingMandatesTable)
      .innerJoin(
        tradingMandateStatesTable,
        eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
      )
      .where(
        and(
          eq(tradingMandatesTable.userId, userId),
          eq(tradingMandatesTable.section, section),
          eq(tradingMandateStatesTable.state, "ACTIVE"),
          lte(tradingMandatesTable.expiresAt, now),
        ),
      )
      .for("update");
    for (const row of expired) {
      await tx
        .update(tradingMandateStatesTable)
        .set({
          state: "EXPIRED",
          lifecycleVersion: sql`${tradingMandateStatesTable.lifecycleVersion} + 1`,
          reasonCode: "MANDATE_HARD_EXPIRY",
          reason: "Hard expiry was reached; new-entry authority is removed",
        })
        .where(eq(tradingMandateStatesTable.id, row.state.id));
      await appendEvent(tx, {
        clientRequestId: `expiry:${row.mandate.id}:${row.mandate.expiresAt.toISOString()}`,
        mandateId: row.mandate.id,
        userId,
        section,
        eventType: "MANDATE_EXPIRED",
        actorType: "SYSTEM",
        fromState: "ACTIVE",
        toState: "EXPIRED",
        reasonCode: "MANDATE_HARD_EXPIRY",
        reason: "Hard expiry was reached; protective exits remain available",
        fingerprint: row.mandate.fingerprint,
      });
    }
  });
}

export async function createTradingMandate(input: {
  userId: number;
  section: "crypto" | "forex";
  clientRequestId: string;
  expectedNextRevision: number;
  replacesMandateId: number | null;
  changeReason: string;
  terms: TradingMandateTerms;
  actorUserId: number;
}): Promise<TradingMandateView> {
  const terms = canonicalizeTradingMandateTerms(input.terms);
  return db.transaction(async (tx) => {
    const [existingRequest] = await tx
      .select({
        mandate: tradingMandatesTable,
        state: tradingMandateStatesTable,
      })
      .from(tradingMandatesTable)
      .innerJoin(
        tradingMandateStatesTable,
        eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
      )
      .where(
        and(
          eq(tradingMandatesTable.userId, input.userId),
          eq(tradingMandatesTable.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (existingRequest)
      return toView(existingRequest.mandate, existingRequest.state);

    const [brain] = await tx
      .select()
      .from(brainVersionsTable)
      .where(
        and(
          eq(brainVersionsTable.id, terms.brainVersionId),
          eq(brainVersionsTable.userId, input.userId),
          eq(brainVersionsTable.section, input.section),
          eq(brainVersionsTable.version, terms.brainVersion),
          eq(brainVersionsTable.fingerprint, terms.brainFingerprint),
        ),
      )
      .limit(1)
      .for("update");
    if (!brain || !["DEMO_APPROVED", "LIVE_RESTRICTED"].includes(brain.state)) {
      throw new MandateConflictError(
        "The exact brain version must be DEMO_APPROVED before mandate drafting",
      );
    }

    let mandateKey: string = randomUUID();
    let revision = 1;
    if (input.replacesMandateId !== null) {
      const replaced = await loadLocked(tx, {
        mandateId: input.replacesMandateId,
        userId: input.userId,
        section: input.section,
      });
      if (["REVOKED", "REPLACED", "RETIRED"].includes(replaced.state.state)) {
        throw new MandateConflictError(
          "A terminal mandate cannot be used as replacement authority",
        );
      }
      mandateKey = replaced.mandate.mandateKey;
      revision = replaced.mandate.revision + 1;
    }
    if (input.expectedNextRevision !== revision) {
      throw new MandateConflictError(
        `Stale expected revision ${input.expectedNextRevision}; next revision is ${revision}`,
      );
    }
    const core = TradingMandateCoreSchema.parse({
      schemaVersion: TRADING_MANDATE_SCHEMA_VERSION,
      mandateKey,
      revision,
      replacesMandateId: input.replacesMandateId,
      userId: input.userId,
      tenantId: `user:${input.userId}`,
      section: input.section,
      terms,
      changeReason: input.changeReason,
    });
    const fingerprint = tradingMandateFingerprint(core);
    const [mandate] = await tx
      .insert(tradingMandatesTable)
      .values({
        mandateKey,
        revision,
        replacesMandateId: input.replacesMandateId,
        userId: input.userId,
        tenantId: core.tenantId,
        section: input.section,
        brainVersionId: terms.brainVersionId,
        brainVersion: terms.brainVersion,
        brainFingerprint: terms.brainFingerprint,
        accountIds: terms.accountIds,
        exchanges: terms.exchanges,
        markets: terms.markets,
        symbols: terms.symbols,
        strategies: terms.strategies,
        models: terms.models,
        settlementCurrency: terms.settlementCurrency,
        monetaryScale: terms.monetaryScale,
        maximumPerTradeRisk: terms.maximumPerTradeRisk,
        maximumPositionNotional: terms.maximumPositionNotional,
        maximumAggregateExposure: terms.maximumAggregateExposure,
        maximumLeverageBps: terms.maximumLeverageBps,
        maximumConcurrentPositions: terms.maximumConcurrentPositions,
        maximumConcurrentOrders: terms.maximumConcurrentOrders,
        dailyLossLimit: terms.dailyLossLimit,
        weeklyLossLimit: terms.weeklyLossLimit,
        monthlyLossLimit: terms.monthlyLossLimit,
        maximumDrawdownBps: terms.maximumDrawdownBps,
        tradingHours: terms.tradingHours,
        effectiveAt: new Date(terms.effectiveAt),
        expiresAt: new Date(terms.expiresAt),
        canaryAllocation: terms.canaryAllocation,
        automaticSuspension: terms.automaticSuspension,
        fallbackPolicy: terms.fallbackPolicy,
        fingerprint,
        changeReason: input.changeReason,
        clientRequestId: input.clientRequestId,
        createdByUserId: input.actorUserId,
      })
      .returning();
    if (!mandate) throw new Error("Trading mandate was not persisted");
    const [state] = await tx
      .insert(tradingMandateStatesTable)
      .values({
        mandateId: mandate.id,
        userId: input.userId,
        section: input.section,
        state: "DRAFT",
        reasonCode: "MANDATE_CREATED",
        reason: "Immutable terms are frozen without execution authority",
      })
      .returning();
    if (!state) throw new Error("Trading mandate state was not persisted");
    await tx.insert(tradingMandateUsageTable).values({
      mandateId: mandate.id,
      userId: input.userId,
      section: input.section,
      status: "UNAVAILABLE",
      staleReasons: ["No server-authoritative runtime projection is available"],
    });
    await appendEvent(tx, {
      clientRequestId: input.clientRequestId,
      mandateId: mandate.id,
      userId: input.userId,
      section: input.section,
      eventType: "MANDATE_CREATED",
      actorType: "HUMAN",
      actorUserId: input.actorUserId,
      toState: "DRAFT",
      reasonCode: "MANDATE_CREATED",
      reason: input.changeReason,
      fingerprint,
      payload: {
        revision,
        replacesMandateId: input.replacesMandateId,
        maximumPossibleExposure: terms.maximumAggregateExposure,
      },
    });
    return toView(mandate, state);
  });
}

export async function transitionTradingMandate(input: {
  mandateId: number;
  userId: number;
  section: "crypto" | "forex";
  expectedRevision: number;
  clientRequestId: string;
  reason: string;
  actorType: "HUMAN" | "SYSTEM";
  actorUserId?: number;
  action: "SUBMIT" | "SUSPEND" | "REVOKE" | "RETIRE";
  reasonCode?: string;
}): Promise<TradingMandateView> {
  const rules: Record<
    typeof input.action,
    { from: readonly TradingMandateState[]; to: TradingMandateState }
  > = {
    SUBMIT: { from: ["DRAFT"], to: "PENDING_APPROVAL" },
    SUSPEND: { from: ["ACTIVE"], to: "SUSPENDED" },
    REVOKE: {
      from: ["DRAFT", "PENDING_APPROVAL", "ACTIVE", "SUSPENDED", "EXPIRED"],
      to: "REVOKED",
    },
    RETIRE: { from: ["EXPIRED", "REPLACED"], to: "RETIRED" },
  };
  return db.transaction(async (tx) => {
    const current = await loadLocked(tx, input);
    if (current.mandate.revision !== input.expectedRevision) {
      throw new MandateConflictError("Mandate revision is stale");
    }
    const rule = rules[input.action];
    const currentState = TradingMandateStateSchema.parse(current.state.state);
    if (currentState === rule.to) return toView(current.mandate, current.state);
    if (!rule.from.includes(currentState)) {
      throw new MandateConflictError(
        `${input.action} is not allowed from ${currentState}`,
      );
    }
    const [updated] = await tx
      .update(tradingMandateStatesTable)
      .set({
        state: rule.to,
        lifecycleVersion: sql`${tradingMandateStatesTable.lifecycleVersion} + 1`,
        reasonCode: input.reasonCode ?? `MANDATE_${rule.to}`,
        reason: input.reason,
      })
      .where(eq(tradingMandateStatesTable.id, current.state.id))
      .returning();
    if (!updated) throw new Error("Mandate transition was not persisted");
    await appendEvent(tx, {
      clientRequestId: input.clientRequestId,
      mandateId: current.mandate.id,
      userId: input.userId,
      section: input.section,
      eventType: `MANDATE_${rule.to}`,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      fromState: currentState,
      toState: rule.to,
      reasonCode: input.reasonCode ?? `MANDATE_${rule.to}`,
      reason: input.reason,
      fingerprint: current.mandate.fingerprint,
    });
    return toView(current.mandate, updated);
  });
}

export async function approveTradingMandate(input: {
  mandateId: number;
  userId: number;
  section: "crypto" | "forex";
  expectedRevision: number;
  clientRequestId: string;
  authorizationId: string;
  reason: string;
  actorUserId: number;
  sessionVersion: number;
  authorizationMethod: "PASSWORD_STEP_UP" | "BASIC_REAUTH";
}): Promise<TradingMandateView> {
  await expireTradingMandates(input.userId, input.section);
  return db.transaction(async (tx) => {
    const current = await loadLocked(tx, input);
    if (current.mandate.revision !== input.expectedRevision) {
      throw new MandateConflictError("Mandate revision is stale");
    }
    if (current.state.state === "ACTIVE") {
      const [originalAuthorization] = await tx
        .select()
        .from(tradingMandateAuthorizationsTable)
        .where(
          and(
            eq(tradingMandateAuthorizationsTable.mandateId, current.mandate.id),
            eq(
              tradingMandateAuthorizationsTable.authorizationId,
              input.authorizationId,
            ),
            eq(
              tradingMandateAuthorizationsTable.clientRequestId,
              input.clientRequestId,
            ),
          ),
        )
        .limit(1);
      if (originalAuthorization) {
        return toView(current.mandate, current.state);
      }
      throw new MandateConflictError(
        "The mandate is already active; a second or replayed authorization is refused",
      );
    }
    if (current.state.state !== "PENDING_APPROVAL") {
      throw new MandateConflictError(
        `Approval is not allowed from ${current.state.state}`,
      );
    }
    if (Date.now() >= current.mandate.expiresAt.getTime()) {
      throw new MandateConflictError("An expired mandate cannot be authorized");
    }
    const [replayedAuthorization] = await tx
      .select({ id: tradingMandateAuthorizationsTable.id })
      .from(tradingMandateAuthorizationsTable)
      .where(
        eq(
          tradingMandateAuthorizationsTable.authorizationId,
          input.authorizationId,
        ),
      )
      .limit(1);
    if (replayedAuthorization) {
      throw new MandateConflictError(
        "The step-up authorization identity has already been consumed",
      );
    }
    const active = await tx
      .select({
        mandate: tradingMandatesTable,
        state: tradingMandateStatesTable,
      })
      .from(tradingMandatesTable)
      .innerJoin(
        tradingMandateStatesTable,
        eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
      )
      .where(
        and(
          eq(tradingMandatesTable.userId, input.userId),
          eq(tradingMandatesTable.section, input.section),
          eq(tradingMandateStatesTable.state, "ACTIVE"),
          ne(tradingMandatesTable.id, current.mandate.id),
        ),
      )
      .for("update");
    for (const prior of active) {
      if (current.mandate.replacesMandateId !== prior.mandate.id) {
        throw new MandateConflictError(
          "Another active mandate exists and is not this revision's replacement target",
        );
      }
      await tx
        .update(tradingMandateStatesTable)
        .set({
          state: "REPLACED",
          lifecycleVersion: sql`${tradingMandateStatesTable.lifecycleVersion} + 1`,
          reasonCode: "MANDATE_REPLACED",
          reason: `Replaced by approved revision ${current.mandate.revision}`,
        })
        .where(eq(tradingMandateStatesTable.id, prior.state.id));
      await appendEvent(tx, {
        clientRequestId: `${input.clientRequestId}:replace`,
        mandateId: prior.mandate.id,
        userId: input.userId,
        section: input.section,
        eventType: "MANDATE_REPLACED",
        actorType: "HUMAN",
        actorUserId: input.actorUserId,
        fromState: "ACTIVE",
        toState: "REPLACED",
        reasonCode: "MANDATE_REPLACED",
        reason: input.reason,
        fingerprint: prior.mandate.fingerprint,
        payload: { replacementMandateId: current.mandate.id },
      });
    }
    await tx.insert(tradingMandateAuthorizationsTable).values({
      authorizationId: input.authorizationId,
      mandateId: current.mandate.id,
      userId: input.userId,
      section: input.section,
      mandateFingerprint: current.mandate.fingerprint,
      approvingHumanId: input.actorUserId,
      authorizationMethod: input.authorizationMethod,
      sessionVersion: input.sessionVersion,
      clientRequestId: input.clientRequestId,
      reason: input.reason,
    });
    const authorizedAt = new Date();
    const [updated] = await tx
      .update(tradingMandateStatesTable)
      .set({
        state: "ACTIVE",
        lifecycleVersion: sql`${tradingMandateStatesTable.lifecycleVersion} + 1`,
        reasonCode: "MANDATE_STEP_UP_AUTHORIZED",
        reason: input.reason,
        approvingHumanId: input.actorUserId,
        authorizationMethod: input.authorizationMethod,
        authorizationId: input.authorizationId,
        authorizedAt,
      })
      .where(eq(tradingMandateStatesTable.id, current.state.id))
      .returning();
    if (!updated) throw new Error("Mandate authorization was not persisted");
    await appendEvent(tx, {
      clientRequestId: input.clientRequestId,
      mandateId: current.mandate.id,
      userId: input.userId,
      section: input.section,
      eventType: "MANDATE_AUTHORIZED",
      actorType: "HUMAN",
      actorUserId: input.actorUserId,
      fromState: "PENDING_APPROVAL",
      toState: "ACTIVE",
      reasonCode: "MANDATE_STEP_UP_AUTHORIZED",
      reason: input.reason,
      fingerprint: current.mandate.fingerprint,
      payload: {
        authorizationId: input.authorizationId,
        authorizationMethod: input.authorizationMethod,
        revision: current.mandate.revision,
      },
    });
    return toView(current.mandate, updated);
  });
}

export async function listTradingMandates(
  userId: number,
  section: "crypto" | "forex",
): Promise<TradingMandateView[]> {
  await expireTradingMandates(userId, section);
  const rows = await db
    .select({ mandate: tradingMandatesTable, state: tradingMandateStatesTable })
    .from(tradingMandatesTable)
    .innerJoin(
      tradingMandateStatesTable,
      eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
    )
    .where(
      and(
        eq(tradingMandatesTable.userId, userId),
        eq(tradingMandatesTable.section, section),
      ),
    )
    .orderBy(
      desc(tradingMandatesTable.revision),
      desc(tradingMandatesTable.id),
    );
  return rows.map((row) => toView(row.mandate, row.state));
}

export async function getTradingMandateView(input: {
  mandateId: number;
  userId: number;
  section: "crypto" | "forex";
}): Promise<TradingMandateView> {
  await expireTradingMandates(input.userId, input.section);
  const [row] = await db
    .select({ mandate: tradingMandatesTable, state: tradingMandateStatesTable })
    .from(tradingMandatesTable)
    .innerJoin(
      tradingMandateStatesTable,
      eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
    )
    .where(
      and(
        eq(tradingMandatesTable.id, input.mandateId),
        eq(tradingMandatesTable.userId, input.userId),
        eq(tradingMandatesTable.section, input.section),
      ),
    )
    .limit(1);
  if (!row) throw new MandateNotFoundError("Trading mandate not found");
  return toView(row.mandate, row.state);
}

export async function getActiveTradingMandate(input: {
  userId: number;
  section: "crypto" | "forex";
}): Promise<{
  view: TradingMandateView;
  core: TradingMandateCore;
} | null> {
  await expireTradingMandates(input.userId, input.section);
  const [row] = await db
    .select({ mandate: tradingMandatesTable, state: tradingMandateStatesTable })
    .from(tradingMandatesTable)
    .innerJoin(
      tradingMandateStatesTable,
      eq(tradingMandateStatesTable.mandateId, tradingMandatesTable.id),
    )
    .where(
      and(
        eq(tradingMandatesTable.userId, input.userId),
        eq(tradingMandatesTable.section, input.section),
        eq(tradingMandateStatesTable.state, "ACTIVE"),
      ),
    )
    .limit(1);
  return row
    ? {
        view: toView(row.mandate, row.state),
        core: coreFromRecord(row.mandate),
      }
    : null;
}

export async function listTradingMandateEvents(
  userId: number,
  section: "crypto" | "forex",
  mandateId?: number,
  limit = 200,
) {
  return db
    .select()
    .from(tradingMandateEventsTable)
    .where(
      and(
        eq(tradingMandateEventsTable.userId, userId),
        eq(tradingMandateEventsTable.section, section),
        ...(mandateId === undefined
          ? []
          : [eq(tradingMandateEventsTable.mandateId, mandateId)]),
      ),
    )
    .orderBy(desc(tradingMandateEventsTable.occurredAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function listTradingMandateDecisions(
  userId: number,
  section: "crypto" | "forex",
  mandateId?: number,
  limit = 100,
) {
  return db
    .select()
    .from(tradingMandateDecisionClaimsTable)
    .where(
      and(
        eq(tradingMandateDecisionClaimsTable.userId, userId),
        eq(tradingMandateDecisionClaimsTable.section, section),
        ...(mandateId === undefined
          ? []
          : [eq(tradingMandateDecisionClaimsTable.mandateId, mandateId)]),
      ),
    )
    .orderBy(desc(tradingMandateDecisionClaimsTable.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export interface RestrictedLiveClaimIdentity {
  decisionId: string;
  decisionFingerprint: string;
  riskDecisionId: string;
  riskFingerprint: string;
  planFingerprint: string;
  configurationFingerprint: string;
  ownershipGeneration: number;
  idempotencyKey: string;
}

export async function evaluateAndClaimRestrictedLiveDecision(input: {
  mandateId: number;
  mandateFingerprint: string;
  userId: number;
  section: "crypto" | "forex";
  evidence: RestrictedLiveEvidence;
  identity: RestrictedLiveClaimIdentity;
}): Promise<
  | {
      allowed: true;
      claimId: number;
      evaluation: MandateEvaluation;
      core: TradingMandateCore;
    }
  | { allowed: false; evaluation: MandateEvaluation }
> {
  return db.transaction(async (tx) => {
    const current = await loadLocked(tx, input);
    if (current.mandate.fingerprint !== input.mandateFingerprint) {
      throw new MandateConflictError(
        "Mandate fingerprint changed or was tampered",
      );
    }
    const core = coreFromRecord(current.mandate);
    const evidence = {
      ...input.evidence,
      lifecycleState: TradingMandateStateSchema.parse(current.state.state),
    };
    const evaluation = evaluateRestrictedLiveEntry(core, evidence);
    const usageStatus = [
      evidence.aggregateExposure,
      evidence.canaryUsed,
      evidence.dailyLoss,
      evidence.weeklyLoss,
      evidence.monthlyLoss,
      evidence.drawdownBps,
      evidence.openPositionCount,
      evidence.openOrderCount,
    ].every((value) => value !== null)
      ? "CURRENT"
      : "UNAVAILABLE";
    await tx
      .update(tradingMandateUsageTable)
      .set({
        aggregateExposure: evidence.aggregateExposure?.toString() ?? null,
        canaryUsed: evidence.canaryUsed?.toString() ?? null,
        dailyLoss: evidence.dailyLoss?.toString() ?? null,
        weeklyLoss: evidence.weeklyLoss?.toString() ?? null,
        monthlyLoss: evidence.monthlyLoss?.toString() ?? null,
        drawdownBps: evidence.drawdownBps,
        openPositionCount: evidence.openPositionCount,
        openOrderCount: evidence.openOrderCount,
        decisionsLastHour: evidence.decisionsLastHour ?? 0,
        entriesLastHour: evidence.entriesLastHour ?? 0,
        status: usageStatus,
        staleReasons:
          usageStatus === "CURRENT"
            ? []
            : ["One or more server-authoritative usage inputs are unavailable"],
        observedAt: evidence.now,
        lastDecisionAt: evidence.now,
      })
      .where(eq(tradingMandateUsageTable.mandateId, current.mandate.id));
    if (!evaluation.allowed) {
      await tx
        .insert(tradingMandateDecisionClaimsTable)
        .values({
          mandateId: current.mandate.id,
          mandateRevision: current.mandate.revision,
          mandateFingerprint: current.mandate.fingerprint,
          userId: input.userId,
          section: input.section,
          ...input.identity,
          reservedRisk: evidence.perTradeRisk?.toString() ?? null,
          reservedNotional: evidence.positionNotional?.toString() ?? null,
          spreadBps: evidence.spreadBps,
          expectedSlippageBps: evidence.expectedSlippageBps,
          status: "REFUSED",
          reasonCode: evaluation.reasonCode,
          reason: evaluation.reason,
        })
        .onConflictDoNothing();
      return { allowed: false, evaluation };
    }
    const [claim] = await tx
      .insert(tradingMandateDecisionClaimsTable)
      .values({
        mandateId: current.mandate.id,
        mandateRevision: current.mandate.revision,
        mandateFingerprint: current.mandate.fingerprint,
        userId: input.userId,
        section: input.section,
        ...input.identity,
        reservedRisk: evidence.perTradeRisk!.toString(),
        reservedNotional: evidence.positionNotional!.toString(),
        spreadBps: evidence.spreadBps,
        expectedSlippageBps: evidence.expectedSlippageBps,
        status: "CLAIMED",
        reasonCode: "RESTRICTED_LIVE_AUTHORIZED",
        reason: evaluation.reason,
      })
      .onConflictDoNothing()
      .returning();
    if (!claim) {
      return {
        allowed: false,
        evaluation: {
          ...evaluation,
          allowed: false,
          reasonCode: "DUPLICATE_RESTRICTED_LIVE_DECISION",
          reason: "The exact mandate-bound decision was already claimed",
        },
      };
    }
    await tx
      .update(tradingMandateUsageTable)
      .set({
        decisionsLastHour: sql`${tradingMandateUsageTable.decisionsLastHour} + 1`,
      })
      .where(eq(tradingMandateUsageTable.mandateId, current.mandate.id));
    return { allowed: true, claimId: claim.id, evaluation, core };
  });
}

export async function completeRestrictedLiveDecision(input: {
  claimId: number;
  userId: number;
  section: "crypto" | "forex";
  status: "EXECUTED" | "FAILED" | "OUTCOME_UNKNOWN";
  reasonCode: string;
  reason: string;
  executionIntentId?: number;
  tradeId?: number;
  brokerCommandId?: string;
  brokerOrderId?: string;
  fillId?: string;
  realizedSlippageBps?: number;
  fillLatencyMs?: number;
  liveDemoDivergenceBps?: number;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(tradingMandateDecisionClaimsTable)
      .where(
        and(
          eq(tradingMandateDecisionClaimsTable.id, input.claimId),
          eq(tradingMandateDecisionClaimsTable.userId, input.userId),
          eq(tradingMandateDecisionClaimsTable.section, input.section),
        ),
      )
      .limit(1)
      .for("update");
    if (!claim || !["CLAIMED", "BOUNDARY_AUTHORIZED"].includes(claim.status))
      return;
    await tx
      .update(tradingMandateDecisionClaimsTable)
      .set({
        status: input.status,
        reasonCode: input.reasonCode,
        reason: input.reason,
        executionIntentId: input.executionIntentId ?? null,
        tradeId: input.tradeId ?? null,
        brokerCommandId: input.brokerCommandId ?? null,
        brokerOrderId: input.brokerOrderId ?? null,
        fillId: input.fillId ?? null,
        realizedSlippageBps: input.realizedSlippageBps ?? null,
        fillLatencyMs: input.fillLatencyMs ?? null,
        liveDemoDivergenceBps: input.liveDemoDivergenceBps ?? null,
      })
      .where(eq(tradingMandateDecisionClaimsTable.id, claim.id));
    if (input.status === "EXECUTED") {
      await tx
        .update(tradingMandateUsageTable)
        .set({
          entriesLastHour: sql`${tradingMandateUsageTable.entriesLastHour} + 1`,
        })
        .where(eq(tradingMandateUsageTable.mandateId, claim.mandateId));
    }
  });
}

/**
 * Last mandate check inside LiveExecutor's authorization callback. The state
 * row is locked before the claim becomes BOUNDARY_AUTHORIZED. A concurrent
 * revocation therefore has a deterministic order: it either commits first and
 * refuses this command, or this already-claimed command is recorded as the
 * final in-flight command while revocation blocks every later claim.
 */
export async function authorizeRestrictedLiveClaimAtBoundary(input: {
  context: import("./service").RestrictedLiveExecutionContext;
  userId: number;
  section: "crypto" | "forex";
  ownershipGeneration: number;
}): Promise<
  { allowed: true } | { allowed: false; code: string; reason: string }
> {
  return db.transaction(async (tx) => {
    const current = await loadLocked(tx, {
      mandateId: input.context.mandateId,
      userId: input.userId,
      section: input.section,
    });
    const [claim] = await tx
      .select()
      .from(tradingMandateDecisionClaimsTable)
      .where(
        and(
          eq(tradingMandateDecisionClaimsTable.id, input.context.claimId),
          eq(tradingMandateDecisionClaimsTable.mandateId, current.mandate.id),
          eq(tradingMandateDecisionClaimsTable.userId, input.userId),
          eq(tradingMandateDecisionClaimsTable.section, input.section),
        ),
      )
      .limit(1)
      .for("update");
    if (!claim) {
      return {
        allowed: false,
        code: "RESTRICTED_LIVE_CLAIM_MISSING",
        reason: "Durable Restricted Live decision claim is missing",
      };
    }
    if (claim.status === "BOUNDARY_AUTHORIZED") return { allowed: true };
    if (claim.status !== "CLAIMED") {
      return {
        allowed: false,
        code: "RESTRICTED_LIVE_CLAIM_NOT_EXECUTABLE",
        reason: `Restricted Live claim is ${claim.status}`,
      };
    }
    if (
      current.state.state !== "ACTIVE" ||
      current.mandate.expiresAt.getTime() <= Date.now()
    ) {
      return {
        allowed: false,
        code:
          current.state.state === "ACTIVE"
            ? "MANDATE_EXPIRED"
            : `MANDATE_${current.state.state}`,
        reason: "Mandate authority was removed before the Live boundary",
      };
    }
    if (
      current.mandate.revision !== input.context.mandateRevision ||
      current.mandate.fingerprint !== input.context.mandateFingerprint ||
      claim.mandateFingerprint !== input.context.mandateFingerprint ||
      claim.configurationFingerprint !==
        input.context.configurationFingerprint ||
      claim.ownershipGeneration !== input.ownershipGeneration
    ) {
      return {
        allowed: false,
        code: "MANDATE_BOUNDARY_IDENTITY_MISMATCH",
        reason: "Mandate, configuration, or ownership identity changed",
      };
    }
    await tx
      .update(tradingMandateDecisionClaimsTable)
      .set({
        status: "BOUNDARY_AUTHORIZED",
        reasonCode: "LIVE_BOUNDARY_AUTHORIZED",
        reason:
          "Exact mandate and Phase 11 identity were revalidated at the Live boundary",
      })
      .where(eq(tradingMandateDecisionClaimsTable.id, claim.id));
    return { allowed: true };
  });
}

export async function getTradingMandateUsage(mandateId: number) {
  const [usage] = await db
    .select()
    .from(tradingMandateUsageTable)
    .where(eq(tradingMandateUsageTable.mandateId, mandateId))
    .limit(1);
  return usage ?? null;
}
