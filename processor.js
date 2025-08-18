#!/usr/bin/env node
/* processor.js — Bezier“液态面具”后端复刻 (CommonJS)
 * stdin  : rawvideo (rgb24)
 * stdout : rawvideo (rgb24)
 *
 * 与前端一致：
 *  - PoseNet: MobileNetV1 / stride=16 / inputResolution=500 / multiplier=0.75 / quantBytes=2
 *  - 多人姿态，flipHorizontal 默认 false（如素材为镜像可改 true）
 *  - 面具尺寸 = 基于耳距：maskW=1.3*faceWidth, maskH=1.8*faceWidth
 *  - 面具形状 = 两段三次 Bezier + 连接线，参数同前端 drawLiquidMask
 *  - 填充黑色 + 2px 白色描边（可调）
 *
 * 用法（例，固定 1280x720@25fps）：
 *   ffmpeg -hide_banner -loglevel error -i "<SIGNED_URL>" \
 *     -vf scale=1280:720,fps=25 -f rawvideo -pix_fmt rgb24 pipe:1 \
 *   | node processor.js --width 1280 --height 720 --fps 25 \
 *   | ffmpeg -hide_banner -loglevel error -f rawvideo -pix_fmt rgb24 -s 1280x720 -r 25 -i pipe:0 \
 *       -c:v libx264 -movflags +faststart -f mp4 pipe:1
 */

const tf = require('@tensorflow/tfjs-node');
const posenet = require('@tensorflow-models/posenet');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  // 固定 720p（可改）
  .option('width', { type: 'number', default: 1280 })
  .option('height', { type: 'number', default: 720 })
  .option('fps', { type: 'number', default: 25 })

  // PoseNet（与前端一致）
  .option('quantBytes', { type: 'number', default: 2 })
  .option('multiplier', { type: 'number', default: 0.75 })
  .option('outputStride', { type: 'number', default: 16 })
  .option('inputResolution', { type: 'number', default: 500 })

  // 多人参数
  .option('maxDetections', { type: 'number', default: 5 })
  .option('scoreThreshold', { type: 'number', default: 0.1 })
  .option('nmsRadius', { type: 'number', default: 30 })
  .option('minPoseConfidence', { type: 'number', default: 0.15 })
  .option('flipHorizontal', { type: 'boolean', default: false })

  // 面具形状/样式（与前端比例一致）
  .option('maskScaleW', { type: 'number', default: 1.3 })  // maskWidth = 1.3 * faceWidth
  .option('maskScaleH', { type: 'number', default: 1.8 })  // maskHeight = 1.8 * faceWidth
  .option('strokeWidth', { type: 'number', default: 2 })   // 白色描边
  .option('samplesPerCurve', { type: 'number', default: 64 }) // 每段 Bezier 采样数
  .option('modelUrl', { type: 'string', default: '' })
  .argv;

const W = argv.width | 0;
const H = argv.height | 0;
const FRAME_SIZE = W * H * 3;

// ---------------- 工具函数 ----------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 计算三次 Bezier 点
function cubicPoint(p0, p1, p2, p3, t) {
  const it = 1 - t;
  const a = it * it * it;
  const b = 3 * it * it * t;
  const c = 3 * it * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

// 采样两段 Bezier + 连接线，得到闭合轮廓（局部坐标）
function buildLiquidMaskPolyline(maskW, maskH, samplesPerCurve) {
  const halfW = maskW / 2;

  // 前端路径（局部坐标，原点在 mask 中心）：
  // moveTo(-W/2, -H*0.2)
  // bezierCurveTo(-W*0.4, -H*0.6,  W*0.4, -H*0.6,  W/2, -H*0.2)
  // lineTo(W/2, -H*0.05)
  // bezierCurveTo( W*0.4,  H*0.05, -W*0.4,  H*0.05, -W/2, -H*0.01)
  // closePath()

  const p0 = { x: -halfW, y: -maskH * 0.2 };
  const p1 = { x: -maskW * 0.4, y: -maskH * 0.6 };
  const p2 = { x:  maskW * 0.4, y: -maskH * 0.6 };
  const p3 = { x:  halfW,       y: -maskH * 0.2 };

  const q0 = { x:  halfW,       y: -maskH * 0.05 };
  const q1 = { x:  maskW * 0.4, y:  maskH * 0.05 };
  const q2 = { x: -maskW * 0.4, y:  maskH * 0.05 };
  const q3 = { x: -halfW,       y: -maskH * 0.01 };

  const pts = [];

  // 第一段三次 Bezier：p0 -> p3
  for (let i = 0; i <= samplesPerCurve; i++) {
    const t = i / samplesPerCurve;
    pts.push(cubicPoint(p0, p1, p2, p3, t));
  }

  // 直线：p3 -> q0
  pts.push({ x: q0.x, y: q0.y });

  // 第二段三次 Bezier：q0 -> q3
  for (let i = 1; i <= samplesPerCurve; i++) {
    const t = i / samplesPerCurve;
    pts.push(cubicPoint(q0, q1, q2, q3, t));
  }

  // 闭合（q3 -> p0）— 扫描线填充会自动闭合，polyline 绘制时处理
  return pts;
}

// 将局部点集做旋转+平移到帧坐标
function transformPolyline(points, cx, cy, angle) {
  const cosT = Math.cos(angle);
  const sinT = Math.sin(angle);
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i];
    const xr =  x *  cosT + y * sinT;
    const yr = -x *  sinT + y * cosT;
    out[i] = { x: xr + cx, y: yr + cy };
  }
  return out;
}

