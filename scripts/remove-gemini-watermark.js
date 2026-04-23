#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { findWatermarkSparkles } = require('./detect-gemini-watermark.js');

// Constants for pixel subtraction matching Real.js
const CONSTANTS = {
  ALPHA_THRESHOLD: 0.002,
  MAX_ALPHA: 0.99,
  LOGO_VALUE: 255
};

const PRIMARY_MATCH_MIN_SCORES = {
  48: 0.75,
  96: 0.75,
};
const DEFAULT_PLACEMENT_MIN_SCORES = {
  48: 0.64,
  96: 0.58,
};
const SECONDARY_MATCH_RATIO = 0.75;
const TEMPLATE_CACHE = new Map();
const SCALED_TEMPLATE_CACHE = new Map();
let OPENCV_PYTHON_RUNTIME;
const RESIDUAL_HEAL_CONFIG = {
  grayThreshold: 212,
  saturationThreshold: 18,
  windowWidth: 90,
  windowHeight: 90,
  minArea: 250,
  dilationRadius: 2,
  iterations: 400,
  cornerSeedGrayFloor: 180,
  cornerSeedSaturationMax: 30,
  cornerSeedResidualMin: 2.4,
  cornerSeedSearchXRatio: 0.6,
  cornerSeedSearchYRatio: 0.8,
  cornerSeedRadius: 3,
  cornerSeedMinScore: 4.6,
  cornerEllipseRadiusX: 9,
  cornerEllipseRadiusY: 9,
  cornerIterations: 160,
  lowContrastStripWidthRatio: 0.39,
  lowContrastMaskStartXRatio: 0.45,
  lowContrastResidualMin: 8,
  lowContrastSaturationMax: 28,
  lowContrastMinArea: 80,
  lowContrastMaxBoxes: 3,
  lowContrastBoxPadding: 6,
  openCvMaskPadding: 2,
  openCvRadius: 2,
};

// Alpha Maps for the watermark patterns (48px and 96px versions)
const ASSETS = {
  bg48: "data:image/png;base64,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",
  bg96: "data:image/png;base64,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"
};

// --- Utilities ---
function loadPng(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(new PNG())
      .on('parsed', function onParsed() {
        resolve(this);
      })
      .on('error', reject);
  });
}

function savePng(png, filePath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    png.pack().pipe(stream);
  });
}

async function decodeBase64Png(base64String) {
  const base64Data = base64String.replace(/^data:image\/png;base64,/, "");
  const buffer = Buffer.from(base64Data, 'base64');
  return new Promise((resolve, reject) => {
    new PNG().parse(buffer, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function calculateAlphaMap(logoPng) {
  const alphaMap = new Float32Array(logoPng.width * logoPng.height);
  for (let i = 0; i < alphaMap.length; i++) {
    const idx = i * 4;
    const maxChannel = Math.max(logoPng.data[idx], logoPng.data[idx + 1], logoPng.data[idx + 2]);
    alphaMap[i] = maxChannel / 255;
  }
  return alphaMap;
}

function resizeAlphaMap(alphaMap, sourceSize, targetSize) {
  if (sourceSize === targetSize) {
    return new Float32Array(alphaMap);
  }

  const scaled = new Float32Array(targetSize * targetSize);
  const sourceLast = Math.max(1, sourceSize - 1);
  const targetLast = Math.max(1, targetSize - 1);

  for (let y = 0; y < targetSize; y += 1) {
    const srcY = (y / targetLast) * sourceLast;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(sourceSize - 1, y0 + 1);
    const wy = srcY - y0;

    for (let x = 0; x < targetSize; x += 1) {
      const srcX = (x / targetLast) * sourceLast;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(sourceSize - 1, x0 + 1);
      const wx = srcX - x0;

      const a00 = alphaMap[y0 * sourceSize + x0];
      const a10 = alphaMap[y0 * sourceSize + x1];
      const a01 = alphaMap[y1 * sourceSize + x0];
      const a11 = alphaMap[y1 * sourceSize + x1];

      const top = a00 * (1 - wx) + a10 * wx;
      const bottom = a01 * (1 - wx) + a11 * wx;
      scaled[y * targetSize + x] = top * (1 - wy) + bottom * wy;
    }
  }

  return scaled;
}

async function getAlphaTemplate(logoSize) {
  if (TEMPLATE_CACHE.has(logoSize)) {
    return TEMPLATE_CACHE.get(logoSize);
  }

  const assetKey = logoSize === 48 ? 'bg48' : 'bg96';
  const logo = await decodeBase64Png(ASSETS[assetKey]);
  const template = {
    logoSize,
    alphaMap: calculateAlphaMap(logo),
  };

  TEMPLATE_CACHE.set(logoSize, template);
  return template;
}

async function getScaledAlphaTemplate(baseSize, targetSize) {
  const key = `${baseSize}:${targetSize}`;
  if (SCALED_TEMPLATE_CACHE.has(key)) {
    return SCALED_TEMPLATE_CACHE.get(key);
  }

  const baseTemplate = await getAlphaTemplate(baseSize);
  const template = {
    logoSize: targetSize,
    alphaMap: resizeAlphaMap(baseTemplate.alphaMap, baseSize, targetSize),
  };
  SCALED_TEMPLATE_CACHE.set(key, template);
  return template;
}

function buildGrayscale(png) {
  const gray = new Float32Array(png.width * png.height);
  for (let i = 0; i < gray.length; i++) {
    const idx = i << 2;
    gray[i] = (png.data[idx] + png.data[idx + 1] + png.data[idx + 2]) / 3;
  }
  return gray;
}

function createBounds(x, y, size) {
  return {
    x0: x,
    y0: y,
    x1: x + size - 1,
    y1: y + size - 1,
  };
}

function overlapsBounds(bounds, suppressed, padding = 0) {
  return suppressed.some((entry) => (
    bounds.x0 <= entry.x1 + padding &&
    bounds.x1 >= entry.x0 - padding &&
    bounds.y0 <= entry.y1 + padding &&
    bounds.y1 >= entry.y0 - padding
  ));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isDefaultPlacementMatch(png, match, logoSize) {
  if (!match || !Number.isFinite(match.score)) {
    return false;
  }

  const expectedMargin = logoSize === 96 ? 64 : 32;
  const rightMargin = png.width - (match.x + logoSize);
  const bottomMargin = png.height - (match.y + logoSize);
  const tolerance = logoSize === 96 ? 12 : 8;

  return (
    Math.abs(rightMargin - expectedMargin) <= tolerance &&
    Math.abs(bottomMargin - expectedMargin) <= tolerance
  );
}

function isNearCornerPlacement(png, match, logoSize) {
  if (!match || !Number.isFinite(match.x) || !Number.isFinite(match.y)) {
    return false;
  }

  const rightMargin = png.width - (match.x + logoSize);
  const bottomMargin = png.height - (match.y + logoSize);
  const marginLimitX = Math.max(96, Math.floor(png.width * 0.12));
  const marginLimitY = Math.max(96, Math.floor(png.height * 0.12));

  return rightMargin >= 0 && bottomMargin >= 0 &&
    rightMargin <= marginLimitX &&
    bottomMargin <= marginLimitY;
}

function getCornerSearchBounds(png, logoSize) {
  const searchWidth = Math.max(192, Math.floor(png.width * 0.18), logoSize * 4 + 32);
  const searchHeight = Math.max(192, Math.floor(png.height * 0.18), logoSize * 4 + 32);
  return {
    startX: Math.max(0, png.width - searchWidth - logoSize),
    startY: Math.max(0, png.height - searchHeight - logoSize),
    endX: png.width - logoSize,
    endY: png.height - logoSize,
  };
}

function resolveOpenCvPythonRuntime() {
  if (OPENCV_PYTHON_RUNTIME !== undefined) {
    return OPENCV_PYTHON_RUNTIME;
  }

  const candidates = [];
  if (process.env.IMPROVEDWATER_PYTHON) {
    candidates.push({ command: process.env.IMPROVEDWATER_PYTHON, args: [] });
  }
  candidates.push(
    { command: 'C:\\Users\\ASUS\\AppData\\Local\\Programs\\Python\\Python313\\python.exe', args: [] },
    { command: 'python', args: [] },
    { command: 'py', args: ['-3'] },
  );

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate.command,
      [...candidate.args, '-c', 'import cv2; print(cv2.__version__)'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (probe.status === 0) {
      OPENCV_PYTHON_RUNTIME = candidate;
      return OPENCV_PYTHON_RUNTIME;
    }
  }

  OPENCV_PYTHON_RUNTIME = null;
  return OPENCV_PYTHON_RUNTIME;
}

function findResidualEdgeComponent(png, x0, y0, width, height) {
  const {
    grayThreshold,
    saturationThreshold,
    minArea,
  } = RESIDUAL_HEAL_CONFIG;
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = ((y0 + y) * png.width + (x0 + x)) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const gray = (r + g + b) / 3;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (gray > grayThreshold && saturation < saturationThreshold) {
        mask[y * width + x] = 1;
      }
    }
  }

  const seen = new Uint8Array(width * height);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ];
  let best = null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || seen[start]) {
        continue;
      }

      const stack = [start];
      seen[start] = 1;
      const pixels = [];
      let touchRight = false;
      let touchBottom = false;

      while (stack.length > 0) {
        const current = stack.pop();
        const cy = Math.floor(current / width);
        const cx = current % width;
        pixels.push([cx, cy]);
        if (cx >= width - 4) {
          touchRight = true;
        }
        if (cy >= height - 4) {
          touchBottom = true;
        }

        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }

          const nextIndex = ny * width + nx;
          if (mask[nextIndex] && !seen[nextIndex]) {
            seen[nextIndex] = 1;
            stack.push(nextIndex);
          }
        }
      }

      if (pixels.length < minArea) {
        continue;
      }

      const component = {
        pixels,
        area: pixels.length,
        touchRight,
        touchBottom,
      };

      if (
        !best ||
        (component.touchRight && !best.touchRight) ||
        (component.touchRight === best.touchRight && component.area > best.area)
      ) {
        best = component;
      }
    }
  }

  if (!best || (!best.touchRight && !best.touchBottom)) {
    return null;
  }

  return best;
}

