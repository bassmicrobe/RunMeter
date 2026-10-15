import type { ProviderId } from "@/lib/runmeter-types";

type ProviderConsoleLink = {
  label: string;
  url: string;
  scope: string;
};

export const PROVIDER_CONSOLE_LINKS: Record<ProviderId, ProviderConsoleLink> = {
  codex: {
    label: "Codexの利用状況",
    url: "https://chatgpt.com/codex/settings/usage",
    scope: "ChatGPTプランに含まれるCodexの利用枠とクレジットを確認できます。",
  },
  claude: {
    label: "Claudeの利用状況",
    url: "https://claude.ai/settings/usage",
    scope: "Claude Codeで使うPro・Maxプランの利用枠です。Claude Codeの /usage でも確認できます。",
  },
  gemini: {
    label: "AI Studioの利用状況",
    url: "https://aistudio.google.com/usage",
    scope: "選択したGoogle CloudプロジェクトのGemini API利用量と上限です。",
  },
};
