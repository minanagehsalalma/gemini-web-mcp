#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const TEMPLATE_CACHE = new Map();

function getCornerSearchBounds(png) {
  const searchWidth = Math.max(192, Math.floor(png.width * 0.18));
  const searchHeight = Math.max(192, Math.floor(png.height * 0.18));
  return {
    x0: Math.max(0, png.width - searchWidth),
    y0: Math.max(0, png.height - searchHeight),
    x1: png.width - 1,
    y1: png.height - 1,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setPixel(png, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) {
    return;
  }

  const index = (png.width * y + x) << 2;
  png.data[index] = r;
  png.data[index + 1] = g;
  png.data[index + 2] = b;
  png.data[index + 3] = a;
}

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
    const stream = fs.createWriteStream(filePath);
    stream.on('finish', resolve);
    stream.on('error', reject);
    png.pack().pipe(stream);
  });
}

function buildImageStats(png) {
  const pixels = png.width * png.height;
  const gray = new Float32Array(pixels);
  const saturation = new Float32Array(pixels);

  for (let index = 0; index < pixels; index += 1) {
    const offset = index << 2;
    const r = png.data[offset];
    const g = png.data[offset + 1];
    const b = png.data[offset + 2];

    gray[index] = (r + g + b) / 3;
    saturation[index] = Math.max(r, g, b) - Math.min(r, g, b);
  }

  return { gray, saturation };
}

function getAstroidTemplate(size) {
  if (TEMPLATE_CACHE.has(size)) {
    return TEMPLATE_CACHE.get(size);
  }

  const center = (size - 1) / 2;
  const inside = [];
  const ring = [];
  const core = [];
  const north = [];
  const east = [];
  const south = [];
  const west = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x - center) / Math.max(center, 1);
      const ny = (y - center) / Math.max(center, 1);
      const astroid = Math.pow(Math.abs(nx), 2 / 3) + Math.pow(Math.abs(ny), 2 / 3);
      const square = Math.max(Math.abs(nx), Math.abs(ny));
      const offset = y * size + x;

      if (astroid <= 1) {
        inside.push(offset);

        if (square <= 0.26) {
          core.push(offset);
        } else if (Math.abs(nx) >= Math.abs(ny)) {
          if (nx >= 0) {
            east.push(offset);
          } else {
            west.push(offset);
          }
        } else if (ny >= 0) {
          south.push(offset);
        } else {
          north.push(offset);
        }
      } else if (square <= 1) {
        ring.push(offset);
      }
    }
  }

  const template = {
    size,
    inside: Uint32Array.from(inside),
    ring: Uint32Array.from(ring),
    core: Uint32Array.from(core),
    north: Uint32Array.from(north),
    east: Uint32Array.from(east),
    south: Uint32Array.from(south),
    west: Uint32Array.from(west),
    insideCount: inside.length,
    ringCount: ring.length,
    coreCount: core.length,
  };

  TEMPLATE_CACHE.set(size, template);
  return template;
}

function bboxFromCandidate(candidate) {
  return {
    x0: candidate.x,
    y0: candidate.y,
    x1: candidate.x + candidate.size - 1,
    y1: candidate.y + candidate.size - 1,
  };
}

function centerFromCandidate(candidate) {
  return {
    x: candidate.x + Math.floor(candidate.size / 2),
    y: candidate.y + Math.floor(candidate.size / 2),
  };
}

function unionBounds(boundsList) {
  return {
    x0: Math.min(...boundsList.map((bounds) => bounds.x0)),
    y0: Math.min(...boundsList.map((bounds) => bounds.y0)),
    x1: Math.max(...boundsList.map((bounds) => bounds.x1)),
    y1: Math.max(...boundsList.map((bounds) => bounds.y1)),
  };
}

function overlapsSuppression(center, suppressed) {
  return suppressed.some((entry) => {
    const dx = center.x - entry.center.x;
    const dy = center.y - entry.center.y;
    const distanceSquared = dx * dx + dy * dy;
    const minDistance = Math.max(entry.radius, 1);
    return distanceSquared < minDistance * minDistance;
  });
}

