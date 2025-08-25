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
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || 'xxxxxx',
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET || 'xxxxxxx',
    region: 'cn-shanghai',
    
    // 视频信息
    videoId: 'c09f564080ff71f0bfc64531959c0102', // 源视频ID
    outputTitle: '隐私保护处理后的视频',
    outputDescription: '使用MoveNet进行眼部遮挡处理的视频',
    
    // 视频处理参数
    width: 1280,  // 必须是偶数
    height: 720,  // 必须是偶数
    fps: 25,
    crf: 23,      // 视频质量，值越小质量越高
    
    // 姿态检测参数
    minScore: 0.1,           // 置信度阈值
    detectScale: 0.5,        // 检测缩放比例
    detectEvery: 3,          // 每隔几帧检测一次
    enableSmoothing: true,   // 启用平滑
    adaptiveSkip: true,      // 自适应跳过
    maxDetections: 5,        // 最大检测数量
    
    // 面具参数
    maskScaleW: 1.3,         // 面具宽度缩放
    maskScaleH: 1.8,         // 面具高度缩放
    samplesPerCurve: 28,     // 曲线采样点数量
    strokeWidth: 1,          // 描边宽度
    
    // 其他参数
    timeout: 300000,         // 超时时间（毫秒）
  };

  try {
    console.log('开始处理VOD视频...');
    console.log('配置参数:', JSON.stringify(config, null, 2));
    
    const result = await maskEyesWithPoseNetVOD(config);
    
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
  .option('width', { type: 'number', default: 1280, description: '视频宽度（必须为偶数）' })
  .option('height', { type: 'number', default: 720, description: '视频高度（必须为偶数）' })
  .option('fps', { type: 'number', default: 25, description: '视频帧率' })
  .option('crf', { type: 'number', default: 23, description: '视频质量参数' })
  .option('minScore', { type: 'number', default: 0.1, description: '置信度阈值' })
  .option('detectScale', { type: 'number', default: 0.5, description: '检测缩放比例' })
  .option('detectEvery', { type: 'number', default: 3, description: '每隔几帧检测一次' })
  .option('enableSmoothing', { type: 'boolean', default: true, description: '启用平滑' })
  .option('adaptiveSkip', { type: 'boolean', default: true, description: '自适应跳过' })
  .option('maxDetections', { type: 'number', default: 5, description: '最大检测数量' })
  .option('maskScaleW', { type: 'number', default: 1.3, description: '面具宽度缩放' })
  .option('maskScaleH', { type: 'number', default: 1.8, description: '面具高度缩放' })
  .option('samplesPerCurve', { type: 'number', default: 28, description: '曲线采样点数量' })
  .option('strokeWidth', { type: 'number', default: 1, description: '描边宽度' })
  .option('timeout', { type: 'number', default: 300000, description: '超时时间（毫秒）' })
  .help()
  .argv;

// 如果提供了命令行参数，则使用命令行参数
if (argv.videoId) {
  const config = {
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
