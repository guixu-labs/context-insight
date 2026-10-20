"""Lossless response packing; budget the entire escaped UTF-8 text, not each item."""

import json

# Below the observed 10k-token host ceiling even for non-ASCII/code-heavy text.
# Leave room for the MCP/host wrapper. This is not a promise for arbitrary hosts
# or callers that concatenate several independent tool responses themselves.
RESPONSE_BYTES = 9000
FRAME_BYTES = 6900  # A cached frame must leave room for deferred batch cursors.


def wire_size(text):
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def allocate(lengths, budget):
    """Share the remaining byte budget, finishing short packets when possible."""
    count = len(lengths)
    if not count:
        return []
    floor = budget // count
    limits = [min(size, floor) for size in lengths]
    remaining = budget - sum(limits)
    # Finish short packets first, without changing query/execution/output order.
    for i in sorted(range(count), key=lambda i: (lengths[i], i)):
        need = lengths[i] - limits[i]
        if need <= remaining:
            limits[i] += need
            remaining -= need
    pending = [i for i in range(count) if limits[i] < lengths[i]]
    if pending:
        share, extra = divmod(remaining, len(pending))
        for rank, i in enumerate(pending):
            limits[i] += share + (rank < extra)
    return limits


def frame_text(page, end):
    identity, body, offset = page["result_id"], page["body"], page["offset"]
    context = page.get("context")
    if context and wire_size(json.dumps(context, ensure_ascii=False)) > 600:
        # The complete context already lives in the saved query body. Do not
        # repeat arbitrarily long paths/arguments on every continuation frame.
        context = {
            **{
                k: context[k]
                for k in ("cite", "scope_id", "at", "record_owner")
                if isinstance(context.get(k), str) and len(context[k]) <= 128
            },
            "details_in_result": identity,
            "offset": 0,
            "note": "Full source/scope/request context is in the saved body.",
        }
    return (
        f"RESULT {identity} chars={len(body)} range={offset}:{end}\n"
        + body[offset:end]
        + f"\nEND FRAME next={end if end < len(body) else 'none'}; "
        "server_sent_only; not proof of model visibility or understanding"
        + (
            "; CONTEXT "
            + json.dumps(context, ensure_ascii=False, separators=(",", ":"))
            if context
            else ""
        )
    )


def fit_frame(page, budget):
    """Fit on Unicode character boundaries, retaining absolute body offsets."""
    offset, total = page["offset"], len(page["body"])
    low, high = offset, min(total, offset + budget)
    while low < high:
        middle = (low + high + 1) // 2
        if wire_size(frame_text(page, middle)) <= budget:
            low = middle
        else:
            high = middle - 1
    text = frame_text(page, low)
    if wire_size(text) > budget or (low == offset and offset < total):
        raise ValueError("response budget cannot fit a frame with progress")
    return text


def pack(pages):
    """Return bounded response and actually emitted frames. Never slice a cache.

    A cached frame is immutable. If it cannot fit beside the other items, defer
    that whole item with the same cursor rather than claiming it was emitted.
    """

    def deferred(rest):
        return (
            (
                "DEFERRED "
                + json.dumps(
                    {
                        "requests": [
                            {"result_id": p["result_id"], "offset": p["offset"]}
                            for p in rest
                            if "result_id" in p
                        ],
                        "errors": [p["text"] for p in rest if "result_id" not in p],
                        "note": "Not sent. Continue these cursors with page (up to 4 per call).",
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
            if rest
            else ""
        )

    def join(texts, rest):
        return "\n\n".join(texts + ([deferred(rest)] if rest else []))

    minimum = [
        p.get("text") or frame_text(p, min(p["offset"] + 1, len(p["body"])))
        for p in pages
    ]
    count = len(pages)
    while count and wire_size(join(minimum[:count], pages[count:])) > RESPONSE_BYTES:
        count -= 1
    if not count:
        raise ValueError(
            "saved frame exceeds response budget; reissue the original query"
        )
    active, rest = pages[:count], pages[count:]
    candidates = [p.get("text") or fit_frame(p, FRAME_BYTES) for p in active]
    remaining = RESPONSE_BYTES - wire_size(join(minimum[:count], rest))
    extra = allocate(
        [wire_size(c) - wire_size(m) for c, m in zip(candidates, minimum)], remaining
    )
    emitted = [
        p.get("text") or fit_frame(p, min(FRAME_BYTES, wire_size(m) + add))
        for p, m, add in zip(active, minimum, extra)
    ]
    response = join(emitted, rest)
    if wire_size(response) > RESPONSE_BYTES:
        raise ValueError("response budget invariant violated")
    return response, list(zip(active, emitted))
