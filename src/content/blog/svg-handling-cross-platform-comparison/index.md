---
title: '各跨平台框架处理 SVG 的底层差异全解析'
description: '深入对比 Web、React Native、Flutter、Lynx 处理 SVG 的底层原理，剖析浏览器 img 引用与内联 SVG 的本质区别。'
publishDate: 2026-05-25
tags: ['svg', '跨平台', 'react-native', 'flutter', 'lynx', '前端']
language: 'zh'
draft: false
comment: true
---

# 各跨平台框架处理 SVG 的底层差异全解析

## 前言

SVG（Scalable Vector Graphics）是前端开发中最常用的矢量图形格式——图标、插画、Logo、数据可视化图表，到处都有它的身影。在 Web 浏览器中使用 SVG 已经是家常便饭，但当我们把目光扩展到 React Native、Flutter、Lynx 这些跨平台框架时，会发现它们对 SVG 的处理方式有着根本性的差异。

这些差异不是 API 层面的"写法不同"那么简单，而是由各框架的渲染架构决定的。本文将从底层原理出发，逐一拆解每个框架处理 SVG 的方式，并在最后做一个横向对比。

额外地，本文还会深入分析一个 Web 开发中容易被忽略的问题：用 `<img src="icon.svg">` 加载 SVG 和直接将 `<svg>` 标签写进 HTML 页面，**底层到底有什么不同？**

## 一、Web 浏览器：SVG 的"原生领地"

Web 是 SVG 的诞生地，浏览器对 SVG 的支持最为完整。但即便在 Web 中，SVG 的嵌入方式不同，浏览器的处理策略也截然不同。

### 1.1 内联 SVG：融入 DOM 树

将 `<svg>` 标签直接写在 HTML 中，SVG 的所有元素会成为当前页面 DOM 树的一部分：

```html
<div class="icon-wrapper">
  <svg viewBox="0 0 24 24" width="24" height="24">
    <path
      d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
      stroke="currentColor"
      fill="none"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
</div>
```

**浏览器的处理流程：**

1. HTML 解析器遇到 `<svg>` 标签，切换到 SVG 命名空间进行解析。
2. SVG 内的每个元素（`<path>`、`<circle>`、`<g>` 等）都被创建为 DOM 节点，挂到当前文档的 DOM 树上。
3. 布局引擎为每个 SVG 根元素创建一个 `LayoutSVGRoot`，内部元素各自有对应的布局对象。
4. 渲染时，SVG 元素和普通 HTML 元素一样参与页面的合成和绘制流程。

因为 SVG 节点就是 DOM 节点，所以可以：

```css
/* 用 CSS 控制 SVG 内部元素 */
.icon-wrapper svg path {
  stroke: #333;
  transition: stroke 0.2s;
}
.icon-wrapper:hover svg path {
  stroke: #0066ff;
}
```

```javascript
// 用 JS 操作 SVG 内部元素
const path = document.querySelector('.icon-wrapper svg path');
path.addEventListener('click', () => {
  path.setAttribute('stroke', 'red');
});
```

### 1.2 img 引用 SVG：隔离沙箱

用 `<img>` 标签加载 SVG 时，浏览器会用完全不同的策略来处理：

```html
<img src="/icons/layers.svg" alt="layers icon" width="24" height="24" />
```

**浏览器的处理流程（以 Chromium 为例）：**

1. 图片加载器发起请求，拿到 SVG 文件内容。
2. 创建一个 `SVGImage` 对象——这不是普通的位图 `Image`，而是一个 **隔离的沙箱文档**。
3. 这个沙箱包含：
   - 独立的 `Page` 对象（**JavaScript 被禁用**）
   - 独立的 `Document`，持有解析后的 SVG 树
   - 独立的 `LocalFrame`，有自己的事件循环——但**不接受任何用户交互**（无指针事件、无焦点）
4. 绘制时，`SVGImage` 走标准的 paint 路径，生成一个 `PaintRecord`，然后由 compositor 光栅化。
5. **不缓存位图**——缩放时会以目标分辨率重新绘制，所以不会糊。

这段机制的核心点在于"隔离"：

```html
<!-- 这个 SVG 文件中的 JS 不会执行 -->
<!-- layers.svg -->
<svg xmlns="http://www.w3.org/2000/svg">
  <script>alert('XSS!')</script>  <!-- 被禁用 -->
  <circle cx="12" cy="12" r="10" fill="red"
    onclick="alert('click')" />     <!-- 事件不会触发 -->
</svg>
```

