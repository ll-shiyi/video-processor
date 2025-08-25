#!/usr/bin/env node
/* processor_yuv.js — YUV420P 管线 + MoveNet；仅遮罩鼻子以上区域
 * stdin : rawvideo (yuv420p)
 * stdout: rawvideo (yuv420p)
 */

process.env.TF_CPP_MIN_LOG_LEVEL = '2';
process.env.TENSORFLOW_NUM_INTRAOP_THREADS = process.env.TENSORFLOW_NUM_INTRAOP_THREADS || '4';
process.env.TENSORFLOW_NUM_INTEROP_THREADS = process.env.TENSORFLOW_NUM_INTEROP_THREADS || '2';
// 抑制 Node.js 弃用警告
process.env.NODE_NO_WARNINGS = '1';
// 设置 --no-deprecation 标志来抑制弃用警告
if (!process.argv.includes('--no-deprecation')) {
  process.argv.unshift('--no-deprecation');
}

const tf = require('@tensorflow/tfjs-node');
const poseDetection = require('@tensorflow-models/pose-detection');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs');
const path = require('path');

const argv = yargs(hideBin(process.argv))
  .option('width', { type: 'number', default: 1280 })
  .option('height', { type: 'number', default: 720 })
  .option('fps', { type: 'number', default: 25 })
  .option('modelType', { type: 'string', default: 'SINGLEPOSE_LIGHTNING' })
  .option('enableSmoothing', { type: 'boolean', default: true })
  .option('maxDetections', { type: 'number', default: 3 })
  .option('scoreThreshold', { type: 'number', default: 0.2 })
  .option('minPoseConfidence', { type: 'number', default: 0.15 })
  .option('flipHorizontal', { type: 'boolean', default: false })
  .option('maskScaleW', { type: 'number', default: 1.3 })
  .option('maskScaleH', { type: 'number', default: 1.8 })
  .option('samplesPerCurve', { type: 'number', default: 28 }) // 建议 28~56
  .option('strokeWidth', { type: 'number', default: 1 })     // Y 平面描边像素粗细
  .option('detectScale', { type: 'number', default: 0.3 })
  .option('detectEvery', { type: 'number', default: 5 })
  .option('adaptiveSkip', { type: 'boolean', default: true })
  .option('showProgress', { type: 'boolean', default: true })
  .argv;

const W = argv.width | 0, H = argv.height | 0;
if (W % 2 || H % 2) {
  console.error('[processor] width/height must be even for yuv420p.');
  process.exit(1);
}
const W2 = W >> 1, H2 = H >> 1;

const FRAME_Y = W * H;
const FRAME_U = W2 * H2;
const FRAME_V = FRAME_U;
const FRAME_SIZE = FRAME_Y + FRAME_U + FRAME_V;

const DW = Math.max(64, Math.round(W * argv.detectScale));
const DH = Math.max(64, Math.round(H * argv.detectScale));
const SCALE_X = W / DW;
const SCALE_Y = H / DH;

// ---------------- WASM (可选) ----------------
let wasm = null;
(async () => {
  try {
    const wasmPath = path.resolve(process.cwd(), 'raster.wasm');
    if (fs.existsSync(wasmPath)) {
      const bin = fs.readFileSync(wasmPath);
      const mod = await WebAssembly.instantiate(bin, {});
      wasm = mod.instance.exports;
      console.error('[processor] WASM raster loaded.');
    }
  } catch (e) {
    console.error('[processor] WASM load failed:', e.message);
  }
})();

// ---------------- 工具函数 ----------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// “超椭圆”美化面具（更像脸型，额头略收、下巴更饱满）
function buildBeautyMaskPolyline(maskW, maskH, samples, nTop = 3.0, nBot = 2.2) {
  const a = maskW / 2;
  const b = maskH / 2;
  const pts = new Array(samples);
  const TWO_PI = Math.PI * 2;

  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * TWO_PI; // 0..2π
    const c = Math.cos(t);
    const s = Math.sin(t);

    const n = (s >= 0) ? nBot : nTop; // s>=0 为下巴区；s<0 为额头区
    const pow = 2 / n;

    let x = a * Math.sign(c) * Math.pow(Math.abs(c), pow);
    let y = b * Math.sign(s) * Math.pow(Math.abs(s), pow);

    if (s < 0) { x *= 0.92; y *= 0.96; } // 额头收窄
    else      { y *= 1.06; }            // 下巴更饱满（但稍后我们会裁掉鼻子以下）
    pts[i] = { x, y };
  }
  return pts;
}

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

