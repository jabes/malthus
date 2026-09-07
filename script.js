// =============================================================================
// Malthus — a 2D ball sim in a circular container. When two balls hit each
// other hard enough, a third ball is born at the contact point.
//
// Units: positions and radii are pixels in canvas space, velocities are
// pixels per second, gravity is pixels per second squared, time is seconds.
//
// Per physics substep the order is fixed and matters:
//   1. integrate      — apply gravity/drag, move every ball
//   2. ball vs. ball  — push overlapping pairs apart, exchange impulses,
//                       queue births
//   3. ball vs. wall  — clamp to the container, reflect or damp
//   4. commit births  — queued spawns become real balls
// Births are queued rather than pushed immediately so the `balls` array does
// not grow while a loop is iterating over it.
// =============================================================================

const canvas = document.getElementById('c');
const context = canvas.getContext('2d');

// --- world ---

// Backing-store size, not CSS display size. Both axes are read separately so
// nothing downstream assumes the canvas is square.
const canvasWidth = canvas.width;
const canvasHeight = canvas.height;
const centerX = canvasWidth / 2;
const centerY = canvasHeight / 2;

// 14px inset leaves room for the container's stroke, which is drawn centred
// on the path and would otherwise be clipped at the canvas edge.
const containerRadius = Math.min(canvasWidth, canvasHeight) / 2 - 14;

// --- ball sizing ---

// [minimum, maximum] radius for every ball, seed or newborn alike.
const radiusRange = [6, 12];

// Largest radius any ball can ever have. The broad-phase grid sizes its
// cells off this, so it is derived rather than typed in a second time.
const maxBallRadius = radiusRange[1];

// --- spawn-on-collision tuning ---

// Hard population cap. Also, the length of every fixed-size grid array below,
// so it cannot be exceeded at runtime.
const maxBalls = 2600;

// A collision spawns a child only if the two balls are closing along the
// contact normal faster than this (pixels/second). Glancing taps and resting
// contacts are well under it, so piles do not breed.
const spawnImpactSpeed = 50;

// After giving birth, both parents are barred from spawning again for this
// many seconds. Without it, one hard collision that takes several substeps to
// separate would emit a child on each of those substeps.
const spawnCooldown = 0.25;

// A newborn is barred from spawning for this long. It is created buried
// inside both parents and gets shoved out at high speed, which would
// otherwise read as a qualifying impact immediately.
const birthLockout = 0.25;

// --- seed traits ---
// Restitution is kept below 1 and drag above 0 so the sim has somewhere for
// energy to go. Every birth injects a fresh ball's kinetic energy plus a
// tangential kick, and positional correction adds a little more; with
// restitution pinned at 1 and drag at 0 the mean speed climbed without
// bound. Two 6px balls have a 12px contact distance, so at 1/240s a relative
// closing speed past 2880 px/s passes clean through with no overlap ever
// detected — that is the wall this was heading for.
//
// These are also ranges rather than constants so the trait inheritance in
// resolvePair() has something to actually vary.
const seedRestitutionRange = [1.00, 1.00];
const seedDragRange = [0.00, 0.00];

// --- solver tuning ---

// Correcting 100% of an overlap in one call teleports bodies apart and adds
// energy, which is very visible when a child is born buried inside its two
// parents. Resolve a fraction per call and leave a slop band so resting
// contacts stop twitching.
const correctionPercent = 0.8;
const penetrationSlop = 0.05;

// Below this outward speed (pixels/second) a wall hit is treated as a resting
// contact: the outward component is removed instead of reflected. Reflecting
// tiny velocities forever is what makes balls jitter along the rim.
const wallRestThreshold = 30;

// Hue steps for the sprite cache. 24 hues x 7 radii is 168 offscreen
// canvases worst case, instead of 360 x 7.
const hueSteps = 24;