function solve3x3(matrix, vector) {
  const A = matrix.map((row) => row.slice());
  const B = vector.slice();

  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) {
        pivot = row;
      }
    }

    if (Math.abs(A[pivot][col]) < 1e-9) {
      return [0, 0, 0];
    }

    [A[col], A[pivot]] = [A[pivot], A[col]];
    [B[col], B[pivot]] = [B[pivot], B[col]];

    const divisor = A[col][col];
    for (let k = col; k < 3; k += 1) {
      A[col][k] /= divisor;
    }
    B[col] /= divisor;

    for (let row = 0; row < 3; row += 1) {
      if (row === col) {
        continue;
      }

      const factor = A[row][col];
      for (let k = col; k < 3; k += 1) {
        A[row][k] -= factor * A[col][k];
      }
      B[row] -= factor * B[col];
    }
  }

  return B;
}

function fitGrayPlane(png, x0, y0, width, height) {
  const stripWidth = Math.max(12, Math.floor(width * RESIDUAL_HEAL_CONFIG.lowContrastStripWidthRatio));
  let sx = 0;
  let sy = 0;
  let sg = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxg = 0;
  let syg = 0;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < stripWidth; x += 1) {
      const idx = ((y0 + y) * png.width + (x0 + x)) << 2;
      const gray = (png.data[idx] + png.data[idx + 1] + png.data[idx + 2]) / 3;
      sx += x;
      sy += y;
      sg += gray;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      sxg += x * gray;
      syg += y * gray;
      count += 1;
    }
  }

  return solve3x3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, count],
    ],
    [sxg, syg, sg],
  );
}

function fitChannelPlaneFromRing(png, x0, y0, width, height, box, mask, channel) {
  const samplePadding = 10;
  const sampleX0 = Math.max(0, box.x0 - samplePadding);
  const sampleY0 = Math.max(0, box.y0 - samplePadding);
  const sampleX1 = Math.min(width - 1, box.x1 + samplePadding);
  const sampleY1 = Math.min(height - 1, box.y1 + samplePadding);
  let sx = 0;
  let sy = 0;
  let sv = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxv = 0;
  let syv = 0;
  let count = 0;

  for (let y = sampleY0; y <= sampleY1; y += 1) {
    for (let x = sampleX0; x <= sampleX1; x += 1) {
      if (mask[y * width + x]) {
        continue;
      }

      const idx = ((y0 + y) * png.width + (x0 + x)) << 2;
      const value = png.data[idx + channel];
      sx += x;
      sy += y;
      sv += value;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
      sxv += x * value;
      syv += y * value;
      count += 1;
    }
  }

  if (count < 12) {
    return [0, 0, 0];
  }

  return solve3x3(
    [
      [sxx, sxy, sx],
      [sxy, syy, sy],
      [sx, sy, count],
    ],
    [sxv, syv, sv],
  );
}