### 1.3 两种方式的底层差异

从 Chromium 的实现看，`<img>` 引用 SVG 和内联 SVG 的差异可以用一张表概括：

| 维度 | 内联 `<svg>` | `<img src="*.svg">` |
|------|-------------|---------------------|
| Document | 宿主页面的文档 | 隔离的沙箱文档 |
| DOM 树 | SVG 节点在页面 DOM 树中 | SVG 树在独立文档中，页面无法访问 |
| JavaScript | 可执行（跟随宿主页面） | 禁用 |
| CSS 样式 | 可被页面 CSS 选中和修改 | 无法被页面 CSS 影响 |
| `currentColor` | 继承父元素颜色 | 不可用 |
| 事件交互 | 支持 click、hover 等 | 仅 `<img>` 元素本身可接受事件 |
| 外部资源加载 | 允许 | 禁止（字体、图片、样式表均不加载） |
| 动画 | 支持 SMIL、CSS、JS 动画 | 仅支持 SMIL 和 CSS 动画 |
| 缓存 | 不缓存（每次解析 HTML 都重新解析） | 浏览器按正常图片缓存策略缓存 |
| 安全模型 | 无隔离，需自行清理不可信 SVG | 沙箱隔离，`<script>` 不执行 |

**这个差异的本质是**：内联 SVG 是文档的一部分，`<img>` 引用的 SVG 是一个被沙箱化的独立文档。浏览器用"安全降级"的方式换取了隔离性——禁用脚本、禁止外部资源加载、切断事件传播。

### 1.4 其他嵌入方式

除了 `<img>` 和内联，Web 中还有其他嵌入 SVG 的方式：

```html
<!-- object/embed：独立 frame 文档，JS 可以运行 -->
<object type="image/svg+xml" data="/icons/chart.svg"></object>

<!-- CSS background-image：和 img 一样走沙箱文档 -->
<div style="background-image: url('/icons/bg.svg')"></div>

<!-- SVG Sprite + use：内联定义，use 引用 -->
<svg style="display: none">
  <defs>
    <symbol id="icon-home" viewBox="0 0 24 24">
      <path d="M3 12l9-9 9 9M5 10v10h14V10" />
    </symbol>
  </defs>
</svg>
<svg width="24" height="24"><use href="#icon-home" /></svg>
```

| 方式 | 缓存 | CSS/JS 访问 | 可复用 | 安全沙箱 |
|------|------|------------|--------|---------|
| 内联 `<svg>` | ❌ | ✅ 完全 | ❌ | ❌ |
| `<img>` | ✅ | ❌ | ✅ | ✅ |
| `<object>` | ✅ | 有限 | ✅ | ❌（独立 frame） |
| CSS `background-image` | ✅ | ❌ | ✅ | ✅ |
| SVG Sprite + `<use>` | 部分 | ✅ | ✅ | ❌ |

在实际项目中，图标系统通常采用 SVG Sprite 或内联方式（配合构建工具如 `@svgr/webpack` 自动转换），装饰性插图则用 `<img>` 或 `background-image`。

## 二、React Native：原生 Canvas 绘制

React Native 本身**不内置 SVG 支持**。要在 RN 中使用 SVG，需要引入社区库 `react-native-svg`，它是目前唯一的主流方案。

### 2.1 底层架构

`react-native-svg` 的实现思路是：**将 JS 侧的 SVG 组件树翻译成原生视图，在原生 Canvas 上绘制**。

```
JS 侧                         原生侧
┌────────────┐                ┌──────────────┐
│ <Svg>      │ ──Fabric/JSI→ │ SvgView      │
│  <Circle>  │                │  (Canvas)    │
│  <Path>    │                │   draw()     │
│  <G>       │                │   invalidate│
│ </Svg>     │                └──────────────┘
└────────────┘
```

具体来说：

1. JS 侧每个 SVG 元素（`<Svg>`、`<Circle>`、`<Path>` 等）都对应一个 React 组件，这些组件通过 `codegenNativeComponent` 映射到原生视图。
2. 原生侧的 `SvgView` 是一个自定义 `View`（Android）或 `UIView`（iOS），它持有一棵子元素树。
3. 渲染时，`SvgView` 遍历子元素树，每个子元素（`VirtualView` / `RenderableView`）在原生 `Canvas`（Android）或 `CGContext`（iOS）上调用绘制方法。
4. 对于 mask、filter 等特效，使用离屏 `Bitmap` / 离屏层来实现。

