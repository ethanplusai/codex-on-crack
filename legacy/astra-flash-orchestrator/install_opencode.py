#!/usr/bin/env python3
"""Preview/install native OpenCode agents without changing provider configuration."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys

if sys.version_info < (3, 11):
    raise SystemExit("Python 3.11+ is required. No packages or settings were changed.")
sys.dont_write_bytecode = True

from install import BUNDLE, SetupError, apply_changes, contents, no_symlinks, undo_files

PRIMARY = "astra-flash-orchestrator"
BUILDER = "astra_flash_builder"


def config_directory(project: str | None, config_dir: str | None) -> Path:
    if project:
        path = Path(project).expanduser() / ".opencode"
    elif config_dir:
        path = Path(config_dir).expanduser()
    elif os.environ.get("OPENCODE_CONFIG_DIR"):
        path = Path(os.environ["OPENCODE_CONFIG_DIR"]).expanduser()
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        path = base / "opencode"
    # Keep symlinks visible to the shared write guard instead of resolving them.
    path = Path(os.path.abspath(path))
    no_symlinks(path)
    return path


def validate_model(model: str) -> str:
    # OpenRouter/custom providers can have multiple slashes in the model ID.
    # Restrict to an identifier, never a URL, YAML fragment or credentials.
    if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9][A-Za-z0-9._:/-]*", model):
        raise SetupError("Use an exact provider/model ID from OpenCode's model list, not a URL or credentials.")
    if any(part in {"", ".", ".."} for part in model.split("/")):
        raise SetupError("Invalid provider/model ID.")
    return model


def worker_model(requested: str | None, builder_path: Path) -> str:
    if requested is not None:
        return validate_model(requested)
    existing = contents(builder_path)
    if existing is not None:
        # Only reuse the JSON-quoted scalar emitted by this installer. Do not
        # attempt to parse arbitrary YAML, choose a provider or infer a default.
        match = re.match(rb'---\r?\n(.*?)\r?\n---\r?\n', existing, re.DOTALL)
        if match:
            models = re.findall(rb'^model: (.+)\r?$', match[1], re.MULTILINE)
            if len(models) == 1:
                try:
                    value = json.loads(models[0])
                except ValueError:
                    value = None
                if isinstance(value, str):
                    return validate_model(value)
    raise SetupError("First install requires --worker-model with your exact OpenCode provider/model ID. No provider is selected automatically.")


def plan_changes(directory: Path, model: str, replace: bool) -> list[dict]:
    model = validate_model(model)
    no_symlinks(directory)
    instructions = (BUNDLE / "WORKER-INSTRUCTIONS.md").read_text(encoding="utf-8").strip()
    instructions = instructions.replace("Astra", "orchestrator")
    changes = []
    for name in (PRIMARY, BUILDER):
        source = BUNDLE / "opencode" / "agents" / f"{name}.md"
        no_symlinks(source)
        text = source.read_text(encoding="utf-8")
        text = text.replace("{{WORKER_MODEL}}", json.dumps(model))
        text = text.replace("{{WORKER_INSTRUCTIONS}}", instructions)
        path = directory / "agents" / f"{name}.md"
        before = contents(path)
        after = text.encode("utf-8")
        if before == after:
            continue
        if before is not None and not replace:
            raise SetupError(f"Different content already exists at {path}. Review it, then use --replace to back it up and update it.")
        changes.append({"path": path, "before": before, "after": after,
                        "mode": path.stat().st_mode & 0o777 if before is not None else 0o600})
    return changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    location = parser.add_mutually_exclusive_group()
    location.add_argument("--project", help="install in PROJECT/.opencode instead of globally")
    location.add_argument("--config-dir", help="explicit OpenCode config directory")
    parser.add_argument("--worker-model", help="exact OpenCode provider/model ID; required on first install, reused on updates")
    parser.add_argument("--apply", action="store_true", help="write changes; otherwise preview only")
    parser.add_argument("--replace", action="store_true", help="back up and update existing package agents")
    parser.add_argument("--undo", type=Path, metavar="RECEIPT", help="preview undo; combine with --apply to restore")
    args = parser.parse_args()
    try:
        directory = config_directory(args.project, args.config_dir)
        if args.undo:
            undo_files(args.undo.expanduser().absolute(), directory, args.apply, tree=None,
                       files={directory / "agents" / f"{name}.md" for name in (PRIMARY, BUILDER)})
            return 0
        model = worker_model(args.worker_model, directory / "agents" / f"{BUILDER}.md")
        changes = plan_changes(directory, model, args.replace)
        print(f"OpenCode agents directory: {directory / 'agents'}")
        print(f"Primary: {PRIMARY} (inherits your selected model)")
        print(f"Builder: {BUILDER} (pinned to {model})")
        print("Routing unverified: offline generation does not check model availability, authentication or effective overrides.")
        for change in changes:
            print(f"{'UPDATE' if change['before'] is not None else 'CREATE'} {change['path']}")
        if not args.apply:
            print("Preview only. No files changed. Add --apply to install.")
            return 0
        receipt = apply_changes(changes, directory, {})
        print(f"Installed. Undo receipt: {receipt}" if receipt else "Already installed; no changes needed.")
        print("Provider configuration, credentials and AGENTS.md were not changed. No model request was made.")
        print(f"Restart OpenCode and select {PRIMARY}. Verify child routing during your first authorized useful task.")
        return 0
    except (SetupError, OSError, ValueError) as exc:
        message = str(exc) if isinstance(exc, SetupError) else f"Local installation error ({type(exc).__name__}); inspect locally."
        print(f"INSTALL FAILED: {message}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
