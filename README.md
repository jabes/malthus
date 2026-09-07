# Malthus

A 2D ball simulation in a circular container. When two balls collide hard enough, a third ball is born at the contact point. The population grows until it hits a hard cap of 2600.

Vanilla JavaScript, one canvas, no dependencies, no build step.

## Units

Positions and radii are pixels in canvas space. Velocities are pixels/second, gravity pixels/second². Time is in seconds.

## Substep order

Physics runs at a fixed 240Hz driven by an accumulator, so step count is independent of display refresh rate. Each substep runs four stages, and the order matters:

1. **Integrate** - semi-implicit Euler: gravity and drag update velocity, then position uses the new velocity.
2. **Ball vs. ball** - two passes. Overlapping pairs are pushed apart, an impulse is exchanged, and births are queued. Only the first pass can spawn, so one contact cannot produce two children.
3. **Ball vs. wall** - clamp to the container circle, then either reflect or damp.
4. **Commit births** - queued spawns become real balls.

Births are queued rather than pushed immediately so the `balls` array never grows while a loop is iterating over it. The ball count is also snapshot at the top of each substep, so newborns aren't integrated or wall-resolved until the next one.

At most 8 substeps run per frame. If the budget is exhausted with time still owed - a backgrounded tab, a paused debugger - the backlog is discarded instead of carried forward, where it would ask for even more steps on the following frame.

## Spawning

A collision produces a child only when all of these hold:

| Condition | Value |
| --- | --- |
| Closing speed along the contact normal | > 50 px/s |
| Both parents off cooldown | 0.25 s after a birth |
| Newborn lockout | 0.25 s from creation |
| Population headroom | `balls.length + pendingSpawns.length < 2600` |

The impact threshold keeps piles from breeding: glancing taps and resting contacts sit well under 50 px/s. The parent cooldown exists because a single hard collision can take several substeps to separate, and without it each of those substeps would emit a child. The newborn lockout exists because a child is created buried inside both parents and gets shoved out at high speed by positional correction, which would otherwise read as a qualifying impact immediately.

The child spawns at the contact point with the pair's center-of-mass velocity - mass-weighted, not the arithmetic mean, since radii span 6–12 px and mass goes as r², so the two can differ 4:1 and a plain mean biases the child toward the lighter, usually faster parent. On top of that it gets a tangential kick of 120–260 px/s in a random direction, so it escapes the collision instead of sitting wedged between its parents.

### Inherited traits

| Trait | Rule |
| --- | --- |
| Gravity | Mean of the two parents |
| Restitution | `min` - the less bouncy parent |
| Drag | `max` - the more damped parent |
| Radius | Fresh random 6–12, not inherited |

Taking the more dissipative parent for restitution and drag means the population trends calmer as it grows.

## Why energy is bounded

Seed restitution is 0.90–1.00 and seed drag is 0.00–0.15 - deliberately not perfectly elastic and not frictionless. Every birth injects a new ball's kinetic energy plus that tangential kick, and positional correction adds a little more. With restitution pinned at 1.0 and drag at 0, mean speed climbs without bound.

That has a concrete failure mode. Two 6 px balls have a 12 px contact distance; at 1/240 s, a relative closing speed above 2880 px/s moves them past each other within a single step with no overlap ever detected. They pass clean through. Keeping restitution under 1 and drag above 0 is what stops the sim from walking into that.

## Broad phase

A uniform grid with cells one max-diameter wide (24 px), so any pair that can touch is inside the 3×3 neighborhood of a ball's own cell.

Storage is a counting sort into flat `Int32Array`s sized at the population cap - no per-frame allocation, no array-of-arrays. Three passes: count how many balls land in each cell, prefix-sum the counts into start offsets in place, then place each ball index at its cell's cursor.

Cells are walked in row-major order, and each cell is tested against itself plus four *forward* neighbors (E, SW, S, SE). That visits every pair exactly once, which removes both the `j <= i` rejection test and half the candidate visits.

Positional correction moves balls after the grid was built, but only by the overlap amount, and the 3×3 span carries a full cell of slack. Anything missed is caught on the next substep.

## Wall handling

The container is a circle, so the wall normal is just the direction from the center to the ball. Position is corrected in full - unlike ball/ball contacts there's no second body to share the correction with and nothing to jitter against.

Velocity handling depends on the outward speed:

- **≥ 30 px/s** - reflect the outward component and scale by restitution.
- **< 30 px/s** - treated as resting contact: cancel the outward component only, leaving the tangential component so the ball can still slide along the rim.
- **≤ 0** - the ball is already heading back inside, so nothing is done. Damping here is what used to pin slow balls to the rim.

## Rendering

Each `(color, radius)` pair is rendered once into a small offscreen canvas and cached. `draw()` then calls `drawImage` per ball instead of `beginPath`/`arc`/`fill` plus a `fillStyle` assignment, which reparses the CSS color string every time.

Hue is quantized to 24 steps, which bounds the cache at 24 hues × 7 radii = 168 offscreen canvases worst case instead of 360 × 7. Sprites carry 1 px of padding per side so the antialiased edge isn't cut off, and destinations are rounded to integers to keep `drawImage` off the resampling path.

## Tuning constants

All at the top of the file:

| Constant | Value | Effect |
| --- | --- | --- |
| `radiusRange` | `[6, 12]` | Ball radius, seeds and newborns alike |
| `maxBalls` | `2600` | Population cap; also sizes every grid array |
| `spawnImpactSpeed` | `50` | Minimum closing speed for a birth |
| `spawnCooldown` | `0.25` | Parent lockout after a birth |
| `birthLockout` | `0.25` | Newborn lockout |
| `seedRestitutionRange` | `[0.90, 1.00]` | Bounciness of the two seeds |
| `seedDragRange` | `[0.00, 0.15]` | Exponential velocity decay per second |
| `correctionPercent` | `0.8` | Fraction of overlap resolved per call |
| `penetrationSlop` | `0.05` | Overlap band left uncorrected |
| `wallRestThreshold` | `30` | Reflect above, damp below |
| `hueSteps` | `24` | Hue quantization for the sprite cache |
| `physicsStep` | `1/240` | Fixed timestep |
| `collisionPasses` | `2` | Resolution passes per substep |
| `maxSubsteps` | `8` | Substep ceiling per frame |

Correcting 100% of an overlap in one call teleports bodies apart and adds energy, which is very visible when a child is born buried inside two parents - hence `correctionPercent` below 1. The slop band is what stops resting contacts from twitching.

## Seeding

Two balls. That's the minimum needed for a collision, so everything after the first contact is a product of the simulation rather than the initial conditions.

Seed placement picks a random point in the inner 85% of the container and retries until it's clear of every existing ball, giving up after 60 attempts and taking the last candidate - the solver untangles it within a substep or two.