/** Direction B palette. Contrast figures are the WCAG 2.x ratio against the darkest surface in that theme. */
export const palette = {
  light: {
    bg: "#faf8f6",
    surface: "#ffffff",
    surface2: "#f3efeb",
    text: "#1a1514",
    secondary: "#5f5752",
    accent: "#c30500",
    focus: "#c30500",
    pending: "#8f5200",
    approved: "#1b6e45",
    rejected: "#5c5552",
    stale: "#3a5a96",
    error: "#a3121c",
    diffAddText: "#14532d",
    diffAddBg: "#e4f2e9",
    diffDelText: "#8b1a12",
    diffDelBg: "#f9e5e2",
  },
  dark: {
    bg: "#0c0a0a",
    surface: "#161313",
    surface2: "#1f1b1a",
    text: "#f2eeec",
    secondary: "#ada39f",
    accent: "#ff3b30",
    focus: "#ff5a4f",
    pending: "#f2b65c",
    approved: "#63cf95",
    rejected: "#b0a8a5",
    stale: "#8fb0ff",
    error: "#ff8b85",
    diffAddText: "#9be3b6",
    diffAddBg: "#122419",
    diffDelText: "#ffb4ac",
    diffDelBg: "#2d1412",
  },
} as const;

export function contrastRatio(foreground: string, background: string) {
  const channel = (hex: string) => {
    const value = Number.parseInt(hex, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (color: string) => {
    const hex = color.slice(1);
    return 0.2126 * channel(hex.slice(0, 2)) + 0.7152 * channel(hex.slice(2, 4)) + 0.0722 * channel(hex.slice(4, 6));
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}
