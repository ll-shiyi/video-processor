#!/usr/bin/env node
/* processor_direct.js — 直接视频处理版本，完全参照Pose.jsx逻辑
 * 不使用YUV优化，直接读取视频，逐帧传递给PoseNet检测，然后打码输出
 * 确保处理效果与前端Pose.jsx完全一致
 */

process.env.TF_CPP_MIN_LOG_LEVEL = '2';
process.env.TENSORFLOW_NUM_INTRAOP_THREADS = process.env.TENSORFLOW_NUM_INTRAOP_THREADS || '4';
process.env.TENSORFLOW_NUM_INTEROP_THREADS = process.env.TENSORFLOW_NUM_INTEROP_THREADS || '2';
process.env.NODE_NO_WARNINGS = '1';
if (!process.argv.includes('--no-deprecation')) {
  process.argv.unshift('--no-deprecation');
}

const tf = require('@tensorflow/tfjs-node');
const posenet = require('@tensorflow-models/posenet');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs');
const path = require('path');

const argv = yargs(hideBin(process.argv))
  .option('width', { type: 'number', demandOption: true })
  .option('height', { type: 'number', demandOption: true })
  .option('fps', { type: 'number', default: 25 })

  // —— 与前端Pose.jsx完全一致的参数 ——
  .option('maskScaleW', { type: 'number', default: 1.3 }) // faceWidth * 1.3
  .option('maskScaleH', { type: 'number', default: 1.8 }) // faceWidth * 1.8
  .option('strokeWidth', { type: 'number', default: 2 })

  // —— 检测参数（与前端Pose.jsx一致）——
  .option('detectEvery', { type: 'number', default: 1 }) // 每帧都检测，确保与前端一致
  .option('adaptiveSkip', { type: 'boolean', default: false }) // 关闭自适应跳过
  .option('flipHorizontal', { type: 'boolean', default: true })       // 前端：true
  .option('scoreThreshold', { type: 'number', default: 0.1 })         // 前端：0.1
  .option('maxDetections', { type: 'number', default: 5 })            // 前端：5
  .option('nmsRadius', { type: 'number', default: 30 })               // 前端：30
  .option('minPoseConfidence', { type: 'number', default: 0.15 })     // 前端：0.15

  // —— PoseNet模型参数（与前端Pose.jsx一致）——
  .option('quantBytes', { type: 'number', default: 2 })
  .option('multiplier', { type: 'number', default: 0.75 })
  .option('outputStride', { type: 'number', default: 16 })
  .option('inputResolution', { type: 'number', default: 500 })

  .option('showProgress', { type: 'boolean', default: false })
  .option('saveNoFaceFrames', { type: 'boolean', default: false })
  .option('noFaceDir', { type: 'string', default: 'no_face_frames' })
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

// ---------------- 工具函数 ----------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 确保目录存在
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// YUV420P到RGB转换并保存为PNG
function saveYUVFrameAsPNG(yPlane, uPlane, vPlane, width, height, filename) {
  try {
    const { createCanvas, createImageData } = require('canvas');
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const imageData = createImageData(width, height);
    const data = imageData.data;
    
    const w2 = width >> 1;
    const h2 = height >> 1;
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const yIndex = y * width + x;
        const uvIndex = Math.floor(y / 2) * w2 + Math.floor(x / 2);
        
        const Y = yPlane[yIndex];
        const U = uPlane[uvIndex] - 128;
        const V = vPlane[uvIndex] - 128;
        
        // YUV to RGB conversion
        const R = Math.max(0, Math.min(255, Y + 1.402 * V));
        const G = Math.max(0, Math.min(255, Y - 0.344136 * U - 0.714136 * V));
        const B = Math.max(0, Math.min(255, Y + 1.772 * U));
        
        const pixelIndex = yIndex * 4;
        data[pixelIndex] = R;     // Red
        data[pixelIndex + 1] = G; // Green
        data[pixelIndex + 2] = B; // Blue
        data[pixelIndex + 3] = 255; // Alpha
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(filename, buffer);
    
    return true;
  } catch (error) {
    console.error(`[SAVE] 保存帧失败: ${error.message}`);
    return false;
  }
}

