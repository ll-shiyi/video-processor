#!/usr/bin/env node
/* processor_optimized.js — 高性能优化版本
 * 主要优化：
 * 1. 智能帧跳过策略 - 基于运动检测和置信度
 * 2. 优化的模型参数 - 平衡速度和质量
 * 3. 内存池和对象复用 - 减少GC压力
 * 4. 并行处理优化 - 异步处理非关键路径
 * 5. 缓存和预测 - 利用时间连续性
 */

process.env.TF_CPP_MIN_LOG_LEVEL = '2';
process.env.TENSORFLOW_NUM_INTRAOP_THREADS = process.env.TENSORFLOW_NUM_INTRAOP_THREADS || '6';
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

  // —— 优化参数 ——
  .option('maskScaleW', { type: 'number', default: 1.3 })
  .option('maskScaleH', { type: 'number', default: 1.8 })
  .option('strokeWidth', { type: 'number', default: 2 })

  // —— 智能检测参数 ——
  .option('detectEvery', { type: 'number', default: 2 }) // 默认每2帧检测一次，提高检测率
  .option('adaptiveSkip', { type: 'boolean', default: true }) // 启用自适应跳过
  .option('motionThreshold', { type: 'number', default: 0.05 }) // 降低运动检测阈值，提高敏感度
  .option('confidenceDecay', { type: 'number', default: 0.98 }) // 提高置信度衰减因子，保持更长时间
  .option('maxSkipFrames', { type: 'number', default: 3 }) // 减少最大跳过帧数，提高检测率
  .option('flipHorizontal', { type: 'boolean', default: false })
  .option('scoreThreshold', { type: 'number', default: 0.05 }) // 降低检测阈值，提高敏感度
  .option('maxDetections', { type: 'number', default: 5 }) // 增加最大检测数量
  .option('nmsRadius', { type: 'number', default: 20 }) // 减少NMS半径，提高检测精度
  .option('minPoseConfidence', { type: 'number', default: 0.1 }) // 降低最小姿态置信度

  // —— 平衡的模型参数 ——
  .option('quantBytes', { type: 'number', default: 2 }) // 使用2字节量化，平衡速度和质量
  .option('multiplier', { type: 'number', default: 0.75 }) // 使用中等乘数，提高检测精度
  .option('outputStride', { type: 'number', default: 16 }) // 使用中等步长，提高检测精度
  .option('inputResolution', { type: 'number', default: 513 }) // 使用中等分辨率，提高检测精度

  .option('showProgress', { type: 'boolean', default: false })
  .option('saveNoFaceFrames', { type: 'boolean', default: false })
  .option('noFaceDir', { type: 'string', default: 'no_face_frames' })
  .option('enableMemoryPool', { type: 'boolean', default: true }) // 启用内存池
  .option('enablePrediction', { type: 'boolean', default: true }) // 启用预测
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

// ---------------- 内存池和缓存 ----------------
class MemoryPool {
  constructor() {
    this.rgbBuffer = new Float32Array(W * H * 3);
    this.tempBuffers = [];
    this.canvasPool = [];
    this.poseHistory = [];
    this.maxHistorySize = 10;
  }

  getTempBuffer(size) {
    if (this.tempBuffers.length > 0) {
      return this.tempBuffers.pop();
    }
    return new Float32Array(size);
  }

  returnTempBuffer(buffer) {
    if (this.tempBuffers.length < 5) { // 限制池大小
      this.tempBuffers.push(buffer);
    }
  }

  getCanvas() {
    if (this.canvasPool.length > 0) {
      return this.canvasPool.pop();
    }
    const { createCanvas } = require('canvas');
    return createCanvas(W, H);
  }

  returnCanvas(canvas) {
    if (this.canvasPool.length < 3) { // 限制池大小
      this.canvasPool.push(canvas);
    }
  }

  addPoseHistory(poses, frameCount) {
    this.poseHistory.push({ poses, frameCount, timestamp: Date.now() });
    if (this.poseHistory.length > this.maxHistorySize) {
      this.poseHistory.shift();
    }
  }

  getPredictedPoses(currentFrameCount) {
    if (this.poseHistory.length < 2) return null;
    
    const last = this.poseHistory[this.poseHistory.length - 1];
    const prev = this.poseHistory[this.poseHistory.length - 2];
    
    // 简单的线性预测
    const frameDiff = currentFrameCount - last.frameCount;
    if (frameDiff > 0 && frameDiff <= argv.maxSkipFrames) {
      return last.poses.map(pose => ({
        ...pose,
        keypoints: pose.keypoints.map(kp => ({
          ...kp,
          x: kp.x + (kp.x - prev.poses[0]?.keypoints.find(p => p.name === kp.name)?.x || 0) * frameDiff,
          y: kp.y + (kp.y - prev.poses[0]?.keypoints.find(p => p.name === kp.name)?.y || 0) * frameDiff,
          score: kp.score * Math.pow(argv.confidenceDecay, frameDiff)
        }))
      }));
    }
    return null;
  }
}

