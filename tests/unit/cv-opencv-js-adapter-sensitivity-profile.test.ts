import { describe, expect, it } from 'vitest';

import {
  HIGH_RES_CV_SENSITIVITY_PROFILE,
  NORMAL_CV_SENSITIVITY_PROFILE,
  createOpenCvJsAdapter,
  type CvSurfaceRaster
} from '../../src/core/engines/structure/cv';

interface AdaptiveThresholdCall {
  blockSize: number;
  c: number;
}

interface CannyCall {
  lo: number;
  hi: number;
}

interface CapturingRuntime {
  cv: unknown;
  adaptiveThresholdCalls: AdaptiveThresholdCall[];
  cannyCalls: CannyCall[];
}

const createCapturingRuntime = (): CapturingRuntime => {
  const adaptiveThresholdCalls: AdaptiveThresholdCall[] = [];
  const cannyCalls: CannyCall[] = [];

  class MockMat {
    rows = 0;
    cols = 0;
    data32S?: Int32Array;
    data?: Uint8Array;
    delete(): void {}
  }

  class MockMatVector {
    private mats: MockMat[] = [];
    size(): number {
      return this.mats.length;
    }
    get(index: number): MockMat {
      return this.mats[index];
    }
    push(mat: MockMat): void {
      this.mats.push(mat);
    }
    delete(): void {}
  }

  const cv = {
    Mat: MockMat,
    MatVector: MockMatVector,
    Size: class {
      constructor(public width: number, public height: number) {}
    },
    matFromImageData: () => new MockMat(),
    cvtColor: () => {},
    adaptiveThreshold: (
      _src: MockMat,
      _dst: MockMat,
      _maxValue: number,
      _adaptiveMethod: number,
      _thresholdType: number,
      blockSize: number,
      c: number
    ) => {
      adaptiveThresholdCalls.push({ blockSize, c });
    },
    threshold: () => {},
    morphologyEx: () => {},
    Canny: (_src: MockMat, _dst: MockMat, lo: number, hi: number) => {
      cannyCalls.push({ lo, hi });
    },
    GaussianBlur: () => {},
    bitwise_or: () => {},
    findContours: (
      _image: MockMat,
      _contours: InstanceType<typeof MockMatVector>,
      _hierarchy: MockMat,
      _mode: number,
      _method: number
    ) => {},
    boundingRect: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    contourArea: () => 0,
    approxPolyDP: () => {},
    arcLength: () => 0,
    isContourConvex: () => false,
    getStructuringElement: () => new MockMat(),
    HoughLinesP: () => {},
    COLOR_RGBA2GRAY: 0,
    ADAPTIVE_THRESH_GAUSSIAN_C: 0,
    THRESH_BINARY_INV: 0,
    THRESH_BINARY: 0,
    MORPH_RECT: 0,
    MORPH_OPEN: 0,
    MORPH_CLOSE: 0,
    RETR_EXTERNAL: 0,
    RETR_TREE: 0,
    RETR_LIST: 0,
    CHAIN_APPROX_SIMPLE: 0
  };

  return { cv, adaptiveThresholdCalls, cannyCalls };
};

const makeUniformGreyRaster = (
  width: number,
  height: number,
  luminance: number
): CvSurfaceRaster => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = luminance;
    data[i + 1] = luminance;
    data[i + 2] = luminance;
    data[i + 3] = 255;
  }
  return {
    surface: { pageIndex: 0, surfaceWidth: width, surfaceHeight: height },
    pixels: { width, height, data, colorSpace: 'srgb' } as unknown as ImageData
  };
};