function maskCoverage(gray, saturation, width, patchStart, size, mask, brightThreshold) {
  if (!mask.length) {
    return 0;
  }

  let brightCount = 0;

  for (const offset of mask) {
    const row = Math.floor(offset / size);
    const col = offset % size;
    const index = patchStart + row * width + col;
    const pixelGray = gray[index];
    const pixelSat = saturation[index];

    if (pixelGray > brightThreshold && pixelSat < 120) {
      brightCount += 1;
    }
  }

  return brightCount / mask.length;
}

function scoreCandidate(stats, width, height, x, y, template) {
  const { gray, saturation } = stats;
  const size = template.size;
  const patchStart = y * width + x;
  let patchGraySum = 0;

  for (let row = 0; row < size; row += 1) {
    const rowStart = patchStart + row * width;
    for (let col = 0; col < size; col += 1) {
      patchGraySum += gray[rowStart + col];
    }
  }

  const localMean = patchGraySum / (size * size);
  const brightThreshold = Math.max(localMean + 3, 128);

  let insideGraySum = 0;
  let insideSatSum = 0;
  let ringGraySum = 0;
  let brightInside = 0;
  let brightRing = 0;
  let weightedX = 0;
  let weightedY = 0;
  let weightedEnergy = 0;

  for (const offset of template.inside) {
    const row = Math.floor(offset / size);
    const col = offset % size;
    const index = patchStart + row * width + col;
    const pixelGray = gray[index];
    const pixelSat = saturation[index];

    insideGraySum += pixelGray;
    insideSatSum += pixelSat;

    if (pixelGray > brightThreshold && pixelSat < 110) {
      brightInside += 1;
      const energy = pixelGray - brightThreshold + 1;
      weightedX += col * energy;
      weightedY += row * energy;
      weightedEnergy += energy;
    }
  }

  for (const offset of template.ring) {
    const row = Math.floor(offset / size);
    const col = offset % size;
    const index = patchStart + row * width + col;
    const pixelGray = gray[index];
    const pixelSat = saturation[index];

    ringGraySum += pixelGray;

    if (pixelGray > brightThreshold && pixelSat < 110) {
      brightRing += 1;
    }
  }

  const insideGrayMean = insideGraySum / template.insideCount;
  const insideSatMean = insideSatSum / template.insideCount;
  const ringGrayMean = ringGraySum / template.ringCount;
  const insideCoverage = brightInside / template.insideCount;
  const ringCoverage = brightRing / template.ringCount;
  const shape = insideCoverage - 0.75 * ringCoverage;
  const contrast = insideGrayMean - ringGrayMean - 0.28 * insideSatMean;
  const xPos = (x + size / 2) / width;
  const yPos = (y + size / 2) / height;
  const rightMargin = Math.max(0, width - (x + size));
  const bottomMargin = Math.max(0, height - (y + size));
  const cornerWindowX = Math.max(1, Math.floor(width * 0.18));
  const cornerWindowY = Math.max(1, Math.floor(height * 0.18));
  const cornerCloseness = clamp(
    1 - ((rightMargin / cornerWindowX) * 0.45 + (bottomMargin / cornerWindowY) * 0.55),
    0,
    1,
  );
  const cornerTightness = clamp(1 - (rightMargin + bottomMargin) / (size * 1.6 + 28), 0, 1);
  const edgeTouch = {
    right: x + size >= width - 2,
    bottom: y + size >= height - 2,
    left: x <= 1,
    top: y <= 1,
  };
  const armCoverage = {
    north: maskCoverage(gray, saturation, width, patchStart, size, template.north, brightThreshold),
    east: maskCoverage(gray, saturation, width, patchStart, size, template.east, brightThreshold),
    south: maskCoverage(gray, saturation, width, patchStart, size, template.south, brightThreshold),
    west: maskCoverage(gray, saturation, width, patchStart, size, template.west, brightThreshold),
  };
  const coreCoverage = maskCoverage(gray, saturation, width, patchStart, size, template.core, brightThreshold);
  const requiredArmNames = ['north', 'east', 'south', 'west'].filter((name) => {
    if (name === 'east' && edgeTouch.right) {
      return false;
    }
    if (name === 'south' && edgeTouch.bottom) {
      return false;
    }
    if (name === 'west' && edgeTouch.left) {
      return false;
    }
    if (name === 'north' && edgeTouch.top) {
      return false;
    }
    return true;
  });
  const clippedArmNames = ['north', 'east', 'south', 'west'].filter((name) => !requiredArmNames.includes(name));
  const requiredArmCoverage =
    requiredArmNames.length
      ? requiredArmNames.reduce((sum, name) => sum + armCoverage[name], 0) / requiredArmNames.length
      : 0;
  const clippedArmCoverage =
    clippedArmNames.length
      ? clippedArmNames.reduce((sum, name) => sum + armCoverage[name], 0) / clippedArmNames.length
      : 0;
  const centroidOffset =
    weightedEnergy > 0
      ? Math.hypot(
        weightedX / weightedEnergy - ((size - 1) / 2),
        weightedY / weightedEnergy - ((size - 1) / 2),
      ) / Math.max(size, 1)
      : 1;
  const centroidScore = clamp(1 - centroidOffset / 0.24, 0, 1);
  const edgeTouchCount =
    Number(edgeTouch.right) + Number(edgeTouch.bottom) + Number(edgeTouch.left) + Number(edgeTouch.top);
  const edgeClipBoost =
    edgeTouchCount > 0
      ? 12 * cornerTightness * clamp((requiredArmCoverage - 0.2) / 0.55, 0, 1)
      : 0;
  const geometry =
    shape
    + 0.12 * requiredArmCoverage
    + 0.08 * coreCoverage
    + 0.06 * centroidScore
    + 0.04 * clippedArmCoverage;
  const score =
    contrast
    + 40 * shape
    + 12 * (xPos - 0.82)
    + 12 * (yPos - 0.82)
    + 18 * cornerCloseness
    + 10 * cornerTightness
    + 4 * edgeClipBoost;

  return {
    score,
    contrast,
    shape,
    geometry,
    insideCoverage,
    ringCoverage,
    coreCoverage,
    armCoverage,
    requiredArmCoverage,
    clippedArmCoverage,
    centroidOffset,
    centroidScore,
    cornerCloseness,
    cornerTightness,
    edgeTouch,
    edgeTouchCount,
  };
}

