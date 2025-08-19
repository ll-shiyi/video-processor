const { maskEyesWithPoseNetOSS } = require('./video_eye_blur_oss');

/**
 * 性能优化配置级别
 */
const OPTIMIZATION_LEVELS = {
  // 极速模式 - 最大速度，质量较低
  ULTRA_FAST: {
    width: 640,           // 大幅降低分辨率
    height: 360,
    fps: 25,
    mosaic: 10,
    eyeExpand: 0.4,
    minScore: 0.2,
    crf: 32,              // 高压缩率
    detectScale: 0.25,    // 极低检测分辨率
    detectEvery: 8,       // 大幅跳帧
    enableSmoothing: false,
    maxDetections: 2,
    showProgress: false
  },
  
  // 快速模式 - 平衡速度和质量
  FAST: {
    width: 960,
    height: 540,
    fps: 25,
    mosaic: 15,
    eyeExpand: 0.5,
    minScore: 0.15,
    crf: 28,
    detectScale: 0.3,
    detectEvery: 5,
    enableSmoothing: false,
    maxDetections: 3,
    showProgress: false
  },
  
  // 720p快速模式 - 专门针对720p分辨率的快速处理
  FAST_720P: {
    width: 1280,
    height: 720,
    fps: 25,
    mosaic: 18,
    eyeExpand: 0.55,
    minScore: 0.12,
    crf: 30,              // 提高压缩率，减少编码时间
    detectScale: 0.2,     // 极低检测分辨率，大幅减少AI计算
    detectEvery: 5,       // 大幅跳帧，减少检测频率
    enableSmoothing: false, // 关闭平滑，减少计算开销
    maxDetections: 2,     // 限制检测人数
    showProgress: false   // 关闭进度显示，减少I/O开销
  },
  
  // 标准模式 - 平衡质量和速度
  STANDARD: {
    width: 1280,
    height: 720,
    fps: 25,
    mosaic: 20,
    eyeExpand: 0.6,
    minScore: 0.1,
    crf: 23,
    detectScale: 0.5,
    detectEvery: 3,
    enableSmoothing: true,
    maxDetections: 5,
    showProgress: true
  },
  
  // 高质量模式 - 优先质量
  HIGH_QUALITY: {
    width: 1920,
    height: 1080,
    fps: 30,
    mosaic: 25,
    eyeExpand: 0.7,
    minScore: 0.05,
    crf: 18,
    detectScale: 0.7,
    detectEvery: 2,
    enableSmoothing: true,
    maxDetections: 10,
    showProgress: true
  }
};

/**
 * 执行视频眼睛打码处理 - 优化版本
 * @param {Object} config - 配置参数
 * @param {string} optimizationLevel - 优化级别 ('ULTRA_FAST', 'FAST', 'STANDARD', 'HIGH_QUALITY')
 */
async function executeVideoEyeBlurOptimized(config, optimizationLevel = 'FAST') {
  try {
    console.log(`开始执行视频眼睛打码处理 (${optimizationLevel} 模式)...`);
    
    // 合并优化配置
    const optimizedConfig = {
      ...config,
      ...OPTIMIZATION_LEVELS[optimizationLevel]
    };
    
    console.log('优化配置参数:', JSON.stringify(optimizedConfig, null, 2));
    
    const result = await maskEyesWithPoseNetOSS(optimizedConfig);
    
    console.log('处理完成!');
    console.log('结果:', result);
    
    return result;
  } catch (error) {
    console.error('处理失败:', error.message);
    throw error;
  }
}

/**
 * 示例配置和调用 - 多级别优化版本
 */
async function main() {
  // 基础配置
  const baseConfig = {
    // OSS 配置
    region: 'oss-cn-hangzhou',
    bucket: 'xxx',
    accessKeyId: 'xxxx',
    accessKeySecret: 'xxxx',
    
    // 视频文件配置
    srcKey: 'output/fast2.mov',
    dstKey: 'output/fast2_blurred_optimized.mp4',
    
    // 网络配置
    useInternal: false
  };
  process.env.TF_CPP_MIN_LOG_LEVEL = '2';
  process.env.TENSORFLOW_NUM_INTRAOP_THREADS = '4';
  process.env.TENSORFLOW_NUM_INTEROP_THREADS = '2';
  // 选择优化级别
  const optimizationLevel = process.argv[2] || 'FAST_720P';
  
  if (!OPTIMIZATION_LEVELS[optimizationLevel]) {
    console.error(`无效的优化级别: ${optimizationLevel}`);
    console.log('可用级别:', Object.keys(OPTIMIZATION_LEVELS).join(', '));
    process.exit(1);
  }
  
  try {
    await executeVideoEyeBlurOptimized(baseConfig, optimizationLevel);
  } catch (error) {
    console.error('主程序执行失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，则执行主程序
if (require.main === module) {
  main();
}

module.exports = {
  executeVideoEyeBlurOptimized,
  OPTIMIZATION_LEVELS
}; 