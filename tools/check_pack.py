#!/usr/bin/env python3
"""Validate this handoff package only. This is not an app test runner."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import sys

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--root",type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument("--report",type=Path)
    args=parser.parse_args()
    root=args.root.resolve()
    errors=[]
    warnings=[]
    required=[
        "START_HERE.md","AGENTS.md","CLAUDE.md",
        "docs/ARCHITECTURE.md","docs/EXECUTION.md",
        "docs/IMPLEMENTATION_PLAN.md","docs/TESTING.md","docs/CONTRACTS.md",
        "docs/DECISIONS.md","docs/SOURCES_WORKFLOW.md","docs/DELIVERY_TEMPLATE.md",
        "prompts/START.md","prompts/RESUME.md","prompts/WORKER.md","prompts/REVIEW.md",
        ".agent/state.json",".agent/tasks.json",".agent/acceptance.json",".agent/NEXT.md",
        "tests/scenarios.json","tests/fixtures/replay/partial-and-overlap.json",
        "roles/AUDIO.md","roles/UI_PROMPTER.md","roles/CONTEXT.md","roles/VERIFIER.md",
        ".agent/schemas/state.schema.json",".agent/schemas/transcript-event.schema.json",
        ".agent/schemas/generation-event.schema.json",".agent/schemas/run-report.schema.json",
    ]
    for rel in required:
        if not (root/rel).is_file(): errors.append("Missing "+rel)
    if errors:
        print(json.dumps({"kind":"pack_check","status":"fail","errors":errors},indent=2))
        return 1
    def read(rel):
        return json.loads((root/rel).read_text(encoding="utf-8"))
    state=read(".agent/state.json")
    tasks=read(".agent/tasks.json")["tasks"]
    acceptance=read(".agent/acceptance.json")["requirements"]
    scenarios=read("tests/scenarios.json")["cases"]
    ids=[x["id"] for x in tasks]
    if len(ids)!=len(set(ids)): errors.append("Duplicate task IDs")
    known=set(ids)
    reqs={x["id"] for x in acceptance}
    cases={x["id"] for x in scenarios}
    by_id={x["id"]:x for x in tasks}
    for t in tasks:
        if not set(t["depends_on"])<=known: errors.append("Unknown dependency in "+t["id"])
        if not set(t["acceptance_ids"])<=reqs: errors.append("Unknown acceptance in "+t["id"])
        if t["status"] not in {"pending","in_progress","implemented","verified","blocked"}:
            errors.append("Invalid task status "+t["id"])
    active=set()
    done=set()
    def visit(tid):
        if tid in active: raise ValueError("Dependency cycle at "+tid)
        if tid in done: return
        active.add(tid)
        for dep in by_id[tid]["depends_on"]:
            if dep in by_id: visit(dep)
        active.remove(tid)
        done.add(tid)
    try:
        for tid in ids: visit(tid)
    except ValueError as e: errors.append(str(e))
    covered=set()
    for req in acceptance:
        if not set(req["scenario_ids"])<=cases: errors.append("Unknown scenario in "+req["id"])
        covered.update(req["scenario_ids"])
    if cases-covered: errors.append("Unmapped scenarios: "+",".join(sorted(cases-covered)))
    if "@AGENTS.md" not in (root/"CLAUDE.md").read_text(): errors.append("Missing Claude import")
    if (root/"AGENTS.md").stat().st_size>24000: errors.append("Shared instructions too large")
    for path in root.rglob("*.md"):
        text=path.read_text(encoding="utf-8")
        if text.count("```")%2: errors.append("Unbalanced fence "+str(path.relative_to(root)))
    schema_status="structural_only"
    try:
        import jsonschema
        schemas={}
        for p in (root/".agent/schemas").glob("*.schema.json"):
            schema=json.loads(p.read_text())
            jsonschema.Draft202012Validator.check_schema(schema)
            schemas[p.name]=schema
        jsonschema.validate(state,schemas["state.schema.json"])
        fixture=read("tests/fixtures/replay/partial-and-overlap.json")
        for event in fixture["events"]:
            jsonschema.validate(event["transcript"],schemas["transcript-event.schema.json"])
        schema_status="validated"
    except ImportError:
        # This fallback checks package structure and our fixture contract only.
        # It deliberately does not claim full JSON Schema specification validation.
        warnings.append("Full Draft 2020-12 validation unavailable; P00 must install a proper schema validator")
        for p in (root/".agent/schemas").glob("*.schema.json"):
            schema=json.loads(p.read_text())
            if schema.get("$schema")!="https://json-schema.org/draft/2020-12/schema":
                errors.append("Unexpected schema dialect: "+p.name)
            if schema.get("type")!="object": errors.append("Expected object schema: "+p.name)
            if not set(schema.get("required",[]))<=set(schema.get("properties",{})):
                errors.append("Required field absent from properties: "+p.name)
        if state.get("schema_version")!="0.3" or not isinstance(state.get("revision"),int):
            errors.append("Invalid state contract fields")
        schema=read(".agent/schemas/transcript-event.schema.json")
        for row in read("tests/fixtures/replay/partial-and-overlap.json")["events"]:
            event=row["transcript"]
            if not set(schema["required"])<=set(event): errors.append("Missing transcript field")
            if set(event)-set(schema["properties"]): errors.append("Unknown transcript field")
            if event["role"] not in {"self","remote"}: errors.append("Invalid transcript role")
            if event["status"] not in {"partial","final"}: errors.append("Invalid transcript status")
            if not 0<=event["start_ms"]<=event["end_ms"]<=row["at_ms"]:
                errors.append("Invalid transcript timeline")
    except Exception as e:
        errors.append("Schema validation: "+str(e))
    # Initial handoff must not contain fabricated app verification.
    if not state["application_implemented"]:
        if any(x["status"]=="pass" for x in state["gates"].values()):
            errors.append("Unimplemented app has a passing gate")
        if any(x["status"]=="verified" for x in tasks):
            errors.append("Initial task marked verified without app")
    report={
        "kind":"pack_check",
        "status":"fail" if errors else "pass",
        "scope":"Instruction-package consistency only; no application/native/audio/provider tests executed",
        "application_test_status":"not_run",
        "counts":{"tasks":len(tasks),"requirements":len(acceptance),"scenario_specs":len(scenarios)},
        "json_schema":schema_status,
        "errors":errors,
        "warnings":warnings,
        "sha256":{
            rel:hashlib.sha256((root/rel).read_bytes()).hexdigest()
            for rel in required
        },
    }
    if args.report:
        report_path=args.report if args.report.is_absolute() else root/args.report
        report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({k:v for k,v in report.items() if k!="sha256"},ensure_ascii=False,indent=2))
    return 1 if errors else 0

if __name__=="__main__":
    sys.exit(main())

