---
title: 'Valdi 跨平台框架核心原理拆解与横向对比'
description: '从编译产物、运行时架构、渲染协议三个层面拆解 Snapchat Valdi 的核心原理，并与 Flutter、Lynx、React Native 横向对比。'
publishDate: 2026-05-09
tags: ['跨平台', 'valdi', 'flutter', 'react-native', 'lynx']
language: 'zh'
draft: false
comment: true
---

# Valdi 跨平台框架核心原理拆解与横向对比

## 前言

2025 年底，Snapchat 将内部使用了 8 年的跨平台 UI 框架 Valdi 以 MIT 协议开源。这个框架在 Snapchat 的生产环境中驱动了几乎所有界面——从完整页面到嵌入在原生视图中的小组件——累计由 Snap 工程师编写了近 200 万行 TypeScript 代码。

在 React Native 的新架构已经移除 JS Bridge、Flutter 凭借自绘引擎建立起庞大生态、Lynx 以双线程模型切入市场的当下，Valdi 选择了一条不同的路：**将 TypeScript 编译为 `.valdimodule`，由 C++ 运行时直接驱动原生视图，不依赖 WebView，也不走传统意义上的 JS Bridge。**

本文将从编译产物、运行时架构、渲染协议三个层面拆解 Valdi 的核心原理，并在文末给出与 Flutter、Lynx、React Native 的横向对比和现状分析。

## 一、分层架构总览

Valdi 的架构分为四层，从上到下依次是：

```
┌──────────────────────────────────────┐
│  Feature Layer (TypeScript)          │  ← 业务 UI 与逻辑
├──────────────────────────────────────┤
│  Framework Layer (TypeScript / C++)  │  ← 组件生命周期、渲染器
├──────────────────────────────────────┤
│  Core Layer (C++)                    │  ← JS 引擎 + Yoga 布局 + UI 更新
├──────────────────────────────────────┤
│  Integration Layer (ObjC/Swift/Kt)   │  ← 平台原生视图映射
└──────────────────────────────────────┘
```

- **Feature Layer**：开发者编写的业务代码，使用 React 风格的 TSX 语法定义 UI。
- **Framework Layer**：管理组件和元素的生命周期，处理渲染请求。
- **Core Layer**：C++ 编写的运行时核心，集成 JS 引擎（iOS 端用 JavaScriptCore，Android/Desktop 端用 QuickJS/Hermes）和 Yoga 布局引擎。
- **Integration Layer**：将抽象的 `<view>`、`<label>` 等元素映射到平台原生视图——iOS 端是 `UIView`、`UILabel`，Android 端是 `ViewGroup`、`TextView`。

这种分层的关键意义在于：**主线程上跑的逻辑全部是 C++ 代码**，JS 引擎和布局计算都在 C++ 层完成，最大程度减少了跨语言调用的开销。

## 二、编译产物与模块加载

### 2.1 三种编译模式

Valdi 编译器将 TypeScript 源码打包成 `.valdimodule` 文件，支持三种输出模式：

| 模式 | 产物 | 执行方式 | 适用场景 |
|------|------|----------|----------|
| JS Source | 编译 + 压缩后的 JS | JS 引擎解释执行 | 开发调试 |
| JS Bytecode | 预编译为字节码 | JS 引擎直接加载（默认） | 生产环境 |
| Native | TS → C → Clang 编译 | 编入应用二进制 | 极致性能 |

三种模式之间可以完全互操作——一个 bytecode 模块可以无缝调用一个 native 模块，反之亦然。Snapchat 在 2025 年底的生产环境中同时运行着约 600 个 `.valdimodule`。

### 2.2 延迟加载

Valdi 的模块加载器使用 ES6 Proxy 实现了懒加载：当一个模块被 `require()` 时，返回的是一个 Proxy 对象，模块代码只在首次访问属性时才真正执行。

```typescript
// 这里不会立即执行 heavy_module 的代码
import { HeavyComponent } from 'heavy_module/src/HeavyComponent';

// 只有当 HeavyComponent 真正被使用时，模块才会被求值
<HeavyComponent />;
```

