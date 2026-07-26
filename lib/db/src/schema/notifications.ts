import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// In-app notifications — a second, in-app channel for the exact same events
// that already fire the risk-alert webhook (circuit breaker, risk pause,
// untracked-position alerts, startup reconciliation failures). Today those
// only reach a user who has configured alertWebhookUrl; a user without one
// has no way to learn their bot paused itself except by opening the
// dashboard. Wired once, at the sendAlert() chokepoint every alert already
// funnels through (botEngine.ts) — additive, never touches the webhook path.
// ---------------------------------------------------------------------------
export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  /** Independent trading section (crypto | forex) this alert concerns. */
  section: text("section").notNull().default("crypto"),
  /** All alerts are "risk" today (the only producer is sendAlert()); the
   *  column exists so future producers (e.g. Co-Pilot recommendations) can
   *  add their own type without a migration. */
  type: text("type").notNull().default("risk"),
  message: text("message").notNull(),
  severity: text("severity").notNull().default("warning"), // info | warning | critical
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp("read_at", { withTimezone: true }),
}, (t) => [
  // Queried on every poll: WHERE user_id = ? AND section = ? ORDER BY id DESC
  index("notifications_user_section_idx").on(t.userId, t.section),
  // Unread-count query: WHERE user_id = ? AND read_at IS NULL
  index("notifications_user_read_at_idx").on(t.userId, t.readAt),
]);

export const insertNotificationSchema = createInsertSchema(notificationsTable).omit({ id: true, createdAt: true });
export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type NotificationRow = typeof notificationsTable.$inferSelect;