function buildDilatedMask(width, height, pixels, padding) {
  const mask = new Uint8Array(width * height);
  for (const [px, py] of pixels) {
    for (let dy = -padding; dy <= padding; dy += 1) {
      for (let dx = -padding; dx <= padding; dx += 1) {
        const x = px + dx;
        const y = py + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) {
          continue;
        }
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

function buildEllipseMask(width, height, centerX, centerY, radiusX, radiusY) {
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - centerX) / radiusX;
      const dy = (y - centerY) / radiusY;
      if ((dx * dx) + (dy * dy) <= 1) {
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

function mergeMaskInto(target, source) {
  for (let i = 0; i < target.length; i += 1) {
    if (source[i]) {
      target[i] = 1;
    }
  }
}

function distanceToMaskEdge(mask, width, height, x, y, maxDistance) {
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    for (let dy = -distance; dy <= distance; dy += 1) {
      for (let dx = -distance; dx <= distance; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== distance) {
          continue;
        }

        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) {
          return distance;
        }
      }
    }
  }

  return maxDistance + 1;
}

function fillMaskFromPlanes(png, x0, y0, width, height, box, mask) {
  const planes = [
    fitChannelPlaneFromRing(png, x0, y0, width, height, box, mask, 0),
    fitChannelPlaneFromRing(png, x0, y0, width, height, box, mask, 1),
    fitChannelPlaneFromRing(png, x0, y0, width, height, box, mask, 2),
  ];
  const featherRadius = 4;

  for (let y = box.y0; y <= box.y1; y += 1) {
    for (let x = box.x0; x <= box.x1; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      const idx = ((y0 + y) * png.width + (x0 + x)) << 2;
      const edgeDistance = distanceToMaskEdge(mask, width, height, x, y, featherRadius);
      const alpha = clamp(edgeDistance / featherRadius, 0, 1);
      for (let channel = 0; channel < 3; channel += 1) {
        const [ax, ay, c] = planes[channel];
        const predicted = clamp(Math.round((ax * x) + (ay * y) + c), 0, 255);
        png.data[idx + channel] = Math.round((png.data[idx + channel] * (1 - alpha)) + (predicted * alpha));
      }
    }
  }
}

function fillMaskByRowInterpolation(png, x0, y0, width, height, box, mask) {
  const sampleOffset = 8;
  for (let y = box.y0; y <= box.y1; y += 1) {
    let x = box.x0;
    while (x <= box.x1) {
      if (!mask[y * width + x]) {
        x += 1;
        continue;
      }

      const runStart = x;
      while (x <= box.x1 && mask[y * width + x]) {
        x += 1;
      }
      const runEnd = x - 1;

      let sourceLeft = runStart - 1;
      while (sourceLeft >= 0 && mask[y * width + sourceLeft]) {
        sourceLeft -= 1;
      }
      if (sourceLeft >= 0) {
        sourceLeft = Math.max(0, sourceLeft - sampleOffset);
      }

      let sourceRight = runEnd + 1;
      while (sourceRight < width && mask[y * width + sourceRight]) {
        sourceRight += 1;
      }
      if (sourceRight < width) {
        sourceRight = Math.min(width - 1, sourceRight + sampleOffset);
      }

      for (let fillX = runStart; fillX <= runEnd; fillX += 1) {
        const dstIdx = ((y0 + y) * png.width + (x0 + fillX)) << 2;
        for (let channel = 0; channel < 3; channel += 1) {
          let value = 0;
          if (sourceLeft >= 0 && sourceRight < width) {
            const leftIdx = ((y0 + y) * png.width + (x0 + sourceLeft)) << 2;
            const rightIdx = ((y0 + y) * png.width + (x0 + sourceRight)) << 2;
            const span = Math.max(1, sourceRight - sourceLeft);
            const t = (fillX - sourceLeft) / span;
            value = Math.round((png.data[leftIdx + channel] * (1 - t)) + (png.data[rightIdx + channel] * t));
          } else if (sourceLeft >= 0) {
            const leftIdx = ((y0 + y) * png.width + (x0 + sourceLeft)) << 2;
            value = png.data[leftIdx + channel];
          } else if (sourceRight < width) {
            const rightIdx = ((y0 + y) * png.width + (x0 + sourceRight)) << 2;
            value = png.data[rightIdx + channel];
          } else {
            value = png.data[dstIdx + channel];
          }
          png.data[dstIdx + channel] = value;
        }
      }
    }
  }
}

function healScaledTemplateMatch(png, match) {
  if (!match || match.logoSize === 48 || match.logoSize === 96 || !match.alphaMap) {
    return false;
  }

  const alphaThreshold = 0.015;
  const dilateRadius = Math.max(4, Math.floor(match.logoSize * 0.08));
  const boxPadding = dilateRadius + 2;
  const pad = 8;
  const x0 = Math.max(0, match.x - pad);
  const y0 = Math.max(0, match.y - pad);
  const x1 = Math.min(png.width - 1, match.x + match.logoSize - 1 + pad);
  const y1 = Math.min(png.height - 1, match.y + match.logoSize - 1 + pad);
  const width = x1 - x0 + 1;
  const height = y1 - y0 + 1;
  const mask = new Uint8Array(width * height);
  const maskPixels = [];
  let maskX0 = width;
  let maskY0 = height;
  let maskX1 = -1;
  let maskY1 = -1;

  for (let row = 0; row < match.logoSize; row += 1) {
    for (let col = 0; col < match.logoSize; col += 1) {
      const alpha = match.alphaMap[(row * match.logoSize) + col];
      if (alpha < alphaThreshold) {
        continue;
      }

      const localX = (match.x - x0) + col;
      const localY = (match.y - y0) + row;
      if (localX < 0 || localY < 0 || localX >= width || localY >= height) {
        continue;
      }

      mask[localY * width + localX] = 1;
      maskPixels.push([localX, localY]);
      if (localX < maskX0) maskX0 = localX;
      if (localY < maskY0) maskY0 = localY;
      if (localX > maskX1) maskX1 = localX;
      if (localY > maskY1) maskY1 = localY;
    }
  }

  if (maskPixels.length === 0) {
    return false;
  }

  const dilatedMask = buildDilatedMask(width, height, maskPixels, dilateRadius);
  const box = {
    x0: Math.max(0, maskX0 - boxPadding),
    y0: Math.max(0, maskY0 - boxPadding),
    x1: Math.min(width - 1, maskX1 + boxPadding),
    y1: Math.min(height - 1, maskY1 + boxPadding),
  };

  fillMaskByRowInterpolation(png, x0, y0, width, height, box, dilatedMask);
  return true;
}

function findLowContrastResidualComponents(png, x0, y0, width, height) {
  const {
    lowContrastMaskStartXRatio,
    lowContrastResidualMin,
    lowContrastSaturationMax,
    lowContrastMinArea,
    lowContrastMaxBoxes,
    lowContrastBoxPadding,
  } = RESIDUAL_HEAL_CONFIG;
  const [ax, ay, c] = fitGrayPlane(png, x0, y0, width, height);
  const mask = new Uint8Array(width * height);
  const minX = Math.max(0, Math.floor(width * lowContrastMaskStartXRatio));

  for (let y = 0; y < height; y += 1) {
    for (let x = minX; x < width; x += 1) {
      const idx = ((y0 + y) * png.width + (x0 + x)) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const gray = (r + g + b) / 3;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      const residual = gray - ((ax * x) + (ay * y) + c);
      if (saturation <= lowContrastSaturationMax && residual >= lowContrastResidualMin) {
        mask[y * width + x] = 1;
      }
    }
  }

  const seen = new Uint8Array(width * height);
  const dirs = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [-1, -1], [1, -1], [-1, 1],
  ];
  const components = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = minX; x < width; x += 1) {
      const start = y * width + x;
      if (!mask[start] || seen[start]) {
        continue;
      }

      const stack = [start];
      seen[start] = 1;
      let area = 0;
      const pixels = [];
      let minBoxX = width;
      let minBoxY = height;
      let maxBoxX = 0;
      let maxBoxY = 0;

      while (stack.length > 0) {
        const current = stack.pop();
        const cy = Math.floor(current / width);
        const cx = current % width;
        area += 1;
        pixels.push([cx, cy]);
        minBoxX = Math.min(minBoxX, cx);
        minBoxY = Math.min(minBoxY, cy);
        maxBoxX = Math.max(maxBoxX, cx);
        maxBoxY = Math.max(maxBoxY, cy);

        for (const [dx, dy] of dirs) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }

          const next = ny * width + nx;
          if (mask[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }

      if (area >= lowContrastMinArea) {
        components.push({
          area,
          pixels,
          x0: Math.max(0, minBoxX - lowContrastBoxPadding),
          y0: Math.max(0, minBoxY - lowContrastBoxPadding),
          x1: Math.min(width - 1, maxBoxX + lowContrastBoxPadding),
          y1: Math.min(height - 1, maxBoxY + lowContrastBoxPadding),
        });
      }
    }
  }

  return components
    .sort((left, right) => right.area - left.area)
    .slice(0, lowContrastMaxBoxes);
}

