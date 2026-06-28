// test-backend-connection.js
// 简单验证后端健康与状态接口
const axios = require('axios');

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

async function main() {
  console.log(`\n[语音转写] 后端连接测试: ${BACKEND_URL}\n`);

  try {
    process.stdout.write('1) 健康检查 /api/health ... ');
    const health = await axios.get(`${BACKEND_URL}/api/health`, { timeout: 5000 });
    console.log('OK', health.status);
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(1);
  }

  try {
    process.stdout.write('2) 状态检查 /api/status ... ');
    const status = await axios.get(`${BACKEND_URL}/api/status`, { timeout: 8000 });
    console.log('OK', status.status);
    console.log('   状态摘要:', JSON.stringify(status.data));
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(2);
  }

  console.log('\n✓ 后端接口可用\n');
}

main().catch((e) => { console.error(e); process.exit(99); });
