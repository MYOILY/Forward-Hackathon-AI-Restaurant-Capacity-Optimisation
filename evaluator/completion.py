"""Required evaluation trials and evidence completeness checks."""

from __future__ import annotations


def planned_trials(models, roles):
    return [
        {
            "clip_role": role,
            "model": model,
            "trial": trial,
            "status": "not_run",
            "reason": "Required trial has not run",
        }
        for role in roles
        for model in models
        for trial in range(1, 4 if role == "main" else 2)
    ]


def completion_status(clips, test_layers, trials):
    reasons = []
    for role in ("main", "held_out"):
        clip = clips.get(role, {"status": "not_run"})
        if clip.get("status") != "passed":
            reasons.append(f"{role} recording has not passed complete evaluation")
        if clip.get("provenance") != "manual_real_video":
            reasons.append(f"{role} independently labelled real recording is required")
    main = clips.get("main", {})
    heldout = clips.get("held_out", {})
    if main.get("video_sha256") and main.get("video_sha256") == heldout.get(
        "video_sha256"
    ):
        reasons.append("Held-out recording must differ from the main source video")
    if not trials or any(row.get("status") != "passed" for row in trials):
        reasons.append(
            "All requested fresh-process model trials must pass correctness checks"
        )
    models = {
        row.get("model") for row in trials if row.get("model") in {"nano", "tiny", "s"}
    }
    for role in ("main", "held_out"):
        for model in models:
            numbers = [
                row.get("trial")
                for row in trials
                if row.get("clip_role") == role and row.get("model") == model
            ]
            required_trials = {1, 2, 3} if role == "main" else {1}
            if (
                any(type(number) is not int or number < 1 for number in numbers)
                or len(numbers) != len(set(numbers))
                or not required_trials.issubset(numbers)
            ):
                reasons.append(
                    f"{role}/{model} requires three distinct main benchmark trials"
                    if role == "main"
                    else f"{role}/{model} requires one held-out evaluation"
                )
    if not models:
        reasons.append("No requested model trials were declared")
    if not test_layers or any(row.get("status") != "passed" for row in test_layers):
        reasons.append("Required code and real-model test layers remain incomplete")
    required = {"python_unit", "real_model_integration", "typescript_state", "browser"}
    required.add("object_surface_integration")
    if not required.issubset({row.get("name") for row in test_layers}):
        reasons.append("One or more required test layers were not declared")
    statuses = [row.get("status") for row in [*clips.values(), *test_layers, *trials]]
    return {
        "status": (
            "failed" if "failed" in statuses else "incomplete" if reasons else "passed"
        ),
        "reasons": reasons,
    }