// 与前端Pose.jsx完全一致的drawLiquidMask函数
function drawLiquidMask(context, nosePosition, faceWidth, angle) {
  context.save();
  context.translate(nosePosition.x, nosePosition.y);
  context.rotate(angle);
  
  // 设置面具的大小（与前端一致）
  const maskWidth = faceWidth * argv.maskScaleW;  // faceWidth * 1.3
  const maskHeight = faceWidth * argv.maskScaleH; // faceWidth * 1.8
  
  context.beginPath();
  context.fillStyle = 'black'; // 不透明黑色
  context.strokeStyle = 'white'; // 不透明白色边框
  context.lineWidth = argv.strokeWidth;
  
  // 绘制流动的曲线边缘（修正Y轴翻转问题）
  context.moveTo(-maskWidth / 2, maskHeight * 0.2);
  context.bezierCurveTo(
    -maskWidth * 0.4, maskHeight * 0.6,
    maskWidth * 0.4, maskHeight * 0.6,
    maskWidth / 2, maskHeight * 0.2
  );
  context.lineTo(maskWidth / 2, maskHeight * 0.05);
  context.bezierCurveTo(
    maskWidth * 0.4, -maskHeight * 0.05,
    -maskWidth * 0.4, -maskHeight * 0.05,
    -maskWidth / 2, maskHeight * 0.01
  );
  context.closePath();
  context.fill();
  context.stroke();
  
  context.restore();
}

// 取关键点（兼容 PoseNet 命名）
function getKP(map, want) {
  const norm = s => (s || '').toString().replace(/_/g, '').toLowerCase();
  const target = norm(want);
  for (let i = 0; i < map.length; i++) {
    const k = map[i];
    const nm = norm(k.name || k.part);
    if (nm === target) {
      const x = (k.x != null) ? k.x : (k.position && k.position.x);
      const y = (k.y != null) ? k.y : (k.position && k.position.y);
      const score = k.score != null ? k.score : 1;
      if (x != null && y != null) return { x, y, score };
      return null;
    }
  }
  return null;
}

// ---------------- 扫描线填充 ----------------
const XS_BUF = new Float32Array(64);
function fillPolygonY(bufY, points, width, height) {
  const n = points.length; if (n < 3) return;
  let minY = height - 1, maxY = 0;
  for (let i = 0; i < n; i++) {
    const y = clamp((points[i].y + 0.5) | 0, 0, height - 1);
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5; let k = 0;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[(i + 1) % n];
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
      x0 = clamp(x0, 0, width - 1); x1 = clamp(x1, 0, width - 1);
      bufY.fill(0, y * width + x0, y * width + x1 + 1); // 黑色填充
    }
  }
}

function fillPolygonUV(bufU, bufV, points, width2, height2) {
  if (points.length < 3) return;
  const pts = points.map(p => ({ x: p.x * 0.5, y: p.y * 0.5 }));
  const n = pts.length;
  let minY = height2 - 1, maxY = 0;
  for (let i = 0; i < n; i++) {
    const y = clamp((pts[i].y + 0.5) | 0, 0, height2 - 1);
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  for (let y = minY; y <= maxY; y++) {
    const scanY = y + 0.5; let k = 0;
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
      x0 = clamp(x0, 0, width2 - 1); x1 = clamp(x1, 0, width2 - 1);
      bufU.fill(128, y * width2 + x0, y * width2 + x1 + 1);
      bufV.fill(128, y * width2 + x0, y * width2 + x1 + 1);
    }
  }
}

// 将Canvas绘制的面具应用到YUV平面
function applyCanvasMaskToYUV(yPlane, uPlane, vPlane, canvas, width, height) {
  const imageData = canvas.getContext('2d').getImageData(0, 0, width, height);
  const data = imageData.data;
  
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    
    // 如果是黑色区域（面具），则填充到Y平面
    if (r === 0 && g === 0 && b === 0) {
      yPlane[i] = 0; // 黑色
    }
  }
  
  // 处理UV平面
  for (let y = 0; y < height / 2; y++) {
    for (let x = 0; x < width / 2; x++) {
      const srcX = x * 2;
      const srcY = y * 2;
      const srcIndex = srcY * width + srcX;
      const uvIndex = y * (width / 2) + x;
      
      const r = data[srcIndex * 4];
      const g = data[srcIndex * 4 + 1];
      const b = data[srcIndex * 4 + 2];
      
      if (r === 0 && g === 0 && b === 0) {
        uPlane[uvIndex] = 128; // 中性色
        vPlane[uvIndex] = 128; // 中性色
      }
    }
  }
}

