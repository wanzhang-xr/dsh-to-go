'use strict';
/**
 * npmrc.js —— 让 npm 只读盘内的配置，不依赖宿主 ~/.npmrc
 *
 * 为什么需要：npm 默认会读用户目录的 .npmrc（registry / proxy / 私有源 token）。
 * 那等于"依赖宿主机"——换台机器行为就变，甚至会把请求带到宿主代理上。
 * 这里把 userconfig 指到 data/npmrc，盘内文件为空即可；用户要私有源就写这里。
 *
 * 只影响我们主动调 npm/pnpm 的那些路径（安装 / 升级 / 插件），
 * 不改宿主任何东西，也不写宿主的 .npmrc。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = process.env.WZD_DATA_DIR || path.join(ROOT, 'data');
const NPMRC = path.join(DATA, 'npmrc');

function ensure() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (!fs.existsSync(NPMRC)) {
      fs.writeFileSync(NPMRC,
        '# 盘内 npm 配置。想用私有源 / 代理就写在这里，不要依赖宿主的 ~/.npmrc。\n'
        + '# 例：registry=https://registry.npmmirror.com\n', 'utf8');
    }
    try { fs.chmodSync(NPMRC, 0o600); } catch (e) { /* Windows 上 chmod 能力有限，忽略 */ }
    return NPMRC;
  } catch (e) {
    // 写不出来就返回 null：调用方会跳过设置，而不是把不存在的路径塞给 npm
    return null;
  }
}

/** 把一个 env 对象补上 userconfig（拿不到路径就什么都不做）。 */
function apply(e) {
  const p = ensure();
  if (p) e.npm_config_userconfig = p; else delete e.npm_config_userconfig;
  return e;
}

/** 在当前进程环境上补 npm_config_userconfig（不改其它变量）。 */
function env(base) {
  return apply(Object.assign({}, base || process.env));
}

module.exports = { NPMRC, ensure, env, apply };
