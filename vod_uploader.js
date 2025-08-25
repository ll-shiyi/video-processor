/**
 * vod_uploader.js - VOD上传器
 * 使用OSS SDK实现VOD视频上传功能，支持分片上传和断点续传
 * 
 * 使用示例：
 * 
 * // 基本分片上传
 * const result = await uploader.uploadToVod(filePath, vodClient, {
 *   title: '我的视频',
 *   partSize: 1024 * 1024, // 1MB分片
 *   parallel: 3, // 3个并发
 *   maxRetries: 3, // 最大重试3次
 *   onProgress: (progress, info) => {
 *     console.log(`上传进度: ${(progress * 100).toFixed(2)}%`);
 *     // info包含: { uploadedBytes, fileSize, uploadId, parts }
 *   }
 * });
 * 
 * // 断点续传
 * const resumeResult = await uploader.uploadToVod(filePath, vodClient, {
 *   title: '我的视频',
 *   uploadId: '之前失败的uploadId',
 *   existingParts: [/* 之前已上传的分片信息 *\/]
 * });
 */

const OSS = require('ali-oss');
const fs = require('fs');
const path = require('path');

/**
 * VOD上传器类
 */
class VodUploader {
  constructor(accessKeyId, accessKeySecret, region = 'cn-shanghai') {
    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.region = region;
  }

  /**
   * 获取VOD上传凭证
   * @param {Object} vodClient - VOD客户端
   * @param {Object} options - 上传选项
   * @returns {Promise<Object>} 上传凭证
   */
  async getUploadCredentials(vodClient, options) {
    const vod = require('@alicloud/vod20170321');
    const CreateUploadVideoRequest = vod.CreateUploadVideoRequest;
    
    const request = new CreateUploadVideoRequest({
      title: options.title || '上传的视频',
      description: options.description || '',
      fileName: options.fileName,
      fileSize: options.fileSize,
      cateId: options.cateId || 0,
      tags: options.tags || '',
      coverURL: options.coverURL || '',
      userData: options.userData || '',
      templateGroupId: options.templateGroupId || '',
      workflowId: options.workflowId || '',
      storageLocation: options.storageLocation || '',
      appId: options.appId || '',
    });

    try {
      const response = await vodClient.createUploadVideo(request);
      console.log('[UPLOAD] 获取上传凭证成功');

      
      return {
        videoId: response.body.videoId,
        uploadAddress: response.body.uploadAddress,
        uploadAuth: response.body.uploadAuth,
        requestId: response.body.requestId
      };
    } catch (error) {
      console.error('[UPLOAD] 获取上传凭证失败:', error.message);
      throw error;
    }
  }

  /**
   * 解析上传地址和认证信息
   * @param {string} uploadAddress - 上传地址
   * @param {string} uploadAuth - 上传认证信息
   * @returns {Object} 解析后的OSS配置
   */
  parseUploadInfo(uploadAddress, uploadAuth) {
    try {
      // 解析上传地址（base64解码）
      const addressData = JSON.parse(Buffer.from(uploadAddress, 'base64').toString());
      console.log('[UPLOAD] 解析的上传地址:', addressData);
      
      // 解析认证信息（base64解码）
      const auth = JSON.parse(Buffer.from(uploadAuth, 'base64').toString());
      
      return {
        bucket: addressData.Bucket,
        region: auth.Region,
        accessKeyId: auth.AccessKeyId,
        accessKeySecret: auth.AccessKeySecret,
        securityToken: auth.SecurityToken,
        endpoint: addressData.Endpoint,
        objectKey: addressData.FileName
      };
    } catch (error) {
      console.error('[UPLOAD] 解析上传信息失败:', error.message);
      throw new Error('上传信息格式错误');
    }
  }

  /**
   * 创建OSS客户端
   * @param {Object} ossConfig - OSS配置
   * @returns {OSS} OSS客户端实例
   */
  createOssClient(ossConfig) {
    return new OSS({
      accessKeyId: ossConfig.accessKeyId,
      accessKeySecret: ossConfig.accessKeySecret,
      stsToken: ossConfig.securityToken,
      bucket: ossConfig.bucket,
      endpoint: ossConfig.endpoint,
      region: ossConfig.region,
      secure: true,
      timeout: 120000, // 2分钟超时
    });
  }

