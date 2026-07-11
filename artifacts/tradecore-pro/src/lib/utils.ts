import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(value: number | null | undefined, signDisplay: "auto" | "always" | "never" = "auto") {
  if (value == null) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    signDisplay,
  }).format(value);
}

export function formatPercent(value: number | null | undefined) {
  if (value == null) return "0.00%";
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value / 100);
}

export function formatNumber(value: number | null | undefined, decimals = 2) {
  if (value == null) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value);
}

export function formatDate(dateStr: string | null | undefined) {
  if (!dateStr) return "-";
  const d = new Date(dateStr);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}
