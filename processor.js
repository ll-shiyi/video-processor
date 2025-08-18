#!/usr/bin/env node
/* processor.js — Bezier"液态面具"后端复刻 (CommonJS, speed-optimized, no-tidy-async)
 * stdin  : rawvideo (rgb24)
 * stdout : rawvideo (rgb24)
 *
 * 模型/几何与前端一致，优化点：
 *  - 使用 @tensorflow/tfjs-node 的原生后端
 *  - 姿态检测仅在降采样帧上进行（--detectScale），坐标缩放回原尺寸
 *  - 跳帧检测（--detectEvery），中间帧复用上次姿态（已启 smoothing）
 *  - 手动 dispose()，不在 tf.tidy 中返回 Promise（修复 Cannot return a Promise inside of tidy）
 */

const tf = require('@tensorflow/tfjs-node'); // ★ 原生后端：显著加速（CPU/GPU二进制）
const poseDetection = require('@tensorflow-models/pose-detection');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  // 固定帧尺寸（渲染在原尺寸上）
  .option('width', { type: 'number', default: 1280 })
  .option('height', { type: 'number', default: 720 })
  .option('fps', { type: 'number', default: 25 })

  // pose-detection（与前端一致）
  .option('modelType', { type: 'string', default: 'SINGLEPOSE_LIGHTNING' })
  .option('enableSmoothing', { type: 'boolean', default: true })
  .option('enableSegmentation', { type: 'boolean', default: false })

  // 多人参数
  .option('maxDetections', { type: 'number', default: 5 })
  .option('scoreThreshold', { type: 'number', default: 0.1 })
  .option('nmsRadius', { type: 'number', default: 30 })
  .option('minPoseConfidence', { type: 'number', default: 0.15 })
  .option('flipHorizontal', { type: 'boolean', default: false })

  // 面具形状/样式（与前端比例一致）
  .option('maskScaleW', { type: 'number', default: 1.3 })
  .option('maskScaleH', { type: 'number', default: 1.8 })
  .option('strokeWidth', { type: 'number', default: 2 })
  .option('samplesPerCurve', { type: 'number', default: 64 })
  .option('modelUrl', { type: 'string', default: '' })

  // 性能开关
  .option('detectScale', { type: 'number', default: 0.5, describe: '仅用于姿态检测的降采样比例(0.3~1.0)' })
  .option('detectEvery', { type: 'number', default: 2, describe: '每N帧执行一次姿态检测，其余复用' })
  .option('showProgress', { type: 'boolean', default: true, description: '显示处理进度' })
  .argv;

const W = argv.width | 0;
const H = argv.height | 0;
const FRAME_SIZE = W * H * 3;

const DW = Math.max(64, Math.round(W * argv.detectScale)); // 检测用宽
const DH = Math.max(64, Math.round(H * argv.detectScale)); // 检测用高
const SCALE_X = W / DW;
const SCALE_Y = H / DH;

// ---------------- 工具函数 ----------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 三次 Bezier
function cubicPoint(p0, p1, p2, p3, t) {
  const it = 1 - t;
  const a = it * it * it;
  const b = 3 * it * it * t;
  const c = 3 * it * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

// 两段 Bezier + 连接线（局部）
function buildLiquidMaskPolyline(maskW, maskH, samples) {
  const halfW = maskW / 2;
  const p0 = { x: -halfW, y:  maskH * 0.2 };
  const p1 = { x: -maskW * 0.4, y:  maskH * 0.6 };
  const p2 = { x:  maskW * 0.4, y:  maskH * 0.6 };
  const p3 = { x:  halfW,       y:  maskH * 0.2 };
  const q0 = { x:  halfW,       y:  maskH * 0.05 };
  const q1 = { x:  maskW * 0.4, y: -maskH * 0.05 };
  const q2 = { x: -maskW * 0.4, y: -maskH * 0.05 };
  const q3 = { x: -halfW,       y:  maskH * 0.01 };

  const pts = new Array(samples * 2 + 2);
  let idx = 0;
  for (let i = 0; i <= samples; i++) pts[idx++] = cubicPoint(p0, p1, p2, p3, i / samples);
  pts[idx++] = { x: q0.x, y: q0.y };
  for (let i = 1; i <= samples; i++) pts[idx++] = cubicPoint(q0, q1, q2, q3, i / samples);
  return pts;
}

// 旋转+平移
function transformPolyline(points, cx, cy, angle) {
  const cosT = Math.cos(angle), sinT = Math.sin(angle);
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i];
    const xr =  x *  cosT + y * sinT;
    const yr = -x *  sinT + y * cosT;
    out[i] = { x: xr + cx, y: yr + cy };
  }
  return out;
}

