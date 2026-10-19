---
name: task-decomposition
description: "Use when turning a specification into features, tasks, dependencies, acceptance criteria, and independently executable work items."
user-invocable: true
---

# Task Decomposition

## Objective

Convert an approved specification into a small, traceable set of features and tasks that agents can execute independently.

## Workflow

1. Extract outcomes, constraints, actors, and acceptance criteria.
2. Group requirements into coherent features.
3. Split each feature into vertical or independently verifiable tasks.
4. Include implementation, tests, documentation, infrastructure, security, and release tasks where relevant.
5. Define dependencies, owner role, inputs, outputs, and completion criteria.
6. Assign stable IDs and explicit status.
7. Create one Markdown file per task using the task template.
8. Keep tasks small enough to complete and review in one focused change.

## Task quality rules

- one clear outcome per task;
- no hidden dependency;
- no ambiguous verbs such as "handle" without observable behavior;
- acceptance criteria must be testable;
- a task must identify its validation command or evidence;
- avoid mixing unrelated layers unless the task is intentionally vertical;
- preserve links to the source feature and specification.

## Output

A feature index plus task files with IDs, dependencies, owner role, acceptance criteria, validation, status, and completion metadata.
