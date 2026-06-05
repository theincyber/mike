import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    OPENAI_LOW_MODELS,
    OPENAI_MID_MODELS,
    CLAUDE_MID_MODELS,
    providerForModel,
    isProviderEnabled,
    type UserApiKeys,
} from "./llm";
import { getUserApiKeys as getStoredUserApiKeys } from "./userApiKeys";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// Returns the best low-tier model for title generation, skipping disabled providers.
function resolveTitleModel(apiKeys: UserApiKeys): string {
    if (isProviderEnabled("gemini") && apiKeys.gemini?.trim()) return DEFAULT_TITLE_MODEL;
    if (isProviderEnabled("openai") && apiKeys.openai?.trim()) return OPENAI_LOW_MODELS[0];
    if (isProviderEnabled("claude") && apiKeys.claude?.trim()) return "claude-haiku-4-5";
    // No key available for an enabled provider — return the cheapest enabled model.
    if (isProviderEnabled("openai")) return OPENAI_LOW_MODELS[0];
    if (isProviderEnabled("claude")) return "claude-haiku-4-5";
    return DEFAULT_TITLE_MODEL;
}

// Returns the default tabular model for the first enabled provider.
function defaultTabularModel(): string {
    if (isProviderEnabled("gemini")) return DEFAULT_TABULAR_MODEL;
    if (isProviderEnabled("openai")) return OPENAI_MID_MODELS[0];
    if (isProviderEnabled("claude")) return CLAUDE_MID_MODELS[0];
    return DEFAULT_TABULAR_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("tabular_model")
        .eq("user_id", userId)
        .single();
    const api_keys = await getStoredUserApiKeys(userId, client);

    const fallbackTabular = defaultTabularModel();
    const resolvedTabular = resolveModel(data?.tabular_model, fallbackTabular);
    const tabular_model = isProviderEnabled(providerForModel(resolvedTabular))
        ? resolvedTabular
        : fallbackTabular;

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model,
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    return getStoredUserApiKeys(userId, client);
}