// 扫描线填充（黑色）
function fillPolygonRGB24(buf, points) {
  const n = points.length;
  if (n < 3) return;
  let minY = H - 1, maxY = 0;
  for (let i = 0; i < n; i++) {
    const y = clamp((points[i].y + 0.5) | 0, 0, H - 1);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const xs = []; // 复用
  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      const ay = a.y, by = b.y;
      if (ay === by || scanY < Math.min(ay, by) || scanY >= Math.max(ay, by)) continue;
      const t = (scanY - ay) / (by - ay);
      xs.push(a.x + t * (b.x - a.x));
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let x0 = xs[k] | 0, x1 = xs[k + 1] | 0;
      if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
      x0 = clamp(x0, 0, W - 1);
      x1 = clamp(x1, 0, W - 1);
      let idx = (y * W + x0) * 3;
      for (let x = x0; x <= x1; x++) { buf[idx] = 0; buf[idx + 1] = 0; buf[idx + 2] = 0; idx += 3; }
    }
  }
}

// 白色描边（粗线）
function strokePolylineRGB24(buf, points, thickness) {
  if (points.length < 2 || thickness <= 0) return;
  const r = Math.max(1, thickness / 2), r2 = r * r;

  const drawSeg = (x0, y0, x1, y1) => {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
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
        const cx = x0 + t * dx, cy = y0 + t * dy;
        const ddx = px - cx, ddy = py - cy;
        if (ddx * ddx + ddy * ddy <= r2) {
          const idx = (y * W + x) * 3;
          buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255;
        }
      }
    }
  };

  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    drawSeg(a.x, a.y, b.x, b.y);
  }
}

function getKP(map, name) {
  for (let i = 0; i < map.length; i++) {
    const k = map[i];
    if (k.name === name) return (k.score != null ? k : null);
  }
  return null;
}

// ★ CPU 最近邻降采样：从原始 720p RGB24 Buffer 采样生成 DW×DH×3 的 Float32Array
function downsampleRGB24Nearest(srcBuf, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh * 3);
  const sxStep = sw / dw, syStep = sh / dh;
  let o = 0;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y * syStep) | 0);
    const row = sy * sw * 3;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, (x * sxStep) | 0);
      const si = row + sx * 3;
      out[o++] = srcBuf[si];     // R
      out[o++] = srcBuf[si + 1]; // G
      out[o++] = srcBuf[si + 2]; // B
    }
  }
  return out;
}

