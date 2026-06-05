import type {
    LlmMessage,
    NormalizedToolCall,
    NormalizedToolResult,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 16384;

// ---------------------------------------------------------------------------
// Azure OpenAI configuration
// ---------------------------------------------------------------------------
// Set all three env vars to route OpenAI calls through your Azure tenancy
// instead of api.openai.com. Data then stays within your Azure subscription.
//   AZURE_OPENAI_ENDPOINT   — https://<resource>.openai.azure.com
//   AZURE_OPENAI_DEPLOYMENT — name of your Azure deployment (e.g. "gpt-4o")
//   AZURE_OPENAI_API_KEY    — Azure resource API key (overrides OPENAI_API_KEY)
//   AZURE_OPENAI_API_VERSION — defaults to 2024-08-01-preview

type AzureConfig = {
    endpoint: string;
    deployment: string;
    apiVersion: string;
};

function getAzureConfig(): AzureConfig | null {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, "");
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    if (!endpoint || !deployment) return null;
    return {
        endpoint,
        deployment,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-08-01-preview",
    };
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function apiKey(override?: string | null): string {
    const azure = getAzureConfig();
    const key =
        override?.trim() ||
        (azure ? process.env.AZURE_OPENAI_API_KEY?.trim() : undefined) ||
        process.env.OPENAI_API_KEY?.trim() ||
        "";
    if (!key) {
        throw new Error(
            "OpenAI API key is not configured. Set OPENAI_API_KEY (or AZURE_OPENAI_API_KEY for Azure) or add a user OpenAI key.",
        );
    }
    return key;
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
    const events: unknown[] = [];
    const chunks = buffer.split(/\n\n/);
    const rest = chunks.pop() ?? "";

    for (const chunk of chunks) {
        const dataLines = chunk
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());

        for (const data of dataLines) {
            if (!data || data === "[DONE]") continue;
            try {
                events.push(JSON.parse(data));
            } catch {
                // Incomplete events stay buffered until the next read.
            }
        }
    }

    return { events, rest };
}

// ---------------------------------------------------------------------------
// Azure Chat Completions types
// ---------------------------------------------------------------------------

type AzureToolCallDelta = {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
};

type AzureChatChunk = {
    choices: {
        index: number;
        delta: {
            role?: string;
            content?: string | null;
            tool_calls?: AzureToolCallDelta[];
        };
        finish_reason?: string | null;
    }[];
};

type AzureToolCallObj = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

type ChatMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: AzureToolCallObj[] }
    | { role: "tool"; tool_call_id: string; content: string };

type AzureFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
    };
};

// ---------------------------------------------------------------------------
// Azure Chat Completions implementation
// ---------------------------------------------------------------------------