// 扫描线填充简单多边形（偶奇规则），points 为按顺序的折线路径（最后一条边自动闭合）
function fillPolygonRGB24(buf, points) {
  // 构建每条边
  const n = points.length;
  if (n < 3) return;

  // 计算包围盒，减少扫描范围
  let minY = H - 1, maxY = 0;
  for (const p of points) {
    const y = clamp(Math.round(p.y), 0, H - 1);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5;
    const xs = [];

    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const ay = a.y, by = b.y;
      const ax = a.x, bx = b.x;

      // 跳过水平边；处理半开区间避免顶点重复计数
      if ((scanY < Math.min(ay, by)) || (scanY >= Math.max(ay, by)) || ay === by) continue;

      const t = (scanY - ay) / (by - ay);
      const x = ax + t * (bx - ax);
      xs.push(x);
    }

    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    // 成对涂黑
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let x0 = Math.round(xs[k]);
      let x1 = Math.round(xs[k + 1]);
      if (x0 > x1) [x0, x1] = [x1, x0];
      x0 = clamp(x0, 0, W - 1);
      x1 = clamp(x1, 0, W - 1);
      let idx = (y * W + x0) * 3;
      for (let x = x0; x <= x1; x++) {
        buf[idx] = 0; buf[idx + 1] = 0; buf[idx + 2] = 0; // 黑色
        idx += 3;
      }
    }
  }
}

// 加粗折线描边（白色），通过逐段“粗线”绘制
function strokePolylineRGB24(buf, points, thickness) {
  if (points.length < 2 || thickness <= 0) return;
  const r = Math.max(1, thickness / 2);
  const r2 = r * r;

  // 简单粗线段绘制（以点到线段距离阈值判断）
  const drawThickSeg = (x0, y0, x1, y1) => {
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    const minX = clamp(Math.floor(Math.min(x0, x1) - r - 1), 0, W - 1);
    const maxX = clamp(Math.ceil (Math.max(x0, x1) + r + 1), 0, W - 1);
    const minY = clamp(Math.floor(Math.min(y0, y1) - r - 1), 0, H - 1);
    const maxY = clamp(Math.ceil (Math.max(y0, y1) + r + 1), 0, H - 1);

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let t = 0;
        if (len2 > 0) {
          t = ((px - x0) * dx + (py - y0) * dy) / len2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
        }
        const cx = x0 + t * dx;
        const cy = y0 + t * dy;
        const ddx = px - cx, ddy = py - cy;
        if (ddx * ddx + ddy * ddy <= r2) {
          const idx = (y * W + x) * 3;
          buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255; // 白色
        }
      }
    }
  };

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length]; // 闭合描边
    drawThickSeg(a.x, a.y, b.x, b.y);
  }
}

function getKP(map, name) {
  const kp = map.find(k => k.part === name);
  return kp && kp.score != null ? kp : null;
}

// ---------------- 主逻辑 ----------------
(async () => {
  const net = await posenet.load({
    architecture: 'MobileNetV1',
    outputStride: argv.outputStride,
    inputResolution: argv.inputResolution,
    multiplier: argv.multiplier,
    quantBytes: argv.quantBytes,
    modelUrl: argv.modelUrl || undefined
  });

  const stdin = process.stdin;
  const stdout = process.stdout;
  try { stdout._handle && stdout._handle.setBlocking && stdout._handle.setBlocking(true); } catch {}

  let pending = Buffer.alloc(0);
  stdin.on('error', () => {});
  stdout.on('error', () => process.exit(0));

  for await (const chunk of stdin) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_SIZE) {
      const frame = pending.subarray(0, FRAME_SIZE);
      pending = pending.subarray(FRAME_SIZE);

      // [H,W,3] tensor
      const img = tf.tensor3d(new Uint8Array(frame), [H, W, 3], 'int32');

      const poses = await net.estimateMultiplePoses(img, {
        flipHorizontal: !!argv.flipHorizontal,
        maxDetections: argv.maxDetections,
        scoreThreshold: argv.scoreThreshold,
        nmsRadius: argv.nmsRadius
      });
      img.dispose();

      for (const pose of poses) {
        if (!pose || pose.score < argv.minPoseConfidence) continue;

        const nose     = getKP(pose.keypoints, 'nose');
        const leftEar  = getKP(pose.keypoints, 'leftEar');
        const rightEar = getKP(pose.keypoints, 'rightEar');
        if (!nose || !leftEar || !rightEar) continue;
        if (leftEar.score < argv.scoreThreshold || rightEar.score < argv.scoreThreshold) continue;

        const lx = leftEar.position.x,  ly = leftEar.position.y;
        const rx = rightEar.position.x, ry = rightEar.position.y;

        const faceAngle = Math.atan2(ry - ly, rx - lx);
        const faceWidth = Math.hypot(rx - lx, ry - ly);

        const maskW = argv.maskScaleW * faceWidth;
        const maskH = argv.maskScaleH * faceWidth;

        const cx = clamp(nose.position.x, 0, W - 1);
        const cy = clamp(nose.position.y, 0, H - 1);

        // 1) 构建局部 Bezier 轮廓（未旋转/未平移）
        const localPoly = buildLiquidMaskPolyline(maskW, maskH, argv.samplesPerCurve);
        // 2) 旋转+平移到图像坐标
        const poly = transformPolyline(localPoly, cx, cy, faceAngle);
        // 3) 填充黑色
        fillPolygonRGB24(frame, poly);
        // 4) 白色描边
        strokePolylineRGB24(frame, poly, argv.strokeWidth);
      }

      if (!stdout.write(frame)) {
        await new Promise(res => stdout.once('drain', res));
      }
    }
  }

  stdout.end();
})().catch(err => {
  console.error('[processor] fatal:', err && err.stack || err);
  process.exit(1);
});
