import type { Context } from "@deepseek-ai/cordis";
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { LineageClient, type JsonValue } from "./client.js";
export interface Binding {
    snapshot_id: string;
    run_id: string;
    at: string | null;
    session_ids: string[];
    records: number;
}
type Exec = Pick<ToolExecution, "agent" | "signal">;
export declare class Sessions {
    private ctx;
    private core;
    private directory;
    private bindings;
    private tail;
    constructor(ctx: Context, core: LineageClient, directory: string);
    load(): Promise<void>;
    private owner;
    current(exec: Exec): Binding | null;
    private exclusive;
    private remember;
    list(args: {
        query?: string;
        offset?: number;
        limit?: number;
    }, exec: Exec): Promise<JsonValue>;
    bind(snapshotId: string, exec: Exec): Promise<Binding>;
    resolve(snapshotId: string | undefined, exec: Exec): Promise<Binding>;
    import(args: {
        session_id?: string;
        paths?: string[];
        include_children?: boolean;
    }, exec: Exec, onlyIfMissing?: boolean): Promise<Binding>;
}
export {};
