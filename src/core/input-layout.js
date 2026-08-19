'use strict';

const EDGE_TOLERANCE = 4;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeRect(value, fallback = {}) {
  return {
    id: String(value?.id ?? fallback.id ?? ''),
    x: Math.round(finiteNumber(value?.x, fallback.x ?? 0)),
    y: Math.round(finiteNumber(value?.y, fallback.y ?? 0)),
    width: Math.max(1, Math.round(finiteNumber(value?.width, fallback.width ?? 1))),
    height: Math.max(1, Math.round(finiteNumber(value?.height, fallback.height ?? 1)))
  };
}

function rectRight(rect) {
  return rect.x + rect.width;
}

function rectBottom(rect) {
  return rect.y + rect.height;
}

function within(value, minimum, maximum, tolerance = 0) {
  return value >= minimum - tolerance && value <= maximum + tolerance;
}

function overlapPoint(value, firstStart, firstEnd, secondStart, secondEnd) {
  return within(value, Math.max(firstStart, secondStart), Math.min(firstEnd, secondEnd));
}

function hasAdjacentEdge(localDisplays, remoteValue, tolerance = EDGE_TOLERANCE) {
  const remote = normalizeRect(remoteValue);
  const remoteRight = rectRight(remote);
  const remoteBottom = rectBottom(remote);
  return localDisplays.some((localValue) => {
    const local = normalizeRect(localValue);
    const localRight = rectRight(local);
    const localBottom = rectBottom(local);
    const verticalOverlap = Math.min(localBottom, remoteBottom) - Math.max(local.y, remote.y);
    const horizontalOverlap = Math.min(localRight, remoteRight) - Math.max(local.x, remote.x);
    return (verticalOverlap > 1
        && (Math.abs(localRight - remote.x) <= tolerance || Math.abs(local.x - remoteRight) <= tolerance))
      || (horizontalOverlap > 1
        && (Math.abs(localBottom - remote.y) <= tolerance || Math.abs(local.y - remoteBottom) <= tolerance));
  });
}

function defaultRemoteRect(localDisplays, width = 1920, height = 1080, id = 'remote') {
  const locals = localDisplays.map((display) => normalizeRect(display));
  if (!locals.length) return normalizeRect({ id, x: 0, y: 0, width, height });
  const top = Math.min(...locals.map((display) => display.y));
  const topRow = locals.filter((display) => display.y === top);
  const anchor = topRow.reduce((best, display) => (
    !best || rectRight(display) > rectRight(best) ? display : best
  ), null);
  return normalizeRect({ id, x: rectRight(anchor), y: anchor.y, width, height });
}

function findEntry(localDisplays, remoteValue, pointValue, deltaValue, tolerance = EDGE_TOLERANCE) {
  const remote = normalizeRect(remoteValue);
  const point = { x: finiteNumber(pointValue?.x), y: finiteNumber(pointValue?.y) };
  const delta = { x: finiteNumber(deltaValue?.x), y: finiteNumber(deltaValue?.y) };

  for (const localValue of localDisplays) {
    const local = normalizeRect(localValue);
    const localRight = rectRight(local);
    const localBottom = rectBottom(local);
    const remoteRight = rectRight(remote);
    const remoteBottom = rectBottom(remote);

    if (Math.abs(localRight - remote.x) <= tolerance
      && delta.x > 0
      && point.x >= localRight - tolerance
      && overlapPoint(point.y, local.y, localBottom, remote.y, remoteBottom)) {
      return {
        edge: 'right',
        local,
        remotePoint: { x: 1, y: Math.max(0, Math.min(remote.height - 1, point.y - remote.y)) }
      };
    }
    if (Math.abs(local.x - remoteRight) <= tolerance
      && delta.x < 0
      && point.x <= local.x + tolerance
      && overlapPoint(point.y, local.y, localBottom, remote.y, remoteBottom)) {
      return {
        edge: 'left',
        local,
        remotePoint: { x: remote.width - 2, y: Math.max(0, Math.min(remote.height - 1, point.y - remote.y)) }
      };
    }
    if (Math.abs(localBottom - remote.y) <= tolerance
      && delta.y > 0
      && point.y >= localBottom - tolerance
      && overlapPoint(point.x, local.x, localRight, remote.x, remoteRight)) {
      return {
        edge: 'bottom',
        local,
        remotePoint: { x: Math.max(0, Math.min(remote.width - 1, point.x - remote.x)), y: 1 }
      };
    }
    if (Math.abs(local.y - remoteBottom) <= tolerance
      && delta.y < 0
      && point.y <= local.y + tolerance
      && overlapPoint(point.x, local.x, localRight, remote.x, remoteRight)) {
      return {
        edge: 'top',
        local,
        remotePoint: { x: Math.max(0, Math.min(remote.width - 1, point.x - remote.x)), y: remote.height - 2 }
      };
    }
  }
  return null;
}