function getKP(map, name) {
  for (let i = 0; i < map.length; i++) {
    const k = map[i];
    if (k.name === name) return (k.score != null ? k : null);
  }
  return null;
}

// ---- 多边形裁剪：仅保留 y <= yLimit 的部分（Sutherland–Hodgman 针对单条水平半平面）----
function clipPolygonAbove(points, yLimit) {
  // “鼻子以上” → 图像坐标 y 向下为正，因此保留 y <= yLimit
  const n = points.length;
  if (n < 3) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const prev = points[(i + n - 1) % n];
    const currIn = curr.y <= yLimit;
    const prevIn = prev.y <= yLimit;

    if (prevIn && currIn) {
      // in → in：保留当前点
      out.push(curr);
    } else if (prevIn && !currIn) {
      // in → out：加入交点
      const t = (yLimit - prev.y) / (curr.y - prev.y);
      const x = prev.x + t * (curr.x - prev.x);
      out.push({ x, y: yLimit });
    } else if (!prevIn && currIn) {
      // out → in：加入交点 + 当前点
      const t = (yLimit - prev.y) / (curr.y - prev.y);
      const x = prev.x + t * (curr.x - prev.x);
      out.push({ x, y: yLimit });
      out.push(curr);
    }
    // out → out：无输出
  }
  // 可能退化成线/点，调用侧会跳过
  return out;
}

// ---------------- 预计算：降采样索引（从 Y 平面降采样，灰度 → 3 通道） ----------------
const DS_INDEX = (() => {
  const sxStep = W / DW, syStep = H / DH;
  const arr = new Int32Array(DW * DH);
  let o = 0;
  for (let y = 0; y < DH; y++) {
    const sy = Math.min(H - 1, (y * syStep) | 0);
    let row = sy * W; // Y 平面 1 字节/像素
    for (let x = 0; x < DW; x++) {
      const sx = Math.min(W - 1, (x * sxStep) | 0);
      arr[o++] = row + sx;
    }
  }
  return arr;
})();
const DS_BUF_RGB = new Float32Array(DW * DH * 3); // 灰度复制到 3 通道

function downsampleY_toRGB(sY) {
  // 将 Y 值复制到 R/G/B 三通道
  for (let i = 0, j = 0; i < DS_INDEX.length; i++) {
    const yv = sY[DS_INDEX[i]];
    DS_BUF_RGB[j++] = yv;
    DS_BUF_RGB[j++] = yv;
    DS_BUF_RGB[j++] = yv;
  }
  return DS_BUF_RGB;
}

// ---------------- 扫描线填充/描边（JS 版，若无 WASM） ----------------
const XS_BUF = new Float32Array(64);

function fillPolygonY(bufY, points, width, height) {
  const n = points.length;
  if (n < 3) return;
  let minY = height - 1, maxY = 0;
  for (let i = 0; i < n; i++) {
    const y = clamp((points[i].y + 0.5) | 0, 0, height - 1);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
      const ay = a.y, by = b.y;
      if (ay === by || scanY < Math.min(ay, by) || scanY >= Math.max(ay, by)) continue;
      const t = (scanY - ay) / (by - ay);
      XS_BUF[k++] = a.x + t * (b.x - a.x);
    }
    if (k < 2) continue;
    // 插入排序 (k 很小)
    for (let i = 1; i < k; i++) {
      const v = XS_BUF[i]; let j = i - 1;
      while (j >= 0 && XS_BUF[j] > v) { XS_BUF[j + 1] = XS_BUF[j]; j--; }
      XS_BUF[j + 1] = v;
    }
    for (let t = 0; t + 1 < k; t += 2) {
      let x0 = XS_BUF[t] | 0, x1 = XS_BUF[t + 1] | 0;
      if (x0 > x1) { const tmp = x0; x0 = x1; x1 = tmp; }
      x0 = clamp(x0, 0, width - 1);
      x1 = clamp(x1, 0, width - 1);
      bufY.fill(0, y * width + x0, y * width + x1 + 1);
    }
  }
}