function inpaintMask(png, x0, y0, width, height, mask, iterations) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) {
        continue;
      }

      let sourceX = x - 1;
      while (sourceX >= 0 && mask[y * width + sourceX]) {
        sourceX -= 1;
      }

      const srcX = x0 + (sourceX >= 0 ? sourceX : 0);
      const srcY = y0 + y;
      const srcIdx = (srcY * png.width + srcX) << 2;
      const dstIdx = ((y0 + y) * png.width + (x0 + x)) << 2;
      png.data[dstIdx] = png.data[srcIdx];
      png.data[dstIdx + 1] = png.data[srcIdx + 1];
      png.data[dstIdx + 2] = png.data[srcIdx + 2];
    }
  }

  const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = Buffer.from(png.data);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!mask[y * width + x]) {
          continue;
        }

        const sums = [0, 0, 0];
        let count = 0;
        for (const [dx, dy] of neighbors) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }

          const neighborIdx = ((y0 + ny) * png.width + (x0 + nx)) << 2;
          sums[0] += png.data[neighborIdx];
          sums[1] += png.data[neighborIdx + 1];
          sums[2] += png.data[neighborIdx + 2];
          count += 1;
        }

        const dstIdx = ((y0 + y) * png.width + (x0 + x)) << 2;
        next[dstIdx] = Math.round(sums[0] / count);
        next[dstIdx + 1] = Math.round(sums[1] / count);
        next[dstIdx + 2] = Math.round(sums[2] / count);
      }
    }
    png.data.set(next);
  }
}

function findCornerResidualSeed(png, x0, y0, width, height) {
  const {
    cornerSeedGrayFloor,
    cornerSeedSaturationMax,
    cornerSeedResidualMin,
    cornerSeedSearchXRatio,
    cornerSeedSearchYRatio,
    cornerSeedRadius,
    cornerSeedMinScore,
  } = RESIDUAL_HEAL_CONFIG;
  const startX = Math.max(0, Math.floor(width * cornerSeedSearchXRatio));
  const startY = Math.max(0, Math.floor(height * cornerSeedSearchYRatio));
  let best = null;

  for (let y = startY; y < height; y += 1) {
    for (let x = startX; x < width; x += 1) {
      const idx = ((y0 + y) * png.width + (x0 + x)) << 2;
      const r = png.data[idx];
      const g = png.data[idx + 1];
      const b = png.data[idx + 2];
      const gray = (r + g + b) / 3;
      const saturation = Math.max(r, g, b) - Math.min(r, g, b);
      if (gray < cornerSeedGrayFloor || saturation > cornerSeedSaturationMax) {
        continue;
      }

      let neighborSum = 0;
      let neighborCount = 0;
      for (let dy = -cornerSeedRadius; dy <= cornerSeedRadius; dy += 1) {
        for (let dx = -cornerSeedRadius; dx <= cornerSeedRadius; dx += 1) {
          if (dx === 0 && dy === 0) {
            continue;
          }

          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
            continue;
          }

          const neighborIdx = ((y0 + ny) * png.width + (x0 + nx)) << 2;
          neighborSum += (png.data[neighborIdx] + png.data[neighborIdx + 1] + png.data[neighborIdx + 2]) / 3;
          neighborCount += 1;
        }
      }

      if (neighborCount === 0) {
        continue;
      }

      const residual = gray - (neighborSum / neighborCount);
      if (residual < cornerSeedResidualMin) {
        continue;
      }

      const score = residual + ((x / Math.max(1, width - 1)) * 0.6) + (y / Math.max(1, height - 1));
      if (!best || score > best.score) {
        best = { x, y, score };
      }
    }
  }

  return best && best.score >= cornerSeedMinScore ? best : null;
}