  /**
   * 上传文件到VOD
   * @param {string} filePath - 本地文件路径
   * @param {Object} vodClient - VOD客户端
   * @param {Object} options - 上传选项
   * @returns {Promise<Object>} 上传结果
   */
  async uploadToVod(filePath, vodClient, options = {}) {
    console.log('[UPLOAD] 开始上传文件到VOD...');
    console.log('[UPLOAD] 文件路径:', filePath);
    
    try {
      // 检查文件是否存在
      if (!fs.existsSync(filePath)) {
        throw new Error(`文件不存在: ${filePath}`);
      }

      const fileStats = fs.statSync(filePath);
      const fileName = path.basename(filePath);
      
      console.log('[UPLOAD] 文件信息:', {
        fileName,
        fileSize: fileStats.size,
        lastModified: new Date(fileStats.mtime).toISOString()
      });

      // 1. 获取上传凭证
      const credentials = await this.getUploadCredentials(vodClient, {
        title: options.title || `上传的视频_${Date.now()}`,
        description: options.description || '通过AI处理的视频',
        fileName: fileName,
        fileSize: fileStats.size,
        cateId: options.cateId || 0,
        tags: options.tags || '',
        ...options
      });

      // 2. 解析上传信息
      const ossConfig = this.parseUploadInfo(credentials.uploadAddress, credentials.uploadAuth);
      console.log('[UPLOAD] OSS配置:', {
        bucket: ossConfig.bucket,
        region: ossConfig.region,
        endpoint: ossConfig.endpoint,
        objectKey: ossConfig.objectKey
      });

      // 3. 创建OSS客户端
      const ossClient = this.createOssClient(ossConfig);

      // 4. 上传文件
      console.log('[UPLOAD] 开始上传到OSS...');
      const uploadResult = await this.uploadToOss(ossClient, filePath, ossConfig.objectKey, options);

      // 5. 刷新上传凭证
      await this.refreshUploadCredentials(vodClient, credentials.videoId);

      console.log('[UPLOAD] 上传完成');
      return {
        success: true,
        videoId: credentials.videoId,
        requestId: credentials.requestId,
        etag: uploadResult.etag,
        fileSize: fileStats.size,
        uploadTime: new Date().toISOString()
      };

    } catch (error) {
      console.error('[UPLOAD] 上传失败:', error.message);
      throw error;
    }
  }

