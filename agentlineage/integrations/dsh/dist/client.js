export class LineageClient {
    token;
    baseUrl;
    constructor(baseUrl, token) {
        this.token = token;
        const url = new URL(baseUrl);
        if (url.username || url.password || url.search || url.hash || url.pathname !== "/")
            throw new Error("Service URL must be an origin without credentials, query or path");
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
            throw new Error("Remote service requires HTTPS");
        this.baseUrl = url.origin;
    }
    async request(path, body, signal, timeoutMs = 30_000) {
        return this.send(path, body === undefined ? undefined : JSON.stringify(body), "application/json", signal, timeoutMs);
    }
    async upload(name, bytes, signal) {
        if (!bytes.length || bytes.length > 64 * 1024 * 1024)
            throw new Error("Source exceeds 64 MiB");
        return this.send("/v1/sources?format=auto&name=" + encodeURIComponent(name), new Uint8Array(bytes), "application/octet-stream", signal, 300000);
    }
    async send(path, body, mime, signal, timeoutMs) {
        if (!path.startsWith("/v1/") || path.includes("\\") || new URL(path, this.baseUrl).origin !== this.baseUrl)
            throw new Error("Invalid API path");
        const timeout = AbortSignal.timeout(timeoutMs);
        const response = await fetch(this.baseUrl + path, {
            method: body === undefined ? "GET" : "POST",
            headers: { ...(this.token ? { Authorization: "Bearer " + this.token } : {}),
                ...(body === undefined ? {} : { "Content-Type": mime }) },
            ...(body === undefined ? {} : { body }),
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            redirect: "error",
        });
        if (!response.ok)
            throw new Error("AgentLineage request failed (HTTP " + response.status + ")");
        const reader = response.body?.getReader();
        if (!reader)
            throw new Error("Missing response body");
        const chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                if (size > 8 * 1024 * 1024)
                    throw new Error("Response exceeds 8 MiB; paginate query");
                chunks.push(value);
            }
        }
        finally {
            await reader.cancel();
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
}