这种设计解决了大型应用中一个常见的痛点：随着代码量增长，主 bundle 的加载时间线性增长。在 Valdi 中，每个模块都是独立的，不存在一个 `main.jsbundle`，冷启动时间不会随代码规模膨胀。

## 三、组件模型与渲染机制

### 3.1 组件基础

Valdi 的组件模型基于类，核心生命周期方法有四个：

```typescript
import { Component } from 'valdi_core/src/Component';

interface TodoItemViewModel {
  title: string;
  completed: boolean;
}

class TodoItem extends Component<TodoItemViewModel> {
  onCreate() {
    // 组件创建时调用，用于初始化资源、订阅
  }

  onViewModelUpdate(previous?: TodoItemViewModel) {
    // viewModel 变化时调用，适合触发异步操作
  }

  onRender() {
    // 声明式定义子元素
    const { title, completed } = this.viewModel;
    <view flexDirection="row" padding={12} backgroundColor={completed ? '#e8f5e9' : 'white'}>
      <view
        width={24} height={24}
        backgroundColor={completed ? '#4caf50' : '#e0e0e0'}
        borderRadius={12}
        onTap={this.onToggle}
      />
      <label
        value={title}
        marginLeft={12}
        fontSize={16}
        color={completed ? '#9e9e9e' : '#212121'}
      />
    </view>;
  }

  onDestroy() {
    // 组件销毁时调用，清理资源
  }

  private onToggle = () => {
    // 通过 context 通知原生层
    this.context.onToggleCompleted?.();
  };
}
```

### 3.2 JSX 的本质差异

Valdi 的 TSX 看起来和 React 很像，但底层语义完全不同：

- **React**：JSX 表达式返回虚拟 DOM 对象，需要 reconciler 做 diff。
- **Valdi**：JSX 表达式返回 `void`，直接突变渲染器的栈。

```typescript
// React 中 JSX 返回的是对象
const element = <div>Hello</div>; // => React.createElement('div', null, 'Hello')

// Valdi 中 JSX 是副作用操作
// <view> 会被编译为 jsx.beginElement(__viewNodePrototype)
// 不会创建中间对象，也不需要 diff
```

这意味着 Valdi 的渲染天然就是增量的：一个组件重新渲染时，不会触发父组件的重新渲染；子组件只在 `viewModel` 引用发生变化时才会重新渲染。框架在很多情况下可以跳过中间层级的组件，直接更新目标组件。

### 3.3 原生元素映射

Valdi 提供了一组内置的原生元素，每个元素直接对应平台原生视图：

| 元素 | iOS | Android | 用途 |
|------|-----|---------|------|
| `<view>` | UIView | ViewGroup | 容器，支持布局和视觉属性 |
| `<layout>` | — | — | 仅用于布局，不创建原生视图 |
| `<label>` | UITextView | TextView | 文本显示 |
| `<image>` | UIImageView | ValdiImageView | 图片 |
| `<scroll>` | SCValdiScrollView | ValdiScrollView | 滚动容器 |
| `<text-input>` | UITextField | EditText | 单行输入 |
| `<text-area>` | UITextView | EditText | 多行输入 |

其中 `<layout>` 是一个特殊的优化节点——它参与 FlexBox 布局计算，但不会创建对应的原生视图，适合用于纯布局对齐的场景。

## 四、渲染协议与性能优化

### 4.1 RenderRequest 二进制协议

当 TypeScript 侧的渲染器完成一次 render pass 后，它会向 C++ 运行时提交一个 `RenderRequest`，由三部分组成：

1. **treeId**：标识要更新的元素树。
2. **descriptor**：一个 `ArrayBuffer`，包含序列化的二进制命令。
3. **values**：一个数组，存放不能序列化的 JS 值（如回调函数、原生对象引用）。

二进制协议中每个命令以 4 字节头部开始：1 字节的 `CommandType` 枚举 + 3 字节的 `ElementId`。常见命令如 `CreateElement`（8 字节）、`DestroyElement`（4 字节）、`MoveElementToParent`（12 字节）、`SetAttributeInt`（12 字节）等，都经过精心设计以最小化序列化开销。

### 4.2 Valdi::Value 数据容器