  /**
   * 上传文件到OSS（分片上传）
   * @param {OSS} ossClient - OSS客户端
   * @param {string} filePath - 本地文件路径
   * @param {string} objectKey - OSS对象键
   * @param {Object} options - 上传选项
   * @returns {Promise<Object>} 上传结果
   */
  async uploadToOss(ossClient, filePath, objectKey, options = {}) {
    const fileSize = fs.statSync(filePath).size;
    const partSize = options.partSize || 1024 * 1024; // 默认1MB分片
    const parallel = options.parallel || 3; // 默认3个并发上传
    const maxRetries = options.maxRetries || 3; // 最大重试次数
    
    console.log(`[UPLOAD] 开始分片上传，文件大小: ${fileSize} bytes，分片大小: ${partSize} bytes，并发数: ${parallel}`);
    
    let uploadId = options.uploadId; // 支持断点续传
    let parts = options.existingParts || []; // 已上传的分片
    
    // 如果有uploadId但没有parts，尝试获取已上传的分片
    if (uploadId && parts.length === 0) {
      parts = await this.getUploadedParts(ossClient, objectKey, uploadId);
    }
    
    try {
      // 1. 如果没有uploadId，初始化分片上传
      if (!uploadId) {
        const multipartUpload = await ossClient.initMultipartUpload(objectKey, {
          headers: {
            'Content-Type': 'video/mp4'
          }
        });
        uploadId = multipartUpload.uploadId;
        console.log('[UPLOAD] 初始化分片上传成功，uploadId:', uploadId);
      } else {
        console.log('[UPLOAD] 使用现有uploadId进行断点续传:', uploadId);
      }
      
      // 2. 计算分片数量
      const partCount = Math.ceil(fileSize / partSize);
      console.log(`[UPLOAD] 总分片数: ${partCount}，已上传: ${parts.length}`);
      
      // 3. 找出未上传的分片
      const uploadedPartNumbers = new Set(parts.map(p => p.number));
      const pendingParts = [];
      
      for (let i = 0; i < partCount; i++) {
        const partNumber = i + 1;
        if (!uploadedPartNumbers.has(partNumber)) {
          const start = i * partSize;
          const end = Math.min(start + partSize, fileSize);
          const partSize_actual = end - start;
          
          pendingParts.push({
            partNumber,
            start,
            partSize: partSize_actual
          });
        }
      }
      
      console.log(`[UPLOAD] 待上传分片数: ${pendingParts.length}`);
      
      // 4. 上传剩余分片
      let uploadedBytes = parts.reduce((sum, part) => sum + part.partSize, 0);
      let lastProgressTime = Date.now();
      
      // 分批上传分片，控制并发数
      for (let i = 0; i < pendingParts.length; i += parallel) {
        const batch = [];
        const batchEnd = Math.min(i + parallel, pendingParts.length);
        
        for (let j = i; j < batchEnd; j++) {
          const part = pendingParts[j];
          batch.push(this.uploadPartWithRetry(ossClient, filePath, objectKey, uploadId, part.partNumber, part.start, part.partSize, maxRetries));
        }
        
        // 并发上传当前批次
        const batchResults = await Promise.all(batch);
        
        // 更新进度
        for (const result of batchResults) {
          parts.push(result);
          uploadedBytes += result.partSize;
          
          const now = Date.now();
          if (now - lastProgressTime > 1000) {
            const progress = ((uploadedBytes / fileSize) * 100).toFixed(2);
            console.log(`[UPLOAD] 上传进度: ${progress}% (${uploadedBytes}/${fileSize} bytes)`);
            lastProgressTime = now;
          }
        }
        
        // 调用进度回调
        if (options.onProgress) {
          const progress = uploadedBytes / fileSize;
          options.onProgress(progress, { 
            uploadedBytes, 
            fileSize, 
            uploadId,
            parts: [...parts] // 传递已上传的分片信息，用于断点续传
          });
        }
      }
      
      // 5. 完成分片上传
      console.log('[UPLOAD] 所有分片上传完成，正在合并...');
      const result = await ossClient.completeMultipartUpload(objectKey, uploadId, parts);
      
      console.log('[UPLOAD] 分片上传成功');
      console.log('[UPLOAD] ETag:', result.etag);
      
      return result;
      
    } catch (error) {
      console.error('[UPLOAD] 分片上传失败:', error.message);
      
      // 如果上传失败，不立即取消，保留uploadId用于断点续传
      console.log('[UPLOAD] 上传失败，可保存以下信息用于断点续传:');
      console.log('[UPLOAD] uploadId:', uploadId);
      console.log('[UPLOAD] 已上传分片数:', parts.length);
      
      throw error;
    }
  }

