export const cactusTheme = {
  dark: {
    canvas: "#07110F",
    surface: "#0D1916",
    elevated: "#13231E",
    border: "#294039",
    text: "#F1F7F4",
    mutedText: "#A2B2AC",
    primary: "#58C99D",
    positive: "#34D399",
    negative: "#FB7185",
    warning: "#FBBF24",
    demo: "#38BDF8",
    practice: "#A78BFA",
    live: "#F97316",
    destructive: "#EF4444"
  },
  light: {
    canvas: "#F3F6F5",
    surface: "#FFFFFF",
    elevated: "#FFFFFF",
    border: "#C8D3CF",
    text: "#0B1713",
    mutedText: "#53645E",
    primary: "#167A5A",
    positive: "#087F5B",
    negative: "#BE123C",
    warning: "#9A6700",
    demo: "#0369A1",
    practice: "#6D28D9",
    live: "#C2410C",
    destructive: "#B91C1C"
  },
  spacing: [4, 8, 12, 16, 24, 32, 48] as const,
  motion: { fast: 120, standard: 180, deliberate: 240 } as const,
  radius: { control: 8, panel: 10 } as const
} as const;

export type CactusTheme = typeof cactusTheme;
