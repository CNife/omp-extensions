#!/usr/bin/env python3
"""echo-endpoint.py — OpenAI-compatible 回显端点（provider-models-guide 验证探针）。

契约与实测结论见 omp-extensions issue #85（resolution 评论）；本脚本的日志 body
曾与 PI_REQ_DEBUG=1 抓到的 rr-session-N.json 请求 body 逐字节一致（omp 18.3.0 实测，
两轮交叉验证）。

行为契约（与 #85 resolution 一字不改）：
- 仅标准库；OpenAI-compatible 回显端点；每个 POST 记一行 JSONL（path、headers 含鉴权、完整 body）。
- 终止语义：请求里出现 role="tool" 的消息即一律回纯文本；ECHO_TOOL_CALL=1 只在首个
  请求回一次 tool call；ECHO_MAX_REQUESTS（默认 8）兜底；ECHO_MAX_LOG_BYTES（默认 32 MiB）防日志跑飞。
- GET /v1/models 返回 ECHO_MODEL，便于 discovery 场景。

能力边界（#85 实测）：
- 只对 openai-completions 能应答并跑完（POST 路径含 chat/completions）。
- 其他方言（如 anthropic-messages 的 /v1/messages）请求照发、body 照样抓到，但本端点
  不回对方言的响应事件，omp 会挂到超时——所以其他方言下它只能回答「请求长什么样」，
  不能回答「响应解析对不对」。

环境变量：
  ECHO_MODEL          GET /v1/models 返回的模型 id（默认 echo-model）
  ECHO_TOOL_CALL      =1 时首个无 role="tool" 的请求回一次 tool call
  ECHO_MAX_REQUESTS   tool-call 兜底上限：第 N 个及之后的 POST 一律回纯文本（默认 8）
  ECHO_MAX_LOG_BYTES  JSONL 日志字节上限，超过后不再写入（默认 32 MiB）

用法：python3 echo-endpoint.py [port]   （默认 8787；日志写 cwd 的 echo-endpoint.jsonl）
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ECHO_MODEL = os.environ.get("ECHO_MODEL", "echo-model")
ECHO_TOOL_CALL = os.environ.get("ECHO_TOOL_CALL") == "1"
ECHO_MAX_REQUESTS = int(os.environ.get("ECHO_MAX_REQUESTS", "8"))
ECHO_MAX_LOG_BYTES = int(os.environ.get("ECHO_MAX_LOG_BYTES", str(32 * 1024 * 1024)))

LOG_PATH = os.path.join(os.getcwd(), "echo-endpoint.jsonl")

_lock = threading.Lock()
_state = {"posts": 0, "tool_call_sent": False, "log_overflow_notified": False}


def log_request(path: str, headers, body_bytes: bytes) -> None:
    """每个 POST 记一行 JSONL：path、headers（含鉴权）、完整 body。"""
    try:
        body = json.loads(body_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        body = body_bytes.decode("utf-8", errors="replace")
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "path": path,
        "headers": dict(headers.items()),
        "body": body,
    }
    line = json.dumps(entry, ensure_ascii=False) + "\n"
    with _lock:
        try:
            size = os.path.getsize(LOG_PATH) if os.path.exists(LOG_PATH) else 0
        except OSError:
            size = 0
        if size + len(line.encode("utf-8")) > ECHO_MAX_LOG_BYTES:
            if not _state["log_overflow_notified"]:
                _state["log_overflow_notified"] = True
                print(f"[echo-endpoint] log cap {ECHO_MAX_LOG_BYTES} bytes reached; "
                      f"further requests are served but not logged", file=sys.stderr)
            return
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(line)


def count_post() -> int:
    with _lock:
        _state["posts"] += 1
        return _state["posts"]


def pick_tool(body: dict):
    """优先回 bash（omp 内建工具、#85 实测路径），否则回请求 tools 里的第一个。"""
    for tool in body.get("tools") or []:
        fn = tool.get("function") or {}
        if fn.get("name") == "bash":
            return "bash", json.dumps({"command": "echo echo-endpoint-probe"})
    for tool in body.get("tools") or []:
        fn = tool.get("function") or {}
        if fn.get("name"):
            return fn["name"], "{}"
    return None, None


class EchoHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802
        if self.path.split("?")[0] == "/v1/models":
            payload = {
                "object": "list",
                "data": [{"id": ECHO_MODEL, "object": "model",
                          "created": 0, "owned_by": "echo-endpoint"}],
            }
            self._send_json(payload)
        else:
            self._send_json({"ok": True, "path": self.path})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body_bytes = self.rfile.read(length) if length else b"{}"
        log_request(self.path, self.headers, body_bytes)
        posts = count_post()

        # 其他方言：请求已记录，但不应答 —— 让调用方挂到超时（#85 实测语义）。
        if "chat/completions" not in self.path:
            self.close_connection = False
            return

        try:
            body = json.loads(body_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = {}

        messages = body.get("messages") or []
        has_tool_result = any(m.get("role") == "tool" for m in messages)

        # 终止语义：出现 role="tool" 一律纯文本；ECHO_TOOL_CALL 只发一次；
        # 超过 ECHO_MAX_REQUESTS 后一律纯文本兜底。
        want_tool_call = (
            ECHO_TOOL_CALL
            and not has_tool_result
            and posts <= ECHO_MAX_REQUESTS
        )
        with _lock:
            if want_tool_call and not _state["tool_call_sent"]:
                _state["tool_call_sent"] = True
            else:
                want_tool_call = False
        if posts > ECHO_MAX_REQUESTS:
            print(f"[echo-endpoint] ECHO_MAX_REQUESTS={ECHO_MAX_REQUESTS} exceeded; "
                  f"responding plain text", file=sys.stderr)

        model = body.get("model") or ECHO_MODEL
        stream = bool(body.get("stream"))
        include_usage = bool((body.get("stream_options") or {}).get("include_usage"))
        usage = {
            "prompt_tokens": 1,
            "completion_tokens": 1,
            "total_tokens": 2,
        }

        if want_tool_call:
            name, arguments = pick_tool(body)
            if name is None:
                want_tool_call = False

        if want_tool_call:
            finish_reason = "tool_calls"
            tool_calls = [{
                "index": 0,
                "id": f"call_echo_{int(time.time()*1000)}",
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            }]
            first_delta = {"role": "assistant", "content": None, "tool_calls": tool_calls}
        else:
            finish_reason = "stop"
            tool_calls = None
            first_delta = {"role": "assistant", "content": "echo-endpoint: done"}

        if stream:
            self._send_sse(model, first_delta, finish_reason, usage, include_usage)
        else:
            message = {"role": "assistant", "content": first_delta.get("content")}
            if tool_calls:
                message["tool_calls"] = [
                    {k: v for k, v in tc.items() if k != "index"} for tc in tool_calls
                ]
            self._send_json({
                "id": f"chatcmpl-echo-{int(time.time()*1000)}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "message": message,
                             "finish_reason": finish_reason}],
                "usage": usage,
            })

    def _send_json(self, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _chunk(self, model: str, delta: dict, finish_reason) -> str:
        chunk = {
            "id": f"chatcmpl-echo-{int(time.time()*1000)}",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
        }
        return f"data: {json.dumps(chunk)}\n\n"

    def _send_sse(self, model, first_delta, finish_reason, usage, include_usage) -> None:
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def emit(s: str) -> None:
            self.wfile.write(s.encode("utf-8"))
            self.wfile.flush()

        emit(self._chunk(model, first_delta, None))
        emit(self._chunk(model, {}, finish_reason))
        if include_usage:
            final = {
                "id": f"chatcmpl-echo-{int(time.time()*1000)}",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [],
                "usage": usage,
            }
            emit(f"data: {json.dumps(final)}\n\n")
        emit("data: [DONE]\n\n")

    def log_message(self, fmt, *args):  # 静默默认访问日志；探针日志在 JSONL
        pass


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    server = ThreadingHTTPServer(("127.0.0.1", port), EchoHandler)
    print(f"[echo-endpoint] listening on http://127.0.0.1:{port} "
          f"(model={ECHO_MODEL}, tool_call={ECHO_TOOL_CALL}, "
          f"max_requests={ECHO_MAX_REQUESTS}, max_log_bytes={ECHO_MAX_LOG_BYTES})", file=sys.stderr)
    print(f"[echo-endpoint] request log: {LOG_PATH}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
