const canvas = document.getElementById('c');
const context = canvas.getContext('2d');

// --- world (units are pixels in canvas space, seconds for time) ---
const canvasSize = canvas.width;              // internal resolution, 1120
const centerX = canvasSize / 2;
const centerY = canvasSize / 2;
const containerRadius = canvasSize / 2 - 14;

// --- spawn-on-collision tuning ---
const maxBalls = 2500;
const spawnImpactSpeed = 50;
const spawnCooldown = 0.25;
const birthLockout = 0.25;
const childRadiusRange = [6, 12];

// Largest radius any ball can ever have. The broad-phase grid sizes its
// cells off this, so if you raise either radius range you must raise this
// too or contacts will be missed.
const maxBallRadius = 12;

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min, max) {
    return Math.random() * (max - min) + min;
}

// --- sprite cache ---
// Each (color, radius) pair gets rendered once into a small offscreen
// canvas. draw() then does drawImage instead of beginPath/arc/fill plus a
// fillStyle assignment (which re-parses the CSS color string) per ball.
const spriteCache = new Map();

function getSprite(color, radius) {
    const key = color + '|' + radius;
    let sprite = spriteCache.get(key);
    if (sprite !== undefined) return sprite;

    const pad = 1;                              // room for the antialiased edge
    const size = (radius + pad) * 2;
    sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;

    const spriteContext = sprite.getContext('2d');
    spriteContext.beginPath();
    spriteContext.arc(radius + pad, radius + pad, radius, 0, Math.PI * 2);
    spriteContext.fillStyle = color;
    spriteContext.fill();

    spriteCache.set(key, sprite);
    return sprite;
}

// --- balls ---
const balls = [];

function spawnBall(options = {}) {
    const radius = options.radius ?? randomInt(6, 12);
    const spawnLimit = containerRadius - radius;

    let x = options.x;
    let y = options.y;

    if (x === undefined || y === undefined) {
        for (let attempt = 0; attempt < 60; attempt++) {
            const angle = randomFloat(0, Math.PI * 2);
            const distance = randomFloat(0, spawnLimit * 0.85);
            x = centerX + Math.cos(angle) * distance;
            y = centerY + Math.sin(angle) * distance;

            const clear = balls.every(other =>
                Math.hypot(x - other.x, y - other.y) > radius + other.radius + 2);
            if (clear) break;
        }
    }

    const color = options.color ?? `hsl(${randomInt(0, 359)} 70% 58%)`;
    const sprite = getSprite(color, radius);

    const ball = {
        x,
        y,
        velocityX: options.velocityX ?? randomInt(-1000, 1000),
        velocityY: options.velocityY ?? randomInt(-1000, 1000),

        radius,
        gravity: options.gravity ?? randomInt(50, 250),
        restitution: options.restitution ?? 1,
        drag: options.drag ?? 0,
        color,

        spawnLockout: options.spawnLockout ?? 0,

        mass: radius * radius,
        inverseMass: 1 / (radius * radius),
        maxCenterDistance: spawnLimit,
        maxCenterDistanceSquared: spawnLimit * spawnLimit,

        sprite,
        spriteHalf: sprite.width / 2
    };

    balls.push(ball);
    return ball;
}

for (let i = 0; i < 2; i++) spawnBall();

const pendingSpawns = [];

// --- broad phase: uniform grid ---
// Cell size is one max diameter, so any pair that can touch is within the
// 3x3 neighbourhood of a ball's own cell. Storage is a counting sort into
// flat Int32Arrays: no per-frame allocation, no array-of-arrays.
const cellSize = maxBallRadius * 2;
const inverseCellSize = 1 / cellSize;
const gridCols = Math.ceil(canvasSize / cellSize);
const gridRows = gridCols;
const cellCount = gridCols * gridRows;

const cellStart = new Int32Array(cellCount + 1);   // prefix sums
const cellCursor = new Int32Array(cellCount);      // write heads during fill
const ballCell = new Int32Array(maxBalls);         // ball index -> cell index
const cellItems = new Int32Array(maxBalls);        // ball indices, cell-major

