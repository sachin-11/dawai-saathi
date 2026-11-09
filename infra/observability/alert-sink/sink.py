"""Prints every Alertmanager webhook as one readable line (local stand-in for Slack / email)."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer


class Sink(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - http.server API
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        try:
            payload = json.loads(body)
            for alert in payload.get("alerts", []):
                labels, notes = alert.get("labels", {}), alert.get("annotations", {})
                print(
                    f"[ALERT {alert.get('status', '?').upper()}] {labels.get('alertname')} "
                    f"severity={labels.get('severity')} :: {notes.get('summary')} "
                    f"runbook={notes.get('runbook_url')}",
                    flush=True,
                )
        except (ValueError, AttributeError):
            print("[ALERT] unreadable payload", flush=True)
        self.send_response(200)
        self.end_headers()

    def log_message(self, *_args: object) -> None:  # silence the default access log
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", 9094), Sink).serve_forever()