### 2.2 代码示例

```tsx
import Svg, { Circle, Rect, G, Defs, LinearGradient, Stop } from 'react-native-svg';

function GradientCard() {
  return (
    <Svg width={200} height={120} viewBox="0 0 200 120">
      <Defs>
        <LinearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#667eea" />
          <Stop offset="100%" stopColor="#764ba2" />
        </LinearGradient>
      </Defs>
      <Rect width={200} height={120} rx={12} fill="url(#grad)" />
      <G transform="translate(80, 30)">
        <Circle cx={20} cy={20} r={18} fill="rgba(255,255,255,0.3)" />
        <Circle cx={20} cy={20} r={10} fill="white" />
      </G>
    </Svg>
  );
}
```

### 2.3 关键实现细节

**Fabric 架构下的 Shadow Node**

在 React Native 新架构（Fabric）中，`react-native-svg` 为每个 SVG 元素创建 Shadow Node。但 SVG 元素的布局不依赖 Yoga——SVG 有自己的坐标系统和变换矩阵，它绕过了 Yoga 的 FlexBox 布局。Shadow Node 的尺寸被设置为 absolute fill（`position: absolute; 100% x 100%`），这是为了让 `onPress` 等触摸事件的命中测试能正确工作。

**绘制流程**

Android 端的 `RenderableView.render()` 方法：

```
render(Canvas, Paint, opacity)
  ├─ 检查 mask → 有则创建离屏 Bitmap
  ├─ 检查 filter → 有则创建离屏层
  ├─ draw(Canvas, Paint, opacity)
  │   ├─ 构建 Path 对象
  │   ├─ 应用 transform 矩阵
  │   ├─ 设置 fill/stroke Paint
  │   └─ canvas.drawPath(path, paint)
  └─ 应用 mask alpha 通道混合
```

iOS 端类似，只是用 `CGContext` 替代 `Canvas`，用 `CGPath` 替代 `Path`。

**性能特征**

由于每个 SVG 元素都是一个原生 View（至少在 Shadow Tree 中是），大量 SVG 元素会带来额外的内存和渲染开销。对于复杂的 SVG（几百个 path），性能会明显下降。常见的优化手段是把复杂 SVG 预渲染为 PNG，或者使用 `react-native-svg` 的 `toDataURL` 方法导出为位图。

## 三、Flutter：Dart 层解析 + Skia/Impeller 绘制

Flutter 的渲染架构是自绘引擎——所有 UI 都通过 Skia（或其后继者 Impeller）直接绘制到 GPU Surface 上，不使用平台原生控件。SVG 的处理也延续了这个思路。

### 3.1 flutter_svg 的工作原理

Flutter 同样不内置 SVG 支持，社区标准库是 `flutter_svg`（现已被 Flutter 团队官方维护）。

```
SVG XML 文件
    │
    ▼ (Dart 层 XML 解析)
DrawableRoot（Dart 对象树）
    │
    ▼ (转换)
ui.Picture（Skia SkPicture 的 Dart 包装）
    │
    ▼ (绘制)
Canvas.drawPicture() → Skia/Impeller → GPU
```

核心流程：

1. **解析**：`flutter_svg` 在 Dart 层解析 SVG XML，构建一棵 `DrawableRoot` 对象树。这一步完全不涉及原生代码——path 解析、渐变计算、transform 处理都在 Dart 中完成。
2. **录制**：将 `DrawableRoot` 录制为 `ui.Picture`——这是 Skia `SkPicture` 的 Dart 包装，本质是一系列绘制命令的录制（类似 Canvas 的"录像带"）。
3. **缓存**：`SvgPicture` Widget 内置了 `PictureProvider` 缓存机制，相同的 SVG 资源只解析一次。
4. **绘制**：在 `paint()` 阶段，Flutter 调用 `Canvas.drawPicture()` 将录制的绘制命令回放到渲染表面上。

### 3.2 代码示例