function buildGrid() {
    cellStart.fill(0);

    const count = balls.length;
    for (let i = 0; i < count; i++) {
        const ball = balls[i];

        let column = (ball.x * inverseCellSize) | 0;
        let row = (ball.y * inverseCellSize) | 0;
        if (column < 0) column = 0; else if (column >= gridCols) column = gridCols - 1;
        if (row < 0) row = 0; else if (row >= gridRows) row = gridRows - 1;

        const cell = row * gridCols + column;
        ballCell[i] = cell;
        cellStart[cell + 1]++;          // counts, shifted one slot right
    }

    for (let cell = 0; cell < cellCount; cell++) {
        cellStart[cell + 1] += cellStart[cell];
        cellCursor[cell] = cellStart[cell];
    }

    for (let i = 0; i < count; i++) {
        cellItems[cellCursor[ballCell[i]]++] = i;
    }
}

// --- integration ---
function integrate(ball, deltaTime) {
    if (ball.spawnLockout > 0) ball.spawnLockout -= deltaTime;

    ball.velocityY += ball.gravity * deltaTime;

    if (ball.drag !== 0) {
        const dampingFactor = Math.exp(-ball.drag * deltaTime);
        ball.velocityX *= dampingFactor;
        ball.velocityY *= dampingFactor;
    }

    ball.x += ball.velocityX * deltaTime;
    ball.y += ball.velocityY * deltaTime;
}

// --- ball vs. ball ---
function resolvePair(a, b, canSpawn) {
    let offsetX = b.x - a.x;
    let offsetY = b.y - a.y;

    const contactDistance = a.radius + b.radius;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;

    // Reject on squared distance. Math.hypot does overflow-safe scaling and
    // costs roughly an order of magnitude more than this; the sqrt below
    // only runs for pairs that are actually touching.
    if (distanceSquared >= contactDistance * contactDistance) return;

    let distance = Math.sqrt(distanceSquared);

    if (distance === 0) {
        offsetX = 1;
        offsetY = 0;
        distance = 0.0001;
    }

    const normalX = offsetX / distance;
    const normalY = offsetY / distance;

    const overlap = contactDistance - distance;
    const totalInverseMass = a.inverseMass + b.inverseMass;
    const correction = overlap / totalInverseMass;

    a.x -= normalX * correction * a.inverseMass;
    a.y -= normalY * correction * a.inverseMass;
    b.x += normalX * correction * b.inverseMass;
    b.y += normalY * correction * b.inverseMass;

    const relativeNormalSpeed =
        (b.velocityX - a.velocityX) * normalX +
        (b.velocityY - a.velocityY) * normalY;

    if (relativeNormalSpeed > 0) return;

    // --- birth ---
    if (canSpawn &&
        balls.length + pendingSpawns.length < maxBalls &&
        -relativeNormalSpeed > spawnImpactSpeed &&
        a.spawnLockout <= 0 && b.spawnLockout <= 0) {

        const contactX = a.x + normalX * a.radius;
        const contactY = a.y + normalY * a.radius;
        const kick = randomFloat(120, 260) * (Math.random() < 0.5 ? -1 : 1);

        pendingSpawns.push({
            x: contactX,
            y: contactY,
            velocityX: (a.velocityX + b.velocityX) / 2 - normalY * kick,
            velocityY: (a.velocityY + b.velocityY) / 2 + normalX * kick,
            radius: randomInt(childRadiusRange[0], childRadiusRange[1]),
            gravity: (a.gravity + b.gravity) / 2,
            restitution: Math.min(a.restitution, b.restitution),
            spawnLockout: birthLockout
        });

        a.spawnLockout = spawnCooldown;
        b.spawnLockout = spawnCooldown;
    }

    const restitution = a.restitution < b.restitution ? a.restitution : b.restitution;
    const impulse = -(1 + restitution) * relativeNormalSpeed / totalInverseMass;

    a.velocityX -= impulse * a.inverseMass * normalX;
    a.velocityY -= impulse * a.inverseMass * normalY;
    b.velocityX += impulse * b.inverseMass * normalX;
    b.velocityY += impulse * b.inverseMass * normalY;
}

