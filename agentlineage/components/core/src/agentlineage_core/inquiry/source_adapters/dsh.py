# Copyright (c) 2025-2026 Huawei Technologies Co., Ltd.
# This program is free software: you can redistribute it and/or modify it under the terms of
# CANN Open Software License Agreement Version 2.0 (the "License").
# Please refer to the License for details. You may not use this file except in compliance with the License.
# THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED,
# INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT, MERCHANTABILITY, OR FITNESS FOR A PARTICULAR PURPOSE.
# See LICENSE in the root of the software repository for the full text of the License.

import json
from datetime import datetime, timezone

from .base import Identity, message_role


def project(rows, line_numbers=None):
    header = rows[0]
    if type(header.get("version")) is not int or header["version"] != 4:
        raise ValueError("Only DSH Session format v4 is supported; migrate through DSH first")
    if (not isinstance(header.get("id"), str) or not header["id"]
            or type(header.get("createdAt")) is not int or not 0 <= header["createdAt"] <= 253402300799999
            or any(key in header and not isinstance(header[key], str) for key in ("cwd", "parentSession"))
            or type(header.get("isSeeded")) is not bool):
        raise ValueError("Invalid DSH session header")
    events = rows[1:]
    for seq, event in enumerate(events):
        if (not isinstance(event, dict) or type(event.get("seq")) is not int or event["seq"] != seq
                or type(event.get("time")) is not int or not 0 <= event["time"] <= 253402300799999
                or not isinstance(event.get("type"), str) or "data" not in event
                or (not event["type"].startswith("plugin:") and not isinstance(event["data"], dict))):
            raise ValueError("DSH events require contiguous seq, time and object data")
        kind, data = event["type"], event["data"]
        if kind in ("tool/call", "tool/ptc-dispatch-start", "tool/ptc-dispatch"):
            id_key = "callId" if kind == "tool/call" else "subCallId"
            if any(not isinstance(data.get(key), str) or not data[key] for key in (id_key, "name")):
                raise ValueError("DSH tool events require a name and call identity")
            if kind == "tool/call" and not isinstance(data.get("arguments"), str):
                raise ValueError("DSH tool/call arguments must be a native JSON string")
        if kind == "tool/result":
            message = data.get("message")
            if (not isinstance(message, dict) or message.get("role") != "tool"
                    or not isinstance(message.get("toolCallId"), str)
                    or not isinstance(message.get("content"), list)
                    or type(message.get("isError", False)) is not bool):
                raise ValueError("Invalid DSH tool result receipt")
        if kind == "tool/ptc-dispatch" and type(data.get("isError")) is not bool:
            raise ValueError("DSH PTC receipts require isError")
    cuts = [e["seq"] for e in events if e["type"] == "session/end-seed"
            and e["data"].get("inherited") is True]
    if header["isSeeded"] and not cuts:
        raise ValueError("Seeded DSH session is missing its inherited-prefix boundary")
    cut = cuts[-1] if header["isSeeded"] else 0
    if cuts and not header["isSeeded"]:
        raise ValueError("Unexpected inherited-prefix boundary in unseeded DSH session")
    cwd = header.get("cwd", "")
    for index, record in enumerate(rows):
        line = line_numbers[index] if line_numbers is not None else index + 1
        if record["type"] == "working-directory/change":
            changed = record["data"].get("cwd")
            if not isinstance(changed, str) or not changed:
                raise ValueError("Invalid DSH working-directory change")
            cwd = changed
        owned = index == 0 or record["seq"] >= cut
        time = header["createdAt"] if index == 0 else record["time"]
        yield {"type": "dsh-native-record", "timestamp": datetime.fromtimestamp(
            time / 1000, timezone.utc).isoformat(), "session": header,
            "record": record, "owned": owned, "cwd": cwd, "origin_line": line}


class DshAdapter:
    name = "dsh"

    def matches(self, record):
        return record.get("type") == "dsh-native-record"

    def identity(self, record):
        header = record["session"]
        return Identity(self.name, header["id"], record.get("cwd", ""), header.get("parentSession"))

    def input_role(self, record):
        native = record["record"]
        data = native.get("data", {})
        if not isinstance(data, dict):
            return None
        return message_role(data.get("message", data))

    def parts(self, record):
        if not record.get("owned"):
            return
        native = record["record"]
        kind, data = native["type"], native.get("data", {})
        if kind in ("tool/call", "tool/ptc-dispatch-start"):
            arguments = data.get("arguments")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except ValueError:
                    pass
            if (data.get("name") in ("read", "write", "edit") and isinstance(arguments, dict)
                    and isinstance(arguments.get("file_path"), str)):
                from ..store import path_key
                arguments = {**arguments, "file_path": path_key(arguments["file_path"], record["cwd"])}
            yield (0, "dsh", "request", data.get("callId", data.get("subCallId")),
                   data.get("name", ""), arguments, None)
        elif kind == "tool/result":
            result = data.get("message", {})
            error = result.get("isError", False)
            yield (0, "dsh", "result", result.get("toolCallId"), "",
                   {"content": result.get("content"), "meta": data.get("meta")},
                   int(not error) if type(error) is bool else None)
        elif kind == "tool/ptc-dispatch":
            error = data.get("isError")
            yield (0, "dsh", "result", data.get("subCallId"), data.get("name", ""),
                   {"content": data.get("content"), "meta": data.get("meta")},
                   int(not error) if type(error) is bool else None)