function searchCandidateGrid(png, stats, searchBounds, suppressed, sizeStart, sizeEnd, sizeStep, refineBounds = null) {
  let best = null;

  for (let size = sizeStart; size <= sizeEnd; size += sizeStep) {
    const template = getAstroidTemplate(size);
    const activeBounds = refineBounds
      ? {
        x0: Math.max(searchBounds.x0, refineBounds.x0),
        y0: Math.max(searchBounds.y0, refineBounds.y0),
        x1: Math.min(searchBounds.x1, refineBounds.x1),
        y1: Math.min(searchBounds.y1, refineBounds.y1),
      }
      : searchBounds;
    const maxX = activeBounds.x1 - size + 1;
    const maxY = activeBounds.y1 - size + 1;
    const step = refineBounds ? 1 : Math.max(2, Math.floor(size / 8));

    if (maxX < activeBounds.x0 || maxY < activeBounds.y0) {
      continue;
    }

    for (let y = activeBounds.y0; y <= maxY; y += step) {
      for (let x = activeBounds.x0; x <= maxX; x += step) {
        const center = {
          x: x + Math.floor(size / 2),
          y: y + Math.floor(size / 2),
        };

        if (overlapsSuppression(center, suppressed)) {
          continue;
        }

        const metrics = scoreCandidate(stats, png.width, png.height, x, y, template);

        if (!best || metrics.score > best.score) {
          best = {
            x,
            y,
            size,
            center,
            bbox: {
              x0: x,
              y0: y,
              x1: x + size - 1,
              y1: y + size - 1,
            },
            ...metrics,
          };
        }
      }
    }
  }

  return best;
}