  /**
   * 上传单个分片（带重试机制）
   * @param {OSS} ossClient - OSS客户端
   * @param {string} filePath - 本地文件路径
   * @param {string} objectKey - OSS对象键
   * @param {string} uploadId - 上传ID
   * @param {number} partNumber - 分片编号
   * @param {number} start - 分片起始位置
   * @param {number} partSize - 分片大小
   * @param {number} maxRetries - 最大重试次数
   * @returns {Promise<Object>} 分片上传结果
   */
  async uploadPartWithRetry(ossClient, filePath, objectKey, uploadId, partNumber, start, partSize, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.uploadPart(ossClient, filePath, objectKey, uploadId, partNumber, start, partSize);
        if (attempt > 1) {
          console.log(`[UPLOAD] 分片 ${partNumber} 重试成功（第${attempt}次尝试）`);
        }
        return result;
      } catch (error) {
        lastError = error;
        console.warn(`[UPLOAD] 分片 ${partNumber} 上传失败（第${attempt}次尝试）:`, error.message);
        
        if (attempt < maxRetries) {
          // 等待一段时间后重试，使用指数退避
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          console.log(`[UPLOAD] 等待 ${delay}ms 后重试分片 ${partNumber}...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(`分片 ${partNumber} 上传失败，已重试 ${maxRetries} 次: ${lastError.message}`);
  }

  /**
   * 上传单个分片
   * @param {OSS} ossClient - OSS客户端
   * @param {string} filePath - 本地文件路径
   * @param {string} objectKey - OSS对象键
   * @param {string} uploadId - 上传ID
   * @param {number} partNumber - 分片编号
   * @param {number} start - 分片起始位置
   * @param {number} partSize - 分片大小
   * @returns {Promise<Object>} 分片上传结果
   */
  async uploadPart(ossClient, filePath, objectKey, uploadId, partNumber, start, partSize) {
    return new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(filePath, {
        start: start,
        end: start + partSize - 1
      });
      
      ossClient.uploadPart(objectKey, uploadId, partNumber, readStream, {
        timeout: 60000, // 1分钟超时
        headers: {
          'Content-Length': partSize
        }
      }).then(result => {
        console.log(`[UPLOAD] 分片 ${partNumber} 上传成功`);
        resolve({
          number: partNumber,
          etag: result.etag,
          partSize: partSize
        });
      }).catch(error => {
        console.error(`[UPLOAD] 分片 ${partNumber} 上传失败:`, error.message);
        reject(error);
      });
    });
  }

  /**
   * 刷新上传凭证
   * @param {Object} vodClient - VOD客户端
   * @param {string} videoId - 视频ID
   * @returns {Promise<void>}
   */
  async refreshUploadCredentials(vodClient, videoId) {
    try {
      const { RefreshUploadVideoRequest } = require('@alicloud/vod20170321');
      
      const request = new RefreshUploadVideoRequest({
        videoId: videoId
      });

      await vodClient.refreshUploadVideo(request);
      console.log('[UPLOAD] 刷新上传凭证成功');
    } catch (error) {
      console.warn('[UPLOAD] 刷新上传凭证失败:', error.message);
      // 刷新失败不影响上传结果
    }
  }

  /**
   * 获取已上传的分片列表
   * @param {OSS} ossClient - OSS客户端
   * @param {string} objectKey - OSS对象键
   * @param {string} uploadId - 上传ID
   * @returns {Promise<Array>} 已上传的分片列表
   */
  async getUploadedParts(ossClient, objectKey, uploadId) {
    try {
      const result = await ossClient.listParts(objectKey, uploadId);
      console.log(`[UPLOAD] 获取已上传分片列表成功，共 ${result.parts.length} 个分片`);
      
      return result.parts.map(part => ({
        number: part.partNumber,
        etag: part.etag,
        partSize: part.size
      }));
    } catch (error) {
      console.error('[UPLOAD] 获取已上传分片列表失败:', error.message);
      return [];
    }
  }

  /**
   * 取消分片上传
   * @param {OSS} ossClient - OSS客户端
   * @param {string} objectKey - OSS对象键
   * @param {string} uploadId - 上传ID
   * @returns {Promise<void>}
   */
  async cancelMultipartUpload(ossClient, objectKey, uploadId) {
    try {
      await ossClient.cancelMultipartUpload(objectKey, uploadId);
      console.log('[UPLOAD] 取消分片上传成功');
    } catch (error) {
      console.warn('[UPLOAD] 取消分片上传失败:', error.message);
    }
  }

  /**
   * 获取视频信息
   * @param {Object} vodClient - VOD客户端
   * @param {string} videoId - 视频ID
   * @returns {Promise<Object>} 视频信息
   */
  async getVideoInfo(vodClient, videoId) {
    try {
      const { GetVideoInfoRequest } = require('@alicloud/vod20170321');
      
      const request = new GetVideoInfoRequest({
        videoId: videoId
      });

      const response = await vodClient.getVideoInfo(request);
      console.log('[VOD] 获取视频信息成功');
      
      return {
        videoId: response.body.video.videoId,
        title: response.body.video.title,
        description: response.body.video.description,
        duration: response.body.video.duration,
        size: response.body.video.size,
        status: response.body.video.status,
        createTime: response.body.video.createTime,
        coverURL: response.body.video.coverURL,
        playURL: response.body.video.playURL
      };
    } catch (error) {
      console.error('[VOD] 获取视频信息失败:', error.message);
      throw error;
    }
  }
}

module.exports = VodUploader;