跨语言通信的核心是一个叫 `Valdi::Value` 的 128 位数据容器：

- 64 位用于数据存储（或指针）
- 64 位用于类型元数据
- 线程安全、不可变、引用计数
- 设计目标是零拷贝跨桥

这个统一的数据表示避免了在 TypeScript、Objective-C、Java 之间来回转换的开销。

### 4.3 字符串驻留与样式缓存

Valdi 在桥接层面做了两个关键的优化：

- **字符串驻留（Interned Strings）**：所有唯一字符串只存储一次，`StringBox` 持有驻留字符串的引用，字符串比较退化为指针比较。
- **样式驻留（Interned Styles）**：`Style<>` 对象在首次使用时被驻留，后续传递只需要一个整数 ID，而不是完整的属性字典。

```typescript
// 推荐：样式对象只创建一次，后续复用时跨桥开销极低
const cardStyle = Style.create({
  backgroundColor: 'white',
  padding: 16,
  borderRadius: 8,
});

class CardList extends Component {
  onRender() {
    for (const card of this.viewModel.cards) {
      <view style={cardStyle} key={card.id}>
        <label value={card.title} />
      </view>;
    }
  }
}
```

### 4.4 全局视图回收池

Valdi 维护了一个全局的原生视图池。当一个视图被从屏幕上移除时，它不会立即销毁，而是被回收到池中等待复用。这个机制跨越了所有组件和页面，与 RecyclerView 仅在单个列表内复用不同，Valdi 的视图池是全局共享的。

### 4.5 视口感知渲染

在滚动容器中，Valdi 只对当前可见区域内的元素创建原生视图，让无限滚动场景下也不会出现内存暴涨的问题。

## 五、原生互操作

### 5.1 在 Valdi 中嵌入原生视图

通过 `<custom-view>` 可以将原生视图嵌入 Valdi 的布局树：

```typescript
class MapScreen extends Component {
  onRender() {
    <view flex={1}>
      <label value="附近的地点" fontSize={20} padding={16} />
      <custom-view
        iosClass="MKMapView"
        androidClass="com.google.android.gms.maps.MapView"
        flex={1}
      />
    </view>;
  }
}
```

### 5.2 在原生应用中嵌入 Valdi 组件

反过来也可以——在已有的原生应用中嵌入 Valdi 组件：

```typescript
/**
 * @Component
 * @ExportModel({
 *   ios: 'SCProfileCardView',
 *   android: 'com.snap.profile.ProfileCardView'
 * })
 */
class ProfileCard extends Component<ProfileCardViewModel> {
  onRender() {
    <view padding={16} backgroundColor="white" borderRadius={12}>
      <image source={this.viewModel.avatar} width={64} height={64} borderRadius={32} />
      <label value={this.viewModel.name} fontSize={18} marginTop={8} />
      <label value={this.viewModel.bio} fontSize={14} color="#666" marginTop={4} />
    </view>;
  }
}
```

iOS 端使用：

```objectivec
SCValdiRuntimeManager *runtimeManager = [[SCValdiRuntimeManager alloc] init];
UIView *profileCard = [[SCProfileCardView alloc]
    initWithViewModel:viewModel
     componentContext:nil
     runtime:runtimeManager.mainRuntime];
[self.view addSubview:profileCard];
```

Android 端使用：

```kotlin
val runtimeManager = SupportValdiRuntimeManager.createWithSupportLibs(applicationContext)
val profileCard: View = ProfileCardView.create(
    runtime = runtimeManager.mainRuntime,
    viewModel = viewModel
)
container.addView(profileCard)
```

### 5.3 类型安全的跨语言绑定

Valdi 通过注解自动生成原生端的类型安全接口：

```typescript
/**
 * @Context
 * @ExportModel({
 *   ios: 'SCPaymentContext',
 *   android: 'com.snap.payment.PaymentContext'
 * })
 */
interface PaymentContext {
  processPayment?(amount: number, completion: (success: boolean) => void);
}

class PaymentButton extends Component<{ amount: number }, PaymentContext> {
  onRender() {
    <view onTap={this.onPay} padding={16} backgroundColor="#4caf50" borderRadius={8}>
      <label value={`支付 ¥${this.viewModel.amount}`} color="white" fontSize={16} />
    </view>;
  }

  private onPay = () => {
    this.context.processPayment?.(this.viewModel.amount, (success) => {
      if (success) {
        // 更新 UI 状态
      }
    });
  };
}
```

