/**
 * The app's UI primitives — a barrel, not an implementation.
 *
 * This file used to be a second, parallel component library: its own Card,
 * Button, Badge, Input, Label, Switch and Table, hand-rolled alongside the
 * stock set in `src/components/ui/`. Fifteen files imported from here, six
 * from there, and `backtest.tsx` and `stats.tsx` imported from BOTH — so a
 * Badge on Backtesting and a Badge on the Dashboard were different components
 * with different shapes, and the same `variant="outline"` meant two things.
 *
 * The fork existed for a real reason: `ui/button.tsx` and `ui/badge.tsx` were
 * vendored with references to tokens this project never defined
 * (`--button-outline`, `--badge-outline`, `border-primary-border`,
 * `hover-elevate`), so they rendered with no hover state and broken borders.
 * Rather than fix them, someone wrote working copies here.
 *
 * Those two files are now fixed and carry the working variants, so this file
 * has nothing left to implement. Vite resolves `@/components/ui` to this
 * module before the directory of the same name, so every existing import site
 * keeps working untouched while resolving to a single implementation.
 *
 * Add nothing here. New primitives go in `src/components/ui/` and get
 * re-exported below; shared compositions go in `src/components/patterns/`.
 */
export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
export { Button, buttonVariants, type ButtonProps } from "@/components/ui/button";
export { Badge, badgeVariants, type BadgeProps } from "@/components/ui/badge";
export { Input } from "@/components/ui/input";
export { Label } from "@/components/ui/label";
export { Switch } from "@/components/ui/switch";
export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
} from "@/components/ui/table";
export { Skeleton } from "@/components/ui/skeleton";
export { Separator } from "@/components/ui/separator";
