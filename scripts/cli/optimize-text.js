#!/usr/bin/env node
// CLI: 调用后端文本优化接口

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const DEFAULT_URL = 'http://127.0.0.1:8001';

const printUsage = () => {
  console.log(`用法: node scripts/cli/optimize-text.js [选项] <文本或文件路径>

选项:
  --mode=<optimize|format|punctuate|custom>   默认 optimize
  --prompt=<自定义提示词>                      仅当 mode=custom 时有效
  --file=<路径>                                从文件读取文本（UTF-8）

示例:
  node scripts/cli/optimize-text.js "这个 嗯 那个 就是测试"
  node scripts/cli/optimize-text.js --mode=format --file notes.txt
  node scripts/cli/optimize-text.js --mode=custom --prompt="保持 markdown" "原始文本"

可选环境变量:
  BACKEND_URL - 默认后端地址 (默认为 ${DEFAULT_URL})
`);
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    mode: 'optimize',
    prompt: null,
    file: null,
    text: null,
  };

  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }

    if (arg.startsWith('--mode=')) {
      options.mode = arg.split('=')[1];
      continue;
    }

    if (arg.startsWith('--prompt=')) {
      options.prompt = arg.slice('--prompt='.length);
      continue;
    }

    if (arg.startsWith('--file=')) {
      options.file = arg.slice('--file='.length);
      continue;
    }

    if (!options.text) {
      options.text = arg;
    } else {
      options.text += ' ' + arg;
    }
  }

  return options;
};

async function main() {
  const options = parseArgs();

  if (options.help) {
    printUsage();
    process.exit(0);
  }

  let text = options.text;
  if (options.file) {
    const filePath = path.resolve(options.file);
    if (!fs.existsSync(filePath)) {
      console.error(`找不到文本文件: ${filePath}`);
      process.exit(1);
    }
    text = fs.readFileSync(filePath, 'utf8');
  }

  if (!text) {
    console.error('请提供需要优化的文本或使用 --file 选项。');
    printUsage();
    process.exit(1);
  }

  const backendURL = process.env.BACKEND_URL || DEFAULT_URL;
  const endpoint = `${backendURL.replace(/\/$/, '')}/api/llm/optimize`;

  console.log(`[CLI] 调用: ${endpoint}`);

  try {
    const response = await axios.post(endpoint, {
      text,
      mode: options.mode,
      custom_prompt: options.prompt || null,
    }, {
      timeout: 60000,
    });

    console.log('\n=== 优化结果 ===');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (err) {
    console.error('\n优化失败');
    if (err.response) {
      console.error(`HTTP ${err.response.status}`, err.response.data);
    } else {
      console.error(err.message);
    }
    process.exit(1);
  }
}

main();
