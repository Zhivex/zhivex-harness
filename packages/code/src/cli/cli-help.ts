import { shortCliHelp as sharedShortHelp, formatCliHelp as sharedHelp } from "@zhivex-ai/harness/terminal/cli-help";
export const shortCliHelp = (version: string) => sharedShortHelp(version).replaceAll("zhx", "zhivex-code").replaceAll("Zhivex Harness", "Zhivex Code").replace(/^.*supported aliases.*\n?/gm, "");
export const formatCliHelp: typeof sharedHelp = (...args) => sharedHelp(...args).replaceAll("zhx", "zhivex-code").replaceAll("Zhivex Harness", "Zhivex Code").replace(/^.*supported aliases.*\n?/gm, "");