function searchBestCandidate(png, stats, searchBounds, suppressed = []) {
  const maxSize = Math.min(64, Math.floor(Math.min(png.width, png.height) / 3));
  const coarse = searchCandidateGrid(png, stats, searchBounds, suppressed, 28, maxSize, 4);

  if (!coarse) {
    return null;
  }

  const refineRadius = Math.max(10, Math.floor(coarse.size * 0.55));
  const refineBounds = {
    x0: coarse.x - refineRadius,
    y0: coarse.y - refineRadius,
    x1: coarse.x + refineRadius,
    y1: coarse.y + refineRadius,
  };
  const refined = searchCandidateGrid(
    png,
    stats,
    searchBounds,
    suppressed,
    Math.max(24, coarse.size - 8),
    Math.min(maxSize, coarse.size + 8),
    1,
    refineBounds,
  );

  return refined && refined.score >= coarse.score ? refined : coarse;
}

function findWatermarkSparkles(png) {
  const stats = buildImageStats(png);
  const searchBounds = getCornerSearchBounds(png);

  const first = searchBestCandidate(png, stats, searchBounds, []);
  if (!first) {
    throw new Error('Unable to isolate the sparkle watermark in the bottom-right corner.');
  }

  const suppressed = [
    {
      center: first.center,
      radius: Math.floor(first.size * 1.2),
    },
  ];
  const second = searchBestCandidate(png, stats, searchBounds, suppressed);
  const sparkles = [first];

  if (
    second &&
    second.score >= first.score * 0.8 &&
    second.shape >= 0.78
  ) {
    sparkles.push(second);
  }

  sparkles.sort((left, right) => {
    if (left.center.x !== right.center.x) {
      return left.center.x - right.center.x;
    }
    return left.center.y - right.center.y;
  });

  return {
    searchBounds,
    sparkles,
    clusterBounds: unionBounds(sparkles.map((sparkle) => sparkle.bbox)),
    confidence: Number(clamp(
      0.08
      + 0.27 * clamp((first.contrast - 6) / 70, 0, 1)
      + 0.2 * clamp((first.geometry - 0.18) / 0.9, 0, 1)
      + 0.16 * clamp((first.requiredArmCoverage - 0.2) / 0.7, 0, 1)
      + 0.12 * clamp((first.coreCoverage - 0.12) / 0.7, 0, 1)
      + 0.1 * first.centroidScore
      + 0.08 * first.cornerCloseness
      + 0.08 * first.cornerTightness
      + 0.08 * clamp((first.clippedArmCoverage - 0.1) / 0.6, 0, 1)
      - (first.size <= 32 ? 0.08 : 0),
      0,
      0.995,
    ).toFixed(3)),
  };
}

function drawRectangle(png, bounds, color) {
  for (let x = bounds.x0; x <= bounds.x1; x += 1) {
    setPixel(png, x, bounds.y0, color.r, color.g, color.b);
    setPixel(png, x, bounds.y1, color.r, color.g, color.b);
  }

  for (let y = bounds.y0; y <= bounds.y1; y += 1) {
    setPixel(png, bounds.x0, y, color.r, color.g, color.b);
    setPixel(png, bounds.x1, y, color.r, color.g, color.b);
  }
}

function drawCrosshair(png, center, radius, color) {
  for (let offset = -radius; offset <= radius; offset += 1) {
    setPixel(png, center.x + offset, center.y, color.r, color.g, color.b);
    setPixel(png, center.x, center.y + offset, color.r, color.g, color.b);
  }
}

