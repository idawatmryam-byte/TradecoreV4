import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * A trader's desired strategy availability by intelligence mode.
 *
 * This is deliberately separate from strategy_configs.enabled:
 * - enabled is the strategy's master runtime switch;
 * - these flags choose where an enabled strategy may be considered.
 *
 * AutoPilot flags are desired-next configuration only. Immutable active
 * mandates remain the financial authority until a replacement is reviewed
 * and approved through the existing mandate workflow.
 */
export const strategyModeAssignmentsTable = pgTable(
  "strategy_mode_assignments",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").notNull(),
    section: text("section").notNull(),
    strategyId: text("strategy_id").notNull(),
    brainEnabled: boolean("brain_enabled").notNull().default(true),
    copilotEnabled: boolean("copilot_enabled").notNull().default(true),
    autopilotEnabled: boolean("autopilot_enabled").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("strategy_mode_assignments_user_section_strategy_unique").on(
      table.userId,
      table.section,
      table.strategyId,
    ),
    check(
      "strategy_mode_assignments_section_check",
      sql`${table.section} IN ('crypto', 'forex')`,
    ),
    check(
      "strategy_mode_assignments_revision_positive_check",
      sql`${table.revision} >= 1`,
    ),
  ],
);

export type StrategyModeAssignment =
  typeof strategyModeAssignmentsTable.$inferSelect;
