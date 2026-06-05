"use client";

import { useState } from "react";
import { ChevronDown, Check, AlertCircle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isModelAvailable } from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/mikeApi";

export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI";
}

// All model definitions — kept intact so providers can be re-enabled by
// updating NEXT_PUBLIC_ENABLED_PROVIDERS without touching this file.
const ALL_MODELS: ModelOption[] = [
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", group: "OpenAI" },
];

const PROVIDER_TO_GROUP: Record<string, ModelOption["group"]> = {
    claude: "Anthropic",
    gemini: "Google",
    openai: "OpenAI",
};

// Preferred default model per provider (the mid-tier option for each).
const PROVIDER_DEFAULTS: Record<string, string> = {
    openai: "gpt-5.4-mini",
    gemini: "gemini-3-flash-preview",
    claude: "claude-sonnet-4-6",
};

// Resolve which model groups are active from the env var.
// Set NEXT_PUBLIC_ENABLED_PROVIDERS=openai (comma-separated provider names)
// to restrict the UI to specific providers. Unset = all providers shown.
function buildEnabledGroups(): Set<ModelOption["group"]> {
    const env = process.env.NEXT_PUBLIC_ENABLED_PROVIDERS?.trim();
    if (!env) return new Set(Object.values(PROVIDER_TO_GROUP) as ModelOption["group"][]);
    return new Set(
        env
            .split(",")
            .map((p) => PROVIDER_TO_GROUP[p.trim().toLowerCase()])
            .filter((g): g is ModelOption["group"] => !!g),
    );
}

const ENABLED_GROUPS = buildEnabledGroups();

// Active models — filtered by NEXT_PUBLIC_ENABLED_PROVIDERS.
export const MODELS: ModelOption[] = ALL_MODELS.filter((m) =>
    ENABLED_GROUPS.has(m.group),
);

// Default model: the preferred mid-tier model for the first enabled provider.
function resolveDefaultModelId(): string {
    const env = process.env.NEXT_PUBLIC_ENABLED_PROVIDERS?.trim();
    if (!env) return "gemini-3-flash-preview"; // original default when all providers active
    const firstProvider = env.split(",")[0]?.trim().toLowerCase();
    return PROVIDER_DEFAULTS[firstProvider] ?? MODELS[0]?.id ?? "gpt-5.4-mini";
}

export const DEFAULT_MODEL_ID: string = resolveDefaultModelId();
export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

const GROUP_TO_PROVIDER: Record<ModelOption["group"], string> = {
    Anthropic: "claude",
    Google: "gemini",
    OpenAI: "openai",
};

// Set of provider names (claude / gemini / openai) that are currently enabled.
export const ENABLED_PROVIDER_NAMES: Set<string> = new Set(
    MODELS.map((m) => GROUP_TO_PROVIDER[m.group]),
);

const GROUP_ORDER: ModelOption["group"][] = ["Anthropic", "Google", "OpenAI"];

interface Props {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
}

export function ModelToggle({ value, onChange, apiKeys }: Props) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedLabel = selected?.label ?? "Model";
    const selectedAvailable = apiKeys
        ? isModelAvailable(value, apiKeys)
        : true;

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={`flex items-center gap-1.5 rounded-lg px-2 h-8 text-sm transition-colors cursor-pointer text-gray-400 hover:bg-gray-100 hover:text-gray-700 ${isOpen ? "bg-gray-100 text-gray-700" : ""}`}
                    title={
                        !selectedAvailable
                            ? "API key missing for selected model"
                            : "Choose model"
                    }
                >
                    {!selectedAvailable && (
                        <AlertCircle className="h-3 w-3 shrink-0 text-red-500" />
                    )}
                    <span className="max-w-[140px] truncate">{selectedLabel}</span>
                    <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56 z-50" side="top" align="start">
                {GROUP_ORDER.map((group, gi) => {
                    const items = MODELS.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys)
                                    : true;
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle
                                                className="h-3.5 w-3.5 text-red-500 ml-1"
                                                aria-label="API key missing"
                                            />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
