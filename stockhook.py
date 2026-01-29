#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import sys
import time
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from typing import Any
from urllib.parse import parse_qs, urlparse


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _html_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True)


def _format_cn_date(iso_string: str) -> str:
    s = (iso_string or "").strip()
    if not s:
        return ""
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        beijing = timezone(timedelta(hours=8))
        dt = dt.astimezone(beijing).replace(microsecond=0)
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return s


def _format_bytes(num: int) -> str:
    if num < 0:
        return str(num)
    if num < 1024:
        return f"{num} B"
    if num < 1024 * 1024:
        return f"{num / 1024:.1f} KB"
    if num < 1024 * 1024 * 1024:
        return f"{num / (1024 * 1024):.1f} MB"
    return f"{num / (1024 * 1024 * 1024):.1f} GB"


def _get_by_path(value: Any, path: list[str]) -> Any:
    cur: Any = value
    for key in path:
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        else:
            return None
    return cur


def _first_non_empty_line(text: str) -> str:
    for line in text.splitlines():
        s = line.strip()
        if s:
            return s
    return ""


def _extract_title_from_markdown(text: str) -> str:
    for line in text.splitlines():
        m = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*$", line)
        if m:
            return m.group(1).strip()
    return ""


def _extract_payload_text(payload: Any) -> tuple[str, str]:
    # Prefer a single "main body" field; the upstream may include multiple duplicates.
    candidates: list[tuple[list[str], str]] = [
        (["content"], "content"),
        (["message"], "message"),
        (["body"], "body"),
        (["text"], "text"),
        (["markdown", "text"], "markdown.text"),
        (["markdown", "content"], "markdown.content"),
        (["markdown"], "markdown"),
        (["data", "text"], "data.text"),
        (["data", "content"], "data.content"),
    ]
    if isinstance(payload, dict):
        for path, label in candidates:
            v = _get_by_path(payload, path)
            if isinstance(v, str) and v.strip():
                return v, label
    if isinstance(payload, str) and payload.strip():
        return payload, "raw"
    return "", ""


def _extract_payload_title(payload: Any, body_text: str) -> tuple[str, str]:
    candidates: list[tuple[list[str], str]] = [
        (["title"], "title"),
        (["subject"], "subject"),
        (["markdown", "title"], "markdown.title"),
        (["data", "title"], "data.title"),
    ]
    if isinstance(payload, dict):
        for path, label in candidates:
            v = _get_by_path(payload, path)
            if isinstance(v, str) and v.strip():
                return v.strip(), label

    if body_text.strip():
        title = _extract_title_from_markdown(body_text)
        if title:
            return title, "derived"
        line = _first_non_empty_line(body_text)
        if line:
            return line[:120], "derived"
    return "未命名", "derived"


def _md_inline(text: str) -> str:
    s = _html_escape(text)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", s)

    def _link(m: re.Match[str]) -> str:
        label = m.group(1)
        url = m.group(2)
        safe_url = _html_escape(url)
        return f'<a href="{safe_url}" target="_blank" rel="noopener noreferrer">{label}</a>'

    s = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _link, s)
    return s


