---
title: 'Vite Monorepo 全解析：workspace 依赖的编译、打包与热更新'
description: '拆解 pnpm workspace + Vite 5 中 linked package 的判定、预构建跳过、transform 管线与 HMR 传播机制。'
publishDate: 2026-05-27
tags: ['vite', 'monorepo', 'pnpm', 'hmr', '前端工程化']
language: 'zh'
draft: false
comment: true
---

# Vite Monorepo 全解析：workspace 依赖的编译、打包与热更新

## 背景：为什么 monorepo 常 export TS 源码

在采用 pnpm workspace 的 monorepo 项目中，越来越多团队选择了一种叫 **source-first** 的分包策略：workspace 包的 `package.json` 直接指向 `.ts` 源码，而不是预编译后的 `dist/`。

```json
{
  "name": "@h5-journey/utils",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

这意味着这个包**没有自己的构建步骤**——没有 `build` 脚本输出 JS，没有 `dist/` 目录。它的 TypeScript 源码只会在被应用层（如 `packages/ctshk`）引用时，才作为应用构建过程的一部分被编译。

这种做法的动机很直接：

- **改源码即生效**。不需要先 build 包再看效果，本地开发链路更短。
- **调试路径清晰**。stack trace 和 source map 都指向真实源码，不经过中间产物。
- **减少构建编排**。不需要 Turborepo / Nx 维护包之间的 build 拓扑。

但它也引出了一个核心问题：**Vite 是怎么知道这个 `workspace:*` 依赖应该当源码编译，而不是当普通 npm 包预构建的？**

本文基于一个真实的 pnpm monorepo 项目（Vue 3 + Vite 5.0.8），从 `pnpm install` 到 `vite dev` 再到 `vite build`，完整拆解这条链路。

## 一、案例项目结构

项目采用三层分包：

```
h5-journey-monorepo/
├── shared/          → 基础设施（utils、stores、service、bootstrap…）
├── domains/         → 业务域（ticketResource、flightResource…）
├── packages/        → 应用入口（ctshk、portal、open…）
└── pnpm-workspace.yaml
```

依赖方向是单向的：`packages → domains / shared`。应用层（`packages/*`）是**唯一的打包边界**——只有应用有 `vite build`，workspace 包只有 `type-check`。

以 `packages/ctshk` 为例，它的 `package.json` 中大量依赖形如：

```json
{
  "dependencies": {
    "@h5-journey/utils": "workspace:*",
    "@h5-journey/ticket-resource-domain": "workspace:*",
    "@h5-journey/bootstrap": "workspace:*",
    "vue": "^3.3.0",
    "vant": "^4.0.0"
  }
}
```

构建脚本只有两步：

```json
{
  "build": "vue-tsc --noEmit && vite build"
}
```

| 步骤 | 工具 | 作用 |
|------|------|------|
| 类型检查 | `vue-tsc --noEmit` | 校验类型，**不输出 JS** |
| 打包 | `vite build` | 递归 resolve + transform + bundle → `dist/` |

## 二、pnpm 解析：从 `workspace:*` 到磁盘路径

`pnpm install` 之后，`workspace:*` 依赖在 `node_modules` 中表现为 **symlink**：

```
packages/ctshk/node_modules/@h5-journey/utils
  → ../../shared/utils/    (symlink)
```

当代码中写 `import { formatDate } from '@h5-journey/utils'` 时，Node 的模块解析过程是：

1. 在 `node_modules/@h5-journey/utils/` 下找到 `package.json`
2. 读取 `exports` 字段 → `"./src/index.ts"`
3. 拼出完整路径：`packages/ctshk/node_modules/@h5-journey/utils/src/index.ts`

到这一步还只是 symlink 路径。接下来是 Vite 的关键行为。

## 三、核心机制：Vite 如何判定 linked source

### 3.1 一个出乎意料简单的函数

Vite 5.0.8 源码（`packages/vite/src/node/utils.ts`）中有这样一个函数：

```typescript
export function isInNodeModules(id: string): boolean {
  return id.includes('node_modules')
}
```

没有 `isWorkspacePackage()` 之类专用逻辑，**只看 resolved 路径字符串里有没有 `node_modules`**。

### 3.2 关键：`preserveSymlinks: false`

Vite 默认 `resolve.preserveSymlinks: false`，resolve 时会 follow symlink 到**真实磁盘路径**。

对于 `@h5-journey/utils`，两条路径的判定结果完全不同：

| 路径 | `includes('node_modules')` | 归类 |
|------|---------------------------|------|
| symlink：`…/node_modules/@h5-journey/utils/src/index.ts` | ✅ true | npm 依赖 |
| realpath：`…/shared/utils/src/index.ts` | ❌ **false** | linked source |

Vite 使用的是 **realpath 之后的路径**。因此 workspace 包被归类为 **linked package（源码库）**，而非普通 npm 依赖。

这是整个链路中最关键的 aha moment：**不是 Vite "聪明地识别了" workspace 包，而是 symlink 被 resolve 成真实路径后，路径里恰好不包含 `node_modules` 字符串。**

### 3.3 该判定在三个环节生效

#### 环节 A：Dev 启动 — optimizeDeps 扫描

```typescript
// packages/vite/src/node/optimizer/scan.ts（简化）
if (isInNodeModules(resolved) || include?.includes(id)) {
  // npm 依赖 → 加入 depImports，esbuild 预构建到 .vite/deps/
  depImports[id] = resolved
  return externalUnlessEntry({ path: id })
} else if (isScannable(resolved, ...)) {
  // linked package → 继续 crawl，像应用源码一样递归
  return { path: path.resolve(resolved) }
}
```

对于 `@h5-journey/utils`：
- resolved realpath = `shared/utils/src/index.ts`
- `isInNodeModules` → false
- **不会**进入 `node_modules/.vite/deps/` 预构建缓存
- esbuild 继续 crawl 其内部 import，直到遇到真正的 npm 包（`vue`、`lodash-es` 等）

而 `vue`、`vant` 这些普通 npm 包，resolve 后路径是 `…/node_modules/vue/dist/vue.runtime.esm-bundler.js`，`isInNodeModules` → true，走预构建流程。

#### 环节 B：Dev 运行时 — resolve 插件

```typescript
// packages/vite/src/node/plugins/resolve.ts（简化）
if (
  !isInNodeModules(resolved) ||  // linked → 直接当源码
  !depsOptimizer ||
  options.scan
) {
  return { id: resolved }  // 不重定向到 .vite/deps/
}
```

linked package 的每次 import 都被 resolve 到源码的真实路径，Vite 像处理应用自身的 `src/` 文件一样逐文件 transform。

#### 环节 C：vite build

Vite 5 **已移除 build 阶段的 optimizeDeps**。Rollup 从入口递归 resolve 整个依赖图，所有 reachable 的 workspace 源码直接打入 bundle，和应用代码无差别。

## 四、Transform 管线：源码如何变成 JS

### 4.1 递归解析

从应用入口开始，依赖图被递归展开：

```
packages/ctshk/src/main.ts
  └─ @h5-journey/bootstrap → shared/bootstrap/src/index.ts
       └─ @h5-journey/utils → shared/utils/src/index.ts
            └─ lodash-es（npm 包，预构建）
       └─ @h5-journey/stores → shared/stores/src/index.ts
            └─ pinia（npm 包，预构建）
```

每种文件类型由对应的插件处理：

| 文件类型 | 处理工具 | 作用 |
|----------|----------|------|
| `.ts` / `.tsx` | esbuild | 擦除类型注解，转为 JS |
| `.vue` | `@vitejs/plugin-vue` | 编译 SFC 为 render 函数 |
| `.scss` | sass → PostCSS | 编译样式 + autoprefixer + px→vw |

注意：TypeScript 类型在 esbuild 阶段被擦除，**不经过 `tsc emit`**。`vue-tsc --noEmit` 只负责类型检查，不参与产物生成。

### 4.2 Dev vs Build 的差异

| 阶段 | workspace 源码 | 普通 npm 包（vue、vant） |
|------|----------------|--------------------------|
| **Dev** | 逐文件 on-demand transform | `optimizeDeps` 预构建到 `.vite/deps/` |
| **Build** | Rollup 全量打入 bundle | 同样打入 bundle（已是编译后 JS） |

Dev 时的请求链路：

```
浏览器请求 /@fs/.../shared/utils/src/format.ts
  → Vite dev server transformRequest
  → fs.readFile（root 外文件用 /@fs/ 前缀）
  → pluginContainer.transform
      ├── @vitejs/plugin-vue（.vue 文件）
      ├── vite:esbuild（.ts 文件，擦除类型）
      └── css/scss 插件
  → importAnalysis（解析下一层 import，替换为浏览器可识别的路径）
  → 返回编译后的 JS 模块
```

Build 时的额外步骤：

```
Rollup bundle
  → 所有源码打入 chunk
  → buildEsbuildPlugin（renderChunk，target: es2015 语法降级）
  → terser minify
  → 输出 dist/static/js/*.js
```

### 4.3 vite.config.ts 中的相关配置

```typescript
// packages/ctshk/vite.config.ts（摘录）
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, '../../shared'),
      '@flight': resolve(__dirname, '../../domains/flightResource/src')
    }
  },
  build: {
    target: 'es2015',
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'vant-vendor': ['vant']
        }
      }
    }
  }
})
```

几个值得注意的点：

- **没有针对 workspace 的特殊插件配置**。所有行为来自 Vite 默认机制 + monorepo 目录结构。
- `@shared` / `@flight` alias 直接指向源码目录，这绕过了 package exports，是另一种引用 workspace 代码的方式。
- `build.target: 'es2015'` 仅做**语法降级**（可选链 → 三元运算、async/await → generator），不等于自动注入 runtime polyfill。

## 五、Polyfill：`build.target` 不等于 polyfill

这是一个容易踩的坑，单独拿出来说。

### 5.1 项目现状

| 项目 | 状态 |
|------|------|
| `@vitejs/plugin-legacy` | ❌ 未使用 |
| `core-js` 自动注入 | ❌ 未配置 |
| `build.target: 'es2015'` | ✅ 仅语法降级 |
| 手动按需 polyfill | ✅ 部分场景 |
| CSS autoprefixer | ✅ PostCSS |

手动 polyfill 的例子：

```typescript
// shared/utils/src/composables/useExposureTracking.ts
import 'intersection-observer'
// 仅在使用 IntersectionObserver 的文件中显式引入
```

### 5.2 理解 target 的边界

`build.target: 'es2015'` 告诉 esbuild：把语法特性降级到 ES2015 能理解的程度。

它**会做**的事情：
- `const obj = a?.b?.c` → 三元运算
- `async function` → `__awaiter` + generator（视具体 target）
- `??`、`?.`、`class fields` 等新语法 → 兼容写法

它**不会做**的事情：
- 补齐 `Promise`、`Map`、`Set`、`Symbol`（ES2015 新增 API）
- 补齐 `IntersectionObserver`、`ResizeObserver`（浏览器 API）
- 注入 `Array.prototype.includes`、`Object.entries` 等方法

如果你的目标浏览器（比如老版本的 WebView）缺少这些 API，需要额外引入 `@vitejs/plugin-legacy`（会注入 `core-js` + `regenerator-runtime`）或者手动 polyfill。

## 六、HMR：workspace 文件变更会触发吗？

### 6.1 结论先行

**会，但有前提和边界。**

| 场景 | 结果 |
|------|------|
| 已被浏览器加载过的 workspace `.vue` 文件 | ✅ 组件级 HMR |
| 已被加载过的 workspace `.ts` 工具函数 | ✅ 可能 HMR，也可能 full reload |
| 从未被浏览器加载过的 workspace 文件 | ❌ 未被 watch，改了无反应 |
| `packages/ctshk/src/**` 内的文件 | ✅ 启动时即 watch |

### 6.2 Watch 机制：root 内 vs root 外

Vite 启动时，chokidar 默认 watch 的范围是：

```
packages/ctshk/     ← config.root
+ vite.config.ts 等配置依赖
+ .env 文件目录
```

**不会**自动 watch 整个 `shared/`、`domains/` 目录树。

那 workspace 文件是怎么被 watch 到的？答案是 **lazy watch**。当一个 root 外的文件首次被请求和 transform 时，Vite 通过 `ensureWatchedFile` 动态将它加入 watcher：

```typescript
// packages/vite/src/node/utils.ts
export function ensureWatchedFile(watcher, file, root) {
  if (
    file &&
    !file.startsWith(withTrailingSlash(root)) &&
    fs.existsSync(file)
  ) {
    watcher.add(path.resolve(file))
  }
}
```

这意味着：

- `main.ts` 启动链路上引用的 shared 模块 → 应用启动后很快被 watch
- 某个 domain 页面组件 → 路由导航到该页面后才开始 watch
- 从未被 import 的文件 → 改了什么都不会发生

### 6.3 文件变更 → HMR 流程

```
                                            ┌─────────────┐
  保存 shared/utils/format.ts  →  chokidar  │  onFileChange │
                                            └──────┬──────┘
                                                   ▼
                                         moduleGraph.getModulesByFile(file)
                                                   ▼
                                           handleHMRUpdate(file, server)
                                                   ▼
                                        ┌──── 有 accept boundary? ────┐
                                        │                             │
                                     是 ▼                          否 ▼
                              ws.send('update', {                ws.send('full-reload')
                                type: 'js-update',               浏览器整页刷新
                                path: ...
                              })
                              浏览器增量更新模块
```

module graph 中存储的是 **realpath**（如 `shared/utils/src/format.ts`），与 symlink 路径无关。

### 6.4 组件 HMR vs Full Reload

| 改动类型 | 典型结果 | 原因 |
|----------|----------|------|
| domain 内 `.vue` 组件 | ✅ 组件级 HMR | `@vitejs/plugin-vue` 为每个 SFC 注册了 `accept` boundary |
| 被 `.vue` 引用的 composable | ✅ 通常 HMR | 沿 import 链向上传播到 `.vue` 的 accept boundary |
| `shared/stores` 中的 Pinia store | ⚠️ 易 full reload | store 被多处引用，传播到 `main.ts` 则整页刷新 |
| `shared/bootstrap` / router / i18n 配置 | ⚠️ 易 full reload | 位于应用启动链路的顶端，无 accept boundary |
| `main.ts` | ❌ 必定 full reload | 它就是模块图的 root，无法再向上传播 |

背后的原理：

普通 `.ts` 文件没有 `import.meta.hot.accept()` 调用（除非你手动加了）。当它被修改时，变更事件沿 import 链向上传播——谁 import 了这个文件，谁就被标记为需要更新。传播路径上如果遇到一个 `.vue` 文件（有 accept boundary），热更新就停住了，只更新该组件；如果一路传播到 `main.ts`（dead end），就只能整页刷新。

用一个具体场景说明：

```
// 改动了 shared/utils/src/format.ts

传播路径 A（HMR 成功）：
  format.ts → useTicket.ts (composable) → TicketCard.vue ← accept boundary ✅

传播路径 B（full reload）：
  format.ts → bootstrap.ts → main.ts ← dead end，full reload ⚠️
```

同一个文件的修改可能同时触发两条路径，此时 Vite 取"更严格"的结果——full reload。

## 七、踩坑与最佳实践

### 7.1 不要设 `resolve.preserveSymlinks: true`

如果开启了 `preserveSymlinks`，resolve 后的路径会停留在 `node_modules/…` 下，`isInNodeModules` 返回 true，workspace 包会被当作普通 npm 依赖预构建。此时需要手动排除：

```typescript
// 不推荐这样做，但如果不得不 preserveSymlinks: true
optimizeDeps: {
  exclude: [
    '@h5-journey/utils',
    '@h5-journey/bootstrap',
    '@h5-journey/ticket-resource-domain',
    // ... 每个 workspace 包都要列
  ]
}
```

默认行为（`preserveSymlinks: false`）已经能正确处理，不需要额外配置。

### 7.2 区分「类型检查」与「编译」

workspace 包只有 `type-check`（`vue-tsc --noEmit`），不 emit JS。CI 中应分别运行：

```bash
# 各包类型检查（可并行）
pnpm -r run type-check

# 应用构建（只在 packages/* 下）
pnpm --filter @h5-journey/ctshk run build
```

不要把 workspace 包的 `type-check` 和应用的 `build` 混为一谈。前者验证接口契约，后者生成可部署的产物。

### 7.3 HMR 排查清单

遇到 "改了代码没反应" 或 "改了就整页刷新" 时，按这个顺序排查：

1. **该文件是否已被浏览器加载过？**
   - 看终端，有没有该文件路径的 transform 日志
   - 如果从未加载，chokidar 还没 watch 它，改了不会触发任何事件
   - 手动刷新一次页面（触发加载 → 开始 watch），再试

2. **终端输出的是 `hmr update` 还是 `page reload`？**
   - `[vite] hmr update /path/to/file` → HMR 成功
   - `[vite] page reload` → 变更传播到了 dead end

3. **是否改了全局模块？**
   - stores、router、i18n、bootstrap 等文件在 import 链顶端
   - 考虑为它们手动添加 `import.meta.hot.accept()`（需谨慎处理副作用）

4. **是不是新文件 / 新 import？**
   - 新创建的文件需要先被某个已有模块 import，且被浏览器加载后才能触发 watch
   - 添加新 import 后通常需要手动刷新一次

### 7.4 可选：扩大 watch 范围

如果希望 root 外的目录更早被 watch（而不是等到首次加载），可以配置：

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    watch: {
      // 取消对 shared/ 和 domains/ 的忽略
      ignored: ['!**/shared/**', '!**/domains/**']
    }
  }
})
```

但这会让 chokidar 启动时扫描更多文件，在大型 monorepo 中可能影响 dev server 启动速度。大多数团队接受 lazy watch 的默认行为。

### 7.5 source-first vs dist-first 取舍

| 模式 | 优点 | 缺点 |
|------|------|------|
| **source-first**（本文案例） | 改源码即生效；无二次 build；调试路径清晰 | 应用 build 变慢（要编译全部 workspace 源码）；HMR 边界复杂 |
| **dist-first** | 应用 build 快（直接引用编译产物）；包版本边界清晰 | 每包需 build 脚本和 watch 模式；本地联调需同时开多个 watch |

在包数量较少（< 30）且团队技术栈统一（全部 Vue + TS）的场景下，source-first 通常是更好的选择。当 monorepo 规模增长到几十个包，或者包需要独立发布到 npm 时，dist-first 的编译隔离优势会更明显。

## 八、总结

用一张表回顾核心机制：

| 环节 | workspace 包的行为 | 普通 npm 包的行为 |
|------|-------------------|------------------|
| pnpm 安装 | symlink 到源码目录 | 实际安装到 `node_modules` |
| Vite resolve | follow symlink → realpath（不含 `node_modules`） | 路径本身就在 `node_modules` 中 |
| Dev 预构建 | **跳过**，继续 crawl 内部依赖 | esbuild 预构建到 `.vite/deps/` |
| Dev transform | 逐文件 on-demand transform（和 `src/` 一致） | 使用预构建缓存 |
| Build | Rollup 直接打入 bundle | 同样打入 bundle |
| HMR watch | lazy watch（首次加载后才开始） | 不 watch（用预构建缓存） |
| HMR 更新 | 遵循 accept boundary 规则 | N/A |

整条链路的核心设计思想是：**Vite 不关心你是不是 workspace 包，它只关心 resolve 后的路径在不在 `node_modules` 里。** symlink + realpath 的组合让 workspace 包"恰好"落在了源码侧。

理解了这一点，大多数 monorepo 中和 Vite 相关的构建问题——预构建缓存异常、workspace 包没有被编译、HMR 不生效、改了代码整页刷新——都能快速定位到原因。

## 决策清单

在你的 monorepo 中采用 source-first 之前，过一遍这个清单：

- [ ] 所有 workspace 包的 `exports` 都指向 `.ts` 源码（而非 `dist/`）
- [ ] 应用层的 `tsconfig.json` 能 resolve 到 workspace 包的类型
- [ ] `vite.config.ts` 没有设置 `resolve.preserveSymlinks: true`
- [ ] CI 分开运行 type-check 和 build
- [ ] 团队理解 HMR 的 lazy watch 行为和 accept boundary 规则
- [ ] 如需兼容旧浏览器，已配置 `@vitejs/plugin-legacy` 或手动 polyfill

## 参考资料

- [Vite Dependency Pre-Bundling — Monorepos and Linked Dependencies](https://vite.dev/guide/dep-pre-bundling#monorepos-and-linked-dependencies)
- [Vite resolve.preserveSymlinks](https://vite.dev/config/shared-options#resolve-preservesymlinks)
- [Vite server.watch](https://vite.dev/config/server-options#server-watch)
- Vite 5.0.8 源码：
  - `packages/vite/src/node/utils.ts` — `isInNodeModules`、`ensureWatchedFile`
  - `packages/vite/src/node/optimizer/scan.ts` — linked package crawl
  - `packages/vite/src/node/plugins/resolve.ts` — optimizeDeps 跳过逻辑
  - `packages/vite/src/node/server/hmr.ts` — HMR 传播

## 附录：术语表

| 术语 | 含义 |
|------|------|
| **source-first** | workspace 包 export TS/Vue 源码，不在包内 pre-build |
| **linked package** | Vite 术语：resolve 后路径不在 `node_modules` 中的依赖 |
| **optimizeDeps** | Dev 专用：用 esbuild 预构建 npm 依赖到 `.vite/deps/` |
| **lazy watch** | root 外文件仅在首次加载后加入 file watcher |
| **accept boundary** | HMR 可停住的模块边界（如 `.vue` SFC） |
| **realpath** | follow symlink 后的真实磁盘路径 |