// Visit each unordered pair once by only accepting neighbours with a higher
// array index. Positional correction moves balls after the grid was built,
// but only by the overlap amount, and the 3x3 search has a full cell of
// slack — anything missed is caught on the next substep.
function resolveBallCollisions(canSpawn) {
    buildGrid();

    const count = balls.length;
    for (let i = 0; i < count; i++) {
        const a = balls[i];
        const cell = ballCell[i];
        const column = cell % gridCols;
        const row = (cell / gridCols) | 0;

        const firstColumn = column > 0 ? column - 1 : 0;
        const lastColumn = column < gridCols - 1 ? column + 1 : gridCols - 1;
        const firstRow = row > 0 ? row - 1 : 0;
        const lastRow = row < gridRows - 1 ? row + 1 : gridRows - 1;

        for (let neighbourRow = firstRow; neighbourRow <= lastRow; neighbourRow++) {
            const rowBase = neighbourRow * gridCols;

            for (let neighbourColumn = firstColumn; neighbourColumn <= lastColumn; neighbourColumn++) {
                const neighbourCell = rowBase + neighbourColumn;
                const end = cellStart[neighbourCell + 1];

                for (let k = cellStart[neighbourCell]; k < end; k++) {
                    const j = cellItems[k];
                    if (j <= i) continue;
                    resolvePair(a, balls[j], canSpawn);
                }
            }
        }
    }
}

// --- ball vs. wall ---
function resolveWall(ball) {
    const offsetX = ball.x - centerX;
    const offsetY = ball.y - centerY;
    const distanceSquared = offsetX * offsetX + offsetY * offsetY;

    if (distanceSquared <= ball.maxCenterDistanceSquared) return;

    const distanceFromCenter = Math.sqrt(distanceSquared);
    const normalX = offsetX / distanceFromCenter;
    const normalY = offsetY / distanceFromCenter;

    ball.x = centerX + normalX * ball.maxCenterDistance;
    ball.y = centerY + normalY * ball.maxCenterDistance;

    const speedAlongNormal = ball.velocityX * normalX + ball.velocityY * normalY;
    if (speedAlongNormal > 0) {
        ball.velocityX -= (1 + ball.restitution) * speedAlongNormal * normalX;
        ball.velocityY -= (1 + ball.restitution) * speedAlongNormal * normalY;
    }

    if (speedAlongNormal < 30 && speedAlongNormal > -30) {
        const residualNormalSpeed = ball.velocityX * normalX + ball.velocityY * normalY;
        ball.velocityX -= residualNormalSpeed * normalX;
        ball.velocityY -= residualNormalSpeed * normalY;
    }
}

// --- rendering ---
context.font = '28px ui-monospace, monospace';   // set once; clearRect doesn't reset state
context.lineWidth = 3;

function draw() {
    context.clearRect(0, 0, canvasSize, canvasSize);

    context.beginPath();
    context.arc(centerX, centerY, containerRadius, 0, Math.PI * 2);
    context.strokeStyle = '#6f7d82';
    context.stroke();

    for (let i = 0; i < balls.length; i++) {
        const ball = balls[i];
        const half = ball.spriteHalf;
        context.drawImage(ball.sprite, ball.x - half, ball.y - half);
    }

    context.fillStyle = '#6f7d82';
    context.fillText(balls.length + ' / ' + maxBalls, 24, 44);
}

// --- loop ---
const physicsStep = 1 / 240;
const collisionPasses = 2;

let accumulator = 0;
let lastFrameTime = performance.now();

function frame(now) {
    let elapsed = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (elapsed > 0.25) elapsed = 0.25;
    accumulator += elapsed;

    while (accumulator >= physicsStep) {
        const count = balls.length;

        for (let i = 0; i < count; i++) integrate(balls[i], physicsStep);
        for (let pass = 0; pass < collisionPasses; pass++) {
            resolveBallCollisions(pass === 0);
        }
        for (let i = 0; i < count; i++) resolveWall(balls[i]);

        for (let i = 0; i < pendingSpawns.length; i++) {
            if (balls.length >= maxBalls) break;
            spawnBall(pendingSpawns[i]);
        }
        pendingSpawns.length = 0;

        accumulator -= physicsStep;
    }

    draw();
    requestAnimationFrame(frame);
}

requestAnimationFrame(frame);