```dart
import 'package:flutter_svg/flutter_svg.dart';
import 'package:vector_graphics/vector_graphics.dart';

// 方式一：运行时解析 SVG
Widget buildFromAsset() {
  return SvgPicture.asset(
    'assets/icons/home.svg',
    width: 24,
    height: 24,
    colorFilter: ColorFilter.mode(Colors.blue, BlendMode.srcIn),
  );
}

// 方式二：加载预编译的 .vec 文件（推荐）
Widget buildFromPrecompiled() {
  return const SvgPicture(
    AssetBytesLoader('assets/icons/home.svg.vec'),
  );
}

// 方式三：从网络加载
Widget buildFromNetwork() {
  return SvgPicture.network(
    'https://example.com/icons/home.svg',
    placeholderBuilder: (context) => const CircularProgressIndicator(),
  );
}

// 方式四：从 SVG 字符串渲染
Widget buildFromString() {
  const svgString = '''
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" fill="#4CAF50" />
    </svg>
  ''';
  return SvgPicture.string(svgString, width: 48, height: 48);
}
```

### 3.3 预编译优化：vector_graphics_compiler

`flutter_svg` 的一个重要特性是支持 **构建时预编译**。通过 `vector_graphics_compiler`，可以在构建阶段将 SVG XML 转换为紧凑的二进制格式（`.vec` 文件）：

```bash
dart run vector_graphics_compiler -i assets/icon.svg -o assets/icon.svg.vec
```

也可以在 `pubspec.yaml` 中配置自动转换：

```yaml
flutter:
  assets:
    - path: assets/icons/home.svg
      transformers:
        - package: vector_graphics_compiler
```

预编译的好处：
- **跳过运行时 XML 解析**：`.vec` 是二进制格式，加载速度远快于 XML 解析。
- **编译期优化**：编译器会执行 opacity peepholing（透明度合并）、transformation inlining（变换内联）、group collapsing（分组折叠）、mask/clip elimination（遮罩/裁剪消除）等优化，减少运行时绘制开销。
- **减少包体积**：二进制格式比 XML 文本更紧凑。

### 3.4 两种渲染策略

`flutter_svg` 提供了两种渲染策略：

```dart
// picture 模式（默认）：保留矢量特性，缩放不失真
SvgPicture.asset('icon.svg', strategy: SvgRenderStrategy.picture);

// raster 模式：先光栅化为 Image，再用 drawImage 绘制
// 牺牲缩放灵活性，换取绘制性能
SvgPicture.asset('icon.svg', strategy: SvgRenderStrategy.raster);
```

`picture` 模式下每次绘制都回放完整的 `Picture` 命令序列；`raster` 模式下先光栅化为固定分辨率的位图缓存，后续绘制只需要一次 `drawImage`。对于不需要动态缩放的图标场景，`raster` 模式性能更优。

## 四、Lynx：后台线程解析 + 单视图渲染

Lynx（字节跳动的跨平台框架）对 SVG 的处理方式是四个框架中比较独特的——它内置了 `<svg>` 元素支持，不需要第三方库。

### 4.1 底层实现原理

Lynx SVG 的设计目标是**高性能的静态渲染**，它的策略是：

```
SVG 标记
    │
    ▼ (后台线程)
解析 SVG 标签和属性
    │
    ▼
生成绘制指令
    │
    ▼ (主线程)
作为单个原生视图渲染
```

关键设计决策：

1. **后台线程解析**：SVG 的 XML 解析不在主线程上进行，避免了复杂 SVG 解析阻塞 UI。
2. **单视图渲染**：不论 SVG 内部有多少元素，整个 SVG 图形只创建**一个原生视图**。这和 React Native 的"每个元素一个 View"形成了鲜明对比。
3. **有限的标签支持**：覆盖 17 个最常用的 SVG 标签和 40+ 属性，足以满足图标和常见矢量图形的需求，但不支持完整的 SVG 规范。

### 4.2 代码示例

```tsx
// ReactLynx 中使用内联 SVG
function IconButton() {
  return (
    <view style={{ flexDirection: 'row', alignItems: 'center', padding: 12 }}>
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" fill="#4CAF50" />
        <path d="M9 12l2 2 4-4" stroke="white" stroke-width="2" fill="none" />
      </svg>
      <text style={{ marginLeft: 8 }}>已完成</text>
    </view>
  );
}
```

### 4.3 支持的 SVG 标签

