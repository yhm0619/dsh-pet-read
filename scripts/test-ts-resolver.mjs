/**
 * 测试用模块解析钩子：把 src/ 里无扩展名的相对 import 补成 `.ts`（含目录索引）。
 *
 * 为什么需要：src/shared 是给打包器吃的源码（moduleResolution: Bundler），相对 import 一律
 * 不写扩展名（`./pickers`）。而单测走 `node --experimental-strip-types` 直连源文件，Node 的
 * ESM 解析器要求完整说明符，`./pickers` 会 ERR_MODULE_NOT_FOUND。
 *
 * 与其为了跑测试给所有源文件加 `.ts` 后缀（需要全局打开 allowImportingTsExtensions，
 * 且会牵动 tsdown / rolldown 两条构建链），不如只在测试进程里补这一层解析。
 *
 * 目录模块（`./balance` → `./balance/index.ts`）一并支持：打包器的 Bundler 解析支持目录索引，
 * src/shared 里按职责拆目录后（见 src/shared/balance/），测试进程也得跟上同一套解析。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (!/\.[cm]?[jt]sx?$/.test(specifier) && !specifier.endsWith('.json')) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        try {
          return await nextResolve(candidate, context);
        } catch {
          /* 继续试下一个候选；都不行就落回原说明符，让 Node 报它自己的错 */
        }
      }
    }
  }
  return nextResolve(specifier, context);
}