async function applyOpenCvTeleaFallback(png, x0, y0, width, height) {
  const runtime = resolveOpenCvPythonRuntime();
  if (!runtime) {
    return false;
  }

  const lowContrastComponents = findLowContrastResidualComponents(png, x0, y0, width, height);
  const mask = new Uint8Array(width * height);
  for (const component of lowContrastComponents) {
    mergeMaskInto(mask, buildDilatedMask(width, height, component.pixels, RESIDUAL_HEAL_CONFIG.openCvMaskPadding));
  }

  const cornerSeed = findCornerResidualSeed(png, x0, y0, width, height);
  if (cornerSeed) {
    mergeMaskInto(
      mask,
      buildEllipseMask(
        width,
        height,
        cornerSeed.x,
        cornerSeed.y,
        RESIDUAL_HEAL_CONFIG.cornerEllipseRadiusX,
        RESIDUAL_HEAL_CONFIG.cornerEllipseRadiusY,
      ),
    );
  }

  let maskPixels = 0;
  for (const value of mask) {
    maskPixels += value;
  }
  if (maskPixels === 0) {
    return false;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remove-watermark-'));
  const roiPath = path.join(tempDir, 'roi.png');
  const maskPath = path.join(tempDir, 'mask.png');
  const outPath = path.join(tempDir, 'out.png');

  try {
    const roi = new PNG({ width, height });
    const maskPng = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const srcIdx = ((y0 + y) * png.width + (x0 + x)) << 2;
        const dstIdx = (y * width + x) << 2;
        roi.data[dstIdx] = png.data[srcIdx];
        roi.data[dstIdx + 1] = png.data[srcIdx + 1];
        roi.data[dstIdx + 2] = png.data[srcIdx + 2];
        roi.data[dstIdx + 3] = 255;
        const maskValue = mask[y * width + x] ? 255 : 0;
        maskPng.data[dstIdx] = maskValue;
        maskPng.data[dstIdx + 1] = maskValue;
        maskPng.data[dstIdx + 2] = maskValue;
        maskPng.data[dstIdx + 3] = 255;
      }
    }

    fs.writeFileSync(roiPath, PNG.sync.write(roi));
    fs.writeFileSync(maskPath, PNG.sync.write(maskPng));

    const script = [
      'import cv2, sys',
      'image = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR)',
      'mask = cv2.imread(sys.argv[2], cv2.IMREAD_GRAYSCALE)',
      `result = cv2.inpaint(image, mask, ${RESIDUAL_HEAL_CONFIG.openCvRadius}, cv2.INPAINT_TELEA)`,
      'cv2.imwrite(sys.argv[3], result)',
    ].join('; ');

    const run = spawnSync(
      runtime.command,
      [...runtime.args, '-c', script, roiPath, maskPath, outPath],
      { encoding: 'utf8', windowsHide: true },
    );
    if (run.status !== 0 || !fs.existsSync(outPath)) {
      return false;
    }

    const output = PNG.sync.read(fs.readFileSync(outPath));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dstIdx = ((y0 + y) * png.width + (x0 + x)) << 2;
        const srcIdx = (y * width + x) << 2;
        png.data[dstIdx] = output.data[srcIdx];
        png.data[dstIdx + 1] = output.data[srcIdx + 1];
        png.data[dstIdx + 2] = output.data[srcIdx + 2];
      }
    }

    return true;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function healResidualCornerSparkle(png, primaryMatch) {
  if (primaryMatch.logoSize !== 96 || primaryMatch.confidence < 0.8) {
    return;
  }

  const x0 = clamp(primaryMatch.x + Math.floor(primaryMatch.logoSize * 0.58), 0, png.width - 1);
  const y0 = clamp(primaryMatch.y + Math.floor(primaryMatch.logoSize * 0.5), 0, png.height - 1);
  const width = Math.min(RESIDUAL_HEAL_CONFIG.windowWidth, png.width - x0);
  const height = Math.min(RESIDUAL_HEAL_CONFIG.windowHeight, png.height - y0);
  if (width < 20 || height < 20) {
    return;
  }

  const component = findResidualEdgeComponent(png, x0, y0, width, height);
  if (!component) {
    return;
  }

  const dilated = new Uint8Array(width * height);
  for (const [x, y] of component.pixels) {
    for (let dy = -RESIDUAL_HEAL_CONFIG.dilationRadius; dy <= RESIDUAL_HEAL_CONFIG.dilationRadius; dy += 1) {
      for (let dx = -RESIDUAL_HEAL_CONFIG.dilationRadius; dx <= RESIDUAL_HEAL_CONFIG.dilationRadius; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          continue;
        }
        dilated[ny * width + nx] = 1;
      }
    }
  }

  inpaintMask(png, x0, y0, width, height, dilated, RESIDUAL_HEAL_CONFIG.iterations);

  const lowContrastComponents = findLowContrastResidualComponents(png, x0, y0, width, height);
  if (lowContrastComponents.length > 0) {
    for (const component of lowContrastComponents) {
      const componentMask = buildDilatedMask(width, height, component.pixels, RESIDUAL_HEAL_CONFIG.lowContrastBoxPadding);
      fillMaskFromPlanes(png, x0, y0, width, height, component, componentMask);
    }
  }

  const cornerSeed = findCornerResidualSeed(png, x0, y0, width, height);
  if (!cornerSeed) {
    await applyOpenCvTeleaFallback(png, x0, y0, width, height);
    return;
  }

  const cornerMask = buildEllipseMask(
    width,
    height,
    cornerSeed.x,
    cornerSeed.y,
    RESIDUAL_HEAL_CONFIG.cornerEllipseRadiusX,
    RESIDUAL_HEAL_CONFIG.cornerEllipseRadiusY,
  );

  inpaintMask(png, x0, y0, width, height, cornerMask, RESIDUAL_HEAL_CONFIG.cornerIterations);
  await applyOpenCvTeleaFallback(png, x0, y0, width, height);
}


// --- Advanced Sparkle Detection Logic (Normalized Cross-Correlation) ---
// This guarantees we find the exact structural shape of the watermark and ignore
// high contrast garbage (like bright meme text or pixel drawings) which derailed
// the previous contrast-based logic.

