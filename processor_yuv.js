#!/usr/bin/env node
/* processor_yuv.js — YUV420P 管线 + MoveNet；“液态面具”形状 1:1 复刻（按前端 drawLiquidMask）
 * 每帧检测模式：使用原始视频尺寸，每帧都进行人脸检测和遮挡绘制
 * stdin : rawvideo (yuv420p)
 * stdout: rawvideo (yuv420p)
 */

process.env.TF_CPP_MIN_LOG_LEVEL = '2';
process.env.TENSORFLOW_NUM_INTRAOP_THREADS = process.env.TENSORFLOW_NUM_INTRAOP_THREADS || '4';
process.env.TENSORFLOW_NUM_INTEROP_THREADS = process.env.TENSORFLOW_NUM_INTEROP_THREADS || '2';
// 抑制 Node.js 弃用警告
process.env.NODE_NO_WARNINGS = '1';
if (!process.argv.includes('--no-deprecation')) {
  process.argv.unshift('--no-deprecation');
}

const tf = require('@tensorflow/tfjs-node');
const poseDetection = require('@tensorflow-models/pose-detection');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = yargs(hideBin(process.argv))
  .option('width', { type: 'number', demandOption: true })   // 由外部 ffprobe 传入
  .option('height', { type: 'number', demandOption: true })  // 由外部 ffprobe 传入
  .option('fps', { type: 'number', default: 25 })
  .option('modelType', { type: 'string', default: 'SINGLEPOSE_LIGHTNING' })
  .option('enableSmoothing', { type: 'boolean', default: true })
  .option('maxDetections', { type: 'number', default: 3 })
  .option('scoreThreshold', { type: 'number', default: 0.2 })
  .option('minPoseConfidence', { type: 'number', default: 0.15 })
  .option('flipHorizontal', { type: 'boolean', default: false })

  // —— 关键：与前端一致的尺寸系数 ——
  .option('maskScaleW', { type: 'number', default: 1.3 }) // faceWidth * 1.3
  .option('maskScaleH', { type: 'number', default: 1.8 }) // faceWidth * 1.8

  // 采样密度：每条贝塞尔曲线的采样点数（建议：28~56）
  .option('samplesPerCurve', { type: 'number', default: 32 })

  // 线条粗细（像素），用于“白色描边”
  .option('strokeWidth', { type: 'number', default: 2 })

  // 检测控制
  .option('showProgress', { type: 'boolean', default: false })
  
  // 保存未检测到人脸的帧
  .option('saveNoFaceFrames', { type: 'boolean', default: false })
  .option('noFaceFramesDir', { type: 'string', default: './no_face_frames' })
  .option('saveEveryNFrames', { type: 'number', default: 1, description: '每N帧保存一次（避免保存过多）' })
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

// 使用原始视频尺寸进行检测，不进行降采样
const DW = W;
const DH = H;
const SCALE_X = 1.0;
const SCALE_Y = 1.0;

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

// 创建输出目录
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.error(`[SAVE] 创建目录: ${dirPath}`);
  }
}