编译器会自动生成对应的 Objective-C/Kotlin 类，原生端只需要实现接口即可，不需要手写任何序列化/反序列化代码。

## 六、横向对比：Valdi vs Flutter vs Lynx vs React Native

这四个框架虽然都解决"一套代码，多端运行"的问题，但在技术路径上差异很大。

### 6.1 架构路线对比

| 维度 | Valdi | Flutter | Lynx | React Native |
|------|-------|---------|------|-------------|
| 开发语言 | TypeScript (TSX) | Dart | TypeScript (JSX) | TypeScript (JSX) |
| 渲染方式 | 编译到原生视图 | 自绘引擎 (Impeller) | 双线程原生渲染 | 原生视图映射 |
| 布局引擎 | Yoga (C++) | 自研 (Dart/C++) | 自研 (Rust) | Yoga (C++) |
| JS 引擎 | JSC / QuickJS / Hermes | 无（Dart VM） | PrimJS / QuickJS | Hermes / JSC |
| 桥接方式 | 二进制协议 + Valdi::Value | 无桥接（自绘） | 双线程直通 | JSI (C++ 直调) |
| 模块系统 | 懒加载 .valdimodule | Dart packages | ES Modules | Metro bundler |
| 热重载 | 支持 | 支持 | 支持 | 支持 |
| Web 支持 | 开发中（实验性） | 支持 | 支持 | 社区方案 |

### 6.2 渲染机制对比

```
Flutter (自绘):
  Dart Code → Widget Tree → Element Tree → RenderObject → Skia/Impeller → GPU

React Native (新架构):
  JS Code → React Tree → Fabric → Shadow Tree (Yoga) → Native Views

Lynx (双线程):
  JS Code (主线程) → 首屏渲染 → Native Views
  JS Code (后台线程) → React 运行时 → 节点树 → 增量更新

Valdi (编译式原生):
  TS Code → .valdimodule → C++ Runtime → RenderRequest → Native Views
```

**Flutter** 走的是完全自绘的路线，通过 Impeller 引擎直接在 GPU 上绘制所有 UI，不使用平台原生控件。这保证了跨平台的像素级一致性，但也意味着它无法直接使用平台原生的 UI 组件（如 iOS 的 UINavigationBar）。

**React Native** 的新架构通过 JSI 替换了旧的 JS Bridge，Fabric 渲染器和 TurboModules 显著改善了性能。但本质上它仍然是"JS 运行时 + 原生视图映射"的模型，reconciler 需要做虚拟树的 diff。

**Lynx** 的创新点在于双线程模型：主线程负责首屏渲染和动画，后台线程运行完整的 React 运行时处理业务逻辑。两个线程各有一棵节点树，通过对比保持一致。这种设计让首屏渲染特别快，但也增加了调试复杂度——开发者需要理解哪些代码在哪个线程上执行。

**Valdi** 则是将 TSX 编译为带有副作用的渲染指令，跳过了虚拟 DOM diff 的过程。组件更新是局部的，不会向上冒泡。

### 6.3 性能特征对比

| 指标 | Valdi | Flutter | Lynx | React Native |
|------|-------|---------|------|-------------|
| 首屏渲染 | 快（懒加载 + 预编译字节码） | 快（编译到原生代码） | 极快（主线程直出） | 中等 |
| 增量更新 | 快（局部渲染，无 diff） | 快（Element diff） | 快（后台线程增量） | 中等（reconciler） |
| 内存占用 | 低（视图回收池 + 1/4 内存） | 中等 | 低 | 中等 |
| 动画流畅度 | 高（C++ 主线程） | 高（自绘引擎） | 高（主线程动画） | 高（Reanimated） |
| 冷启动 | 不随代码规模增长 | Dart AOT 编译 | 快 | 随 bundle 增长 |