function findWatermarkNCC(png, alphaMap, logoSize, options = {}) {
  const gray = options.gray ?? buildGrayscale(png);
  const suppressed = options.suppressed ?? [];
  const N = logoSize * logoSize;
  
  // 1. Template stats (Full resolution)
  let tSum = 0;
  for (let i = 0; i < N; i++) tSum += alphaMap[i];
  const tMean = tSum / N;

  let tVarSum = 0;
  const tDiffs = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const diff = alphaMap[i] - tMean;
    tDiffs[i] = diff;
    tVarSum += diff * diff;
  }
  const tNorm = Math.sqrt(tVarSum);

  // 2. Template stats (Coarse pass - stride of 3 saves massive processing time)
  const stride = 3;
  let coarseCount = 0;
  let tSumCoarse = 0;
  for (let r = 0; r < logoSize; r += stride) {
    for (let c = 0; c < logoSize; c += stride) {
       tSumCoarse += alphaMap[r * logoSize + c];
       coarseCount++;
    }
  }
  const tMeanCoarse = tSumCoarse / coarseCount;
  
  let tVarSumCoarse = 0;
  const tDiffsCoarse = new Float32Array(N);
  for (let r = 0; r < logoSize; r += stride) {
    for (let c = 0; c < logoSize; c += stride) {
       const idx = r * logoSize + c;
       const diff = alphaMap[idx] - tMeanCoarse;
       tDiffsCoarse[idx] = diff;
       tVarSumCoarse += diff * diff;
    }
  }
  const tNormCoarse = Math.sqrt(tVarSumCoarse);

  // Limit search to the bottom right quadrant to save time and dodge central text
  const startX = options.startX ?? Math.floor(png.width * 0.5);
  const startY = options.startY ?? Math.floor(png.height * 0.5);
  const endX = options.endX ?? (png.width - logoSize);
  const endY = options.endY ?? (png.height - logoSize);

  let bestR = -Infinity;
  let bestPos = null;

  if (endX < startX || endY < startY) return { x: 0, y: 0, score: -Infinity };

  // 4. Coarse Search (Fast scan jumping multiple pixels)
  for (let y = startY; y <= endY; y += stride) {
    for (let x = startX; x <= endX; x += stride) {
      if (overlapsBounds(createBounds(x, y, logoSize), suppressed, Math.floor(logoSize / 3))) {
        continue;
      }

      let pSum = 0;
      for (let r = 0; r < logoSize; r += stride) {
        const rowStart = (y + r) * png.width + x;
        for (let c = 0; c < logoSize; c += stride) {
          pSum += gray[rowStart + c];
        }
      }
      const pMean = pSum / coarseCount;

      let pVarSum = 0;
      let cov = 0;
      for (let r = 0; r < logoSize; r += stride) {
        const rowStart = (y + r) * png.width + x;
        const tRowStart = r * logoSize;
        for (let c = 0; c < logoSize; c += stride) {
          const pDiff = gray[rowStart + c] - pMean;
          pVarSum += pDiff * pDiff;
          cov += pDiff * tDiffsCoarse[tRowStart + c];
        }
      }

      if (pVarSum === 0) continue;
      const rVal = cov / (tNormCoarse * Math.sqrt(pVarSum));

      if (rVal > bestR) {
        bestR = rVal;
        bestPos = { x, y };
      }
    }
  }

  if (!bestPos) {
    return { x: 0, y: 0, score: -Infinity };
  }

  // 5. Fine Search (Pixel-perfect scan radiating from the best coarse match)
  let fineBestR = -Infinity;
  let fineBestPos = bestPos;
  for (let y = bestPos.y - stride; y <= bestPos.y + stride; y++) {
    for (let x = bestPos.x - stride; x <= bestPos.x + stride; x++) {
      if (x < 0 || y < 0 || x > endX || y > endY) continue;
      if (overlapsBounds(createBounds(x, y, logoSize), suppressed, Math.floor(logoSize / 3))) {
        continue;
      }
      
      let pSum = 0;
      for (let r = 0; r < logoSize; r++) {
        const rowStart = (y + r) * png.width + x;
        for (let c = 0; c < logoSize; c++) {
          pSum += gray[rowStart + c];
        }
      }
      const pMean = pSum / N;

      let pVarSum = 0;
      let cov = 0;
      for (let r = 0; r < logoSize; r++) {
        const rowStart = (y + r) * png.width + x;
        const tRowStart = r * logoSize;
        for (let c = 0; c < logoSize; c++) {
          const pDiff = gray[rowStart + c] - pMean;
          pVarSum += pDiff * pDiff;
          cov += pDiff * tDiffs[tRowStart + c];
        }
      }

      if (pVarSum === 0) continue;
      const rVal = cov / (tNorm * Math.sqrt(pVarSum));

      if (rVal > fineBestR) {
        fineBestR = rVal;
        fineBestPos = { x, y };
      }
    }
  }

  if (!Number.isFinite(fineBestR)) {
    return { x: 0, y: 0, score: -Infinity };
  }

  return {
    x: fineBestPos.x,
    y: fineBestPos.y,
    score: fineBestR,
    bbox: createBounds(fineBestPos.x, fineBestPos.y, logoSize),
  };
}


// --- Exact Alpha Map Matching & Removal Logic ---