// ---------------- 运动检测 ----------------
class MotionDetector {
  constructor() {
    this.prevFrame = null;
    this.motionThreshold = argv.motionThreshold;
  }

  detectMotion(currentFrame) {
    if (!this.prevFrame) {
      this.prevFrame = new Uint8Array(currentFrame.length);
      currentFrame.copy(this.prevFrame);
      return true; // 第一帧总是检测
    }

    let motion = 0;
    const sampleRate = 4; // 每4个像素采样一次，提高速度
    
    for (let i = 0; i < currentFrame.length; i += sampleRate) {
      motion += Math.abs(currentFrame[i] - this.prevFrame[i]);
    }
    
    motion /= (currentFrame.length / sampleRate);
    motion /= 255; // 归一化到0-1
    
    currentFrame.copy(this.prevFrame);
    return motion > this.motionThreshold;
  }
}

// ---------------- 工具函数 ----------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// 优化的YUV到RGB转换
function yuvToRgbOptimized(yPlane, uPlane, vPlane, rgbBuffer) {
  const w2 = W >> 1;
  
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const yIndex = y * W + x;
      const uvIndex = (y >> 1) * w2 + (x >> 1);
      
      const Y = yPlane[yIndex];
      const U = uPlane[uvIndex] - 128;
      const V = vPlane[uvIndex] - 128;
      
      // 优化的YUV to RGB conversion
      const R = Math.max(0, Math.min(255, Y + 1.402 * V));
      const G = Math.max(0, Math.min(255, Y - 0.344136 * U - 0.714136 * V));
      const B = Math.max(0, Math.min(255, Y + 1.772 * U));
      
      const rgbIndex = yIndex * 3;
      rgbBuffer[rgbIndex] = R;
      rgbBuffer[rgbIndex + 1] = G;
      rgbBuffer[rgbIndex + 2] = B;
    }
  }
}

// 优化的面具绘制
function drawLiquidMaskOptimized(context, nosePosition, faceWidth, angle) {
  context.save();
  context.translate(nosePosition.x, nosePosition.y);
  context.rotate(angle);
  
  const maskWidth = faceWidth * argv.maskScaleW;
  const maskHeight = faceWidth * argv.maskScaleH;
  
  context.beginPath();
  context.fillStyle = 'black';
  context.strokeStyle = 'white';
  context.lineWidth = argv.strokeWidth;
  
  // 简化的面具形状，减少计算
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

// 优化的面具应用
function applyCanvasMaskToYUVOptimized(yPlane, uPlane, vPlane, canvas, width, height) {
  const imageData = canvas.getContext('2d').getImageData(0, 0, width, height);
  const data = imageData.data;
  
  // 优化：只处理黑色像素
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    if (r === 0) { // 只检查红色通道，黑色像素的r=0
      yPlane[i] = 0;
    }
  }
  
  // 优化UV平面处理
  const w2 = width >> 1;
  const h2 = height >> 1;
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const srcX = x * 2;
      const srcY = y * 2;
      const srcIndex = srcY * width + srcX;
      const uvIndex = y * w2 + x;
      
      const r = data[srcIndex * 4];
      if (r === 0) {
        uPlane[uvIndex] = 128;
        vPlane[uvIndex] = 128;
      }
    }
  }
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

