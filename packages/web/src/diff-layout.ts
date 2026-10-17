export const DIFF_LAYOUT_KEY = "zhivex.code.diffLayout.v1";
export const DIFF_MIN_WIDTH = 420;
export const CHAT_MIN_WIDTH = 360;
export const DIFF_HANDLE_PX = 24;
export const DIFF_MIN_HEIGHT = 240;
export const DIFF_CHROME_RESERVE = 200;
export const EMPTY_DIFF_WIDTH = 340;
export const SIDE_MIN_VIEWPORT = 1024;
export const NARROW_TABS = 640;
export const DEFAULT_DIFF_WIDTH = 960;
export const DEFAULT_DIFF_HEIGHT = 360;

export type DiffPosition = "side" | "bottom" | "full";
export interface DiffLayoutPreference {
  position: DiffPosition;
  widthPx: number;
  heightPx: number;
  minimized: boolean;
}

export const defaultDiffLayout = (): DiffLayoutPreference => ({
  position: "side",
  widthPx: DEFAULT_DIFF_WIDTH,
  heightPx: DEFAULT_DIFF_HEIGHT,
  minimized: false,
});

export function maxDiffWidth(viewportWidth: number) {
  return Math.max(DIFF_MIN_WIDTH, viewportWidth - CHAT_MIN_WIDTH - DIFF_HANDLE_PX);
}

export function maxDiffHeight(viewportHeight: number) {
  return Math.max(DIFF_MIN_HEIGHT, viewportHeight - DIFF_CHROME_RESERVE);
}

export function clampDiffWidth(width: number, viewportWidth: number) {
  return Math.min(Math.max(Math.round(width), DIFF_MIN_WIDTH), maxDiffWidth(viewportWidth));
}

export function clampDiffHeight(height: number, viewportHeight: number) {
  return Math.min(Math.max(Math.round(height), DIFF_MIN_HEIGHT), maxDiffHeight(viewportHeight));
}

export function readDiffLayout(raw: string | null): DiffLayoutPreference {
  const fallback = defaultDiffLayout();
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<DiffLayoutPreference>;
    const position = value.position === "bottom" || value.position === "full" || value.position === "side"
      ? value.position : fallback.position;
    return {
      position,
      widthPx: Number.isFinite(value.widthPx) ? Math.max(DIFF_MIN_WIDTH, Number(value.widthPx)) : fallback.widthPx,
      heightPx: Number.isFinite(value.heightPx) ? Math.max(DIFF_MIN_HEIGHT, Number(value.heightPx)) : fallback.heightPx,
      minimized: value.minimized === true,
    };
  } catch {
    return fallback;
  }
}

export function effectiveDiffPosition(preference: DiffPosition, viewportWidth: number): DiffPosition {
  if (preference === "side" && viewportWidth < SIDE_MIN_VIEWPORT) return "bottom";
  return preference;
}

export function sideFits(viewportWidth: number) {
  return viewportWidth >= SIDE_MIN_VIEWPORT;
}

export function nextDiffPosition(current: DiffPosition, viewportWidth: number): DiffPosition {
  const order: DiffPosition[] = sideFits(viewportWidth) ? ["side", "bottom", "full"] : ["bottom", "full"];
  const index = order.indexOf(current === "side" && !sideFits(viewportWidth) ? "bottom" : current);
  return order[(index + 1) % order.length] ?? "bottom";
}

export function nudgeDiffSize(value: number, key: string, shift: boolean, min: number, max: number) {
  if (key === "Home") return min;
  if (key === "End") return max;
  const step = shift ? 64 : 16;
  const direction = key === "ArrowRight" || key === "ArrowUp" ? 1 : key === "ArrowLeft" || key === "ArrowDown" ? -1 : 0;
  if (!direction) return value;
  return Math.min(max, Math.max(min, value + direction * step));
}
