import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { applyTheme, readThemeChoice } from "./theme.js";
import "./theme.css";
import "./style.css";
applyTheme(readThemeChoice(globalThis.localStorage), globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true);
createRoot(document.getElementById("root")!).render(<App />);
