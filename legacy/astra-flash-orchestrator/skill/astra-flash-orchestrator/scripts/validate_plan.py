#!/usr/bin/env python3
"""Lint an optional task manifest. Does not execute commands or approve work."""
from __future__ import annotations
import argparse
import json
from pathlib import Path, PurePosixPath
import re
import sys


class PlanError(ValueError):
    pass


def text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PlanError(f"{label} must be a nonempty string.")
    if re.search(r"\b(TBD|TODO|REPLACE_ME)\b|<[^>]+>", value):
        raise PlanError(f"{label} still contains a template placeholder.")
    return value


def path_value(value: object, label: str) -> str:
    value = text(value, label)
    path = PurePosixPath(value)
    if path.is_absolute() or any(p in {"..", ".git"} for p in path.parts) or not path.parts:
        raise PlanError(f"{label} must be a non-root, repository-relative path without '..' or '.git'.")
    if any(c in value for c in "*?[]\\:\n\r") or value in {".", "./"}:
        raise PlanError(f"{label} must be a literal path, not a glob or root scope.")
    return value


def document(value: object, label: str, root: Path) -> None:
    relative = path_value(value, label)
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
        raise PlanError(f"{label} must reference an existing document inside the supplied repo root.")


def objects(value: object, label: str) -> list[dict]:
    if not isinstance(value, list) or not value or not all(isinstance(item, dict) for item in value):
        raise PlanError(f"{label} must be a nonempty list of objects.")
    return value


def checks(value: object, label: str) -> None:
    for i, item in enumerate(objects(value, label)):
        text(item.get("command"), f"{label}[{i}].command")
        text(item.get("expected"), f"{label}[{i}].expected")


def graph(items: list[dict], label: str) -> dict[str, dict]:
    indexed: dict[str, dict] = {}
    for item in items:
        name = text(item.get("id"), f"{label}.id")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) or name in indexed:
            raise PlanError(f"Invalid or duplicate {label} ID: {name}")
        indexed[name] = item
    for name, item in indexed.items():
        deps = item.get("depends_on")
        if not isinstance(deps, list) or not all(isinstance(dep, str) for dep in deps):
            raise PlanError(f"{label} {name} needs a depends_on list.")
        if len(deps) != len(set(deps)) or any(dep not in indexed or dep == name for dep in deps):
            raise PlanError(f"{label} {name} has duplicate, missing, or self dependencies.")
    seen, active = set(), set()
    def visit(name: str) -> None:
        if name in active:
            raise PlanError(f"Dependency cycle in {label}: {name}")
        if name in seen:
            return
        active.add(name)
        for dependency in indexed[name]["depends_on"]:
            visit(dependency)
        active.remove(name)
        seen.add(name)
    for name in indexed:
        visit(name)
    return indexed


def paths_overlap(left: str, right: str) -> bool:
    a, b = PurePosixPath(left), PurePosixPath(right)
    return a == b or a in b.parents or b in a.parents


def validate(plan: object, root: Path) -> dict:
    if not isinstance(plan, dict) or plan.get("schema_version") != 1:
        raise PlanError("Expected schema_version 1.")
    text(plan.get("project"), "project")
    document(plan.get("spec"), "spec", root)
    capacity = plan.get("max_flash_workers", 1)
    if type(capacity) is not int or capacity not in {1, 2}:
        raise PlanError("max_flash_workers must be 1 or 2.")
    phases = graph(objects(plan.get("phases"), "phases"), "phase")
    tasks = graph(objects(plan.get("tasks"), "tasks"), "task")
    for phase in phases.values():
        text(phase.get("goal"), "phase.goal")
        checks(phase.get("integration_checks"), "phase.integration_checks")
    groups: dict[str, list[dict]] = {}
    def phase_depends_on(name: str, other: str) -> bool:
        return other in phases[name]["depends_on"] or any(phase_depends_on(dep, other) for dep in phases[name]["depends_on"])
    for task in tasks.values():
        name = task["id"]
        if task.get("phase") not in phases:
            raise PlanError(f"Task {name} refers to a missing phase.")
        if task.get("executor") not in {"astra", "flash"}:
            raise PlanError(f"Task {name} executor must be astra or flash.")
        if task.get("risk") not in {"normal", "sensitive"}:
            raise PlanError(f"Task {name} needs risk normal or sensitive.")
        if task["risk"] == "sensitive" and task["executor"] != "astra":
            raise PlanError(f"Sensitive task {name} must remain with Astra; split safe supporting work into another task.")
        if task.get("state") not in {"planned", "ready", "running", "review", "changes_requested", "accepted", "blocked"}:
            raise PlanError(f"Task {name} has an invalid state.")
        document(task.get("brief"), f"Task {name} brief", root)
        paths = task.get("allowed_paths")
        if not isinstance(paths, list) or not paths:
            raise PlanError(f"Task {name} requires allowed_paths.")
        for path in paths:
            path_value(path, f"Task {name} allowed path")
        criteria = task.get("acceptance")
        if not isinstance(criteria, list) or not criteria:
            raise PlanError(f"Task {name} requires acceptance criteria.")
        for criterion in criteria:
            text(criterion, f"Task {name} acceptance")
        checks(task.get("checks"), f"Task {name} checks")
        if task.get("parallel_group"):
            group = text(task["parallel_group"], f"Task {name} parallel_group")
            groups.setdefault(group, []).append(task)
    for task in tasks.values():
        for dependency in task["depends_on"]:
            dependency_phase = tasks[dependency]["phase"]
            if task["phase"] != dependency_phase and not phase_depends_on(task["phase"], dependency_phase):
                raise PlanError(f"Task {task['id']} depends on a task in a phase not declared as its prerequisite.")
    def depends_on(name: str, other: str) -> bool:
        return other in tasks[name]["depends_on"] or any(depends_on(dep, other) for dep in tasks[name]["depends_on"])
    for group, members in groups.items():
        if len(members) > capacity or any(t["executor"] != "flash" for t in members):
            raise PlanError(f"Parallel group {group} exceeds worker capacity or includes a non-Flash executor.")
        if len({t["phase"] for t in members}) != 1:
            raise PlanError(f"Parallel group {group} crosses phase boundaries.")
        for i, left in enumerate(members):
            for right in members[i + 1:]:
                overlap = any(paths_overlap(a, b) for a in left["allowed_paths"] for b in right["allowed_paths"])
                if overlap or depends_on(left["id"], right["id"]) or depends_on(right["id"], left["id"]):
                    raise PlanError(f"Parallel group {group} has overlapping paths or dependent tasks.")
    return {"status": "structure-valid", "phases": len(phases), "tasks": len(tasks), "max_flash_workers": capacity,
            "note": "No commands were run. Readiness, workspaces, permissions, semantic correctness and acceptance are not verified."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("plan", type=Path)
    parser.add_argument("--repo-root", type=Path, help="base for spec/brief references; defaults to the plan's parent directory")
    args = parser.parse_args()
    try:
        root = args.repo_root or args.plan.resolve().parent
        result = validate(json.loads(args.plan.read_text()), root)
        print(json.dumps(result, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(f"PLAN INVALID: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