async function planWatermarkRemoval(png) {
  const [template48, template96] = await Promise.all([
    getAlphaTemplate(48),
    getAlphaTemplate(96),
  ]);
  const gray = buildGrayscale(png);
  const suppressed = [];
  const matches = [];
  const maxMatches = 4;
  let primaryConfidence = null;

  console.log('Scanning bottom-right quadrant for exact structural correlation...');

  let lastMatch48 = { x: 0, y: 0, score: -Infinity };
  let lastMatch96 = { x: 0, y: 0, score: -Infinity };

  const default48X = png.width - template48.logoSize - 32;
  const default48Y = png.height - template48.logoSize - 32;
  const default96X = png.width - template96.logoSize - 64;
  const default96Y = png.height - template96.logoSize - 64;
  const default48Score = findWatermarkNCC(png, template48.alphaMap, template48.logoSize, {
    gray,
    startX: default48X,
    endX: default48X,
    startY: default48Y,
    endY: default48Y,
  });
  const default96Score = findWatermarkNCC(png, template96.alphaMap, template96.logoSize, {
    gray,
    startX: default96X,
    endX: default96X,
    startY: default96Y,
    endY: default96Y,
  });
  if (default96Score.score >= 0.15 || default48Score.score >= 0.15) {
    const chosen = default96Score.score >= default48Score.score
      ? {
          x: default96X,
          y: default96Y,
          bbox: createBounds(default96X, default96Y, template96.logoSize),
          logoSize: template96.logoSize,
          alphaMap: template96.alphaMap,
          confidence: default96Score.score,
          source: 'default-placement',
        }
      : {
          x: default48X,
          y: default48Y,
          bbox: createBounds(default48X, default48Y, template48.logoSize),
          logoSize: template48.logoSize,
          alphaMap: template48.alphaMap,
          confidence: default48Score.score,
          source: 'default-placement',
        };
    console.log(`✓ Locked ${chosen.logoSize}px default-placement template at x:${chosen.x}, y:${chosen.y} (Confidence: ${(chosen.confidence * 100).toFixed(1)}%)`);
    return {
      found: true,
      x: chosen.x,
      y: chosen.y,
      logoSize: chosen.logoSize,
      alphaMap: chosen.alphaMap,
      confidence: chosen.confidence,
      matches: [chosen],
      match48: lastMatch48,
      match96: lastMatch96,
    };
  }

  for (let index = 0; index < maxMatches; index += 1) {
    const match48 = findWatermarkNCC(png, template48.alphaMap, template48.logoSize, {
      gray,
      suppressed,
      ...getCornerSearchBounds(png, template48.logoSize),
    });
    const match96 = findWatermarkNCC(png, template96.alphaMap, template96.logoSize, {
      gray,
      suppressed,
      ...getCornerSearchBounds(png, template96.logoSize),
    });
    lastMatch48 = match48;
    lastMatch96 = match96;

    let chosen = null;
    const primary96Threshold = PRIMARY_MATCH_MIN_SCORES[96];
    const primary48Threshold = PRIMARY_MATCH_MIN_SCORES[48];
    const acceptPrimary96 = match96.score > primary96Threshold || (
      primaryConfidence === null &&
      match96.score > DEFAULT_PLACEMENT_MIN_SCORES[96] &&
      isDefaultPlacementMatch(png, match96, template96.logoSize)
    );
    const acceptPrimary48 = match48.score > primary48Threshold || (
      primaryConfidence === null &&
      match48.score > DEFAULT_PLACEMENT_MIN_SCORES[48] &&
      isDefaultPlacementMatch(png, match48, template48.logoSize)
    );
    const secondaryThreshold = primaryConfidence === null
      ? -Infinity
      : Math.max(Math.min(primary96Threshold, primary48Threshold), primaryConfidence * SECONDARY_MATCH_RATIO);

    if (
      match96.score > match48.score &&
      (primaryConfidence === null ? acceptPrimary96 : match96.score > secondaryThreshold)
    ) {
      chosen = {
        x: match96.x,
        y: match96.y,
        bbox: match96.bbox,
        logoSize: template96.logoSize,
        alphaMap: template96.alphaMap,
        confidence: match96.score,
      };
    } else if (primaryConfidence === null ? acceptPrimary48 : match48.score > secondaryThreshold) {
      chosen = {
        x: match48.x,
        y: match48.y,
        bbox: match48.bbox,
        logoSize: template48.logoSize,
        alphaMap: template48.alphaMap,
        confidence: match48.score,
      };
    }

    if (!chosen) {
      break;
    }

    matches.push(chosen);
    primaryConfidence ??= chosen.confidence;
    suppressed.push(chosen.bbox);
    console.log(`✓ Locked ${chosen.logoSize}px template at x:${chosen.x}, y:${chosen.y} (Correlation Confidence: ${(chosen.confidence * 100).toFixed(1)}%)`);
  }

  if (matches.length > 0) {
    return {
      found: true,
      x: matches[0].x,
      y: matches[0].y,
      logoSize: matches[0].logoSize,
      alphaMap: matches[0].alphaMap,
      confidence: matches[0].confidence,
      matches,
      match48: lastMatch48,
      match96: lastMatch96,
    };
  }

  const rawConfidence = Math.max(lastMatch48.score, lastMatch96.score);
  const confidence = Number.isFinite(rawConfidence) ? rawConfidence : 0;
  try {
    const detectorResult = findWatermarkSparkles(png);
    const detectorPrimary = detectorResult.sparkles[0];
    const detectedSize = Math.max(40, Math.min(72, detectorPrimary.size));
    if (detectedSize >= 56 && detectedSize <= 72 && detectorPrimary.edgeTouch.right && !detectorPrimary.edgeTouch.bottom) {
      throw new Error('Skip clipped right-edge scaled fallback');
    }
    const baseSize = detectedSize <= 72 ? 48 : 96;
    const scaledTemplate = await getScaledAlphaTemplate(baseSize, detectedSize);
    const refined = findWatermarkNCC(png, scaledTemplate.alphaMap, scaledTemplate.logoSize, {
      gray,
      startX: Math.max(0, detectorPrimary.bbox.x0 - 20),
      startY: Math.max(0, detectorPrimary.bbox.y0 - 20),
      endX: Math.min(png.width - scaledTemplate.logoSize, detectorPrimary.bbox.x1 + 20),
      endY: Math.min(png.height - scaledTemplate.logoSize, detectorPrimary.bbox.y1 + 20),
    });

    const refinedUsable = Number.isFinite(refined.score) && refined.score >= 0.35;
    const fallbackCandidate = refinedUsable
      ? refined
      : {
          x: detectorPrimary.bbox.x0,
          y: detectorPrimary.bbox.y0,
          bbox: createBounds(detectorPrimary.bbox.x0, detectorPrimary.bbox.y0, scaledTemplate.logoSize),
          score: detectorResult.confidence,
        };

    const detectorReliable =
      detectorResult.confidence >= 0.72 &&
      detectorPrimary.geometry >= 0.5 &&
      detectorPrimary.requiredArmCoverage >= 0.7;
    if (isNearCornerPlacement(png, fallbackCandidate, scaledTemplate.logoSize) && (refinedUsable || detectorReliable)) {
      console.log(`✓ Locked ${scaledTemplate.logoSize}px detector-guided template at x:${fallbackCandidate.x}, y:${fallbackCandidate.y} (Confidence: ${(fallbackCandidate.score * 100).toFixed(1)}%)`);
      return {
        found: true,
        x: fallbackCandidate.x,
        y: fallbackCandidate.y,
        logoSize: scaledTemplate.logoSize,
        alphaMap: scaledTemplate.alphaMap,
        confidence: fallbackCandidate.score,
        matches: [{
          x: fallbackCandidate.x,
          y: fallbackCandidate.y,
          bbox: fallbackCandidate.bbox,
          logoSize: scaledTemplate.logoSize,
          alphaMap: scaledTemplate.alphaMap,
          confidence: fallbackCandidate.score,
        }],
        match48: lastMatch48,
        match96: lastMatch96,
      };
    }
  } catch (error) {
    // Keep the remover deterministic even if the geometric fallback cannot isolate a corner sparkle.
  }

  return {
    found: false,
    x: null,
    y: null,
    logoSize: null,
    alphaMap: null,
    confidence,
    matches: [],
    match48: lastMatch48,
    match96: lastMatch96,
    reason: `No confident watermark match found (max correlation ${(confidence * 100).toFixed(1)}%).`,
  };
}

