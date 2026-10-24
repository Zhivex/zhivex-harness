import { AtomIcon, BrainIcon, CubeIcon, HexagonIcon, SparkleIcon, type Icon } from "@phosphor-icons/react";

const marks: Record<string, { icon: Icon; tone: string }> = {
  openai: { icon: HexagonIcon, tone: "emerald" },
  gemini: { icon: SparkleIcon, tone: "sky" },
  qwen: { icon: AtomIcon, tone: "violet" },
  anthropic: { icon: BrainIcon, tone: "amber" },
};

/** Small provider identity used in the model library and assistant rows. */
export function ProviderMark(props: { provider: string; className?: string }) {
  const key = props.provider.toLowerCase();
  const mark = marks[key] ?? { icon: CubeIcon, tone: "neutral" };
  const Icon = mark.icon;
  return <span aria-hidden="true" className={`provider-mark tone-${mark.tone}${props.className ? ` ${props.className}` : ""}`} data-provider={key}>
    <Icon size={16} />
  </span>;
}