function findExit(localDisplays, remoteValue, pointValue) {
  const remote = normalizeRect(remoteValue);
  const point = { x: finiteNumber(pointValue?.x), y: finiteNumber(pointValue?.y) };
  const world = { x: remote.x + point.x, y: remote.y + point.y };

  for (const localValue of localDisplays) {
    const local = normalizeRect(localValue);
    const localRight = rectRight(local);
    const localBottom = rectBottom(local);
    const remoteRight = rectRight(remote);
    const remoteBottom = rectBottom(remote);

    if (point.x < 0
      && Math.abs(localRight - remote.x) <= EDGE_TOLERANCE
      && overlapPoint(world.y, local.y, localBottom, remote.y, remoteBottom)) {
      return { edge: 'left', local, localPoint: { x: localRight - 2, y: world.y } };
    }
    if (point.x >= remote.width
      && Math.abs(local.x - remoteRight) <= EDGE_TOLERANCE
      && overlapPoint(world.y, local.y, localBottom, remote.y, remoteBottom)) {
      return { edge: 'right', local, localPoint: { x: local.x + 1, y: world.y } };
    }
    if (point.y < 0
      && Math.abs(localBottom - remote.y) <= EDGE_TOLERANCE
      && overlapPoint(world.x, local.x, localRight, remote.x, remoteRight)) {
      return { edge: 'top', local, localPoint: { x: world.x, y: localBottom - 2 } };
    }
    if (point.y >= remote.height
      && Math.abs(local.y - remoteBottom) <= EDGE_TOLERANCE
      && overlapPoint(world.x, local.x, localRight, remote.x, remoteRight)) {
      return { edge: 'bottom', local, localPoint: { x: world.x, y: local.y + 1 } };
    }
  }
  return null;
}

function snapRemoteRect(remoteValue, localDisplays, threshold = 120) {
  const remote = normalizeRect(remoteValue);
  let best = { distance: Math.max(0, finiteNumber(threshold, 120)), x: remote.x, y: remote.y };
  for (const value of localDisplays) {
    const local = normalizeRect(value);
    const candidates = [
      { distance: Math.abs(remote.x - rectRight(local)), x: rectRight(local), y: remote.y },
      { distance: Math.abs(rectRight(remote) - local.x), x: local.x - remote.width, y: remote.y },
      { distance: Math.abs(remote.y - rectBottom(local)), x: remote.x, y: rectBottom(local) },
      { distance: Math.abs(rectBottom(remote) - local.y), x: remote.x, y: local.y - remote.height }
    ];
    for (const candidate of candidates) {
      if (candidate.distance < best.distance) best = candidate;
    }
  }
  return { ...remote, x: Math.round(best.x), y: Math.round(best.y) };
}

class InputLayoutRouter {
  constructor(layout) {
    this.configure(layout);
  }

  configure(layout) {
    this.locals = (layout?.locals || []).map((display) => normalizeRect(display));
    this.remote = normalizeRect(layout?.remote, defaultRemoteRect(this.locals));
    this.remotePoint = { x: 0, y: 0 };
    this.entry = null;
    this.active = false;
  }

  tryEnter(point, delta) {
    if (this.active) return null;
    const entry = findEntry(this.locals, this.remote, point, delta);
    if (!entry) return null;
    this.entry = entry;
    this.remotePoint = entry.remotePoint;
    this.active = true;
    return { ...entry, point: { ...this.remotePoint } };
  }

  move(deltaX, deltaY) {
    if (!this.active) return null;
    const candidate = {
      x: this.remotePoint.x + finiteNumber(deltaX),
      y: this.remotePoint.y + finiteNumber(deltaY)
    };
    const exit = findExit(this.locals, this.remote, candidate);
    if (exit) {
      this.active = false;
      this.remotePoint = {
        x: Math.max(0, Math.min(this.remote.width - 1, candidate.x)),
        y: Math.max(0, Math.min(this.remote.height - 1, candidate.y))
      };
      return { exited: true, ...exit };
    }
    this.remotePoint = {
      x: Math.max(0, Math.min(this.remote.width - 1, candidate.x)),
      y: Math.max(0, Math.min(this.remote.height - 1, candidate.y))
    };
    return { exited: false, point: { ...this.remotePoint } };
  }

  forceExit() {
    this.active = false;
    const local = this.entry?.local || this.locals[0];
    if (!local) return { x: 0, y: 0 };
    if (this.entry?.edge === 'right') return { x: rectRight(local) - 8, y: local.y + local.height / 2 };
    if (this.entry?.edge === 'left') return { x: local.x + 8, y: local.y + local.height / 2 };
    if (this.entry?.edge === 'bottom') return { x: local.x + local.width / 2, y: rectBottom(local) - 8 };
    if (this.entry?.edge === 'top') return { x: local.x + local.width / 2, y: local.y + 8 };
    return { x: local.x + local.width / 2, y: local.y + local.height / 2 };
  }
}

module.exports = {
  EDGE_TOLERANCE,
  InputLayoutRouter,
  defaultRemoteRect,
  findEntry,
  findExit,
  hasAdjacentEdge,
  normalizeRect,
  snapRemoteRect
};
