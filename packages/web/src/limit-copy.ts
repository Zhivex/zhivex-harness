export const counted = (count: number, singular: string) => `${count} ${singular}${count === 1 ? "" : "s"}`;
