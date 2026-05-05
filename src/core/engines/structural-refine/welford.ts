/**
 * Shared Welford helpers used by the aggregator and merge code paths.
 *
 * `WelfordScalar` is `{ count, totalWeight, mean, m2 }`. Storing `m2`
 * rather than a pre-divided variance is what makes parallel merges
 * associative — see `mergeWelford` below.
 */
import type {
  WelfordAffine,
  WelfordRect,
  WelfordRelative,
  WelfordScalar
} from '../../contracts/structural-refine-analytics';
import type { TransformationAffine } from '../../contracts/transformation-model';
import type { StructuralNormalizedRect } from '../../contracts/structural-model';

export const emptyWelfordScalar = (): WelfordScalar => ({
  count: 0,
  totalWeight: 0,
  mean: 0,
  m2: 0
});

export const emptyWelfordAffine = (): WelfordAffine => ({
  scaleX: emptyWelfordScalar(),
  scaleY: emptyWelfordScalar(),
  translateX: emptyWelfordScalar(),
  translateY: emptyWelfordScalar()
});

export const emptyWelfordRect = (): WelfordRect => ({
  xNorm: emptyWelfordScalar(),
  yNorm: emptyWelfordScalar(),
  wNorm: emptyWelfordScalar(),
  hNorm: emptyWelfordScalar()
});

export const emptyWelfordRelative = (): WelfordRelative => ({
  dxCenter: emptyWelfordScalar(),
  dyCenter: emptyWelfordScalar(),
  wRatio: emptyWelfordScalar(),
  hRatio: emptyWelfordScalar()
});

/**
 * West's incremental weighted-Welford update. `weight = 1` for unweighted streams.
 *
 * Mutates the passed accumulator and returns it for chaining.
 */
export const observeWelford = (
  acc: WelfordScalar,
  value: number,
  weight = 1
): WelfordScalar => {
  if (!Number.isFinite(value)) {
    return acc;
  }
  if (weight <= 0) {
    return acc;
  }
  acc.count += 1;
  const newTotalWeight = acc.totalWeight + weight;
  const delta = value - acc.mean;
  acc.mean += (delta * weight) / newTotalWeight;
  const delta2 = value - acc.mean;
  acc.m2 += weight * delta * delta2;
  acc.totalWeight = newTotalWeight;
  return acc;
};

export const observeWelfordAffine = (
  acc: WelfordAffine,
  affine: TransformationAffine,
  weight = 1
): WelfordAffine => {
  observeWelford(acc.scaleX, affine.scaleX, weight);
  observeWelford(acc.scaleY, affine.scaleY, weight);
  observeWelford(acc.translateX, affine.translateX, weight);
  observeWelford(acc.translateY, affine.translateY, weight);
  return acc;
};

export const observeWelfordRectDelta = (
  acc: WelfordRect,
  delta: StructuralNormalizedRect,
  weight = 1
): WelfordRect => {
  observeWelford(acc.xNorm, delta.xNorm, weight);
  observeWelford(acc.yNorm, delta.yNorm, weight);
  observeWelford(acc.wNorm, delta.wNorm, weight);
  observeWelford(acc.hNorm, delta.hNorm, weight);
  return acc;
};

export const observeWelfordRelative = (
  acc: WelfordRelative,
  observed: { dxCenter: number; dyCenter: number; wRatio: number; hRatio: number },
  weight = 1
): WelfordRelative => {
  observeWelford(acc.dxCenter, observed.dxCenter, weight);
  observeWelford(acc.dyCenter, observed.dyCenter, weight);
  observeWelford(acc.wRatio, observed.wRatio, weight);
  observeWelford(acc.hRatio, observed.hRatio, weight);
  return acc;
};

/**
 * Standard parallel-Welford merge. Returns a fresh accumulator; both inputs
 * are read-only.
 */
export const mergeWelford = (a: WelfordScalar, b: WelfordScalar): WelfordScalar => {
  if (a.totalWeight <= 0 && b.totalWeight <= 0) {
    return emptyWelfordScalar();
  }
  if (a.totalWeight <= 0) {
    return cloneWelfordScalar(b);
  }
  if (b.totalWeight <= 0) {
    return cloneWelfordScalar(a);
  }
  const totalWeight = a.totalWeight + b.totalWeight;
  const delta = b.mean - a.mean;
  const mean = (a.mean * a.totalWeight + b.mean * b.totalWeight) / totalWeight;
  const m2 = a.m2 + b.m2 + (delta * delta * a.totalWeight * b.totalWeight) / totalWeight;
  return {
    count: a.count + b.count,
    totalWeight,
    mean,
    m2
  };
};

export const mergeWelfordAffine = (a: WelfordAffine, b: WelfordAffine): WelfordAffine => ({
  scaleX: mergeWelford(a.scaleX, b.scaleX),
  scaleY: mergeWelford(a.scaleY, b.scaleY),
  translateX: mergeWelford(a.translateX, b.translateX),
  translateY: mergeWelford(a.translateY, b.translateY)
});

export const mergeWelfordRect = (a: WelfordRect, b: WelfordRect): WelfordRect => ({
  xNorm: mergeWelford(a.xNorm, b.xNorm),
  yNorm: mergeWelford(a.yNorm, b.yNorm),
  wNorm: mergeWelford(a.wNorm, b.wNorm),
  hNorm: mergeWelford(a.hNorm, b.hNorm)
});

export const mergeWelfordRelative = (
  a: WelfordRelative,
  b: WelfordRelative
): WelfordRelative => ({
  dxCenter: mergeWelford(a.dxCenter, b.dxCenter),
  dyCenter: mergeWelford(a.dyCenter, b.dyCenter),
  wRatio: mergeWelford(a.wRatio, b.wRatio),
  hRatio: mergeWelford(a.hRatio, b.hRatio)
});

export const cloneWelfordScalar = (acc: WelfordScalar): WelfordScalar => ({
  count: acc.count,
  totalWeight: acc.totalWeight,
  mean: acc.mean,
  m2: acc.m2
});

export const cloneWelfordAffine = (acc: WelfordAffine): WelfordAffine => ({
  scaleX: cloneWelfordScalar(acc.scaleX),
  scaleY: cloneWelfordScalar(acc.scaleY),
  translateX: cloneWelfordScalar(acc.translateX),
  translateY: cloneWelfordScalar(acc.translateY)
});

export const cloneWelfordRect = (acc: WelfordRect): WelfordRect => ({
  xNorm: cloneWelfordScalar(acc.xNorm),
  yNorm: cloneWelfordScalar(acc.yNorm),
  wNorm: cloneWelfordScalar(acc.wNorm),
  hNorm: cloneWelfordScalar(acc.hNorm)
});

export const cloneWelfordRelative = (acc: WelfordRelative): WelfordRelative => ({
  dxCenter: cloneWelfordScalar(acc.dxCenter),
  dyCenter: cloneWelfordScalar(acc.dyCenter),
  wRatio: cloneWelfordScalar(acc.wRatio),
  hRatio: cloneWelfordScalar(acc.hRatio)
});
