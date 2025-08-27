#!/usr/bin/env node
/**
 * vod_eye_blur_example.js - VOD视频打码处理示例
 * 演示如何使用 vod_eye_blur_processor.js 处理VOD视频
 */

const { maskEyesWithPoseNetVOD } = require('./vod_eye_blur_processor');

async function main() {
  // 配置参数
  const config = {
    // VOD 配置
     // VOD 配置
     accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || 'xxx',
     accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || 'xxx',
     region: 'cn-shanghai',
     
    
    // 源视频ID
    videoId: '90f6532082f471f0bffa4531958c0102', 
    outputTitle: '隐私保护处理后的视频',
    outputDescription: '使用MoveNet进行眼部遮挡处理的视频',
    
    // 视频处理参数 - 720p清晰度
    // width: 1280,  // 720p宽度（16:9比例）
    // height: 720,  // 720p高度
    // fps: 30,      // 手机视频通常30fps
    crf: 20,      // 提高质量，减少压缩伪影
    
    // 姿态检测参数 - 针对手机视频优化
    minScore: 0.1,          // 提高置信度阈值，减少误检
    detectScale: 0.4,        // 适中的检测缩放比例
    detectEvery: 2,          // 更频繁的检测，适应手机视频
    enableSmoothing: true,   // 启用平滑
    adaptiveSkip: true,      // 自适应跳过
    maxDetections: 3,        // 减少最大检测数量，提高性能
    
    // 面具参数 - 针对手机视频优化
    maskScaleW: 1.4,         // 稍微增大面具宽度
    maskScaleH: 2.0,         // 增大面具高度，适应手机竖屏
    samplesPerCurve: 32,     // 增加采样点，提高面具质量
    strokeWidth: 2,          // 增加描边宽度，提高可见性
    
    // 其他参数
    timeout: 300000,         // 超时时间（毫秒）
  };

  try {
    console.log('开始处理VOD视频...');
    console.log('配置参数:', JSON.stringify(config, null, 2));
    
    const result = await maskEyesWithPoseNetVOD(config);
    console.log('结果:', JSON.stringify(result));
    if (result.success) {
      console.log('✅ 视频处理成功！');
      console.log(`📹 输出视频ID: ${result.outputVideoId}`);
      console.log(`⏱️  处理耗时: ${result.processingTime}ms`);
      console.log(`🕐 开始时间: ${result.startTime}`);
      console.log(`🕐 结束时间: ${result.endTime}`);
      
      if (result.errors && result.errors.length > 0) {
        console.log('⚠️  处理过程中有一些警告:');
        result.errors.forEach(err => console.log(`   - ${err}`));
      }
    } else {
      console.error('❌ 视频处理失败！');
      console.error(`错误信息: ${result.error}`);
      console.error(`错误类型: ${result.errorType}`);
      console.error(`处理耗时: ${result.processingTime}ms`);
      
      if (result.errors && result.errors.length > 0) {
        console.error('详细错误日志:');
        result.errors.forEach(err => console.error(`   - ${err}`));
      }
      
      if (result.stack) {
        console.error('错误堆栈:', result.stack);
      }
    }
  } catch (error) {
    console.error('❌ 程序执行异常:', error.message);
    console.error('错误堆栈:', error.stack);
  }
}

// 命令行参数解析
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');

