#!/usr/bin/env python3
"""Check local config; optionally query ONLY the loopback router's /models endpoint."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
sys.dont_write_bytecode = True
from local_config import SetupError, default_locations, inspect, model_entries, model_id, resolve_worker_route, SUPPORTED_ROUTES


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SetupError("Local catalog redirected. Refusing to forward the private caller URL.")


def check_local_catalog(url: str, worker_route: str) -> None:
    # Disable ambient HTTP proxies and redirects: the capability must stay local.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(url.rstrip("/") + "/models", headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=5) as response:
            body = response.read(10_000_001)
        if len(body) > 10_000_000:
            raise SetupError("Local model response exceeded its size limit.")
        entries = model_entries(json.loads(body))
        if not any(model_id(entry) == worker_route for entry in entries):
            raise SetupError("The live local catalog does not advertise the requested Flash route.")
    except (OSError, urllib.error.URLError, json.JSONDecodeError, UnicodeError) as exc:
        raise SetupError(f"Local catalog check failed ({type(exc).__name__}); private URL withheld.") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home")
    parser.add_argument("--codex-home")
    parser.add_argument("--profile")
    parser.add_argument(
        "--worker-route",
        choices=SUPPORTED_ROUTES,
        help="check a reviewed route (default: installed routing binding, then direct DeepSeek API)",
    )
    parser.add_argument(
        "--check-local-router",
        action="store_true",
        help="GET the loopback /models endpoint; never send an inference request",
    )
    args = parser.parse_args()
    try:
        home, codex_home = default_locations(args.home, args.codex_home)
        binding = Path(__file__).resolve().parents[1] / "routing.json"
        worker_route = resolve_worker_route(args.worker_route, binding)
        report, url = inspect(home, codex_home, args.profile, worker_route)
        if args.check_local_router:
            check_local_catalog(url, worker_route)
            report["status"] = "local-catalog-ready"
            report["local_catalog_checked"] = True
        print(json.dumps(report, indent=2))
        return 0
    except SetupError as exc:
        print(f"CHECK FAILED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
