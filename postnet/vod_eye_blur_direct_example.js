// vod_eye_blur_direct_example.js
// 使用processor_direct.js的直接视频处理示例
// 完全参照Pose.jsx逻辑，确保处理效果与前端一致

const { maskEyesWithPoseNetDirect } = require('./vod_eye_blur_direct');

async function main() {
  console.log('=== VOD视频遮挡处理示例 (直接处理版本) ===');
  console.log('此版本完全参照Pose.jsx逻辑，不使用任何优化');
  console.log('确保处理效果与前端完全一致\n');

  // 配置参数
  const config = {
    // VOD配置
    accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || 'xxxx',
    accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || 'xxxxx',
    region: process.env.ALIBABA_CLOUD_REGION || 'cn-shanghai',
    
    // 视频配置
    videoId: process.env.VIDEO_ID || 'a0145ebb8a0571f095b66723b78e0102',
    outputTitle: '隐私保护处理后的视频 (直接处理版本，无音频)',
    outputDescription: '使用processor_direct.js处理，完全参照Pose.jsx逻辑，输出无音频视频',

    // 可选覆盖
    // width: 1280,  // 可选：指定输出宽度
    // height: 720,  // 可选：指定输出高度
    // fps: 25,      // 可选：指定输出帧率

    // 模型/质量/时限
    minScore: 0.1,
    crf: 23,
    timeout: 300000, // 5分钟超时

    // 检测参数（与前端Pose.jsx完全一致）
    detectEvery: 1,           // 每帧都检测，确保与前端一致
    adaptiveSkip: false,      // 关闭自适应跳过
    maxDetections: 5,         // 前端：5
    scoreThreshold: 0.1,      // 前端：0.1
    nmsRadius: 30,           // 前端：30
    minPoseConfidence: 0.15, // 前端：0.15
    flipHorizontal: false,    // 前端：true

    // 面具参数（与前端Pose.jsx完全一致）
    maskScaleW: 1.3,         // faceWidth * 1.3
    maskScaleH: 1.8,         // faceWidth * 1.8
    strokeWidth: 2,          // 边框宽度

    // PoseNet模型参数（与前端Pose.jsx完全一致）
    quantBytes: 2,           // 前端：2
    multiplier: 0.75,        // 前端：0.75
    outputStride: 16,        // 前端：16
    inputResolution: 500,    // 前端：500

    // 保存无脸帧参数
    saveNoFaceFrames: true,  // 启用保存无脸帧功能
    noFaceDir: 'no_face_frames', // 保存目录
  };

  // 检查必需的环境变量
  if (config.accessKeyId === 'your-access-key-id' || 
      config.accessKeySecret === 'your-access-key-secret' ||
      config.videoId === 'your-video-id') {
    console.error('❌ 请设置必需的环境变量：');
    console.error('   ALIBABA_CLOUD_ACCESS_KEY_ID');
    console.error('   ALIBABA_CLOUD_ACCESS_KEY_SECRET');
    console.error('   ALIBABA_CLOUD_REGION');
    console.error('   VIDEO_ID');
    console.error('\n或者直接修改代码中的配置值。');
    process.exit(1);
  }

  console.log('📋 处理配置：');
  console.log(`   视频ID: ${config.videoId}`);
  console.log(`   区域: ${config.region}`);
  console.log(`   检测参数: 每帧检测, 最大检测数=${config.maxDetections}`);
  console.log(`   面具参数: 宽度=${config.maskScaleW}, 高度=${config.maskScaleH}`);
  console.log(`   模型参数: 量化=${config.quantBytes}, 倍数=${config.multiplier}`);
  console.log(`   保存无脸帧: ${config.saveNoFaceFrames ? '是' : '否'}`);
  if (config.saveNoFaceFrames) {
    console.log(`   无脸帧目录: ${config.noFaceDir}`);
  }
  console.log('');

  try {
    console.log('🚀 开始处理视频...');
    const startTime = Date.now();
    
    const result = await maskEyesWithPoseNetDirect(config);
    
    const endTime = Date.now();
    const processingTime = (endTime - startTime) / 1000;

    if (result.success) {
      console.log('\n✅ 处理成功！');
      console.log(`   输出视频ID: ${result.outputVideoId}`);
      console.log(`   处理时间: ${processingTime.toFixed(1)}秒`);
      console.log(`   视频尺寸: ${result.width}x${result.height}`);
      console.log(`   帧率: ${result.fps} fps`);
      console.log(`   SAR: ${result.sar}`);
      console.log(`   处理类型: ${result.processingType}`);
      
      if (result.errors && result.errors.length > 0) {
        console.log('\n⚠️  警告信息：');
        result.errors.forEach(error => console.log(`   - ${error}`));
      }
      
      console.log('\n🎉 视频已成功上传到阿里云VOD！');
      console.log('   您可以在VOD控制台中查看处理后的视频。');
      
    } else {
      console.log('\n❌ 处理失败！');
      console.log(`   错误: ${result.error}`);
      console.log(`   错误类型: ${result.errorType}`);
      console.log(`   处理时间: ${processingTime.toFixed(1)}秒`);
      
      if (result.errors && result.errors.length > 0) {
        console.log('\n详细错误信息：');
        result.errors.forEach(error => console.log(`   - ${error}`));
      }
      
      if (result.stack) {
        console.log('\n堆栈信息：');
        console.log(result.stack);
      }
    }

  } catch (error) {
    console.error('\n💥 处理过程中发生异常：');
    console.error(`   错误: ${error.message}`);
    console.error(`   类型: ${error.constructor.name}`);
    
    if (error.stack) {
      console.error('\n堆栈信息：');
      console.error(error.stack);
    }
  }
}

// 运行示例
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main };
