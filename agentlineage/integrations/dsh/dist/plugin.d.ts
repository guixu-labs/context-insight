import type { Context } from "@deepseek-ai/cordis";
import { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";
import { LineageClient } from "./client.js";
import { Sessions } from "./sessions.js";
import { type RuntimeConfig } from "./runtime.js";
export declare const name = "dsh-agentlineage";
export declare const inject: string[];
export interface Config extends RuntimeConfig {
    learningUrl?: string;
    learningTokenEnv?: string;
    enableInvestigations?: boolean;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    mode: Schema<"managed" | "external", "managed" | "external">;
    coreUrl: Schema<string, string>;
    tokenEnv: Schema<string, string>;
    pythonPath: Schema<string, string>;
    dataDir: Schema<string, string>;
    startupTimeoutMs: Schema<number, number>;
    learningUrl: Schema<string, string>;
    learningTokenEnv: Schema<string, string>;
    enableInvestigations: Schema<boolean, boolean>;
}>, Schemastery.ObjectT<{
    mode: Schema<"managed" | "external", "managed" | "external">;
    coreUrl: Schema<string, string>;
    tokenEnv: Schema<string, string>;
    pythonPath: Schema<string, string>;
    dataDir: Schema<string, string>;
    startupTimeoutMs: Schema<number, number>;
    learningUrl: Schema<string, string>;
    learningTokenEnv: Schema<string, string>;
    enableInvestigations: Schema<boolean, boolean>;
}>>;
export declare function createTools(core: LineageClient, learning?: LineageClient, allowInvestigations?: boolean, sessions?: Sessions): ToolDefinition[];
export declare function apply(ctx: Context, config: Config): Promise<void>;