// ---------------- 主逻辑 ----------------
(async () => {
  const detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType: poseDetection.movenet.modelType[argv.modelType],
      enableSmoothing: argv.enableSmoothing,
      enableSegmentation: argv.enableSegmentation
    }
  );

  const stdin = process.stdin;
  const stdout = process.stdout;
  try { stdout._handle && stdout._handle.setBlocking && stdout._handle.setBlocking(true); } catch {}

  let pending = Buffer.alloc(0);
  let frameCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;

  // 上一次检测到的姿态（用于跳帧复用）
  let lastPoses = [];

  // 改进错误处理
  stdin.on('error', (err) => {
    console.error('[processor] stdin error:', err.message);
    process.exit(1);
  });
  
  stdout.on('error', (err) => {
    console.error('[processor] stdout error:', err.message);
    process.exit(1);
  });
  
  // 处理进程信号
  process.on('SIGTERM', () => {
    console.log('[processor] Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });
  
  process.on('SIGINT', () => {
    console.log('[processor] Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });

  const showProgress = (currentFrame, fps) => {
    if (!argv.showProgress) return;
    const now = Date.now();
    if (now - lastProgressTime >= 1000) {
      const elapsed = (now - startTime) / 1000;
      // 这里无法知道总帧数（来自 stdin），仅展示速率/耗时等
      process.stderr.write(`\r处理进度: ${currentFrame} 帧 | 已用时间: ${elapsed.toFixed(1)}s`);
      lastProgressTime = now;
    }
  };

  try {
    for await (const chunk of stdin) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_SIZE) {
        const frame = pending.subarray(0, FRAME_SIZE);
        pending = pending.subarray(FRAME_SIZE);
        frameCount++;

        // ★ 决定是否做"新检测"
        const doDetect = (frameCount % Math.max(1, argv.detectEvery)) === 1;

        if (doDetect) {
          // ★ 仅为检测降采样，避免大分辨率进入 TF
          const small = downsampleRGB24Nearest(frame, W, H, DW, DH);
          const img = tf.tensor3d(small, [DH, DW, 3], 'float32'); // 与 MoveNet 预期兼容

          try {
            const poses = await detector.estimatePoses(img, {
              flipHorizontal: !!argv.flipHorizontal,
              maxPoses: argv.maxDetections,
              scoreThreshold: argv.scoreThreshold
            });
            lastPoses = poses || [];
            // 将坐标从降采样尺度映射回原图尺度
            for (const p of lastPoses) {
              if (!p || !p.keypoints) continue;
              for (let i = 0; i < p.keypoints.length; i++) {
                const k = p.keypoints[i];
                k.x *= SCALE_X;
                k.y *= SCALE_Y;
              }
            }
          } finally {
            // 关键：不在 tf.tidy 返回 Promise，改用 finally 手动释放
            img.dispose();
          }
        }

        const poses = lastPoses;

        // 渲染
        for (let pi = 0; pi < poses.length; pi++) {
          const pose = poses[pi];
          if (!pose || pose.score < argv.minPoseConfidence) continue;

          const nose     = getKP(pose.keypoints, 'nose');
          const leftEar  = getKP(pose.keypoints, 'left_ear');
          const rightEar = getKP(pose.keypoints, 'right_ear');
          if (!nose || !leftEar || !rightEar) continue;
          if (leftEar.score < argv.scoreThreshold || rightEar.score < argv.scoreThreshold) continue;

          const lx = leftEar.x,  ly = leftEar.y;
          const rx = rightEar.x, ry = rightEar.y;

          const faceAngle = Math.atan2(ry - ly, rx - lx);
          const faceWidth = Math.hypot(rx - lx, ry - ly);

          const maskW = argv.maskScaleW * faceWidth;
          const maskH = argv.maskScaleH * faceWidth;

          const cx = clamp(nose.x, 0, W - 1);
          const cy = clamp(nose.y, 0, H - 1);

          const localPoly = buildLiquidMaskPolyline(maskW, maskH, argv.samplesPerCurve);
          const poly = transformPolyline(localPoly, cx, cy, faceAngle);

          fillPolygonRGB24(frame, poly);
          strokePolylineRGB24(frame, poly, argv.strokeWidth);
        }

        showProgress(frameCount, argv.fps);

        if (!stdout.write(frame)) await new Promise(res => stdout.once('drain', res));
      }
    }
  } catch (err) {
    console.error('[processor] processing error:', err.message);
    process.exit(1);
  }

  if (argv.showProgress) {
    const totalTime = (Date.now() - startTime) / 1000;
    const avgFps = frameCount / Math.max(0.0001, totalTime);
    process.stderr.write(`\n处理完成！总帧数: ${frameCount} | 总时间: ${totalTime.toFixed(1)}s | 平均处理速度: ${avgFps.toFixed(1)} fps\n`);
  }
  stdout.end();
})().catch(err => {
  console.error('[processor] fatal:', err && (err.stack || err));
  process.exit(1);
});