def _md_render_basic(text: str) -> str:
    # Safe, minimal Markdown-ish renderer (enough for headings/lists/emphasis/links).
    lines = text.splitlines()
    out: list[str] = []

    def flush_paragraph(buf: list[str]) -> None:
        if not buf:
            return
        s = " ".join([b.strip() for b in buf if b.strip()])
        out.append(f"<p>{_md_inline(s)}</p>")
        buf.clear()

    def open_list(kind: str) -> None:
        out.append(f"<{kind}>")

    def close_list(kind: str) -> None:
        out.append(f"</{kind}>")

    in_code = False
    code_buf: list[str] = []
    para_buf: list[str] = []
    list_kind: str | None = None

    for raw_line in lines:
        line = raw_line.rstrip("\n")

        if line.strip().startswith("```"):
            if in_code:
                out.append("<pre><code>")
                out.append(_html_escape("\n".join(code_buf)))
                out.append("</code></pre>")
                code_buf.clear()
                in_code = False
            else:
                flush_paragraph(para_buf)
                if list_kind:
                    close_list(list_kind)
                    list_kind = None
                in_code = True
            continue

        if in_code:
            code_buf.append(line)
            continue

        if not line.strip():
            flush_paragraph(para_buf)
            if list_kind:
                close_list(list_kind)
                list_kind = None
            continue

        m = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$", line)
        if m:
            flush_paragraph(para_buf)
            if list_kind:
                close_list(list_kind)
                list_kind = None
            level = len(m.group(1))
            out.append(f"<h{level}>{_md_inline(m.group(2).strip())}</h{level}>")
            continue

        if re.match(r"^\s{0,3}(-{3,}|\*{3,})\s*$", line):
            flush_paragraph(para_buf)
            if list_kind:
                close_list(list_kind)
                list_kind = None
            out.append("<hr />")
            continue

        m = re.match(r"^\s{0,3}>\s?(.*)$", line)
        if m:
            flush_paragraph(para_buf)
            if list_kind:
                close_list(list_kind)
                list_kind = None
            out.append(f"<blockquote>{_md_inline(m.group(1).strip())}</blockquote>")
            continue

        m = re.match(r"^\s{0,3}(\d+)\.\s+(.+)$", line)
        if m:
            flush_paragraph(para_buf)
            if list_kind not in ("ol",):
                if list_kind:
                    close_list(list_kind)
                open_list("ol")
                list_kind = "ol"
            out.append(f"<li>{_md_inline(m.group(2).strip())}</li>")
            continue

        m = re.match(r"^\s{0,3}[-*+]\s+(.+)$", line)
        if m:
            flush_paragraph(para_buf)
            if list_kind not in ("ul",):
                if list_kind:
                    close_list(list_kind)
                open_list("ul")
                list_kind = "ul"
            out.append(f"<li>{_md_inline(m.group(1).strip())}</li>")
            continue

        para_buf.append(line)

    if in_code:
        out.append("<pre><code>")
        out.append(_html_escape("\n".join(code_buf)))
        out.append("</code></pre>")
    flush_paragraph(para_buf)
    if list_kind:
        close_list(list_kind)

    return "\n".join(out)


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    # socketserver.TCPServer default is 5, which is far too small for bursty webhook traffic.
    # This controls the listen() backlog (capped by kernel limits like net.core.somaxconn).
    request_queue_size = 1024