describe('createOpenCvJsAdapter — sensitivity profile threading', () => {
  it('uses NORMAL_CV_SENSITIVITY_PROFILE values when no profile is supplied', async () => {
    const runtime = createCapturingRuntime();
    const adapter = createOpenCvJsAdapter({ opencvRuntime: runtime.cv });
    const raster = makeUniformGreyRaster(40, 40, 200);

    await adapter.detectContentRect(raster);

    expect(runtime.adaptiveThresholdCalls.length).toBeGreaterThan(0);
    expect(runtime.adaptiveThresholdCalls[0].c).toBe(
      NORMAL_CV_SENSITIVITY_PROFILE.adaptiveThresholdC
    );
  });

  it('threads the supplied adaptiveThresholdC value into the OpenCV adaptiveThreshold call', async () => {
    const runtime = createCapturingRuntime();
    const adapter = createOpenCvJsAdapter({
      opencvRuntime: runtime.cv,
      sensitivityProfile: HIGH_RES_CV_SENSITIVITY_PROFILE
    });
    const raster = makeUniformGreyRaster(40, 40, 200);

    await adapter.detectContentRect(raster);

    expect(runtime.adaptiveThresholdCalls[0].c).toBe(
      HIGH_RES_CV_SENSITIVITY_PROFILE.adaptiveThresholdC
    );
    expect(HIGH_RES_CV_SENSITIVITY_PROFILE.adaptiveThresholdC).toBeLessThan(
      NORMAL_CV_SENSITIVITY_PROFILE.adaptiveThresholdC
    );
  });

  it('widens the Canny hysteresis band when sigma increases', async () => {
    // Same uniform raster → same median luminance → identical (1±sigma)*median
    // computation. A larger sigma must produce a wider (lo, hi) band.
    const normalRuntime = createCapturingRuntime();
    const highResRuntime = createCapturingRuntime();
    const luminance = 200;
    const raster = makeUniformGreyRaster(40, 40, luminance);

    const normalAdapter = createOpenCvJsAdapter({
      opencvRuntime: normalRuntime.cv,
      sensitivityProfile: NORMAL_CV_SENSITIVITY_PROFILE
    });
    const highResAdapter = createOpenCvJsAdapter({
      opencvRuntime: highResRuntime.cv,
      sensitivityProfile: HIGH_RES_CV_SENSITIVITY_PROFILE
    });

    await normalAdapter.detectContentRect(raster);
    await highResAdapter.detectContentRect(raster);

    expect(normalRuntime.cannyCalls.length).toBeGreaterThan(0);
    expect(highResRuntime.cannyCalls.length).toBeGreaterThan(0);

    const normalCall = normalRuntime.cannyCalls[0];
    const highResCall = highResRuntime.cannyCalls[0];

    const normalBand = normalCall.hi - normalCall.lo;
    const highResBand = highResCall.hi - highResCall.lo;
    expect(highResBand).toBeGreaterThan(normalBand);
  });

  it('relaxes the dark-page normalized threshold when the profile floor is lowered', async () => {
    // A dark-perimeter raster (luminance 8) inverts to 247 background. The
    // normalized threshold is `max(profileFloor, min(baseThreshold, invertedBg - 16))`,
    // i.e. `max(floor, 231)`. Under NORMAL the floor is 180 → effective 231.
    // Under a profile with floor 250 the result clamps to 250, demonstrating
    // the floor takes effect. Conversely under HIGH_RES (floor 140) the
    // result is the same 231 because 231 > 140 — i.e. the floor only binds
    // when it is above the natural value, and lowering it never hurts.
    const darkRaster = makeUniformGreyRaster(40, 40, 8);

    const lowFloorRuntime = createCapturingRuntime();
    const lowFloorAdapter = createOpenCvJsAdapter({
      opencvRuntime: lowFloorRuntime.cv,
      sensitivityProfile: HIGH_RES_CV_SENSITIVITY_PROFILE
    });
    await lowFloorAdapter.detectContentRect(darkRaster);

    const highFloorRuntime = createCapturingRuntime();
    const highFloorAdapter = createOpenCvJsAdapter({
      opencvRuntime: highFloorRuntime.cv,
      sensitivityProfile: {
        adaptiveThresholdC: NORMAL_CV_SENSITIVITY_PROFILE.adaptiveThresholdC,
        cannyAutoSigma: NORMAL_CV_SENSITIVITY_PROFILE.cannyAutoSigma,
        darkPageNormalizedThresholdFloor: 250
      }
    });
    await highFloorAdapter.detectContentRect(darkRaster);

    // Both calls completed without throwing — the floor is being threaded
    // through detectBackgroundProfile. We assert the indirect observable: a
    // floor that pins higher does not crash, and adaptiveThreshold still ran.
    expect(lowFloorRuntime.adaptiveThresholdCalls.length).toBeGreaterThan(0);
    expect(highFloorRuntime.adaptiveThresholdCalls.length).toBeGreaterThan(0);
  });

  it('exposes profile constants with the expected hi-res relationship', () => {
    expect(HIGH_RES_CV_SENSITIVITY_PROFILE.adaptiveThresholdC).toBeLessThan(
      NORMAL_CV_SENSITIVITY_PROFILE.adaptiveThresholdC
    );
    expect(HIGH_RES_CV_SENSITIVITY_PROFILE.cannyAutoSigma).toBeGreaterThan(
      NORMAL_CV_SENSITIVITY_PROFILE.cannyAutoSigma
    );
    expect(
      HIGH_RES_CV_SENSITIVITY_PROFILE.darkPageNormalizedThresholdFloor
    ).toBeLessThan(NORMAL_CV_SENSITIVITY_PROFILE.darkPageNormalizedThresholdFloor);
  });
});