// 将YUV帧保存为PNG图片
function saveYUVFrameAsPNG(yPlane, uPlane, vPlane, width, height, outputPath) {
  return new Promise((resolve, reject) => {
    // 使用ffmpeg将YUV420P转换为PNG
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'rawvideo',
      '-pixel_format', 'yuv420p',
      '-video_size', `${width}x${height}`,
      '-framerate', '1',
      '-i', 'pipe:0',
      '-frames:v', '1',
      '-y',
      outputPath
    ], { stdio: ['pipe', 'ignore', 'pipe'] });

    // 将YUV数据写入ffmpeg
    const yuvBuffer = Buffer.concat([
      Buffer.from(yPlane),
      Buffer.from(uPlane),
      Buffer.from(vPlane)
    ]);
    
    ffmpeg.stdin.write(yuvBuffer);
    ffmpeg.stdin.end();

    let errorOutput = '';
    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg failed with code ${code}: ${errorOutput}`));
      }
    });

    ffmpeg.on('error', (err) => {
      reject(err);
    });
  });
}

// ---- 贝塞尔辅助：三次贝塞尔采样 ----
function cubicBezier(p0, p1, p2, p3, t) {
  const it = 1 - t;
  const it2 = it * it;
  const t2 = t * t;
  const a = it2 * it;      // (1-t)^3
  const b = 3 * it2 * t;   // 3(1-t)^2 t
  const c = 3 * it * t2;   // 3(1-t) t^2
  const d = t * t2;        // t^3
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

// ---- 形状构造：与前端 drawLiquidMask 完全一致（局部坐标，原点在鼻尖，已旋转前）----
function buildLiquidMaskPolyline(maskW, maskH, samplesPerCurve) {
  // 前端路径：
  // moveTo(-maskW/2, -maskH*0.2)
  // bezierCurveTo(-maskW*0.4, -maskH*0.6,  maskW*0.4, -maskH*0.6,  maskW/2, -maskH*0.2)
  // lineTo(maskW/2, -maskH*0.05)
  // bezierCurveTo( maskW*0.4,  maskH*0.05, -maskW*0.4,  maskH*0.05, -maskW/2, -maskH*0.01)
  // closePath()

  const P0 = { x: -maskW / 2, y: -maskH * 0.2 };
  const C1 = { x: -maskW * 0.4, y: -maskH * 0.6 };
  const C2 = { x:  maskW * 0.4, y: -maskH * 0.6 };
  const P3 = { x:  maskW / 2,   y: -maskH * 0.2 };

  const L1 = { x:  maskW / 2,   y: -maskH * 0.05 };

  const C3 = { x:  maskW * 0.4, y:  maskH * 0.05 };
  const C4 = { x: -maskW * 0.4, y:  maskH * 0.05 };
  const P7 = { x: -maskW / 2,   y: -maskH * 0.01 };

  const pts = [];

  // Segment 1: P0 -> P3 (cubic)
  for (let i = 0; i <= samplesPerCurve; i++) {
    const t = i / samplesPerCurve;
    pts.push(cubicBezier(P0, C1, C2, P3, t));
  }

  // Segment 2: line P3 -> L1
  const LINE_SAMPLES = 2;
  for (let i = 1; i <= LINE_SAMPLES; i++) {
    const t = i / LINE_SAMPLES;
    pts.push({
      x: P3.x + t * (L1.x - P3.x),
      y: P3.y + t * (L1.y - P3.y),
    });
  }

  // Segment 3: L1 -> P7 (cubic)
  for (let i = 1; i <= samplesPerCurve; i++) {
    const t = i / samplesPerCurve;
    pts.push(cubicBezier(L1, C3, C4, P7, t));
  }

  // closePath: P7 -> P0
  const CLOSE_SAMPLES = 2;
  for (let i = 1; i <= CLOSE_SAMPLES; i++) {
    const t = i / CLOSE_SAMPLES;
    pts.push({
      x: P7.x + t * (P0.x - P7.x),
      y: P7.y + t * (P0.y - P7.y),
    });
  }

  return pts;
}

// 旋转 + 平移到图像坐标（以鼻尖为中心、按脸角旋转）
// ★ 与 Canvas 2D 的 rotate(angle) 完全一致：
//   x' = x * cosθ - y * sinθ
//   y' = x * sinθ + y * cosθ
function transformPolyline(points, cx, cy, angle) {
  const cosT = Math.cos(angle), sinT = Math.sin(angle);
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const { x, y } = points[i];
    const xr =  x * cosT - y * sinT;
    const yr =  x * sinT + y * cosT;
    out[i] = { x: xr + cx, y: yr + cy };
    // out[i] = { x: xr + cx, y: cy - yr };
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

// ---------------- 原始尺寸处理 ----------------
const RGB_BUF = new Float32Array(W * H * 3); // 原始尺寸的RGB缓冲区

function yPlaneToRGB(sY) {
  // 直接将Y平面转换为RGB格式，不进行降采样
  for (let i = 0, j = 0; i < W * H; i++) {
    const yv = sY[i];
    RGB_BUF[j++] = yv;
    RGB_BUF[j++] = yv;
    RGB_BUF[j++] = yv;
  }
  return RGB_BUF;
}

// ---------------- 扫描线填充（Y） ----------------
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
    // 插入排序
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
      // 填充为“黑色”：Y=0
      bufY.fill(0, y * width + x0, y * width + x1 + 1);
    }
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
      // YUV 的“黑/白”都用中性色度：U=V=128
      bufU.fill(128, y * width2 + x0, y * width2 + x1 + 1);
      bufV.fill(128, y * width2 + x0, y * width2 + x1 + 1);
    }
  }
}

// “白色描边”：将边缘 Y 写为 255，U/V 写为 128
function strokePolylineYUV(bufY, bufU, bufV, points, thickness, width, height) {
  if (points.length < 2 || thickness <= 0) return;
  const r = Math.max(1, thickness / 2), r2 = r * r;

  const writeUV = (x, y) => {
    const x2 = (x >> 1);
    const y2 = (y >> 1);
    if (x2 >= 0 && x2 < W2 && y2 >= 0 && y2 < H2) {
      bufU[y2 * W2 + x2] = 128;
      bufV[y2 * W2 + x2] = 128;
    }
  };

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
          bufY[y * width + x] = 255; // 白色描边（亮度）
          writeUV(x, y);             // 色度中性
        }
      }
    }
  };

  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    drawSeg(a.x, a.y, b.x, b.y);
  }
}

// 从历史缓冲区获取最近的人脸位置
function getLatestFaceFromHistory(faceHistoryBuffer) {
  // 从最新的帧开始查找
  for (let i = faceHistoryBuffer.length - 1; i >= 0; i--) {
    const historyFrame = faceHistoryBuffer[i];
    if (historyFrame && historyFrame.faceData) {
      return historyFrame.faceData;
    }
  }
  return null;
}

// 更新人脸历史缓冲区
function updateFaceHistory(faceHistoryBuffer, frameCount, faceData, maxHistoryFrames = 5) {
  // 添加当前帧的人脸数据
  const historyEntry = {
    frameNumber: frameCount,
    faceData: faceData
  };
  
  // 如果faceData存在，添加frameNumber到faceData中
  if (faceData) {
    faceData.frameNumber = frameCount;
  }
  
  faceHistoryBuffer.push(historyEntry);
  
  // 保持缓冲区大小不超过maxHistoryFrames
  if (faceHistoryBuffer.length > maxHistoryFrames) {
    faceHistoryBuffer.shift();
  }
}

// ---------------- 主逻辑 ----------------
(async () => {
  const modelPath = path.resolve(__dirname, 'models/movenet-tfjs-singlepose-lightning-v4/model.json');
  // console.error(`[processor] 使用本地模型: ${modelPath}`);
  
  const detector = await poseDetection.createDetector(
    poseDetection.SupportedModels.MoveNet,
    {
      modelType: poseDetection.movenet.modelType[argv.modelType],
      enableSmoothing: argv.enableSmoothing,
      enableSegmentation: false,
      maxPoses: argv.maxDetections,
      modelUrl: `file://${modelPath}`
    }
  );

  // 预热
  {
    const warm = tf.zeros([H, W, 3], 'float32');
    await detector.estimatePoses(warm, { maxPoses: argv.maxDetections, flipHorizontal: !!argv.flipHorizontal });
    warm.dispose();
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  try { stdout._handle && stdout._handle.setBlocking && stdout._handle.setBlocking(true); } catch {}

  let pending = Buffer.alloc(0);
  let frameCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;
  
  // 人脸位置历史缓冲区，存储最近5帧的人脸检测结果
  const faceHistoryBuffer = [];
  const MAX_HISTORY_FRAMES = 5;
  
  // 初始化保存未检测到人脸帧的功能
  if (argv.saveNoFaceFrames) {
    ensureDir(argv.noFaceFramesDir);
    console.error(`[SAVE] 启用保存未检测到人脸的帧到目录: ${argv.noFaceFramesDir}`);
  }

  const showProgress = () => {
    if (!argv.showProgress) return;
    const now = Date.now();
    if (now - lastProgressTime >= 1000) {
      const elapsed = (now - startTime) / 1000;
      process.stderr.write(`\r处理进度: ${frameCount} 帧 | 已用时间: ${elapsed.toFixed(1)}s`);
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

        const yPlane = frame.subarray(0, FRAME_Y);
        const uPlane = frame.subarray(FRAME_Y, FRAME_Y + FRAME_U);
        const vPlane = frame.subarray(FRAME_Y + FRAME_U, FRAME_SIZE);

        // 每帧都进行检测
        // console.error(`[FRAME ${frameCount}] 开始检测...`);
        const rgbData = yPlaneToRGB(yPlane);
        const img = tf.tensor3d(rgbData, [H, W, 3], 'float32');
        
        let poses = [];
        try {
          poses = await detector.estimatePoses(img, {
            flipHorizontal: !!argv.flipHorizontal,
            maxPoses: argv.maxDetections,
            scoreThreshold: argv.scoreThreshold
          });
          poses = poses || [];
          // console.error(`[FRAME ${frameCount}] 检测到 ${poses.length} 个人体姿态`);
        } finally {
          img.dispose();
        }

        // 渲染到 Y/UV
        let masksDrawn = 0;
        let currentFrameFaceData = null;
        
        // 处理当前帧检测到的人脸
        for (let pi = 0; pi < poses.length; pi++) {
          const pose = poses[pi];
          if (!pose || pose.score < argv.minPoseConfidence) {
            // console.error(`[FRAME ${frameCount}] 姿态 ${pi + 1}: 置信度不足 (${pose?.score || 0} < ${argv.minPoseConfidence})`);
            continue;
          }

          const nose = getKP(pose.keypoints, 'nose');
          const le = getKP(pose.keypoints, 'left_ear');
          const re = getKP(pose.keypoints, 'right_ear');
          
          if (!(nose && le && re)) {
            // console.error(`[FRAME ${frameCount}] 姿态 ${pi + 1}: 缺少关键点 (nose: ${!!nose}, left_ear: ${!!le}, right_ear: ${!!re})`);
            continue;
          }
          
          if (le.score < argv.scoreThreshold || re.score < argv.scoreThreshold) {
            // console.error(`[FRAME ${frameCount}] 姿态 ${pi + 1}: 耳朵置信度不足 (left: ${le.score}, right: ${re.score} < ${argv.scoreThreshold})`);
            continue;
          }

          const lx = le.x, ly = le.y;
          const rx = re.x, ry = re.y;
          const nx = nose.x, ny = nose.y;

          // 修正角度计算：atan2(左耳.y - 右耳.y, 左耳.x - 右耳.x) 确保面具倾斜方向与人脸方向一致
          const faceAngle = Math.atan2(ly - ry, lx - rx);
          // 耳距 = faceWidth
          const faceWidth = Math.hypot(rx - lx, ry - ly);

          // 面具尺寸
          const maskW = argv.maskScaleW * faceWidth;
          const maskH = argv.maskScaleH * faceWidth;

          const cx = clamp(nx, 0, W - 1);
          const cy = clamp(ny, 0, H - 1);

          // console.error(`[FRAME ${frameCount}] 姿态 ${pi + 1}: 绘制面具 - 鼻尖(${nx.toFixed(1)}, ${ny.toFixed(1)}), 耳距: ${faceWidth.toFixed(1)}, 角度: ${(faceAngle * 180 / Math.PI).toFixed(1)}°, 面具尺寸: ${maskW.toFixed(1)}x${maskH.toFixed(1)}`);

          // 生成并放置多边形：已按 Canvas 旋转公式，方向与前端一致（竖直翻转已修正）
          const localPoly = buildLiquidMaskPolyline(maskW, maskH, Math.max(16, argv.samplesPerCurve));
          const poly = transformPolyline(localPoly, cx, cy, faceAngle);

          if (poly.length < 3) {
            // console.error(`[FRAME ${frameCount}] 姿态 ${pi + 1}: 多边形点数不足 (${poly.length} < 3)`);
            continue;
          }

          // 先填充黑，再描边白
          fillPolygonY(yPlane, poly, W, H);
          fillPolygonUV(uPlane, vPlane, poly, W2, H2);

          if (argv.strokeWidth > 0) {
            strokePolylineYUV(yPlane, uPlane, vPlane, poly, argv.strokeWidth, W, H);
          }

          masksDrawn++;
          // console.error(`[FRAME ${frameCount}] 姿态 ${pi + 1}: 面具绘制完成`);
          
          // 保存当前帧的人脸数据到历史缓冲区
          if (pi === 0) { // 只保存第一个有效的人脸数据
            currentFrameFaceData = {
              nose: { x: nx, y: ny },
              leftEar: { x: lx, y: ly },
              rightEar: { x: rx, y: ry },
              faceAngle: faceAngle,
              faceWidth: faceWidth,
              maskW: maskW,
              maskH: maskH
            };
          }
        }
        
        // 如果当前帧未检测到人脸，尝试使用历史数据
        if (masksDrawn === 0) {
          const historyFaceData = getLatestFaceFromHistory(faceHistoryBuffer);
          if (historyFaceData) {
            // console.error(`[FRAME ${frameCount}] 未检测到人脸，使用历史数据绘制面具 - 来自帧 ${historyFaceData.frameNumber || '未知'}`);
            
            const { nose, leftEar, rightEar, faceAngle, faceWidth, maskW, maskH } = historyFaceData;
            const cx = clamp(nose.x, 0, W - 1);
            const cy = clamp(nose.y, 0, H - 1);

            // 生成并放置多边形
            const localPoly = buildLiquidMaskPolyline(maskW, maskH, Math.max(16, argv.samplesPerCurve));
            const poly = transformPolyline(localPoly, cx, cy, faceAngle);

            if (poly.length >= 3) {
              // 先填充黑，再描边白
              fillPolygonY(yPlane, poly, W, H);
              fillPolygonUV(uPlane, vPlane, poly, W2, H2);

              if (argv.strokeWidth > 0) {
                strokePolylineYUV(yPlane, uPlane, vPlane, poly, argv.strokeWidth, W, H);
              }

              masksDrawn++;
              // console.error(`[FRAME ${frameCount}] 使用历史数据绘制面具完成`);
            } else {
              // console.error(`[FRAME ${frameCount}] 历史数据多边形点数不足 (${poly.length} < 3)`);
            }
          } else {
            // console.error(`[FRAME ${frameCount}] 未检测到人脸且无历史数据可用`);
          }
        }
        
        // 更新人脸历史缓冲区
        updateFaceHistory(faceHistoryBuffer, frameCount, currentFrameFaceData, MAX_HISTORY_FRAMES);
        
        // console.error(`[FRAME ${frameCount}] 处理完成 - 检测到 ${poses.length} 个姿态，绘制了 ${masksDrawn} 个面具`);

        // 如果启用了保存功能且未检测到人脸，保存当前帧
        if (argv.saveNoFaceFrames && masksDrawn === 0 && (frameCount % argv.saveEveryNFrames === 0)) {
          try {
            const outputPath = path.join(argv.noFaceFramesDir, `frame_${frameCount.toString().padStart(6, '0')}.png`);
            await saveYUVFrameAsPNG(yPlane, uPlane, vPlane, W, H, outputPath);
            console.error(`[SAVE] 保存未检测到人脸的帧: ${outputPath}`);
          } catch (error) {
            console.error(`[SAVE] 保存帧失败: ${error.message}`);
          }
        }

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