// ---------------- 主逻辑 ----------------
(async () => {
  const modelPath = path.resolve(__dirname, 'models/posenet-model/model-stride16.json');
  
  // 优化的PoseNet配置
  const net = await posenet.load({
    architecture: 'MobileNetV1',
    outputStride: argv.outputStride,
    inputResolution: argv.inputResolution,
    multiplier: argv.multiplier,
    quantBytes: argv.quantBytes,
    modelUrl: `file://${modelPath}`
  });

  // 预热
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

  // 初始化优化组件
  const memoryPool = new MemoryPool();
  const motionDetector = new MotionDetector();

  const stdin = process.stdin;
  const stdout = process.stdout;
  try { stdout._handle && stdout._handle.setBlocking && stdout._handle.setBlocking(true); } catch {}

  let pending = Buffer.alloc(0);
  let frameCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;

  let lastPoses = [];
  let skipCounter = 0;
  let lastDetectionFrame = 0;

  const showProgress = () => {
    if (!argv.showProgress) return;
    const now = Date.now();
    if (now - lastProgressTime >= 1000) {
      const elapsed = (now - startTime) / 1000;
      const detectionRate = ((frameCount - lastDetectionFrame) / Math.max(1, frameCount - lastDetectionFrame)) * 100;
      process.stderr.write(`\r处理进度: ${frameCount} 帧 | 已用时间: ${elapsed.toFixed(1)}s | 检测率: ${detectionRate.toFixed(1)}%`);
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

        // 智能检测决策
        let doDetect = false;
        let usePrediction = false;

        if (argv.adaptiveSkip) {
          // 基于运动检测和帧间隔的智能跳过
          const hasMotion = motionDetector.detectMotion(yPlane);
          const frameSinceLastDetection = frameCount - lastDetectionFrame;
          
          if (hasMotion || frameSinceLastDetection >= argv.detectEvery) {
            doDetect = true;
          } else if (argv.enablePrediction && frameSinceLastDetection <= argv.maxSkipFrames) {
            // 使用预测结果
            const predictedPoses = memoryPool.getPredictedPoses(frameCount);
            if (predictedPoses) {
              lastPoses = predictedPoses;
              usePrediction = true;
            }
          }
        } else {
          // 固定间隔检测
          doDetect = (frameCount % argv.detectEvery) === 1;
        }

        if (doDetect) {
          lastDetectionFrame = frameCount;
          
          // 优化的YUV到RGB转换
          yuvToRgbOptimized(yPlane, uPlane, vPlane, memoryPool.rgbBuffer);
          
          const img = tf.tensor3d(memoryPool.rgbBuffer, [H, W, 3], 'float32');
          try {
            const poses = await net.estimatePoses(img, {
              flipHorizontal: !!argv.flipHorizontal,
              decodingMethod: 'multi-person',
              maxDetections: argv.maxDetections,
              scoreThreshold: argv.scoreThreshold,
              nmsRadius: argv.nmsRadius
            });

            // 统一结构
            lastPoses = (poses || []).map(p => ({
              score: p.score ?? 1,
              keypoints: p.keypoints.map(k => ({
                name: k.part,
                x: Math.max(0, Math.min(W - 1, k.position.x)),
                y: Math.max(0, Math.min(H - 1, k.position.y)),
                score: k.score
              }))
            }));

            // 添加到历史记录
            if (argv.enablePrediction) {
              memoryPool.addPoseHistory(lastPoses, frameCount);
            }
            
            // 检查是否有有效的人脸
            const hasValidFace = lastPoses.some(pose => {
              if (!pose || pose.score < argv.minPoseConfidence) return false;
              const keypoints = pose.keypoints;
              const nose = keypoints.find(kp => kp.name === 'nose');
              const leftEar = keypoints.find(kp => kp.name === 'leftEar');
              const rightEar = keypoints.find(kp => kp.name === 'rightEar');
              return nose && leftEar && rightEar;
            });
            
            if (!hasValidFace && argv.saveNoFaceFrames) {
              ensureDir(argv.noFaceDir);
              const filename = path.join(argv.noFaceDir, `frame_${frameCount.toString().padStart(6, '0')}.png`);
              // 这里可以添加保存逻辑
            }
          } finally { 
            img.dispose(); 
          }
        }

        // 应用面具（使用检测结果或预测结果）
        if (!usePrediction || lastPoses.length > 0) {
          const poses = lastPoses;
          let masksApplied = 0;
          
          for (let pi = 0; pi < poses.length; pi++) {
            const pose = poses[pi];
            if (!pose || pose.score < argv.minPoseConfidence) {
              continue;
            }

            const keypoints = pose.keypoints;
            const nose = keypoints.find(kp => kp.name === 'nose');
            const leftEar = keypoints.find(kp => kp.name === 'leftEar');
            const rightEar = keypoints.find(kp => kp.name === 'rightEar');
            
            if (nose && leftEar && rightEar) {
              masksApplied++;
              
              const faceAngle = Math.atan2(
                rightEar.y - leftEar.y,
                rightEar.x - leftEar.x
              );
              
              const faceWidth = Math.sqrt(
                Math.pow(rightEar.x - leftEar.x, 2) +
                Math.pow(rightEar.y - leftEar.y, 2)
              );
              
              const nosePosition = { x: nose.x, y: nose.y };
              
              // 使用内存池中的Canvas
              const canvas = memoryPool.getCanvas();
              const ctx = canvas.getContext('2d');
              
              // 填充白色背景
              ctx.fillStyle = 'white';
              ctx.fillRect(0, 0, W, H);
              
              // 绘制面具
              drawLiquidMaskOptimized(ctx, nosePosition, faceWidth, faceAngle);
              
              // 应用面具
              applyCanvasMaskToYUVOptimized(yPlane, uPlane, vPlane, canvas, W, H);
              
              // 归还Canvas到池中
              memoryPool.returnCanvas(canvas);
            }
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
    const detectionCount = Math.floor(frameCount / argv.detectEvery);
    const detectionRate = (detectionCount / frameCount) * 100;
    process.stderr.write(`\n处理完成！总帧数: ${frameCount} | 检测帧数: ${detectionCount} | 检测率: ${detectionRate.toFixed(1)}% | 总时间: ${totalTime.toFixed(1)}s | 平均处理速度: ${avgFps.toFixed(1)} fps\n`);
  }
  stdout.end();
})().catch(err => {
  console.error('[processor] fatal:', err && (err.stack || err));
  process.exit(1);
});