function strokePolylineY(bufY, points, thickness, width, height) {
  if (points.length < 2 || thickness <= 0) return;
  const r = Math.max(1, thickness / 2), r2 = r * r;
  const drawSeg = (x0, y0, x1, y1) => {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    const minX = clamp(Math.floor(Math.min(x0, x1) - r - 1), 0, width - 1);
    const maxX = clamp(Math.ceil (Math.max(x0, x1) + r + 1), 0, width - 1);
    const minY = clamp(Math.floor(Math.min(y0, y1) - r - 1), 0, height - 1);
    const maxY = clamp(Math.ceil (Math.max(y0, y1) + r + 1), 0, height - 1);
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
          bufY[y * width + x] = 0;
        }
      }
    }
  };
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    drawSeg(a.x, a.y, b.x, b.y);
  }
}

// UV 平面填充（U/V 是 W/2 × H/2；遮罩范围写 128）
function fillPolygonUV(bufU, bufV, points, width2, height2) {
  if (points.length < 3) return;
  const pts = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    pts[i] = { x: points[i].x * 0.5, y: points[i].y * 0.5 };
  }
  const n = pts.length;
  let minY = height2 - 1, maxY = 0;
  for (let i = 0; i < n; i++) {
    const y = clamp((pts[i].y + 0.5) | 0, 0, height2 - 1);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const ay = a.y, by = b.y;
      if (ay === by || scanY < Math.min(ay, by) || scanY >= Math.max(ay, by)) continue;
      const t = (scanY - ay) / (by - ay);
      XS_BUF[k++] = a.x + t * (b.x - a.x);
    }
    if (k < 2) continue;
    for (let i = 1; i < k; i++) { const v = XS_BUF[i]; let j = i - 1; while (j >= 0 && XS_BUF[j] > v) { XS_BUF[j + 1] = XS_BUF[j]; j--; } XS_BUF[j + 1] = v; }
    for (let t = 0; t + 1 < k; t += 2) {
      let x0 = XS_BUF[t] | 0, x1 = XS_BUF[t + 1] | 0;
      if (x0 > x1) { const tmp = x0; x0 = x1; x1 = tmp; }
      x0 = clamp(x0, 0, width2 - 1);
      x1 = clamp(x1, 0, width2 - 1);
      bufU.fill(128, y * width2 + x0, y * width2 + x1 + 1);
      bufV.fill(128, y * width2 + x0, y * width2 + x1 + 1);
    }
  }
}