async function removeWatermark(png) {
  const { ALPHA_THRESHOLD, MAX_ALPHA, LOGO_VALUE } = CONSTANTS;

  const plan = await planWatermarkRemoval(png);
  if (!plan.found) {
    console.log(`⚠ ${plan.reason} Leaving the image unchanged.`);
    return png;
  }

  for (const match of plan.matches) {
    const pos = {
      x: match.x,
      y: match.y,
      width: match.logoSize,
      height: match.logoSize,
    };

    const alphaMap = match.alphaMap;

    // Direct Pixel Subtraction Engine
    for (let row = 0; row < pos.height; row++) {
      for (let col = 0; col < pos.width; col++) {
        const alphaIdx = row * pos.width + col;
        let alpha = alphaMap[alphaIdx];

        // Ignore fully transparent regions to save processing
        if (alpha < ALPHA_THRESHOLD) continue;
        
        alpha = Math.min(alpha, MAX_ALPHA);
        const oneMinusAlpha = 1 - alpha;

        const targetX = pos.x + col;
        const targetY = pos.y + row;

        // Ensure we don't bleed out of image bounds 
        if (targetX < 0 || targetX >= png.width || targetY < 0 || targetY >= png.height) {
          continue;
        }

        // Buffer index for RGBA
        const imgIdx = (targetY * png.width + targetX) << 2; 

        // Perform inverse alpha blending on the R, G, and B channels
        for (let c = 0; c < 3; c++) {
          const watermarked = png.data[imgIdx + c];
          const original = (watermarked - alpha * LOGO_VALUE) / oneMinusAlpha;
          
          // Clamp and re-apply cleaned color directly back to the source png object
          png.data[imgIdx + c] = Math.max(0, Math.min(255, Math.round(original)));
        }
      }
    }
  }

  healScaledTemplateMatch(png, plan.matches[0]);

  try {
    const detectorResult = findWatermarkSparkles(png);
    const sparkle = detectorResult.sparkles[0];
    const residualSize = Math.max(24, Math.min(48, sparkle.size));
    const residualCandidate = {
      x: sparkle.bbox.x0,
      y: sparkle.bbox.y0,
    };

    if (
      isNearCornerPlacement(png, residualCandidate, residualSize) &&
      detectorResult.confidence >= 0.62 &&
      sparkle.geometry >= 0.55
    ) {
      const pad = 12;
      const x0 = Math.max(0, sparkle.bbox.x0 - pad);
      const y0 = Math.max(0, sparkle.bbox.y0 - pad);
      const x1 = Math.min(png.width - 1, sparkle.bbox.x1 + pad);
      const y1 = Math.min(png.height - 1, sparkle.bbox.y1 + pad);
      const width = x1 - x0 + 1;
      const height = y1 - y0 + 1;
      const mask = new Uint8Array(width * height);
      const rectX0 = Math.max(0, sparkle.bbox.x0 - x0 - 4);
      const rectY0 = Math.max(0, sparkle.bbox.y0 - y0 - 4);
      const rectX1 = Math.min(width - 1, sparkle.bbox.x1 - x0 + 4);
      const rectY1 = Math.min(height - 1, sparkle.bbox.y1 - y0 + 4);
      const box = { x0: rectX0, y0: rectY0, x1: rectX1, y1: rectY1 };
      for (let y = rectY0; y <= rectY1; y += 1) {
        for (let x = rectX0; x <= rectX1; x += 1) {
          mask[y * width + x] = 1;
        }
      }

      const touchesRightEdge = sparkle.bbox.x1 >= png.width - 20;
      const touchesBottomEdge = sparkle.bbox.y1 >= png.height - 20;
      if (touchesRightEdge || touchesBottomEdge) {
        const edgeRectX0 = Math.max(0, sparkle.bbox.x0 - x0 - 2);
        const edgeRectY0 = Math.max(0, sparkle.bbox.y0 - y0 - 2);
        const edgeRectX1 = Math.min(width - 1, sparkle.bbox.x1 - x0 + 6);
        const edgeRectY1 = Math.min(height - 1, sparkle.bbox.y1 - y0 + 6);
        for (let y = edgeRectY0; y <= edgeRectY1; y += 1) {
          for (let x = edgeRectX0; x <= edgeRectX1; x += 1) {
            mask[y * width + x] = 1;
          }
        }
        box.x0 = Math.min(box.x0, edgeRectX0);
        box.y0 = Math.min(box.y0, edgeRectY0);
        box.x1 = Math.max(box.x1, edgeRectX1);
        box.y1 = Math.max(box.y1, edgeRectY1);
      }
      if (touchesRightEdge || touchesBottomEdge) {
        fillMaskByRowInterpolation(png, x0, y0, width, height, box, mask);
      } else {
        fillMaskFromPlanes(png, x0, y0, width, height, box, mask);
      }

    }
  } catch (error) {
    // Ignore post-cleanup detector failures.
  }

  await healResidualCornerSparkle(png, plan.matches[0]);

  return png;
}

// --- Main execution ---
async function main() {
  try {
    const args = process.argv.slice(2);
    if (args.length < 2) {
      throw new Error('Usage: node remove-gemini-watermark.js <input.png> <output.png>');
    }

    const inputPath = path.resolve(args[0]);
    const outputPath = path.resolve(args[1]);

    console.log(`Loading image from ${inputPath}...`);
    const png = await loadPng(inputPath);

    console.log(`Removing watermark (${png.width}x${png.height})...`);
    const cleanPng = await removeWatermark(png);

    console.log(`Saving clean image to ${outputPath}...`);
    await savePng(cleanPng, outputPath);

    console.log('Done!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  main,
  CONSTANTS,
  removeWatermark,
  planWatermarkRemoval,
  loadPng,
  savePng,
  decodeBase64Png,
  getAlphaTemplate,
  findWatermarkNCC
};
