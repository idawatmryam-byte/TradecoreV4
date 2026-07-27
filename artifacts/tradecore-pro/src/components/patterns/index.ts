/**
 * Shared page-level compositions.
 *
 * `ui/` holds primitives (a Button, a Card). This holds the patterns built
 * from them that every page needs and that were previously re-invented per
 * page: a title block, a stat tile, an empty state, a loading skeleton, a
 * foldable section, route tabs.
 *
 * If two pages need the same thing, it belongs here rather than in one of
 * them — that is exactly how three different stat tiles and four different
 * loading states came to exist.
 */
export { PageHeader, PageTabs } from "./page-header";
export { StatTile } from "./stat-tile";
export { EmptyState } from "./empty-state";
export { CollapsibleSection } from "./collapsible-section";
export { LoadingRows, LoadingCards, LoadingFields } from "./loading-state";