// Inclusive on both ends, unlike the usual exclusive-max helper.
function randomInt(minimum, maximum) {
    return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function randomFloat(minimum, maximum) {
    return Math.random() * (maximum - minimum) + minimum;
}

// --- sprite cache ---
// Each (color, radius) pair gets rendered once into a small offscreen
// canvas. draw() then does drawImage instead of beginPath/arc/fill plus a
// fillStyle assignment (which reparses the CSS color string) per ball.
const spriteCache = new Map();

function getSprite(color, radius) {
    const cacheKey = color + '|' + radius;
    const cachedSprite = spriteCache.get(cacheKey);
    if (cachedSprite !== undefined) return cachedSprite;

    // One pixel of padding on every side so the antialiased edge of the
    // circle has somewhere to go instead of being cut off.
    const edgePadding = 1;
    const spriteSize = (radius + edgePadding) * 2;

    const sprite = document.createElement('canvas');
    sprite.width = spriteSize;
    sprite.height = spriteSize;

    const spriteContext = sprite.getContext('2d');
    spriteContext.beginPath();
    spriteContext.arc(radius + edgePadding, radius + edgePadding, radius, 0, Math.PI * 2);
    spriteContext.fillStyle = color;
    spriteContext.fill();

    spriteCache.set(cacheKey, sprite);
    return sprite;
}

// --- balls ---
// The single source of truth for the population. Index into this array is
// what the broad-phase grid stores.
const balls = [];

// `options` supplies any field explicitly; anything omitted is randomized.
// Seed balls pass nothing, births pass everything.
function spawnBall(options = {}) {
    if (balls.length >= maxBalls) return null;

    const radius = options.radius ?? randomInt(radiusRange[0], radiusRange[1]);

    // Distance from the container center at which this ball's edge touches
    // the wall. Every position clamp below is against this, not the raw
    // container radius.
    const spawnLimit = containerRadius - radius;

    let x = options.x;
    let y = options.y;

    if (x === undefined || y === undefined) {
        // No position given: pick a random point in the inner 85% of the
        // container and retry until it is clear of every existing ball.
        // After 60 failures, take whatever the last candidate was — the
        // solver will untangle it within a substep or two.
        for (let attempt = 0; attempt < 60; attempt++) {
            const angle = randomFloat(0, Math.PI * 2);
            const distanceFromCenter = randomFloat(0, spawnLimit * 0.85);
            x = centerX + Math.cos(angle) * distanceFromCenter;
            y = centerY + Math.sin(angle) * distanceFromCenter;

            const isClearOfOthers = balls.every(other =>
                Math.hypot(x - other.x, y - other.y) > radius + other.radius + 2);
            if (isClearOfOthers) break;
        }
    } else {
        // A birth contact point near the rim can sit outside the container.
        // Wall resolution runs before spawning in the substep, so pull it in
        // here rather than leaving it out of bounds for a frame.
        const offsetX = x - centerX;
        const offsetY = y - centerY;
        const distanceSquared = offsetX * offsetX + offsetY * offsetY;

        if (distanceSquared > spawnLimit * spawnLimit) {
            const pullInScale = spawnLimit / Math.sqrt(distanceSquared);
            x = centerX + offsetX * pullInScale;
            y = centerY + offsetY * pullInScale;
        }
    }

    // Quantizing hue to `hueSteps` values keeps the sprite cache small; see
    // the comment on hueSteps above.
    const color = options.color ?? `hsl(${randomInt(0, hueSteps - 1) * (360 / hueSteps)} 70% 58%)`;
    const sprite = getSprite(color, radius);

    const ball = {
        x,
        y,
        velocityX: options.velocityX ?? randomInt(-1000, 1000),
        velocityY: options.velocityY ?? randomInt(-1000, 1000),

        radius,

        // Per-ball gravity, so the population drifts and separates instead of
        // falling as one block.
        gravity: options.gravity ?? randomInt(0, 100),

        // 1 would be perfectly elastic. Seeds start just under it so bounces
        // are a net energy sink; see the seed-traits block above.
        restitution: options.restitution ?? randomFloat(seedRestitutionRange[0], seedRestitutionRange[1]),

        // Exponential velocity decay per second; 0 disables the exp() call.
        drag: options.drag ?? randomFloat(seedDragRange[0], seedDragRange[1]),

        color,

        // Seconds remaining before this ball may take part in a birth.
        spawnLockout: options.spawnLockout ?? 0,

        // Mass is proportional to area, so mass is r^2 with the constant
        // factor dropped — only ratios between two balls matter in the
        // impulse, positional-correction, and inheritance maths.
        mass: radius * radius,
        inverseMass: 1 / (radius * radius),

        // Wall-clamp constants precomputed per ball: resolveWall runs for
        // every ball every substep and only needs the squared form to decide
        // whether to do anything at all.
        maxCenterDistance: spawnLimit,
        maxCenterDistanceSquared: spawnLimit * spawnLimit,

        sprite,

        // Half the sprite's width, i.e. radius + padding. Cached because
        // draw() subtracts it from the center position for every ball.
        spriteHalf: sprite.width / 2
    };

    balls.push(ball);
    return ball;
}

// Two seeds: the minimum needed for a collision, so the population is
// entirely a product of the sim rather than the initial conditions.
for (let seedIndex = 0; seedIndex < 2; seedIndex++) spawnBall();

// Births collected during collision resolution, drained at the end of the
// substep. See the header note on why they are not pushed immediately.
const pendingSpawns = [];

// --- broad phase: uniform grid ---
// Cell size is one max diameter, so any pair that can touch is within the
// 3x3 neighborhood of a ball's own cell. Storage is a counting sort into
// flat Int32Arrays: no per-frame allocation, no array-of-arrays.
const cellSize = maxBallRadius * 2;
const inverseCellSize = 1 / cellSize;
const gridColumns = Math.ceil(canvasWidth * inverseCellSize);
const gridRows = Math.ceil(canvasHeight * inverseCellSize);
const cellCount = gridColumns * gridRows;

// cellStart[cell] is where that cell's ball indices begin in cellItems, and
// cellStart[cell + 1] is where they end. One extra slot so the last cell has
// an end value.
const cellStart = new Int32Array(cellCount + 1);

// Moving write position per cell while cellItems is being filled.
const cellCursor = new Int32Array(cellCount);

// ball index -> cell index, computed in pass one and reused in pass three.
const ballCell = new Int32Array(maxBalls);

// Ball indices sorted by cell, i.e. every cell's members are contiguous.
const cellItems = new Int32Array(maxBalls);

// Half of the 3x3 neighborhood: E, SW, S, SE. Walking cells in row-major
// order and only looking forward visits every pair exactly once, so the
// "j <= i" rejection test disappears along with half the candidate visits.
const forwardColumnOffsets = [1, -1, 0, 1];
const forwardRowOffsets = [0, 1, 1, 1];

// Three passes: count how many balls land in each cell, prefix-sum those
// counts into start offsets, then place each ball index at its cell's cursor.
function buildGrid() {
    cellStart.fill(0);

    const count = balls.length;

    for (let ballIndex = 0; ballIndex < count; ballIndex++) {
        const ball = balls[ballIndex];

        // `| 0` truncates toward zero — fine here because the clamps below
        // handle anything that lands outside the grid anyway.
        let column = (ball.x * inverseCellSize) | 0;
        let row = (ball.y * inverseCellSize) | 0;
        if (column < 0) column = 0; else if (column >= gridColumns) column = gridColumns - 1;
        if (row < 0) row = 0; else if (row >= gridRows) row = gridRows - 1;

        const cell = row * gridColumns + column;
        ballCell[ballIndex] = cell;
        cellStart[cell + 1]++;          // counts, shifted one slot right
    }

    // Shifting the counts right above means this prefix sum turns them into
    // start offsets in place, with no second array.
    for (let cell = 0; cell < cellCount; cell++) {
        cellStart[cell + 1] += cellStart[cell];
        cellCursor[cell] = cellStart[cell];
    }

    for (let ballIndex = 0; ballIndex < count; ballIndex++) {
        cellItems[cellCursor[ballCell[ballIndex]]++] = ballIndex;
    }
}

// --- integration ---
// Semi-implicit Euler: velocity is updated first, then position uses the new
// velocity. Stable at this timestep and cheap.
function integrate(ball, deltaTime) {
    if (ball.spawnLockout > 0) ball.spawnLockout -= deltaTime;

    ball.velocityY += ball.gravity * deltaTime;

    if (ball.drag !== 0) {
        // Exponential decay rather than a per-step multiplier, so the amount
        // of damping does not depend on the timestep.
        const dampingFactor = Math.exp(-ball.drag * deltaTime);
        ball.velocityX *= dampingFactor;
        ball.velocityY *= dampingFactor;
    }

    ball.x += ball.velocityX * deltaTime;
    ball.y += ball.velocityY * deltaTime;
}

// --- ball vs. ball ---
// Handles one candidate pair: overlap test, positional correction, optional
// birth, then the collision impulse. `canSpawn` is false on the second
// resolution pass so a single contact cannot produce two children.
function resolvePair(ballA, ballB, canSpawn) {
    let offsetX = ballB.x - ballA.x;
    let offsetY = ballB.y - ballA.y;

    const contactDistance = ballA.radius + ballB.radius;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;

    // Reject on squared distance. Math.hypot does overflow-safe scaling and
    // costs roughly an order of magnitude more than this; the sqrt below
    // only runs for pairs that are actually touching.
    if (distanceSquared >= contactDistance * contactDistance) return;

    let distance = Math.sqrt(distanceSquared);

    // Exactly concentric centers give no usable direction. Pick an arbitrary
    // axis and a nonzero distance so the divisions below stay finite.
    if (distance === 0) {
        offsetX = 1;
        offsetY = 0;
        distance = 0.0001;
    }

    // Unit vector from A's center toward B's.
    const normalX = offsetX / distance;
    const normalY = offsetY / distance;

    const overlap = contactDistance - distance;
    const totalInverseMass = ballA.inverseMass + ballB.inverseMass;

    if (overlap > penetrationSlop) {
        // Split the correction in proportion to inverse mass, so the smaller
        // ball moves further and the pair's center of mass stays put.
        const correction =
            (overlap - penetrationSlop) * correctionPercent / totalInverseMass;

        ballA.x -= normalX * correction * ballA.inverseMass;
        ballA.y -= normalY * correction * ballA.inverseMass;
        ballB.x += normalX * correction * ballB.inverseMass;
        ballB.y += normalY * correction * ballB.inverseMass;
    }

    // Closing speed along the normal. Negative means approaching, since the
    // normal points from A to B.
    const relativeNormalSpeed =
        (ballB.velocityX - ballA.velocityX) * normalX +
        (ballB.velocityY - ballA.velocityY) * normalY;

    // Already separating — overlapping only because the positional
    // correction has not finished. Applying an impulse here would suck them
    // back together.
    if (relativeNormalSpeed > 0) return;

    // --- birth ---
    if (canSpawn &&
        balls.length + pendingSpawns.length < maxBalls &&
        -relativeNormalSpeed > spawnImpactSpeed &&
        ballA.spawnLockout <= 0 && ballB.spawnLockout <= 0) {

        // Contact point: one radius from A's center along the normal.
        const contactX = ballA.x + normalX * ballA.radius;
        const contactY = ballA.y + normalY * ballA.radius;

        // Center-of-mass velocity of the pair, not the arithmetic mean.
        // Radii span 6..12, so mass (r^2) can differ 4:1 and the plain mean
        // biases the child toward the lighter, usually faster parent.
        const totalMass = ballA.mass + ballB.mass;
        const centerOfMassVelocityX =
            (ballA.velocityX * ballA.mass + ballB.velocityX * ballB.mass) / totalMass;
        const centerOfMassVelocityY =
            (ballA.velocityY * ballA.mass + ballB.velocityY * ballB.mass) / totalMass;

        // Push the child sideways (perpendicular to the normal, direction
        // chosen at random) on top of that, so it escapes the collision
        // instead of sitting between the parents.
        const tangentialKick = randomFloat(120, 260) * (Math.random() < 0.5 ? -1 : 1);

        pendingSpawns.push({
            x: contactX,
            y: contactY,
            velocityX: centerOfMassVelocityX - normalY * tangentialKick,
            velocityY: centerOfMassVelocityY + normalX * tangentialKick,
            radius: randomInt(radiusRange[0], radiusRange[1]),

            // Inherited traits: gravity averages, restitution and drag take
            // the more dissipative parent, so the population trends calmer.
            gravity: (ballA.gravity + ballB.gravity) / 2,
            restitution: Math.min(ballA.restitution, ballB.restitution),
            drag: Math.max(ballA.drag, ballB.drag),

            spawnLockout: birthLockout
        });

        ballA.spawnLockout = spawnCooldown;
        ballB.spawnLockout = spawnCooldown;
    }

    // Standard impulse for a frictionless contact between two bodies.
    const restitution = ballA.restitution < ballB.restitution ? ballA.restitution : ballB.restitution;
    const impulse = -(1 + restitution) * relativeNormalSpeed / totalInverseMass;

    ballA.velocityX -= impulse * ballA.inverseMass * normalX;
    ballA.velocityY -= impulse * ballA.inverseMass * normalY;
    ballB.velocityX += impulse * ballB.inverseMass * normalX;
    ballB.velocityY += impulse * ballB.inverseMass * normalY;
}

// Walks the grid in row-major order, testing each cell against itself and
// against its four forward neighbors.
//
// Positional correction moves balls after the grid was built, but only by
// the overlap amount, and the 3x3 span has a full cell of slack — anything
// missed is caught on the next substep.
function resolveBallCollisions(canSpawn) {
    buildGrid();

    for (let row = 0; row < gridRows; row++) {
        for (let column = 0; column < gridColumns; column++) {
            const cell = row * gridColumns + column;
            const cellItemsStart = cellStart[cell];
            const cellItemsEnd = cellStart[cell + 1];
            if (cellItemsStart === cellItemsEnd) continue;

            // pairs inside this cell
            for (let slot = cellItemsStart; slot < cellItemsEnd; slot++) {
                const ball = balls[cellItems[slot]];
                for (let otherSlot = slot + 1; otherSlot < cellItemsEnd; otherSlot++) {
                    resolvePair(ball, balls[cellItems[otherSlot]], canSpawn);
                }
            }

            // this cell against the four forward neighbors
            for (let neighbour = 0; neighbour < 4; neighbour++) {
                const neighbourColumn = column + forwardColumnOffsets[neighbour];
                const neighbourRow = row + forwardRowOffsets[neighbour];

                // No check for neighbourRow < 0: every forward offset moves
                // down or stays put, so the row can only run off the bottom.
                if (neighbourColumn < 0 || neighbourColumn >= gridColumns) continue;
                if (neighbourRow >= gridRows) continue;

                const neighbourCell = neighbourRow * gridColumns + neighbourColumn;
                const neighbourStart = cellStart[neighbourCell];
                const neighbourEnd = cellStart[neighbourCell + 1];
                if (neighbourStart === neighbourEnd) continue;

                for (let slot = cellItemsStart; slot < cellItemsEnd; slot++) {
                    const ball = balls[cellItems[slot]];
                    for (let neighbourSlot = neighbourStart; neighbourSlot < neighbourEnd; neighbourSlot++) {
                        resolvePair(ball, balls[cellItems[neighbourSlot]], canSpawn);
                    }
                }
            }
        }
    }
}

// --- ball vs. wall ---
// The container is a circle, so the wall normal at any contact is just the
// direction from the center to the ball.
function resolveWall(ball) {
    const offsetX = ball.x - centerX;
    const offsetY = ball.y - centerY;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;

    // Fully inside: no sqrt, no work.
    if (distanceSquared <= ball.maxCenterDistanceSquared) return;

    const distanceFromCenter = Math.sqrt(distanceSquared);
    const normalX = offsetX / distanceFromCenter;
    const normalY = offsetY / distanceFromCenter;

    // Snap back onto the wall. Unlike ball/ball contacts this is corrected in
    // full: there is no second body to share the correction with and nothing
    // to jitter against.
    ball.x = centerX + normalX * ball.maxCenterDistance;
    ball.y = centerY + normalY * ball.maxCenterDistance;

    // Normal points outward, so a positive projection means the ball is
    // still leaving. A ball already heading back inside needs nothing —
    // damping it here is what pinned slow balls to the rim.
    const speedAlongNormal = ball.velocityX * normalX + ball.velocityY * normalY;
    if (speedAlongNormal <= 0) return;

    if (speedAlongNormal < wallRestThreshold) {
        // Resting contact: cancel the outward component only, leaving the
        // tangential component so the ball can still slide along the rim.
        ball.velocityX -= speedAlongNormal * normalX;
        ball.velocityY -= speedAlongNormal * normalY;
    } else {
        // Bounce: reverse the outward component and scale by restitution.
        const impulse = (1 + ball.restitution) * speedAlongNormal;
        ball.velocityX -= impulse * normalX;
        ball.velocityY -= impulse * normalY;
    }
}

// --- rendering ---
context.font = '28px ui-monospace, monospace';   // set once; clearRect doesn't reset state
context.lineWidth = 3;
context.strokeStyle = '#6f7d82';
context.fillStyle = '#6f7d82';

function draw() {
    context.clearRect(0, 0, canvasWidth, canvasHeight);

    context.beginPath();
    context.arc(centerX, centerY, containerRadius, 0, Math.PI * 2);
    context.stroke();

    // Integer destinations keep drawImage off the resampling path.
    // The + 0.5 before truncation rounds to nearest rather than toward zero.
    const count = balls.length;
    for (let ballIndex = 0; ballIndex < count; ballIndex++) {
        const ball = balls[ballIndex];
        const halfSprite = ball.spriteHalf;
        context.drawImage(
            ball.sprite,
            (ball.x - halfSprite + 0.5) | 0,
            (ball.y - halfSprite + 0.5) | 0);
    }

    context.fillText(count + ' / ' + maxBalls, 24, 44);
}

// --- loop ---

// Physics runs at a fixed 240Hz regardless of display refresh rate, so the
// simulation is deterministic in step count and does not change character on
// a 60Hz vs 144Hz monitor.
const physicsStep = 1 / 240;

// Two resolution passes per substep. The first can spawn; the second only
// cleans up overlaps the first pass created or could not fully separate.
const collisionPasses = 2;

// Ceiling on substeps per frame. Without it, a slow frame asks for more
// steps, which makes the next frame slower still. This is also what bounds
// a long gap (backgrounded tab, paused debugger): at most 8/240s of physics
// runs, and the leftover backlog is discarded below.
const maxSubsteps = 8;

// Leftover real time not yet consumed by a whole physics step.
let accumulator = 0;
let lastFrameTime = performance.now();

function frame(now) {
    const elapsed = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    accumulator += elapsed;

    let substeps = 0;

    while (accumulator >= physicsStep && substeps < maxSubsteps) {
        // Snapshot the count: balls added by this substep's births must not
        // be integrated or wall-resolved until the next one.
        const count = balls.length;

        for (let ballIndex = 0; ballIndex < count; ballIndex++) {
            integrate(balls[ballIndex], physicsStep);
        }

        for (let pass = 0; pass < collisionPasses; pass++) {
            resolveBallCollisions(pass === 0);
        }

        for (let ballIndex = 0; ballIndex < count; ballIndex++) {
            resolveWall(balls[ballIndex]);
        }

        for (let spawnIndex = 0; spawnIndex < pendingSpawns.length; spawnIndex++) {
            spawnBall(pendingSpawns[spawnIndex]);
        }
        pendingSpawns.length = 0;

        accumulator -= physicsStep;
        substeps++;
    }

    // Ran out of substep budget with time still owed: drop the backlog rather
    // than carrying it into the next frame, where it would ask for even more
    // steps. The accumulator check matters — without it, a frame that used
    // all 8 steps and legitimately drained the accumulator would still throw
    // away up to 4.2ms of sub-step time.
    if (substeps === maxSubsteps && accumulator >= physicsStep) accumulator = 0;

    draw();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);