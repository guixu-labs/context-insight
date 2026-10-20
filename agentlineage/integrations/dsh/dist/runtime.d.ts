import type { Context } from "@deepseek-ai/cordis";
import { LineageClient } from "./client.js";
export interface RuntimeConfig {
    mode?: "managed" | "external";
    coreUrl?: string;
    tokenEnv?: string;
    pythonPath?: string;
    dataDir?: string;
    startupTimeoutMs?: number;
}
export declare function stateDirectory(ctx: Context, config: RuntimeConfig): string;
export declare function connectCore(ctx: Context, config: RuntimeConfig, directory: string): Promise<LineageClient>;