const argv = yargs(hideBin(process.argv))
  .option('accessKeyId', { type: 'string', description: '阿里云AccessKey ID' })
  .option('accessKeySecret', { type: 'string', description: '阿里云AccessKey Secret' })
  .option('region', { type: 'string', default: 'cn-shanghai', description: 'VOD区域' })
  .option('videoId', { type: 'string', description: '源视频ID' })
  .option('outputTitle', { type: 'string', description: '输出视频标题' })
  .option('outputDescription', { type: 'string', description: '输出视频描述' })
  .option('width', { type: 'number', default: 1280, description: '视频宽度（必须为偶数，默认720p）' })
  .option('height', { type: 'number', default: 720, description: '视频高度（必须为偶数，默认720p）' })
  .option('fps', { type: 'number', default: 30, description: '视频帧率' })
  .option('crf', { type: 'number', default: 20, description: '视频质量参数' })
  .option('minScore', { type: 'number', default: 0.15, description: '置信度阈值' })
  .option('detectScale', { type: 'number', default: 0.4, description: '检测缩放比例' })
  .option('detectEvery', { type: 'number', default: 2, description: '每隔几帧检测一次' })
  .option('enableSmoothing', { type: 'boolean', default: true, description: '启用平滑' })
  .option('adaptiveSkip', { type: 'boolean', default: true, description: '自适应跳过' })
  .option('maxDetections', { type: 'number', default: 3, description: '最大检测数量' })
  .option('maskScaleW', { type: 'number', default: 1.4, description: '面具宽度缩放' })
  .option('maskScaleH', { type: 'number', default: 2.0, description: '面具高度缩放' })
  .option('samplesPerCurve', { type: 'number', default: 32, description: '曲线采样点数量' })
  .option('strokeWidth', { type: 'number', default: 2, description: '描边宽度' })
  .option('timeout', { type: 'number', default: 300000, description: '超时时间（毫秒）' })
  .option('mobileOptimized', { type: 'boolean', default: false, description: '启用手机视频优化模式' })
  .help()
  .argv;

  // 如果提供了命令行参数，则使用命令行参数
  if (argv.videoId) {
    let config = {
      accessKeyId: argv.accessKeyId || process.env.ALIYUN_ACCESS_KEY_ID,
      accessKeySecret: argv.accessKeySecret || process.env.ALIYUN_ACCESS_KEY_SECRET,
      region: argv.region,
      videoId: argv.videoId,
      outputTitle: argv.outputTitle || '隐私保护处理后的视频',
      outputDescription: argv.outputDescription || '使用MoveNet进行眼部遮挡处理的视频',
      width: argv.width,
      height: argv.height,
      fps: argv.fps,
      crf: argv.crf,
      minScore: argv.minScore,
      detectScale: argv.detectScale,
      detectEvery: argv.detectEvery,
      enableSmoothing: argv.enableSmoothing,
      adaptiveSkip: argv.adaptiveSkip,
      maxDetections: argv.maxDetections,
      maskScaleW: argv.maskScaleW,
      maskScaleH: argv.maskScaleH,
      samplesPerCurve: argv.samplesPerCurve,
      strokeWidth: argv.strokeWidth,
      timeout: argv.timeout,
    };

    // 如果启用手机优化模式，应用优化配置
    if (argv.mobileOptimized) {
      console.log('📱 启用手机视频优化模式...');
      config = {
        ...config,
        // 手机视频优化参数
        width: 1080,
        height: 1920,
        fps: 30,
        crf: 18,              // 更高质量
        minScore: 0.2,        // 更高置信度
        detectScale: 0.35,    // 更精确的检测
        detectEvery: 1,       // 每帧检测
        maxDetections: 2,     // 减少检测数量
        maskScaleW: 1.5,      // 更大的面具
        maskScaleH: 2.2,      // 适应竖屏
        samplesPerCurve: 40,  // 更平滑的曲线
        strokeWidth: 3,       // 更明显的描边
      };
    }

  // 验证必需参数
  if (!config.accessKeyId || !config.accessKeySecret) {
    console.error('❌ 错误: 必须提供 accessKeyId 和 accessKeySecret');
    console.error('可以通过命令行参数 --accessKeyId 和 --accessKeySecret 提供');
    console.error('或者设置环境变量 ALIYUN_ACCESS_KEY_ID 和 ALIYUN_ACCESS_KEY_SECRET');
    process.exit(1);
  }

  if (!config.videoId) {
    console.error('❌ 错误: 必须提供 videoId');
    process.exit(1);
  }

  // 执行处理
  (async () => {
    try {
      console.log('开始处理VOD视频...');
      console.log('配置参数:', JSON.stringify(config, null, 2));
      
      const result = await maskEyesWithPoseNetVOD(config);
      
      if (result.success) {
        console.log('✅ 视频处理成功！');
        console.log(`📹 输出视频ID: ${result.outputVideoId}`);
        console.log(`⏱️  处理耗时: ${result.processingTime}ms`);
      } else {
        console.error('❌ 视频处理失败！');
        console.error(`错误信息: ${result.error}`);
        process.exit(1);
      }
    } catch (error) {
      console.error('❌ 程序执行异常:', error.message);
      process.exit(1);
    }
  })();
} else {
  // 如果没有提供命令行参数，运行示例
  console.log('运行示例配置...');
  console.log('要使用自定义参数，请运行:');
  console.log('node vod_eye_blur_example.js --videoId YOUR_VIDEO_ID --accessKeyId YOUR_KEY --accessKeySecret YOUR_SECRET');
  console.log('');
  main();
}