async function fetchAzureChatCompletion(
    azure: AzureConfig,
    messages: ChatMessage[],
    tools: AzureFunctionTool[],
    stream: boolean,
    key: string,
    maxTokens: number,
): Promise<Response> {
    const url = `${azure.endpoint}/openai/deployments/${azure.deployment}/chat/completions?api-version=${azure.apiVersion}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "api-key": key,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            messages,
            tools: tools.length ? tools : undefined,
            tool_choice: tools.length ? "auto" : undefined,
            max_completion_tokens: maxTokens,
            stream,
        }),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const err = new Error(
            `Azure OpenAI request failed (${response.status}): ${text || response.statusText}`,
        );
        (err as { status?: number }).status = response.status;
        throw err;
    }
    return response;
}

async function streamAzure(
    params: StreamChatParams,
    azure: AzureConfig,
): Promise<StreamChatResult> {
    const { systemPrompt, tools = [], callbacks = {}, runTools, apiKeys } = params;
    const maxIter = params.maxIterations ?? 10;
    const key = apiKey(apiKeys?.openai);

    const azureTools: AzureFunctionTool[] = tools.map((t) => ({
        type: "function",
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        },
    }));

    const messages: ChatMessage[] = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    for (const msg of params.messages) {
        messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
    }

    let fullText = "";

    for (let iter = 0; iter < maxIter; iter++) {
        const response = await fetchAzureChatCompletion(
            azure,
            messages,
            azureTools,
            true,
            key,
            MAX_OUTPUT_TOKENS,
        );
        if (!response.body) throw new Error("Azure OpenAI response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const tcAccumulators = new Map<number, { id: string; name: string; args: string }>();
        const notifiedIds = new Set<string>();
        let iterText = "";
        let finishReason: string | null = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = extractSseJson(buffer);
            buffer = rest;

            for (const event of events as AzureChatChunk[]) {
                const choice = event.choices?.[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;

                const delta = choice.delta;

                if (typeof delta.content === "string") {
                    iterText += delta.content;
                    callbacks.onContentDelta?.(delta.content);
                }

                for (const tc of delta.tool_calls ?? []) {
                    if (!tcAccumulators.has(tc.index)) {
                        tcAccumulators.set(tc.index, { id: "", name: "", args: "" });
                    }
                    const acc = tcAccumulators.get(tc.index)!;
                    if (tc.id) acc.id = tc.id;
                    if (tc.function?.name) acc.name += tc.function.name;
                    if (tc.function?.arguments) acc.args += tc.function.arguments;

                    if (acc.id && acc.name && !notifiedIds.has(acc.id)) {
                        notifiedIds.add(acc.id);
                        callbacks.onToolCallStart?.({ id: acc.id, name: acc.name, input: {} });
                    }
                }
            }
        }

        if (finishReason !== "tool_calls" || !runTools || !tcAccumulators.size) {
            fullText += iterText;
            break;
        }

        // Build normalised tool calls from accumulated stream fragments
        const toolCalls: NormalizedToolCall[] = [];
        const assistantToolCalls: AzureToolCallObj[] = [];

        for (const acc of tcAccumulators.values()) {
            let input: Record<string, unknown> = {};
            try {
                const parsed = JSON.parse(acc.args || "{}");
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    input = parsed as Record<string, unknown>;
                }
            } catch {
                input = {};
            }
            toolCalls.push({ id: acc.id, name: acc.name, input });
            assistantToolCalls.push({
                id: acc.id,
                type: "function",
                function: { name: acc.name, arguments: acc.args },
            });
        }

        messages.push({ role: "assistant", content: iterText || null, tool_calls: assistantToolCalls });

        const results = await runTools(toolCalls);
        for (const result of results) {
            messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
        }
    }

    return { fullText };
}

async function completeAzureText(
    azure: AzureConfig,
    params: {
        systemPrompt?: string;
        user: string;
        maxTokens?: number;
        apiKeys?: { openai?: string | null };
    },
): Promise<string> {
    const key = apiKey(params.apiKeys?.openai);
    const messages: ChatMessage[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.user });

    const response = await fetchAzureChatCompletion(
        azure,
        messages,
        [],
        false,
        key,
        params.maxTokens ?? 512,
    );
    const json = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[];
    };
    return json.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Standard OpenAI Responses API implementation
// ---------------------------------------------------------------------------

type ResponseInputItem =
    | { role: "user" | "assistant"; content: string }
    | { type: "function_call_output"; call_id: string; output: string };

type ResponseFunctionTool = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
};

type ResponseFunctionCallItem = {
    type: "function_call";
    call_id?: string;
    name?: string;
    arguments?: string;
};

type ResponseStreamEvent = {
    type?: string;
    delta?: string;
    response?: { id?: string; output_text?: string };
    item?: ResponseFunctionCallItem;
};

function toResponseTools(tools: OpenAIToolSchema[]): ResponseFunctionTool[] {
    return tools.map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
}

function toResponseInput(messages: LlmMessage[]): ResponseInputItem[] {
    return messages.map((message) => ({
        role: message.role,
        content: message.content,
    }));
}

function parseFunctionCall(item: ResponseFunctionCallItem): NormalizedToolCall {
    let input: Record<string, unknown> = {};
    try {
        const parsed = JSON.parse(item.arguments || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
        }
    } catch {
        input = {};
    }

    return {
        id: item.call_id ?? item.name ?? "function_call",
        name: item.name ?? "",
        input,
    };
}

async function createResponse(params: {
    model: string;
    input: ResponseInputItem[];
    instructions?: string;
    tools?: ResponseFunctionTool[];
    stream?: boolean;
    maxTokens?: number;
    previousResponseId?: string;
    reasoningSummary?: boolean;
    apiKey: string;
}): Promise<Response> {
    const response = await fetch(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${params.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: params.model,
            instructions: params.instructions || undefined,
            input: params.input,
            tools: params.tools?.length ? params.tools : undefined,
            stream: params.stream,
            max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
            previous_response_id: params.previousResponseId,
            reasoning: params.reasoningSummary
                ? { summary: "auto" }
                : undefined,
        }),
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        const err = new Error(
            `OpenAI request failed (${response.status}): ${text || response.statusText}`,
        );
        (err as { status?: number }).status = response.status;
        throw err;
    }

    return response;
}

async function streamOpenAIResponses(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const {
        model,
        systemPrompt,
        tools = [],
        callbacks = {},
        runTools,
        apiKeys,
        enableThinking,
    } = params;
    const maxIter = params.maxIterations ?? 10;
    const key = apiKey(apiKeys?.openai);
    const responseTools = toResponseTools(tools);
    let input = toResponseInput(params.messages);
    let previousResponseId: string | undefined;
    let fullText = "";
    const hasTools = responseTools.length > 0;

    for (let iter = 0; iter < maxIter; iter++) {
        const response = await createResponse({
            model,
            instructions: iter === 0 ? systemPrompt : undefined,
            input,
            tools: responseTools,
            stream: true,
            previousResponseId,
            reasoningSummary: !!enableThinking,
            apiKey: key,
        });
        if (!response.body) throw new Error("OpenAI response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const toolCalls: NormalizedToolCall[] = [];
        const startedToolCallIds = new Set<string>();
        let buffer = "";
        let pendingText = "";
        let sawReasoning = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const extracted = extractSseJson(buffer);
            buffer = extracted.rest;

            for (const event of extracted.events as ResponseStreamEvent[]) {
                if (event.response?.id) {
                    previousResponseId = event.response.id;
                }

                if (
                    event.type === "response.reasoning_summary_text.delta" &&
                    typeof event.delta === "string"
                ) {
                    sawReasoning = true;
                    callbacks.onReasoningDelta?.(event.delta);
                }

                if (
                    event.type === "response.output_text.delta" &&
                    typeof event.delta === "string"
                ) {
                    if (hasTools) {
                        pendingText += event.delta;
                    } else {
                        fullText += event.delta;
                        callbacks.onContentDelta?.(event.delta);
                    }
                }

                if (
                    event.type === "response.output_item.added" &&
                    event.item?.type === "function_call"
                ) {
                    const call = parseFunctionCall(event.item);
                    startedToolCallIds.add(call.id);
                    callbacks.onToolCallStart?.(call);
                }

                if (
                    event.type === "response.output_item.done" &&
                    event.item?.type === "function_call"
                ) {
                    const call = parseFunctionCall(event.item);
                    if (!startedToolCallIds.has(call.id)) {
                        callbacks.onToolCallStart?.(call);
                    }
                    toolCalls.push(call);
                }
            }
        }

        if (sawReasoning) callbacks.onReasoningBlockEnd?.();

        if (!toolCalls.length || !runTools) {
            if (pendingText) {
                fullText += pendingText;
                callbacks.onContentDelta?.(pendingText);
            }
            break;
        }

        const results = await runTools(toolCalls);
        input = results.map((result) => ({
            type: "function_call_output",
            call_id: result.tool_use_id,
            output: result.content,
        }));
    }

    return { fullText };
}

async function completeOpenAIResponsesText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const response = await createResponse({
        model: params.model,
        instructions: params.systemPrompt,
        input: [{ role: "user", content: params.user }],
        maxTokens: params.maxTokens ?? 512,
        apiKey: apiKey(params.apiKeys?.openai),
    });
    const json = (await response.json()) as {
        output_text?: string;
        output?: {
            content?: { type?: string; text?: string }[];
        }[];
    };

    if (typeof json.output_text === "string") return json.output_text;

    return (
        json.output
            ?.flatMap((item) => item.content ?? [])
            .filter((content) => content.type === "output_text")
            .map((content) => content.text ?? "")
            .join("") ?? ""
    );
}

// ---------------------------------------------------------------------------
// Exports — dispatch to Azure or standard OpenAI based on configuration
// ---------------------------------------------------------------------------

export async function streamOpenAI(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const azure = getAzureConfig();
    if (azure) return streamAzure(params, azure);
    return streamOpenAIResponses(params);
}

export async function completeOpenAIText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { openai?: string | null };
}): Promise<string> {
    const azure = getAzureConfig();
    if (azure) return completeAzureText(azure, params);
    return completeOpenAIResponsesText(params);
}

export type { NormalizedToolResult };
