/**
 * A small, single-source palette. Every component imports these values so the
 * TUI stays visually coherent without a theme runtime.
 */
export const theme = {
  background: "#16161e",
  surface: "#1a1b26",
  surfaceRaised: "#1f2335",
  border: "#2f3549",
  text: "#c0caf5",
  textMuted: "#7a88b8",
  textDim: "#565f89",
  accent: "#7aa2f7",
  accentSoft: "#2ac3de",
  success: "#9ece6a",
  warning: "#e0af68",
  danger: "#f7768e",
  purple: "#bb9af7",
} as const;
