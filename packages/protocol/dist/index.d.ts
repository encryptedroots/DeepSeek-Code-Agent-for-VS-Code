import { z } from "zod";
export declare const agentResponseSchema: z.ZodEffects<z.ZodObject<{
    version: z.ZodLiteral<1>;
    plan: z.ZodString;
    operations: z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"create">;
        path: z.ZodEffects<z.ZodString, string, string>;
        content: z.ZodString;
    }, "strict", z.ZodTypeAny, {
        path: string;
        type: "create";
        content: string;
    }, {
        path: string;
        type: "create";
        content: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"replace">;
        path: z.ZodEffects<z.ZodString, string, string>;
        edits: z.ZodArray<z.ZodObject<{
            search: z.ZodString;
            replace: z.ZodString;
            expectedOccurrences: z.ZodOptional<z.ZodNumber>;
        }, "strict", z.ZodTypeAny, {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }, {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }>, "many">;
    }, "strict", z.ZodTypeAny, {
        path: string;
        type: "replace";
        edits: {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }[];
    }, {
        path: string;
        type: "replace";
        edits: {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }[];
    }>, z.ZodObject<{
        type: z.ZodLiteral<"delete">;
        path: z.ZodEffects<z.ZodString, string, string>;
    }, "strict", z.ZodTypeAny, {
        path: string;
        type: "delete";
    }, {
        path: string;
        type: "delete";
    }>]>, "many">;
    commands: z.ZodArray<z.ZodString, "many">;
    verification: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodString;
    clarification: z.ZodOptional<z.ZodString>;
    requestedFiles: z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">>;
    searches: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strict", z.ZodTypeAny, {
    version: 1;
    plan: string;
    operations: ({
        path: string;
        type: "create";
        content: string;
    } | {
        path: string;
        type: "replace";
        edits: {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }[];
    } | {
        path: string;
        type: "delete";
    })[];
    commands: string[];
    verification: string[];
    summary: string;
    clarification?: string | undefined;
    requestedFiles?: string[] | undefined;
    searches?: string[] | undefined;
}, {
    version: 1;
    plan: string;
    operations: ({
        path: string;
        type: "create";
        content: string;
    } | {
        path: string;
        type: "replace";
        edits: {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }[];
    } | {
        path: string;
        type: "delete";
    })[];
    commands: string[];
    verification: string[];
    summary: string;
    clarification?: string | undefined;
    requestedFiles?: string[] | undefined;
    searches?: string[] | undefined;
}>, {
    version: 1;
    plan: string;
    operations: ({
        path: string;
        type: "create";
        content: string;
    } | {
        path: string;
        type: "replace";
        edits: {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }[];
    } | {
        path: string;
        type: "delete";
    })[];
    commands: string[];
    verification: string[];
    summary: string;
    clarification?: string | undefined;
    requestedFiles?: string[] | undefined;
    searches?: string[] | undefined;
}, {
    version: 1;
    plan: string;
    operations: ({
        path: string;
        type: "create";
        content: string;
    } | {
        path: string;
        type: "replace";
        edits: {
            search: string;
            replace: string;
            expectedOccurrences?: number | undefined;
        }[];
    } | {
        path: string;
        type: "delete";
    })[];
    commands: string[];
    verification: string[];
    summary: string;
    clarification?: string | undefined;
    requestedFiles?: string[] | undefined;
    searches?: string[] | undefined;
}>;
export type AgentResponse = z.infer<typeof agentResponseSchema>;
export type FileOperation = AgentResponse["operations"][number];
export interface StructuredResponseProvider {
    request(prompt: string, responseLimit: number, signal: AbortSignal, onProgress?: (partial: string) => void, onActivity?: (activity: "thinking" | "answering") => void): Promise<string>;
}
export declare function requestStructuredPlan(provider: StructuredResponseProvider, task: string, context: string, responseLimit: number, signal: AbortSignal, onProgress?: (partial: string) => void, options?: {
    includeProtocol?: boolean;
    onActivity?: (activity: "thinking" | "answering") => void;
}): Promise<AgentResponse>;
export declare function validateDeepSeekChatUrl(input: string): string;
export declare const bridgeJobSchema: z.ZodObject<{
    id: z.ZodString;
    prompt: z.ZodString;
    responseLimit: z.ZodNumber;
    chatUrl: z.ZodEffects<z.ZodString, string, string>;
    newConversation: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    id: string;
    prompt: string;
    responseLimit: number;
    chatUrl: string;
    newConversation?: boolean | undefined;
}, {
    id: string;
    prompt: string;
    responseLimit: number;
    chatUrl: string;
    newConversation?: boolean | undefined;
}>;
export declare const bridgeResultSchema: z.ZodEffects<z.ZodObject<{
    id: z.ZodString;
    response: z.ZodOptional<z.ZodString>;
    error: z.ZodOptional<z.ZodString>;
    conversationUrl: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
}, "strict", z.ZodTypeAny, {
    id: string;
    response?: string | undefined;
    error?: string | undefined;
    conversationUrl?: string | undefined;
}, {
    id: string;
    response?: string | undefined;
    error?: string | undefined;
    conversationUrl?: string | undefined;
}>, {
    id: string;
    response?: string | undefined;
    error?: string | undefined;
    conversationUrl?: string | undefined;
}, {
    id: string;
    response?: string | undefined;
    error?: string | undefined;
    conversationUrl?: string | undefined;
}>;
export declare const bridgeProgressSchema: z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
}, "strict", z.ZodTypeAny, {
    id: string;
    text: string;
}, {
    id: string;
    text: string;
}>;
export declare const bridgeActivitySchema: z.ZodObject<{
    id: z.ZodString;
    activity: z.ZodEnum<["thinking", "answering"]>;
}, "strict", z.ZodTypeAny, {
    id: string;
    activity: "thinking" | "answering";
}, {
    id: string;
    activity: "thinking" | "answering";
}>;
export declare function parseAgentResponse(input: string): AgentResponse;
export declare function protocolInstructions(): string;