### 6.4 生态与工程化对比

| 维度 | Valdi | Flutter | Lynx | React Native |
|------|-------|---------|------|-------------|
| 开源时间 | 2025 年底 | 2018 年 | 2025 年 3 月 | 2015 年 |
| GitHub Stars | ~16k | ~170k+ | ~30k+ | ~130k+ |
| 社区生态 | 早期（beta） | 成熟 | 成长期 | 成熟 |
| 第三方库 | 极少 | pub.dev 丰富 | 少 | npm 丰富 |
| 构建系统 | Bazel | Flutter CLI | Rspack | Metro |
| 企业背书 | Snapchat | Google | ByteDance | Meta |
| 学习曲线 | 中等（类 React） | 中等（学 Dart） | 低（Web 标准） | 低（React 生态） |

### 6.5 代码风格对比

同一个计数器组件在四个框架中的实现：

**Valdi：**
```typescript
import { Component } from 'valdi_core/src/Component';

class Counter extends Component {
  private count = 0;

  onRender() {
    <view padding={20} alignItems="center">
      <label value={`Count: ${this.count}`} fontSize={24} />
      <view onTap={this.onIncrement} marginTop={16} padding={12} backgroundColor="#2196f3" borderRadius={8}>
        <label value="Increment" color="white" />
      </view>
    </view>;
  }

  private onIncrement = () => {
    this.count++;
    this.render();
  };
}
```

**Flutter：**
```dart
class Counter extends StatefulWidget {
  @override
  _CounterState createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int count = 0;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Text('Count: $count', style: TextStyle(fontSize: 24)),
        SizedBox(height: 16),
        ElevatedButton(
          onPressed: () => setState(() => count++),
          child: Text('Increment'),
        ),
      ],
    );
  }
}
```

**Lynx (ReactLynx)：**
```tsx
import { useState } from '@lynx-js/react';

function Counter() {
  const [count, setCount] = useState(0);

  return (
    <view style={{ padding: 20, alignItems: 'center' }}>
      <text style={{ fontSize: 24 }}>Count: {count}</text>
      <view
        bindtap={() => setCount(count + 1)}
        style={{ marginTop: 16, padding: 12, backgroundColor: '#2196f3', borderRadius: 8 }}
      >
        <text style={{ color: 'white' }}>Increment</text>
      </view>
    </view>
  );
}
```

**React Native：**
```tsx
import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

function Counter() {
  const [count, setCount] = useState(0);

  return (
    <View style={styles.container}>
      <Text style={styles.count}>Count: {count}</Text>
      <TouchableOpacity style={styles.button} onPress={() => setCount(count + 1)}>
        <Text style={styles.buttonText}>Increment</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, alignItems: 'center' },
  count: { fontSize: 24 },
  button: { marginTop: 16, padding: 12, backgroundColor: '#2196f3', borderRadius: 8 },
  buttonText: { color: 'white' },
});
```

从代码风格上可以看出：

- **Valdi** 使用类组件 + 内联属性，JSX 标签即布局属性，写法最紧凑。
- **Flutter** 使用 Dart 的嵌套 Widget 语法，代码结构清晰但层级深。
- **Lynx** 最贴近 Web 开发习惯，使用 React Hooks 和 CSS-like 样式。
- **React Native** 和 Lynx 类似，但需要导入特定的组件（`View`、`Text`、`TouchableOpacity`），`StyleSheet` 也是独有的 API。

## 七、Valdi 的现状与前景分析

### 7.1 优势

1. **8 年生产验证**：不是实验项目，而是经过 Snapchat 这种亿级用户量应用长期打磨的成熟框架。这意味着它在稳定性、边界情况处理、性能优化上已经积累了大量经验。

2. **性能架构先进**：编译式渲染 + 全局视图回收 + 懒加载模块 + C++ 主线程逻辑，这套组合拳在理论上确实能够提供比传统 JS Bridge 方案更好的性能天花板。官方数据显示首屏渲染速度提升 2 倍，内存占用降低到竞品的 1/4。

3. **渐进式接入**：支持在已有原生应用中嵌入 Valdi 组件，也支持在 Valdi 中嵌入原生视图。这降低了迁移成本，团队可以先在小功能上试点。