| 标签 | 用途 |
|------|------|
| `svg` | 根元素 |
| `circle`、`ellipse`、`rect`、`line` | 基本图形 |
| `path`、`polygon`、`polyline` | 路径和多边形 |
| `g` | 分组 |
| `defs`、`use` | 定义和复用 |
| `linearGradient`、`radialGradient`、`stop` | 渐变 |
| `clipPath` | 裁剪路径 |
| `text` | 文本 |
| `image` | 嵌入栅格图像 |

### 4.4 限制

- **不支持通过 `<image>` 元素加载 SVG 文件**：Lynx 的 `<image>` 组件目前只支持 PNG/JPG 等栅格图像格式，不能直接加载 `.svg` 文件。要使用 SVG 必须用内联 `<svg>` 标签。
- **不支持 SVG 动画**：没有 SMIL 支持，也不支持 CSS 动画作用于 SVG 内部元素。
- **不支持 SVG 滤镜**：`<filter>`、`<feGaussianBlur>` 等元素不可用。
- **交互有限**：SVG 作为单个视图渲染，无法对内部元素单独绑定事件。

## 五、横向对比

### 5.1 渲染管线对比

```
Web 内联 SVG:
  HTML Parser → DOM Node → LayoutSVGRoot → Paint → Compositor → GPU

Web <img> SVG:
  Image Loader → SVGImage(沙箱 Document) → Paint → PaintRecord → Compositor → GPU

React Native (react-native-svg):
  JSX → Fabric/JSI → SvgView(原生) → Canvas/CGContext 逐元素绘制

Flutter (flutter_svg):
  SVG XML → Dart 解析 → DrawableRoot → ui.Picture → Canvas.drawPicture → Skia/Impeller → GPU

Lynx (<svg> 内置):
  SVG 标记 → 后台线程解析 → 单原生视图 → 绘制
```

### 5.2 核心差异总览

| 维度 | Web 内联 | Web img | React Native | Flutter | Lynx |
|------|---------|---------|--------------|---------|------|
| SVG 支持 | 原生，完整规范 | 原生，沙箱模式 | 第三方库 | 第三方库 | 内置，部分规范 |
| 解析方式 | HTML 解析器 | 隔离文档解析 | JS → 原生映射 | Dart 层 XML 解析 | 后台线程解析 |
| 渲染方式 | DOM 合成绘制 | 沙箱文档绘制 | 原生 Canvas 绘制 | Skia/Impeller 绘制 | 单原生视图绘制 |
| 每个元素是否创建视图 | DOM 节点（非视图） | 否 | 是（Shadow Node） | 否（一个 Picture） | 否（一个视图） |
| CSS 样式控制 | ✅ 完全支持 | ❌ 不可达 | ❌ 无 CSS | ❌ 无 CSS | ❌ 无 CSS |
| JS/交互 | ✅ 完全支持 | ❌ 禁用 | ✅ onPress 等 | ✅ GestureDetector | ❌ 整体事件 |
| 动画 | ✅ SMIL/CSS/JS | ⚠️ SMIL/CSS | ✅ Animated API | ✅ Animation API | ❌ 不支持 |
| 缓存 | ❌ | ✅ 浏览器缓存 | ❌ | ✅ PictureProvider | — |
| 预编译 | ❌ | ❌ | ❌ | ✅ .vec 格式 | ❌ |
| SVG 规范覆盖度 | 完整 | 完整（功能受限） | 大部分 | 大部分 | 17 个标签 |

### 5.3 使用方式对比

**相同的"对勾图标"在各框架中的实现：**

**Web 内联 SVG：**
```html
<svg viewBox="0 0 24 24" width="24" height="24" class="icon-check">
  <path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2"
    fill="none" stroke-linecap="round" stroke-linejoin="round" />
</svg>
```

**Web img 引用：**
```html
<img src="/icons/check.svg" alt="check" width="24" height="24" />
```

**React Native：**
```tsx
import Svg, { Path } from 'react-native-svg';

function CheckIcon({ color = '#333', size = 24 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M5 13l4 4L19 7" stroke={color} strokeWidth={2}
        fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
```

**Flutter：**
```dart
SvgPicture.asset(
  'assets/icons/check.svg',
  width: 24,
  height: 24,
  colorFilter: ColorFilter.mode(Colors.grey, BlendMode.srcIn),
)
```

**Lynx：**
```tsx
<svg width="24" height="24" viewBox="0 0 24 24">
  <path d="M5 13l4 4L19 7" stroke="#333" stroke-width="2"
    fill="none" stroke-linecap="round" stroke-linejoin="round" />
</svg>
```