// ---------------- 主逻辑 ----------------
(async () => {
  const detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType: poseDetection.movenet.modelType[argv.modelType],
      enableSmoothing: argv.enableSmoothing,
      enableSegmentation: false,
      maxPoses: argv.maxDetections
    }
  );

  // 预热
  {
    const warm = tf.zeros([DH, DW, 3], 'float32');
    await detector.estimatePoses(warm, { maxPoses: argv.maxDetections, flipHorizontal: !!argv.flipHorizontal });
    warm.dispose();
  }

  // stdin / stdout
  const stdin = process.stdin;
  const stdout = process.stdout;
  try { stdout._handle && stdout._handle.setBlocking && stdout._handle.setBlocking(true); } catch {}

  let pending = Buffer.alloc(0);
  let frameCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;

  // 跳帧复用
  let lastPoses = [];
  let lastTriplet = null; // {nose:[x,y], left_ear:[x,y], right_ear:[x,y]}

  const showProgress = () => {
    if (!argv.showProgress) return;
    const now = Date.now();
    if (now - lastProgressTime >= 1000) {
      const elapsed = (now - startTime) / 1000;
      process.stderr.write(`\r处理进度: ${frameCount} 帧 | 已用时间: ${elapsed.toFixed(1)}s`);
      lastProgressTime = now;
    }
  };

  const smallMotion = (pose) => {
    if (!argv.adaptiveSkip || !lastTriplet) return false;
    const n = getKP(pose.keypoints, 'nose');
    const le = getKP(pose.keypoints, 'left_ear');
    const re = getKP(pose.keypoints, 'right_ear');
    if (!(n && le && re)) return false;
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const L = (d([n.x, n.y], lastTriplet.nose) +
               d([le.x, le.y], lastTriplet.left_ear) +
               d([re.x, re.y], lastTriplet.right_ear)) / 3;
    return L < 2.5; // 阈值可调
  };

  // 主循环
  try {
    for await (const chunk of stdin) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= FRAME_SIZE) {
        const frame = pending.subarray(0, FRAME_SIZE);
        pending = pending.subarray(FRAME_SIZE);
        frameCount++;

        const yPlane = frame.subarray(0, FRAME_Y);
        const uPlane = frame.subarray(FRAME_Y, FRAME_Y + FRAME_U);
        const vPlane = frame.subarray(FRAME_Y + FRAME_U, FRAME_SIZE);

        // 是否检测
        let doDetect = (frameCount % Math.max(1, argv.detectEvery)) === 1;
        if (!doDetect && argv.adaptiveSkip && lastPoses.length === 1) {
          doDetect = !smallMotion(lastPoses[0]);
        }

        if (doDetect) {
          // 仅用 Y 平面灰度降采样 -> 复制为 3 通道浮点
          const smallRGB = downsampleY_toRGB(yPlane);
          const img = tf.tensor3d(smallRGB, [DH, DW, 3], 'float32');
          try {
            const poses = await detector.estimatePoses(img, {
              flipHorizontal: !!argv.flipHorizontal,
              maxPoses: argv.maxDetections,
              scoreThreshold: argv.scoreThreshold
            });
            lastPoses = poses || [];
            // 坐标映射回原图尺度
            for (const p of lastPoses) {
              if (!p || !p.keypoints) continue;
              for (let i = 0; i < p.keypoints.length; i++) {
                const k = p.keypoints[i];
                k.x *= SCALE_X;
                k.y *= SCALE_Y;
              }
            }
          } finally {
            img.dispose();
          }
        }

        // 渲染到 Y/UV
        const poses = lastPoses;
        for (let pi = 0; pi < poses.length; pi++) {
          const pose = poses[pi];
          if (!pose || pose.score < argv.minPoseConfidence) continue;

          const nose = getKP(pose.keypoints, 'nose');
          const le = getKP(pose.keypoints, 'left_ear');
          const re = getKP(pose.keypoints, 'right_ear');
          if (!(nose && le && re)) continue;
          if (le.score < argv.scoreThreshold || re.score < argv.scoreThreshold) continue;

          const lx = le.x, ly = le.y;
          const rx = re.x, ry = re.y;
          const nx = nose.x, ny = nose.y;

          const faceAngle = Math.atan2(ly - ry, rx - lx);
          const leftDist = Math.hypot(nx - lx, ny - ly);
          const rightDist = Math.hypot(nx - rx, ny - ry);
          const faceWidth = Math.max(leftDist, rightDist) * 2;

          const maskW = argv.maskScaleW * faceWidth;
          const maskH = argv.maskScaleH * faceWidth;

          const cx = clamp(nx, 0, W - 1);
          const cy = clamp(ny, 0, H - 1);

          // 生成“超椭圆”面具并放置到脸部
          const localPoly = buildBeautyMaskPolyline(
            maskW,
            maskH,
            Math.max(24, argv.samplesPerCurve) // 最少 24 点更顺滑
          );
          const polyAll = transformPolyline(localPoly, cx, cy, faceAngle);

          // ★ 仅遮罩“鼻子以上” → 裁剪半平面 y <= nose.y
          const poly = clipPolygonAbove(polyAll, ny+10);
          if (poly.length < 3) continue; // 被裁空/退化则跳过

          // 填充到 Y；描边可选；UV=128
          if (wasm && wasm.fillY) {
            // 如果你实现了 WASM 版，可在此切换到 wasm 调用；默认使用 JS 版：
            fillPolygonY(yPlane, poly, W, H);
          } else {
            fillPolygonY(yPlane, poly, W, H);
          }
          if (argv.strokeWidth > 0) {
            strokePolylineY(yPlane, poly, argv.strokeWidth, W, H);
          }
          fillPolygonUV(uPlane, vPlane, poly, W2, H2);

          // 更新位移缓存
          lastTriplet = { nose: [nx, ny], left_ear: [lx, ly], right_ear: [rx, ry] };
        }

        // 写回
        if (!stdout.write(frame)) await new Promise(res => stdout.once('drain', res));
        showProgress();
      }
    }
  } catch (err) {
    console.error('[processor] processing error:', err && err.message);
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
