import { DesktopIcon, MoonIcon, SunIcon } from "@phosphor-icons/react";
import type { ThemeChoice } from "./theme.js";

const options = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: DesktopIcon },
] as const;

/** Light, dark, and system. The header icon still cycles the same three choices. */
export function ThemeSelector(props: { choice: ThemeChoice; onChange: (choice: ThemeChoice) => void }) {
  return <fieldset className="theme-selector">
    <legend>Appearance</legend>
    <div className="theme-options">
      {options.map(({ value, label, icon: Icon }) => <label key={value}>
        <input type="radio" name="appearance" value={value} checked={props.choice === value} onChange={() => props.onChange(value)} />
        <span><Icon size={16} />{label}</span>
      </label>)}
    </div>
    <p>Saved in this browser. System follows this device.</p>
  </fieldset>;
}