### 5.4 性能特征对比

| 场景 | Web | React Native | Flutter | Lynx |
|------|-----|-------------|---------|------|
| 少量简单图标 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 大量重复图标 | ⭐⭐⭐（内联）/⭐⭐⭐⭐⭐（sprite） | ⭐⭐⭐ | ⭐⭐⭐⭐（缓存） | ⭐⭐⭐⭐ |
| 复杂矢量插画 | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐（预编译后⭐⭐⭐⭐⭐） | ⭐⭐⭐ |
| 需要动态着色 | ⭐⭐⭐⭐⭐（currentColor） | ⭐⭐⭐⭐ | ⭐⭐⭐⭐（colorFilter） | ⭐⭐⭐ |
| SVG 动画 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ❌ |

## 六、工程实践建议

### 6.1 Web 项目

- **图标系统**：使用 SVG Sprite 或配合 `@svgr/webpack` 将 SVG 转为 React 组件（内联方式），支持 `currentColor` 和 CSS 控制。
- **装饰性图形**：用 `<img>` 引用，利用浏览器缓存。
- **用户上传的 SVG**：一律用 `<img>` 加载，禁止内联。如果必须内联，用 DOMPurify 等库做白名单清洗。

### 6.2 React Native 项目

- **简单图标**：使用 `react-native-svg` 配合 `react-native-svg-transformer`，在构建时将 `.svg` 文件转为 React 组件。
- **复杂插画**：考虑预渲染为 PNG（@2x、@3x），避免运行时 Canvas 绘制开销。
- **动态 SVG**：`react-native-svg` 支持 `Animated` API，但复杂动画性能不如 `react-native-reanimated` + Skia 组合。

### 6.3 Flutter 项目

- **优先使用预编译**：配置 `vector_graphics_compiler` 作为 asset transformer，享受构建时优化。
- **图标场景**：`SvgPicture.asset()` 配合 `colorFilter` 实现动态着色。
- **性能敏感场景**：使用 `raster` 渲染策略，用空间换时间。

### 6.4 Lynx 项目

- **内联 SVG 是唯一选择**：Lynx 的 `<image>` 不支持 SVG 格式，必须使用 `<svg>` 标签。
- **控制复杂度**：由于只支持 17 个标签，复杂的 SVG 资源（含滤镜、动画）需要先简化或降级为栅格图像。
- **避免大量 SVG**：虽然单视图渲染效率不错，但后台线程解析仍有成本。

## 总结

四个框架对 SVG 的处理差异，本质上是由各自的渲染架构决定的：

- **Web** 是 SVG 的原生宿主，浏览器的 DOM 引擎和渲染管线天然支持 SVG，区分内联和引用两种模式本质上是安全隔离与灵活性之间的权衡。
- **React Native** 没有 DOM，也没有自绘引擎，所以 `react-native-svg` 选择了"逐元素映射到原生 View + Canvas 绘制"的方案——灵活但不够高效。
- **Flutter** 有自绘引擎但没有内置 SVG 解析，`flutter_svg` 在 Dart 层解析 SVG 并转换为 Skia 绘制命令——通过预编译优化弥补了运行时解析的开销。
- **Lynx** 内置了有限的 SVG 支持，用"后台线程解析 + 单视图渲染"的策略在性能和功能之间取了一个平衡点。

没有"最好"的方案，只有最适合当前框架架构和业务场景的方案。理解底层原理，才能在遇到 SVG 相关的性能问题或兼容性问题时，快速定位到根因。

## 参考资料

- [Chromium SVG as Image 实现分析](https://grida.co/docs/wg/research/chromium/svg/svg-as-image)
- [SVG Security - W3C Wiki](https://www.w3.org/wiki/SVG_Security)
- [SVG Integration Spec](https://svgwg.org/specs/integration/)
- [react-native-svg GitHub](https://github.com/software-mansion/react-native-svg)
- [flutter_svg Documentation](https://pub.dev/packages/flutter_svg)
- [vector_graphics_compiler](https://pub.dev/packages/vector_graphics_compiler)
- [Lynx SVG API](https://lynxjs.org/api/elements/built-in/svg)
- [SVGs on the Web: Performance Comparison](https://joanleon.dev/en/svg-optimization/)
