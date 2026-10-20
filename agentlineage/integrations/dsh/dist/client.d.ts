export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export declare class LineageClient {
    private readonly token?;
    readonly baseUrl: string;
    constructor(baseUrl: string, token?: string | undefined);
    request(path: string, body?: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<JsonValue>;
    upload(name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<JsonValue>;
    private send;
}
