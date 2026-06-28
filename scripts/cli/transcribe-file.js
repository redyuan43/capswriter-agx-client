#!/usr/bin/env node
// CLI: 上传音频文件到后端进行语音识别

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const usage = () => {
  console.log(`用法: node scripts/cli/transcribe-file.js <音频文件路径> [后端地址]

示例:
  node scripts/cli/transcribe-file.js samples/demo.wav
  node scripts/cli/transcribe-file.js samples/demo.wav http://127.0.0.1:8001

可选环境变量:
  BACKEND_URL - 默认后端地址 (优先级低于命令行传入)
`);
};

async function main() {
  const [, , audioPathArg, backendArg] = process.argv;

  if (!audioPathArg || ['-h', '--help'].includes(audioPathArg)) {
    usage();
    process.exit(audioPathArg ? 0 : 1);
  }

  const audioPath = path.resolve(audioPathArg);
  if (!fs.existsSync(audioPath)) {
    console.error(`找不到音频文件: ${audioPath}`);
    process.exit(1);
  }

  const backendURL = backendArg || process.env.BACKEND_URL || 'http://127.0.0.1:8001';
  const endpoint = `${backendURL.replace(/\/$/, '')}/api/asr/transcribe`;

  console.log(`[CLI] 上传音频到: ${endpoint}`);

  const form = new FormData();
  form.append('audio', fs.createReadStream(audioPath));
  form.append('use_vad', 'true');
  form.append('use_punc', 'true');
  form.append('hotword', '');

  try {
    const response = await axios.post(endpoint, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000,
    });

    console.log('\n=== 识别结果 ===');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error('\n识别失败');
    if (err.response) {
      console.error(`HTTP ${err.response.status}`, err.response.data);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

main();
