---
name: hyprune-world-builder
description: Turn a description ("a cosy rooftop garden at sunset with three screens and a CPU tower that glows") into a Hyprune world built step by step with the hyprune MCP server's tools, looked at and checked after each pass. Use when the user wants to make, change or set up a world, its screens, its data-driven machines or its sky and floor in Hyprune.
---

# Building a Hyprune world

Hyprune is a desktop you walk through: a world with **workspace screens** (each screen is the
home of one workspace; its windows show on it), objects, and machines that follow live data.
You build in a **world folder** with the `hyprune` MCP tools. Everything you change is unsaved
until `save`, and `undo` reverses your own steps. You can't touch the user's windows, input or
settings, and you never publish: releasing is the user's action in Hyprune.

Units: metres and degrees. +Y is up. A **yaw** is a heading: 0 faces -Z, 90 faces +X. Objects
stand on their base at their position; a shape's position is the centre of its base.
Workspace screens face +Z at yaw 0: a screen at z = -6 with yaw 0 faces a player standing at z = -2.

## 1. Ask only what changes the build

Mood and time of day, roughly how big, how many screens, and what data the machines should
show (CPU load, a CI queue from a JSON API, ...). Everything else gets a default. One short
question round at most.

## 2. Plan first, and show the plan

Write the plan before building and let the user answer it (the answer is the go-ahead):

- **Areas** with sizes and what each is for, and how they connect (paths, steps, ramps).
  Distinct places, not a grid. One or two vistas (a view across the space, a raised spot).
- **Levels**: a platform or terrace adds a lot; steps of at most 0.35 m, slopes up to ~45°
  (use `ramp` or `stairs`).
- **Sky** (clear-day, sunset, overcast, night) and **floor** (grid, grass, sand, paving,
  concrete), and a **palette** of 3 to 6 materials with names (`material_set`).
- **Screens**: at least two, each with **generous standing space in front** (the checklist
  wants about 2.5 m, or 0.87 × the screen's width, of clear floor in front), never inside a
  wall, bottom edge 0.2 to 3 m above the floor. Bind them to workspaces 21, 22, 23...
- **Machines**: which placement follows which data, and how (a bar grows up: `scale` with
  `anchor: bottom`; a lamp glows: `glow`; a sign turns: `rotate`).
- Every key you will use (`terrace`, `planter-west`, `screen-main`, `cpu-tower`).

## 3. Use what is there

Shapes and materials for the blockout and most props (`catalog_search` lists shapes, the
folder's materials and catalog objects such as workspace screens and library furniture).
Files the user gives you can be imported (`import`) with their licence, author and source.
Only use outside assets under CC0 or CC-BY, and record where they came from. Never use names,
marks or likenesses of existing games, films or brands.

## 4. Build in passes, and look after each

1. `world_create` (or `world_open` an existing one): name, sky, floor, spawn.
2. **Blockout**: floors, platforms, walls, ramps and stairs (`place` with `shape`).
3. **Screens**: `catalog_search` "screen", then `place` with `ref`, `workspace` and a key.
4. **Props**: planters, benches, lamps, railings: shapes with materials, or catalog objects.
   Use `on: {key, face: "top"}` to stand things on other things.
5. **Machines**: `source_set_http` (or ask the user to add a command source in Hyprune),
   then `behaviour_set` on the placement. Test the source with `source_test`.
6. **Sky and polish**: adjust the sky, the floor tile, materials.

After each pass: `look` from `spawn`, from `overview` and from two other angles (a screen's
key, a vista), then `checklist`. Fix what is wrong before going on: something blocking a
screen, a screen too high, a place you can't reach, a gap in a path. A world must hold up
from every reachable angle, not only the first view.

Always place with a key and `ifExists: "update"`: running the same step twice moves the
placement instead of making a copy, so a build that was interrupted can simply be run again.
Use `dryRun: true` when unsure; errors come with a `hint` saying how to fix them.

## 5. Hold the design rules

- Screens: never inside or behind walls; clear standing space in front; upright; reachable.
- Space: distinct places with paths and vistas, not a grid of identical rooms.
- Scale: doors and paths at least 1.2 m wide, rooms at least 3 m high, railings ~1 m.
- The checklist's blocking items (spawn, screen approaches, walkable area, budget) must be
  done before the user can release.

## 6. Hand over

Say what you built (areas, screens and their workspaces, machines and their data), what is
still open on the checklist, and that the changes are unsaved until they (or you, when they
ask) `save`. `undo` reverses your last steps; Discard in Hyprune's Builder page goes back to
the last save. Releasing is theirs, from the Builder page.

See `examples/` for three complete builds.
