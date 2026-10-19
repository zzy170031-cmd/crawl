import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const envPath = value => {
  const normalized = value.replaceAll('\\', '/');
  if (/["\r\n]/.test(normalized)) throw Error('安装目录不能包含双引号或换行');
  return '"' + normalized + '"';
};

// Never read or rewrite an existing credential file. No subprocess/network work.
export async function setup({ root = repository, platform = process.platform } = {}) {
  root = resolve(root);
  const template = await readFile(join(root, '.env.example'), 'utf8');
  const python = join(root, '.venv', ...(platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const paths = {
    CRAWL_PYTHON: envPath(python),
    CRAWL_WHISPER_MODEL: envPath(join(root, 'models', 'faster-whisper-small')),
  };
  const content = template.replace(/^(CRAWL_PYTHON|CRAWL_WHISPER_MODEL)=.*$/gm, (_, key) => key + '=' + paths[key]);
  for (const dir of ['data', 'models']) await mkdir(join(root, dir), { recursive: true });
  try {
    await writeFile(join(root, '.env'), content, { flag: 'wx', mode: 0o600 });
    return { status: 'created', credentials: 'not_configured', downloads: 0, message: '.env 已创建；请填入自己的凭据，并按安装文档显式安装依赖和模型。' };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { status: 'preserved', downloads: 0, message: '已有 .env 完整保留；迁移目录后请自行核对 Python 和模型路径。' };
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await setup(), null, 2)); }
  catch { console.error('初始化失败，请检查仓库目录与文件权限；未覆盖已有配置。'); process.exitCode = 1; }
}