// ---------------- 主逻辑 ----------------
(async () => {
  // PoseNet：与前端Pose.jsx完全一致的配置
  const net = await posenet.load({
    architecture: 'MobileNetV1',
    outputStride: argv.outputStride,
    inputResolution: argv.inputResolution,
    multiplier: argv.multiplier,
    quantBytes: argv.quantBytes
  });

  // 预热（与前端参数一致）
  {
    const warm = tf.zeros([H, W, 3], 'float32');
    await net.estimatePoses(warm, {
      flipHorizontal: !!argv.flipHorizontal,
      decodingMethod: 'multi-person',
      maxDetections: argv.maxDetections,
      scoreThreshold: argv.scoreThreshold,
      nmsRadius: argv.nmsRadius
    });
    warm.dispose();
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  try { stdout._handle && stdout._handle.setBlocking && stdout._handle.setBlocking(true); } catch {}

  let pending = Buffer.alloc(0);
  let frameCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;

  let lastPoses = [];

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

        // 每帧都进行检测（与前端一致）
        let doDetect = argv.detectEvery === 1 || (frameCount % argv.detectEvery) === 1;
        
        // 添加调试信息
        if (frameCount <= 10) {
          process.stderr.write(`\n[DEBUG] 帧 ${frameCount}: doDetect=${doDetect}, detectEvery=${argv.detectEvery}\n`);
        }

        if (doDetect) {
          // 将YUV转换为RGB（正确的YUV420P到RGB转换）
          const rgbData = new Float32Array(W * H * 3);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const yIndex = y * W + x;
              const uvIndex = Math.floor(y / 2) * W2 + Math.floor(x / 2);
              
              const Y = yPlane[yIndex];
              const U = uPlane[uvIndex] - 128;
              const V = vPlane[uvIndex] - 128;
              
              // YUV to RGB conversion
              const R = Math.max(0, Math.min(255, Y + 1.402 * V));
              const G = Math.max(0, Math.min(255, Y - 0.344136 * U - 0.714136 * V));
              const B = Math.max(0, Math.min(255, Y + 1.772 * U));
              
              const rgbIndex = yIndex * 3;
              rgbData[rgbIndex] = R;
              rgbData[rgbIndex + 1] = G;
              rgbData[rgbIndex + 2] = B;
            }
          }
          
          const img = tf.tensor3d(rgbData, [H, W, 3], 'float32');
          try {
            const poses = await net.estimatePoses(img, {
              flipHorizontal: !!argv.flipHorizontal,           // 前端：true
              decodingMethod: 'multi-person',                  // 多人检测模式
              maxDetections: argv.maxDetections,               // 前端：5
              scoreThreshold: argv.scoreThreshold,             // 前端：0.1
              nmsRadius: argv.nmsRadius                        // 前端：30
            });

            // 统一结构，直接使用原始坐标（与前端一致）
            lastPoses = (poses || []).map(p => ({
              score: p.score ?? 1,
              keypoints: p.keypoints.map(k => ({
                name: k.part,
                x: Math.max(0, Math.min(W - 1, k.position.x)),
                y: Math.max(0, Math.min(H - 1, k.position.y)),
                score: k.score
              }))
            }));
            
            // 添加调试信息
            if (frameCount <= 10) {
              process.stderr.write(`[DEBUG] 检测到 ${lastPoses.length} 个姿态\n`);
              lastPoses.forEach((pose, i) => {
                const nose = pose.keypoints.find(kp => kp.name === 'nose');
                const leftEar = pose.keypoints.find(kp => kp.name === 'leftEar');
                const rightEar = pose.keypoints.find(kp => kp.name === 'rightEar');
                process.stderr.write(`[DEBUG] 姿态 ${i}: score=${pose.score.toFixed(3)}, nose=${nose ? 'yes' : 'no'}, ears=${leftEar && rightEar ? 'yes' : 'no'}\n`);
              });
            }
            
            // 检查是否有有效的人脸（鼻子+双耳）
            const hasValidFace = lastPoses.some(pose => {
              if (!pose || pose.score < argv.minPoseConfidence) return false;
              const keypoints = pose.keypoints;
              const nose = keypoints.find(kp => kp.name === 'nose');
              const leftEar = keypoints.find(kp => kp.name === 'leftEar');
              const rightEar = keypoints.find(kp => kp.name === 'rightEar');
              return nose && leftEar && rightEar;
            });
            
            // 如果没有检测到有效人脸且启用了保存功能，则保存帧
            if (!hasValidFace && argv.saveNoFaceFrames) {
              ensureDir(argv.noFaceDir);
              const filename = path.join(argv.noFaceDir, `frame_${frameCount.toString().padStart(6, '0')}.png`);
              const saved = saveYUVFrameAsPNG(yPlane, uPlane, vPlane, W, H, filename);
              if (saved) {
                process.stderr.write(`\n[SAVE] 保存无脸帧: ${filename}\n`);
              }
            }
          } finally { img.dispose(); }
        }

        // 叠加遮挡（与前端Pose.jsx逻辑完全一致）
        const poses = lastPoses;
        let masksApplied = 0;
        
        for (let pi = 0; pi < poses.length; pi++) {
          const pose = poses[pi];
          if (!pose || pose.score < argv.minPoseConfidence) {
            if (frameCount <= 10) {
              process.stderr.write(`[DEBUG] 姿态 ${pi} 被跳过: score=${pose?.score?.toFixed(3) || 'null'} < ${argv.minPoseConfidence}\n`);
            }
            continue;
          }

          // 获取关键点（与前端一致）
          const keypoints = pose.keypoints;
          const nose = keypoints.find(kp => kp.name === 'nose');
          const leftEar = keypoints.find(kp => kp.name === 'leftEar');
          const rightEar = keypoints.find(kp => kp.name === 'rightEar');
          
          if (nose && leftEar && rightEar) {
            masksApplied++;
            if (frameCount <= 10) {
              process.stderr.write(`[DEBUG] 应用面具 ${masksApplied}: nose=(${nose.x.toFixed(1)},${nose.y.toFixed(1)}), faceWidth=${Math.sqrt(Math.pow(rightEar.x - leftEar.x, 2) + Math.pow(rightEar.y - leftEar.y, 2)).toFixed(1)}\n`);
            }
            // 计算人脸旋转角度（与前端一致）
            const faceAngle = Math.atan2(
              rightEar.y - leftEar.y,
              rightEar.x - leftEar.x
            );
            
            // 计算人脸宽度（与前端一致）
            const faceWidth = Math.sqrt(
              Math.pow(rightEar.x - leftEar.x, 2) +
              Math.pow(rightEar.y - leftEar.y, 2)
            );
            
            // 鼻子位置（与前端一致）
            const nosePosition = { x: nose.x, y: nose.y };
            
            // 创建临时canvas来绘制面具
            const canvas = require('canvas').createCanvas(W, H);
            const ctx = canvas.getContext('2d');
            
            // 填充白色背景
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, W, H);
            
            // 绘制流动边缘的面具（与前端完全一致）
            drawLiquidMask(ctx, nosePosition, faceWidth, faceAngle);
            
            // 将canvas面具应用到YUV平面
            applyCanvasMaskToYUV(yPlane, uPlane, vPlane, canvas, W, H);
          } else {
            if (frameCount <= 10) {
              process.stderr.write(`[DEBUG] 姿态 ${pi} 缺少关键点: nose=${nose ? 'yes' : 'no'}, leftEar=${leftEar ? 'yes' : 'no'}, rightEar=${rightEar ? 'yes' : 'no'}\n`);
            }
          }
        }
        
        if (frameCount <= 10) {
          process.stderr.write(`[DEBUG] 帧 ${frameCount} 总结: 检测到${poses.length}个姿态, 应用了${masksApplied}个面具\n`);
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