4. **TypeScript 生态**：选择 TypeScript 作为开发语言是务实的决定。前端和移动端开发者都不需要学习新语言，工具链（VSCode、ESLint、Prettier）可以直接复用。

### 7.2 挑战

1. **生态近乎空白**：开源时间太短，第三方库几乎为零。需要地图？写 Polyglot Module。需要推送？写 Polyglot Module。对于缺乏原生开发经验的团队来说，这是一个很大的门槛。

2. **社区规模小**：相比 React Native 和 Flutter 成熟的社区，Valdi 的 Discord 和 GitHub Discussions 活跃度有限。遇到问题时，很可能没有现成的解决方案可以参考。

3. **Snapchat 强绑定**：框架的演进方向很大程度上取决于 Snapchat 的内部需求。如果 Snapchat 的业务方向发生变化，框架的投入可能会受到影响。这与 React Native（Meta + 社区共治）和 Flutter（Google + 庞大社区）的治理模式不同。

4. **类组件范式**：在 React 社区已经全面拥抱函数组件和 Hooks 的背景下，Valdi 的类组件 + 显式 `render()` 调用的模式可能会让习惯了声明式编程的开发者感到不适。

5. **构建工具链**：依赖 Bazel 构建系统，对于不熟悉 Bazel 的团队来说有额外的学习成本。

### 7.3 适用场景

根据以上分析，Valdi 比较适合以下场景：

- **已有大型原生应用，需要渐进式引入跨平台能力**。Valdi 的嵌入式使用模式和原生互操作能力在这个场景下优势明显。
- **对性能有极致要求的 UI 场景**。比如社交应用的 Feed 流、高帧率动画页面等。
- **团队有原生开发经验**。能够编写 Polyglot Module 来弥补生态的不足。

而以下场景可能不太适合：

- **从零开始的新项目**。此时 React Native 或 Flutter 的成熟生态会显著降低开发成本。
- **纯前端团队**。缺乏 iOS/Android 原生开发经验的团队在 Polyglot Module 上会遇到较大阻力。
- **需要快速上线的项目**。生态空白意味着更多的"自己造轮子"时间。

### 7.4 前景判断

Valdi 能否在跨平台框架的市场中站稳脚跟，取决于几个关键因素：

1. **Snapchat 的持续投入**。框架能否保持活跃的开发节奏，能否在工具链和文档上持续优化。
2. **第三方生态的建设**。是否能吸引足够的开发者贡献组件库和工具。
3. **Web 端支持的成熟度**。如果 Valdi 能够稳定支持 Web 平台，它的适用范围会大幅扩展。

客观来说，Valdi 目前更像是一个**专业工具而非通用解决方案**。它在特定场景下有显著的技术优势，但生态和社区的不成熟是短期内难以逾越的门槛。对于大多数团队来说，React Native 和 Flutter 仍然是更安全的选择；但对于有原生开发积累、追求极致性能的团队，Valdi 值得关注和试用。

跨平台框架的竞争格局还远未定型——React Native 在重构架构，Flutter 在扩展平台，Lynx 在押注双线程，Valdi 在深耕编译优化。每个框架都在用不同的方式回答同一个问题：**如何在开发效率和运行性能之间找到最优的平衡点？** 最终的答案可能不是某一个框架的胜出，而是不同场景下的多元选择。

## 参考资料

- [Snapchat/Valdi - GitHub](https://github.com/Snapchat/Valdi)
- [Valdi Documentation](https://github.com/Snapchat/Valdi/blob/main/docs/README.md)
- [Snapchat Opens Valdi Framework to Developers After 8 Years of Internal Use](https://itsfoss.com/news/snapchat-open-sources-valdi/)
- [Should you bet on Valdi instead of React Native? - LogRocket Blog](https://blog.logrocket.com/valdi-instead-react-native/)
- [Lynx Official Documentation](https://lynxjs.org/)
- [Flutter Documentation](https://docs.flutter.dev/)
- [React Native New Architecture](https://reactnative.dev/docs/the-new-architecture/landing-page)