async function analyzeWatermark(imagePath) {
  const png = await loadPng(imagePath);
  const detection = findWatermarkSparkles(png);

  return {
    image: path.basename(imagePath),
    size: { width: png.width, height: png.height },
    answer: 'The watermark is the white sparkle glyph in the bottom-right corner.',
    watermark: {
      kind: 'sparkle-cluster',
      clusterBounds: detection.clusterBounds,
      sparkles: detection.sparkles.map((sparkle) => ({
        bbox: sparkle.bbox,
        center: sparkle.center,
        size: sparkle.size,
        score: Number(sparkle.score.toFixed(2)),
        shape: Number(sparkle.shape.toFixed(3)),
        geometry: Number(sparkle.geometry.toFixed(3)),
        insideCoverage: Number(sparkle.insideCoverage.toFixed(3)),
        ringCoverage: Number(sparkle.ringCoverage.toFixed(3)),
        coreCoverage: Number(sparkle.coreCoverage.toFixed(3)),
        requiredArmCoverage: Number(sparkle.requiredArmCoverage.toFixed(3)),
        clippedArmCoverage: Number(sparkle.clippedArmCoverage.toFixed(3)),
        centroidOffset: Number(sparkle.centroidOffset.toFixed(3)),
        cornerTightness: Number(sparkle.cornerTightness.toFixed(3)),
        edgeTouch: sparkle.edgeTouch,
      })),
    },
    debug: {
      searchBounds: detection.searchBounds,
    },
    confidence: detection.confidence,
  };
}

async function writeDebugOverlay(imagePath, analysis, outputPath) {
  const png = await loadPng(imagePath);

  drawRectangle(png, analysis.debug.searchBounds, { r: 0, g: 180, b: 255 });
  drawRectangle(png, analysis.watermark.clusterBounds, { r: 0, g: 255, b: 0 });

  for (const sparkle of analysis.watermark.sparkles) {
    drawRectangle(png, sparkle.bbox, { r: 255, g: 255, b: 0 });
    drawCrosshair(png, sparkle.center, 14, { r: 255, g: 140, b: 0 });
  }

  await savePng(png, outputPath);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    imagePath: null,
    debugPath: null,
    jsonOnly: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === '--debug') {
      const next = args[index + 1];
      if (!next) {
        throw new Error('--debug requires an output path.');
      }
      options.debugPath = next;
      index += 1;
      continue;
    }

    if (token === '--json') {
      options.jsonOnly = true;
      continue;
    }

    if (!options.imagePath) {
      options.imagePath = token;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!options.imagePath) {
    throw new Error('Usage: node detect-gemini-watermark.js <image.png> [--debug <overlay.png>] [--json]');
  }

  return options;
}

async function main() {
  try {
    const options = parseArgs(process.argv);
    const imagePath = path.resolve(options.imagePath);
    const analysis = await analyzeWatermark(imagePath);
    const debugPath =
      options.debugPath
        ? path.resolve(options.debugPath)
        : path.join(path.dirname(imagePath), `${path.parse(imagePath).name}.debug.png`);

    await writeDebugOverlay(imagePath, analysis, debugPath);

    if (options.jsonOnly) {
      console.log(JSON.stringify({ ...analysis, debugOverlay: debugPath }, null, 2));
      return;
    }

    console.log(`Image: ${analysis.image}`);
    console.log(`Answer: ${analysis.answer}`);
    console.log(`Cluster bbox: [${analysis.watermark.clusterBounds.x0}, ${analysis.watermark.clusterBounds.y0}] -> [${analysis.watermark.clusterBounds.x1}, ${analysis.watermark.clusterBounds.y1}]`);
    console.log(`Confidence: ${analysis.confidence}`);
    console.log(`Debug overlay: ${debugPath}`);
    console.log(JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}

module.exports = {
  main,
  analyzeWatermark,
  findWatermarkSparkles,
  loadPng,
  writeDebugOverlay,
  buildImageStats,
  scoreCandidate,
  searchBestCandidate,
  getCornerSearchBounds,
  getAstroidTemplate,
  bboxFromCandidate,
  centerFromCandidate,
};