class StockhookHandler(BaseHTTPRequestHandler):
    server_version = "stockhook/1.0"
    # Enable HTTP/1.1 so clients/proxies can reuse connections (keep-alive) under high frequency.
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def _send(self, status: int, body: bytes, content_type: str = "text/plain; charset=utf-8") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, status: int, text: str) -> None:
        self._send(status, text.encode("utf-8"))

    def _send_html(self, status: int, html: str) -> None:
        self._send(status, html.encode("utf-8"), "text/html; charset=utf-8")

    def _require_token(self, parsed_url) -> bool:
        token = os.environ.get("STOCKHOOK_TOKEN", "").strip()
        if not token:
            self._send_text(HTTPStatus.INTERNAL_SERVER_ERROR, "server token not configured\n")
            return False

        provided = (self.headers.get("X-Stockhook-Token") or "").strip()
        if not provided:
            auth = (self.headers.get("Authorization") or "").strip()
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()

        if not provided:
            qs = parse_qs(parsed_url.query)
            provided = (qs.get("token") or [""])[0].strip()

        if secrets.compare_digest(provided, token):
            return True
        self._send_text(HTTPStatus.UNAUTHORIZED, "unauthorized\n")
        return False

    def _data_dir(self) -> str:
        path = os.environ.get("STOCKHOOK_DATA_DIR", "/root/stockhook/data")
        return path

    def _max_body(self) -> int:
        try:
            return int(os.environ.get("STOCKHOOK_MAX_BODY", "262144"))  # 256KiB
        except ValueError:
            return 262144

    def _preview_limit(self) -> int:
        try:
            return int(os.environ.get("STOCKHOOK_PREVIEW_BYTES", "262144"))  # 256KiB
        except ValueError:
            return 262144

    def _render_max_bytes(self) -> int:
        try:
            return int(os.environ.get("STOCKHOOK_RENDER_MAX_BYTES", "2097152"))  # 2MiB
        except ValueError:
            return 2097152

    def _max_records(self) -> int:
        try:
            return int(os.environ.get("STOCKHOOK_MAX_RECORDS", "15"))
        except ValueError:
            return 15

    def _enforce_retention(self) -> None:
        max_records = self._max_records()
        if max_records <= 0:
            return

        data_dir = self._data_dir()
        try:
            names = [n for n in os.listdir(data_dir) if n.endswith(".json")]
        except OSError:
            return
        names.sort(reverse=True)  # newest first by name prefix timestamp
        stale = names[max_records:]
        for record_name in stale:
            record_path = os.path.join(data_dir, record_name)
            body_name = ""
            try:
                with open(record_path, "r", encoding="utf-8") as f:
                    record = json.load(f)
                body_name = (record.get("body_file") or "").strip()
            except Exception:
                body_name = ""

            try:
                os.unlink(record_path)
            except OSError:
                pass

            if body_name and "/" not in body_name and ".." not in body_name:
                body_path = os.path.join(data_dir, body_name)
                try:
                    os.unlink(body_path)
                except OSError:
                    pass

    def _write_body_to_file(self, out_path: str, content_length: int) -> tuple[int, str]:
        hasher = hashlib.sha256()
        written = 0
        with open(out_path, "wb") as f:
            remaining = content_length
            while remaining > 0:
                chunk = self.rfile.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                f.write(chunk)
                hasher.update(chunk)
                written += len(chunk)
                remaining -= len(chunk)
        return written, hasher.hexdigest()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path not in ("/webhook", "/hook"):
            self._send_text(HTTPStatus.NOT_FOUND, "not found\n")
            return
        if not self._require_token(parsed):
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_text(HTTPStatus.BAD_REQUEST, "invalid content-length\n")
            return
        if content_length <= 0:
            self._send_text(HTTPStatus.BAD_REQUEST, "empty body\n")
            return
        if content_length > self._max_body():
            self._send_text(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "payload too large\n")
            return

        content_type = (self.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()

        now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        ident = secrets.token_hex(6)
        record_name = f"{now}-{ident}.json"
        body_name = f"{now}-{ident}.body"
        out_record_path = os.path.join(self._data_dir(), record_name)
        out_body_path = os.path.join(self._data_dir(), body_name)

        os.makedirs(self._data_dir(), exist_ok=True)
        tmp_body_path = out_body_path + ".tmp"
        written, body_sha256 = self._write_body_to_file(tmp_body_path, content_length)
        if written != content_length:
            try:
                os.unlink(tmp_body_path)
            except OSError:
                pass
            self._send_text(HTTPStatus.BAD_REQUEST, "incomplete body\n")
            return
        os.replace(tmp_body_path, out_body_path)

        decoded_body: Any = None
        body_text: str | None = None
        body_b64: str | None = None
        preview_bytes = b""
        try:
            with open(out_body_path, "rb") as f:
                preview_bytes = f.read(self._preview_limit())
        except OSError:
            preview_bytes = b""

        if content_type in ("application/json", "text/json") and preview_bytes:
            try:
                decoded_body = json.loads(preview_bytes.decode("utf-8"))
            except Exception:
                decoded_body = None
                body_text = preview_bytes.decode("utf-8", errors="replace")
        elif preview_bytes:
            try:
                body_text = preview_bytes.decode("utf-8")
                decoded_body = None
            except UnicodeDecodeError:
                decoded_body = None
                body_b64 = base64.b64encode(preview_bytes).decode("ascii")

        record = {
            "received_at": _utc_now_iso(),
            "remote_addr": self.client_address[0],
            "path": parsed.path,
            "content_type": content_type,
            "user_agent": self.headers.get("User-Agent", ""),
            "body_file": body_name,
            "body_size": content_length,
            "body_sha256": body_sha256,
            "preview_truncated": content_length > len(preview_bytes),
            "body_json": decoded_body,
            "body_text": body_text,
            "body_b64": body_b64,
        }

        tmp_path = out_record_path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(record, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, out_record_path)

        self._enforce_retention()
        self._send_text(HTTPStatus.OK, f"ok {record_name}\n")

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._send_text(HTTPStatus.OK, "ok\n")
            return

        if parsed.path in ("/", "/index.html"):
            self._send_html(HTTPStatus.OK, self._render_index())
            return

        if parsed.path == "/view":
            qs = parse_qs(parsed.query)
            name = (qs.get("id") or [""])[0].strip()
            if not name or "/" in name or ".." in name:
                self._send_text(HTTPStatus.BAD_REQUEST, "invalid id\n")
                return
            path = os.path.join(self._data_dir(), name)
            if not os.path.isfile(path):
                self._send_text(HTTPStatus.NOT_FOUND, "not found\n")
                return
            try:
                with open(path, "r", encoding="utf-8") as f:
                    record = json.load(f)
            except Exception:
                self._send_text(HTTPStatus.INTERNAL_SERVER_ERROR, "failed to read record\n")
                return
            self._send_html(HTTPStatus.OK, self._render_view(name, record))
            return

        if parsed.path == "/raw":
            qs = parse_qs(parsed.query)
            name = (qs.get("id") or [""])[0].strip()
            if not name or "/" in name or ".." in name:
                self._send_text(HTTPStatus.BAD_REQUEST, "invalid id\n")
                return
            record_path = os.path.join(self._data_dir(), name)
            if not os.path.isfile(record_path):
                self._send_text(HTTPStatus.NOT_FOUND, "not found\n")
                return
            try:
                with open(record_path, "r", encoding="utf-8") as f:
                    record = json.load(f)
            except Exception:
                self._send_text(HTTPStatus.INTERNAL_SERVER_ERROR, "failed to read record\n")
                return
            body_name = (record.get("body_file") or "").strip()
            if not body_name or "/" in body_name or ".." in body_name:
                self._send_text(HTTPStatus.NOT_FOUND, "no body\n")
                return
            body_path = os.path.join(self._data_dir(), body_name)
            if not os.path.isfile(body_path):
                self._send_text(HTTPStatus.NOT_FOUND, "no body\n")
                return

            try:
                size = os.path.getsize(body_path)
            except OSError:
                size = None

            ctype = (record.get("content_type") or "application/octet-stream").strip() or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8" if ctype.startswith("text/") else ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Disposition", f'attachment; filename="{body_name}"')
            if size is not None:
                self.send_header("Content-Length", str(size))
            self.end_headers()
            with open(body_path, "rb") as f:
                while True:
                    chunk = f.read(1024 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            return

        self._send_text(HTTPStatus.NOT_FOUND, "not found\n")

    def _render_index(self) -> str:
        data_dir = self._data_dir()
        os.makedirs(data_dir, exist_ok=True)
        files = [f for f in os.listdir(data_dir) if f.endswith(".json")]
        files.sort(reverse=True)
        files = files[:50]

        rows: list[str] = []
        for name in files:
            full = os.path.join(data_dir, name)
            try:
                st = os.stat(full)
                size = st.st_size
            except OSError:
                size = 0

            received_at = ""
            title = "（无标题）"
            try:
                with open(full, "r", encoding="utf-8") as f:
                    record = json.load(f)
                received_at = _format_cn_date(str(record.get("received_at") or ""))
                payload = record.get("body_json")
                if payload is None and record.get("body_text") is not None:
                    payload = str(record.get("body_text") or "")
                text, _ = _extract_payload_text(payload)
                t, _ = _extract_payload_title(payload, text)
                if t:
                    title = t
            except Exception:
                pass
            rows.append(
                "<tr>"
                f"<td class='title'><a class='titlelink' href='/view?id={_html_escape(name)}'>{_html_escape(title)}</a>"
                f"<div class='muted small mono'>{_html_escape(name)}</div></td>"
                f"<td class='when'>{_html_escape(received_at)}</td>"
                f"<td class='size'>{_html_escape(_format_bytes(size))}</td>"
                "</tr>"
            )

        body = "\n".join(rows) if rows else "<tr><td colspan='3'>暂无数据</td></tr>"
        return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stockhook</title>
  <style>
    :root {{
      --bg0: #f6f8ff;
      --bg1: #f7fbff;
      --card: rgba(255, 255, 255, 0.85);
      --border: rgba(15, 23, 42, 0.10);
      --text: #0f172a;
      --muted: #475569;
      --accent: #4f46e5;
      --accent2: #06b6d4;
      --shadow: 0 18px 45px rgba(15, 23, 42, 0.10);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji";
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(1100px 600px at 12% -10%, rgba(79, 70, 229, 0.14), transparent 60%),
        radial-gradient(900px 500px at 90% 0%, rgba(6, 182, 212, 0.14), transparent 55%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }}
    body:before {{
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(to right, rgba(15, 23, 42, 0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(15, 23, 42, 0.05) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: radial-gradient(circle at 30% 10%, black, transparent 65%);
      opacity: 0.8;
    }}
    .wrap {{ max-width: 1100px; margin: 24px auto; padding: 0 16px 24px; position: relative; }}
    .hero {{
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 18px 18px 12px;
    }}
    .brand {{
      font-size: 22px;
      letter-spacing: 0.2px;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }}
    .dot {{
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      box-shadow: 0 0 0 6px rgba(79, 70, 229, 0.12);
    }}
    .muted {{ color: var(--muted); }}
    .small {{ font-size: 12px; }}
    .mono {{ font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }}
    .card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
      overflow: hidden;
    }}
    table {{ border-collapse: collapse; width: 100%; }}
    th, td {{ border-bottom: 1px solid rgba(15, 23, 42, 0.07); padding: 12px 16px; vertical-align: top; }}
    th {{ text-align: left; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }}
    tr:hover td {{ background: rgba(255, 255, 255, 0.55); }}
    .title {{ width: 60%; }}
    .when {{ width: 210px; color: var(--muted); font-variant-numeric: tabular-nums; }}
    .size {{ width: 120px; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }}
    a {{ color: var(--accent); text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .titlelink {{ font-weight: 650; color: var(--text); text-decoration: none; }}
    .titlelink:hover {{ text-decoration: underline; text-decoration-color: rgba(79, 70, 229, 0.35); }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hero">
        <h1 class="brand"><span class="dot"></span>Stockhook</h1>
        <div class="muted small mono">v1</div>
      </div>
      <table>
        <thead><tr><th>标题</th><th>日期 (北京时间)</th><th style="text-align:right">大小</th></tr></thead>
        <tbody>
          {body}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
"""

    def _render_view(self, name: str, record: dict[str, Any]) -> str:
        data_dir = self._data_dir()
        body_name = (record.get("body_file") or "").strip()
        body_path = os.path.join(data_dir, body_name) if body_name else ""
        body_size = int(record.get("body_size") or 0) if str(record.get("body_size") or "").isdigit() else 0
        content_type = (record.get("content_type") or "application/octet-stream").strip() or "application/octet-stream"

        note_parts: list[str] = []
        payload: Any = None
        fallback_text = ""

        # Prefer rendering full body if it's within a safe limit.
        render_max = self._render_max_bytes()
        can_render_full = body_path and os.path.isfile(body_path) and (body_size <= render_max or body_size <= 0)
        if can_render_full:
            try:
                with open(body_path, "rb") as f:
                    raw = f.read(render_max + 1)
                if len(raw) > render_max:
                    can_render_full = False
                    note_parts.append("内容过大，仅展示预览。")
                else:
                    if content_type in ("application/json", "text/json"):
                        try:
                            payload = json.loads(raw.decode("utf-8"))
                        except Exception:
                            payload = None
                            fallback_text = raw.decode("utf-8", errors="replace")
                    else:
                        fallback_text = raw.decode("utf-8", errors="replace")
            except Exception:
                can_render_full = False
                note_parts.append("读取原始内容失败，仅展示预览。")

        if not can_render_full:
            payload = record.get("body_json")
            if payload is None and record.get("body_text") is not None:
                fallback_text = str(record.get("body_text") or "")
            elif payload is None and record.get("body_b64") is not None:
                fallback_text = f"[binary base64]\n{record.get('body_b64')}"
            if record.get("preview_truncated"):
                note_parts.append("预览已截断（仅展示前若干字节）。")

        selected_text, selected_field = _extract_payload_text(payload)
        if not selected_text and fallback_text:
            selected_text, selected_field = fallback_text, "raw"

        title, title_src = _extract_payload_title(payload, selected_text)

        content_html = ""
        if selected_text:
            content_html = _md_render_basic(selected_text)
        elif payload is not None:
            content_html = f"<pre><code>{_html_escape(_json_dumps(payload))}</code></pre>"
            note_parts.append("未找到可展示的正文字段，已显示原始 JSON。")
        else:
            content_html = "<p class='muted'>无内容</p>"

        note = " ".join([p for p in note_parts if p])
        received_at = _format_cn_date(str(record.get("received_at") or ""))
        body_sha = str(record.get("body_sha256") or "")
        sha_short = body_sha[:12] if body_sha else ""
        size_label = _format_bytes(body_size) if body_size else ""

        chips: list[tuple[str, str]] = []
        if received_at:
            chips.append(("日期(北京时间)", received_at))
        if size_label:
            chips.append(("大小", size_label))
        if selected_field:
            chips.append(("字段", selected_field))
        if sha_short:
            chips.append(("SHA256", sha_short))

        chips_html = "".join(
            f"<span class='chip'><span class='chipk'>{_html_escape(k)}</span>"
            f"<span class='chipv mono'>{_html_escape(v)}</span></span>"
            for k, v in chips
        )

        return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{_html_escape(title)} - Stockhook</title>
  <style>
    :root {{
      --bg0: #f6f8ff;
      --bg1: #f7fbff;
      --card: rgba(255, 255, 255, 0.85);
      --border: rgba(15, 23, 42, 0.10);
      --text: #0f172a;
      --muted: #475569;
      --accent: #4f46e5;
      --accent2: #06b6d4;
      --shadow: 0 18px 45px rgba(15, 23, 42, 0.10);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans";
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(1100px 600px at 12% -10%, rgba(79, 70, 229, 0.14), transparent 60%),
        radial-gradient(900px 500px at 90% 0%, rgba(6, 182, 212, 0.14), transparent 55%),
        linear-gradient(180deg, var(--bg1), var(--bg0));
    }}
    body:before {{
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(to right, rgba(15, 23, 42, 0.05) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(15, 23, 42, 0.05) 1px, transparent 1px);
      background-size: 48px 48px;
      mask-image: radial-gradient(circle at 30% 10%, black, transparent 65%);
      opacity: 0.8;
    }}
    a {{ color: var(--accent); text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .muted {{ color: var(--muted); }}
    .small {{ font-size: 12px; }}
    .mono {{ font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }}
    .wrap {{ max-width: 1100px; margin: 24px auto; padding: 0 16px 24px; position: relative; }}
    .card {{
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
      overflow: hidden;
    }}
    .topbar {{ display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; padding: 14px 16px; border-bottom: 1px solid rgba(15, 23, 42, 0.07); }}
    .btn {{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 12px;
      border: 1px solid rgba(79, 70, 229, 0.20);
      background: linear-gradient(180deg, rgba(79, 70, 229, 0.10), rgba(6, 182, 212, 0.06));
      color: var(--text);
      text-decoration: none;
    }}
    .btn:hover {{ text-decoration: none; border-color: rgba(79, 70, 229, 0.35); }}
    .hdr {{ padding: 16px 16px 8px; }}
    .title {{ margin: 0; font-size: 24px; letter-spacing: 0.2px; }}
    .chips {{ display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }}
    .chip {{
      display: inline-flex;
      gap: 8px;
      align-items: baseline;
      padding: 8px 10px;
      border-radius: 999px;
      border: 1px solid rgba(15, 23, 42, 0.10);
      background: rgba(255, 255, 255, 0.55);
    }}
    .chipk {{ font-size: 12px; color: var(--muted); letter-spacing: 0.04em; }}
    .chipv {{ font-size: 12px; color: var(--text); }}
    .note {{ padding: 0 16px 8px; }}
    .content {{ padding: 18px 16px 18px; }}
    .content h1, .content h2, .content h3, .content h4 {{ margin: 16px 0 10px; }}
    .content h1 {{ font-size: 22px; }}
    .content h2 {{ font-size: 18px; }}
    .content h3 {{ font-size: 16px; }}
    .content p, .content li, .content blockquote {{ line-height: 1.7; }}
    .content pre {{ white-space: pre-wrap; word-break: break-word; background: #0b1020; color: #e6edf3; padding: 12px; border-radius: 12px; overflow-x: auto; }}
    .content code {{ background: #eef2ff; padding: 2px 6px; border-radius: 8px; }}
    .content blockquote {{ margin: 10px 0; padding: 10px 12px; background: #f8fafc; border-left: 4px solid rgba(6, 182, 212, 0.45); color: #334155; border-radius: 10px; }}
    .content hr {{ border: 0; border-top: 1px solid rgba(15, 23, 42, 0.10); margin: 14px 0; }}
    .footer {{ padding: 0 16px 16px; }}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="topbar">
        <a class="btn" href="/"><span class="mono">←</span><span>返回</span></a>
        <a class="btn" href="/raw?id={_html_escape(name)}"><span>下载原文</span></a>
      </div>
      <div class="hdr">
        <h1 class="title">{_html_escape(title)}</h1>
        <div class="chips">{chips_html}</div>
      </div>
      <div class="note muted small">{_html_escape(note)}</div>
      <div class="content">
        {content_html}
      </div>
      <div class="footer muted small mono">{_html_escape(name)}</div>
    </div>
  </div>
</body>
</html>
"""


def main() -> int:
    host = os.environ.get("STOCKHOOK_HOST", "0.0.0.0")
    port = int(os.environ.get("STOCKHOOK_PORT", "49554"))
    data_dir = os.environ.get("STOCKHOOK_DATA_DIR", "/root/stockhook/data")
    os.makedirs(data_dir, exist_ok=True)

    httpd = ThreadingHTTPServer((host, port), StockhookHandler)
    sys.stderr.write(f"[stockhook] listening on http://{host}:{port}, data_dir={data_dir}\n")

    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
