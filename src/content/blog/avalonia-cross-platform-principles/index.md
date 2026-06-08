---
title: 'Avalonia 跨平台原理拆解与横向对比'
description: '从渲染管线、平台抽象、场景图三个层面拆解 Avalonia 的自绘架构，并与 Flutter、React Native、Lynx 横向对比。'
publishDate: 2026-06-08
tags: ['avalonia', '跨平台', 'flutter', 'react-native', 'lynx', '.net']
language: 'zh'
draft: false
comment: true
---

# Avalonia 跨平台原理拆解与横向对比

## 前言

在跨平台 UI 框架的版图上，Flutter 和 React Native 占据了移动端的主流视野，Lynx 以双线程模型切入市场，而在 .NET 生态中，一个十年磨一剑的框架正在从桌面向移动和 Web 全面扩展——**Avalonia**。

2026 年 4 月，Avalonia 12 正式发布。这个版本在 Android 上实现了 3 倍的性能提升，重建了移动端渲染后端，并公布了与 Google Flutter 团队合作将 Impeller 渲染引擎引入 .NET 生态的计划。在 JetBrains、Autodesk 等企业的生产环境中，Avalonia 已经驱动了大量桌面应用。

Avalonia 和 Flutter 走的是同一条技术路线——**自绘引擎**：不使用平台原生控件，由框架自己绘制每一个像素，换取跨平台的像素级一致性。但两者的语言生态、架构设计和目标用户群体有根本性差异。

本文将从渲染管线、平台抽象层、场景图机制三个层面拆解 Avalonia 的跨平台原理，然后与 Flutter、React Native、Lynx 做横向对比。

## 一、分层架构总览

Avalonia 的架构分为六层：

```
┌────────────────────────────────────────────┐
│  Controls                                  │  ← Button、TextBox、DataGrid、数据绑定、样式
├────────────────────────────────────────────┤
│  Layout                                    │  ← Measure/Arrange 两遍布局
├────────────────────────────────────────────┤
│  Visual                                    │  ← 可视化树、渲染变换、透明度、裁剪
├────────────────────────────────────────────┤
│  Rendering                                 │  ← 绘制原语、场景图、合成器
├────────────────────────────────────────────┤
│  Platform Abstraction                      │  ← 窗口、输入、剪贴板、文件对话框、GPU 上下文
├────────────────────────────────────────────┤
│  Platform Backends                         │  ← Win32 / Cocoa / X11 / Android / iOS / WASM
└────────────────────────────────────────────┘
```

- **Controls**：开发者直接使用的 UI 控件，通过 XAML 声明 + C# 逻辑 + MVVM 模式构建。
- **Layout**：两遍式布局系统——先 Measure（测量）确定期望尺寸，再 Arrange（排列）确定最终位置。
- **Visual**：维护可视化树，管理渲染变换、透明度和裁剪区域。
- **Rendering**：核心渲染层，负责构建场景图并通过合成器提交 GPU 绘制指令。
- **Platform Abstraction**：定义一组接口（`IWindowImpl`、`ITopLevelImpl`、`IRenderTarget` 等），隔离所有平台相关代码。
- **Platform Backends**：各平台的具体实现——Windows 用 Win32 API，macOS 用 Objective-C++ 桥接 Cocoa，Linux 用 X11，移动端用 .NET MAUI workload，Web 端用 CanvasKit (WebGL)。

## 二、双树结构：逻辑树与可视化树

Avalonia 维护两棵平行的树结构，这是理解其渲染原理的关键：

```
XAML 声明
    │
    ├── 逻辑树（Logical Tree）
    │     用途：资源查找、DataContext 继承、属性继承
    │     内容：开发者在 XAML 中声明的控件
    │
    └── 可视化树（Visual Tree）
          用途：渲染、布局、命中测试、事件路由
          内容：所有参与渲染的视觉元素（含模板展开后的内部元素）
```

举例来说，XAML 中一个 `<Button Content="Click me" />` 在逻辑树中只是一个 `Button` 节点；但在可视化树中，它会被模板展开为 `Border` → `ContentPresenter` → `TextBlock` 等多个渲染元素。

| 方面 | 逻辑树 | 可视化树 |
|------|--------|----------|
| 包含内容 | XAML 声明的控件 | 所有视觉元素（含模板内部） |
| 资源查找 | ✅ | ❌ |
| DataContext 继承 | ✅ | ❌ |
| 事件路由 | ❌ | ✅（隧道 + 冒泡） |
| 命中测试 | ❌ | ✅ |
| 布局 | 部分 | ✅ |

这种双树设计来源于 WPF，让数据流和渲染流有了清晰的分离。

## 三、渲染管线：从控件到像素

### 3.1 五阶段管线

Avalonia 的渲染管线分为五个阶段：

```
输入事件 → 属性变更 → 布局（Measure + Arrange）→ 渲染（场景图构建）→ 合成（GPU 绘制）
```

每一帧不是从头重绘所有内容，而是通过**脏区域追踪**（dirty-rect tracking）只更新发生变化的部分。

### 3.2 场景图：延迟渲染的核心

控件本身不直接绘制——它们声明视觉结构，框架据此构建一棵**场景图**（Scene Graph）。

```
控件标记自身需要重绘（InvalidateVisual）
    │
    ▼
DeferredRenderer 检测到脏区域
    │
    ▼
SceneBuilder 遍历可视化树中受影响的部分
    │
    ▼
生成场景图节点（绘制指令 + 变换 + 裁剪 + 透明度）
    │
    ▼
合成器（Compositor）遍历场景图
    │
    ▼
通过 IDrawingContextImpl 提交绘制指令到渲染后端
    │
    ▼
Skia / Direct3D / Metal / Vulkan → GPU → 屏幕
```

场景图是一棵轻量级的绘制指令树，每个节点代表一个可绘制操作及其关联状态（变换矩阵、裁剪区域、透明度）。这种延迟渲染设计带来了几个优化空间：

- **批处理**（Batching）：相似的绘制操作可以合并。
- **裁剪剔除**（Culling）：不可见的元素可以跳过。
- **层缓存**（Layer Caching）：未变化的区域可以复用之前的渲染结果。
- **指令重排**（Reordering）：绘制调用可以重新排序以提高效率。

### 3.3 DrawingContext：绘制抽象

所有绘制操作通过 `DrawingContext` 完成，它提供了一组与渲染后端无关的绘制方法：

```csharp
public override void Render(DrawingContext context)
{
    // 绘制矩形
    context.DrawRectangle(Brushes.Blue, null, new Rect(0, 0, 200, 100), 8, 8);

    // 绘制文本
    var text = new FormattedText("Hello Avalonia",
        CultureInfo.CurrentCulture, FlowDirection.LeftToRight,
        new Typeface("Arial"), 24, Brushes.White);
    context.DrawText(text, new Point(20, 30));

    // 变换和裁剪
    using (context.PushTransform(Matrix.CreateRotation(Math.PI / 6)))
    using (context.PushClip(new Rect(0, 0, 150, 80)))
    {
        context.DrawEllipse(Brushes.Red, null, new Point(75, 40), 60, 30);
    }
}
```

`DrawingContext` 底层通过 `IDrawingContextImpl` 接口分发到具体的渲染后端——这就是 Avalonia 实现跨平台渲染的核心抽象。

### 3.4 渲染后端

| 平台 | 默认后端 | GPU 加速 |
|------|----------|----------|
| Windows | Skia（可选 Direct2D） | Direct3D 11 |
| macOS | Skia | Metal |
| Linux | Skia | OpenGL / Vulkan |
| Android | Skia | OpenGL ES |
| iOS | Skia | Metal |
| WebAssembly | Skia via CanvasKit | WebGL |

Skia 是默认的跨平台渲染引擎（通过 SkiaSharp 绑定到 .NET）。它支持两种合成模式：

- **软件合成**：场景图在 CPU 上用 Skia 光栅化，然后 blit 到平台窗口。这是大多数平台的默认模式，兼容性最好。
- **GPU 合成**：在支持的平台上（Direct3D / Metal / Vulkan / OpenGL），Avalonia 直接向 GPU 提交绘制指令，适合复杂场景。

## 四、平台抽象层

### 4.1 接口驱动的设计

Avalonia 把所有平台相关的功能封装到一组接口中：

| 接口 | 职责 |
|------|------|
| `IWindowImpl` | 窗口创建、大小调整、定位、原生标题栏 |
| `ITopLevelImpl` | 渲染表面、输入传递、缩放因子 |
| `IRenderTarget` | GPU 渲染表面 |
| `IClipboard` | 剪贴板读写 |
| `IStorageProvider` | 文件和文件夹选择对话框 |
| `IInsetsManager` | 安全区域（刘海、状态栏） |
| `IPlatformSettings` | 主题检测、强调色、动画偏好 |

每个平台后端实现这些接口。应用启动时通过 `AppBuilder` 选择后端：

```csharp
AppBuilder.Configure<App>()
    .UsePlatformDetect()  // 根据操作系统自动选择
    .StartWithClassicDesktopLifetime(args);
```

### 4.2 各平台后端实现

**Windows（Win32）**：通过 P/Invoke 直接调用 Win32 API。窗口管理、输入处理、DPI 缩放都走原生 Win32 路径。

**macOS（AvaloniaNative）**：通过一个原生 Objective-C++ 动态库（`libAvaloniaNative.dylib`）桥接到 Cocoa API。使用 COM 风格的接口与 C# 代码通信，实现窗口管理、菜单系统和输入法集成。

**Linux（X11）**：直接使用 XLib API 创建窗口和处理输入。支持 XI2 扩展输入事件和 XSync 同步渲染。Wayland 支持目前处于 private preview 阶段。

**Android**：使用 .NET Android workload，在 `AvaloniaActivity` 中承载渲染表面。Avalonia 12 重建了 Android 后端，实现了可靠的高刷新率调度和多 Activity 支持。

**iOS**：使用 .NET iOS workload，支持 Mac Catalyst。Avalonia 12 实现了完整的 Scene Delegate 以支持 iPadOS 的多窗口。

**WebAssembly**：通过 CanvasKit（Skia 的 WebAssembly 编译版本）在 WebGL 上渲染。不需要服务端组件，纯浏览器运行。

## 五、XAML + MVVM：声明式 UI 的 .NET 范式

### 5.1 XAML 声明式 UI

Avalonia 使用 XAML 定义 UI 结构，语法和 WPF 高度一致：

```xml
<Window xmlns="https://github.com/avaloniaui"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Todo App" Width="400" Height="500">
  <DockPanel>
    <TextBlock DockPanel.Dock="Top" Text="待办事项"
               FontSize="24" Margin="16" FontWeight="Bold" />

    <StackPanel DockPanel.Dock="Bottom" Orientation="Horizontal" Margin="16">
      <TextBox x:Name="NewItemInput" Watermark="添加新任务..."
               Width="280" Margin="0,0,8,0" />
      <Button Content="添加" Command="{Binding AddCommand}" />
    </StackPanel>

    <ListBox ItemsSource="{Binding TodoItems}" Margin="16,0">
      <ListBox.ItemTemplate>
        <DataTemplate>
          <CheckBox IsChecked="{Binding IsCompleted}"
                    Content="{Binding Title}" />
        </DataTemplate>
      </ListBox.ItemTemplate>
    </ListBox>
  </DockPanel>
</Window>
```

### 5.2 MVVM 模式

C# ViewModel 通过数据绑定与 XAML 连接：

```csharp
public class TodoViewModel : ViewModelBase
{
    private string _newItemText = "";

    public ObservableCollection<TodoItem> TodoItems { get; } = new();

    public string NewItemText
    {
        get => _newItemText;
        set => this.RaiseAndSetIfChanged(ref _newItemText, value);
    }

    public ICommand AddCommand { get; }

    public TodoViewModel()
    {
        AddCommand = ReactiveCommand.Create(() =>
        {
            if (!string.IsNullOrWhiteSpace(NewItemText))
            {
                TodoItems.Add(new TodoItem { Title = NewItemText });
                NewItemText = "";
            }
        });
    }
}
```

XAML + C# + MVVM 是 .NET 开发者最熟悉的 UI 开发范式。对于有 WPF、WinUI 或 Xamarin.Forms 经验的团队，迁移到 Avalonia 的学习成本极低。

## 六、横向对比：Avalonia vs Flutter vs React Native vs Lynx

### 6.1 架构路线对比

| 维度 | Avalonia | Flutter | React Native | Lynx |
|------|----------|---------|-------------|------|
| 开发语言 | C# + XAML | Dart | TypeScript (JSX) | TypeScript (JSX) |
| UI 范式 | XAML 声明式 + MVVM | Widget 组合 | 函数组件 + Hooks | 函数组件 + Hooks |
| 渲染方式 | 自绘引擎（Skia） | 自绘引擎（Impeller） | 原生控件映射 | 双线程原生渲染 |
| 布局系统 | Measure/Arrange 两遍式 | 自研（RenderObject） | Yoga (FlexBox) | 自研 (Rust, FlexBox) |
| 渲染后端 | Skia（Impeller 计划中） | Impeller（默认） | 平台原生 | 平台原生 |
| 平台一致性 | 像素级一致 | 像素级一致 | 跟随平台风格 | 跟随平台风格 |
| 热重载 | 有限（XAML Hot Reload） | 完整 Hot Reload | Fast Refresh | Hot Reload |
| Web 支持 | WebAssembly（CanvasKit） | WebAssembly（受限） | 社区方案 | 支持 |

### 6.2 渲染管线对比

```
Avalonia（自绘 + 场景图）:
  XAML/C# → Visual Tree → Scene Graph → IDrawingContextImpl → Skia → GPU

Flutter（自绘 + DisplayList）:
  Dart → Widget Tree → Element Tree → RenderObject → DisplayList → Impeller → GPU

React Native（原生控件映射）:
  JSX → React Tree → Fabric Shadow Tree → Yoga Layout → Native Views

Lynx（双线程原生渲染）:
  JSX(主线程) → 首屏渲染 → Native Views
  JSX(后台线程) → React Runtime → 增量更新
```

**Avalonia 和 Flutter** 走的是相同的技术路线——自绘引擎。两者都不使用平台原生控件，由框架自己控制每个像素的绘制。差异在于：

- Avalonia 的场景图是树状结构，支持脏区域追踪和增量更新；Flutter 的 DisplayList 是一个扁平的绘制指令序列。
- Avalonia 使用 retained mode（保留模式），控件声明视觉结构，框架维护状态；Flutter 的 Widget 是 immutable 的，每次 build 创建新的描述。
- Avalonia 目前使用 Skia，计划迁移到 Impeller；Flutter 已经在 iOS 和 Android 上默认使用 Impeller。

**React Native 和 Lynx** 走的是原生控件映射路线。UI 最终渲染为平台原生视图，保留了平台的 look and feel，但跨平台一致性不如自绘引擎。

### 6.3 生态与工程化对比

| 维度 | Avalonia | Flutter | React Native | Lynx |
|------|----------|---------|-------------|------|
| 首个稳定版 | 2023（v11） | 2018 | 2015 | 2025 |
| 最新版本 | 12.0（2026.04） | 3.x | 0.76+ | 3.x |
| GitHub Stars | ~31k | ~170k+ | ~130k+ | ~30k+ |
| 社区生态 | 成长期 | 成熟 | 成熟 | 早期 |
| 第三方库 | NuGet（.NET 生态） | pub.dev（丰富） | npm（丰富） | npm（少） |
| 企业背书 | AvaloniaUI + JetBrains、Autodesk | Google | Meta | ByteDance |
| 桌面支持 | ✅ Win/Mac/Linux（Tier 1） | ✅ 支持（非主焦点） | ⚠️ 社区维护 | ❌ |
| 移动支持 | ✅ 改进中（v12 大幅提升） | ✅ 核心焦点 | ✅ 核心焦点 | ✅ 核心焦点 |
| Web 支持 | ✅ WebAssembly | ✅ WebAssembly | ⚠️ 社区方案 | ✅ |
| 嵌入式 | ✅ Linux framebuffer | ⚠️ 有限 | ❌ | ❌ |
| 学习曲线 | 低（.NET 开发者） | 中（学 Dart） | 低（JS/TS 生态） | 低（Web 标准） |

### 6.4 代码风格对比

同一个计数器在四个框架中的实现：

**Avalonia（XAML + C#）：**

```xml
<!-- CounterView.axaml -->
<UserControl xmlns="https://github.com/avaloniaui">
  <StackPanel HorizontalAlignment="Center" VerticalAlignment="Center" Spacing="16">
    <TextBlock Text="{Binding Count, StringFormat='Count: {0}'}" FontSize="24" />
    <Button Content="Increment" Command="{Binding IncrementCommand}" />
  </StackPanel>
</UserControl>
```

```csharp
// CounterViewModel.cs
public class CounterViewModel : ViewModelBase
{
    private int _count;
    public int Count
    {
        get => _count;
        set => this.RaiseAndSetIfChanged(ref _count, value);
    }
    public ICommand IncrementCommand { get; }

    public CounterViewModel()
    {
        IncrementCommand = ReactiveCommand.Create(() => Count++);
    }
}
```

**Flutter（Dart）：**

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

**React Native（TypeScript）：**

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
      <Text style={{ fontSize: 24 }}>Count: {count}</Text>
      <Button title="Increment" onPress={() => setCount(count + 1)} />
    </View>
  );
}
```

**Lynx（TypeScript）：**

```tsx
function Counter() {
  const [count, setCount] = useState(0);
  return (
    <view style={{ alignItems: 'center', justifyContent: 'center', flex: 1 }}>
      <text style={{ fontSize: 24 }}>Count: {count}</text>
      <view bindtap={() => setCount(count + 1)}
        style={{ padding: 12, backgroundColor: '#2196f3', borderRadius: 8 }}>
        <text style={{ color: 'white' }}>Increment</text>
      </view>
    </view>
  );
}
```

从代码风格可以看出四个框架服务于不同的开发者群体：
- **Avalonia** 面向 .NET 开发者，XAML + C# + MVVM 是 WPF 的延续。
- **Flutter** 需要学习 Dart，但 Widget 组合式的 UI 构建方式简洁直观。
- **React Native** 和 **Lynx** 都使用 TypeScript + JSX，对前端开发者最友好。

## 七、Avalonia 的现状与前景

### 7.1 优势

1. **.NET 生态的桥头堡**。对于已有 C# / WPF / WinForms 代码资产的团队，Avalonia 是唯一能让这些技能和代码在 Mac、Linux、移动端和 Web 上复用的框架。XPF（Avalonia 的商业产品）甚至可以直接运行大部分 WPF 应用。

2. **桌面端最强的跨平台方案**。Windows + macOS + Linux 三端桌面支持是 Tier 1 水平，这是 Flutter（桌面不是主焦点）和 React Native（桌面是社区维护）都无法比拟的。

3. **像素级一致性**。自绘引擎保证了所有平台上 UI 完全一致，不存在"iOS 上的按钮和 Android 上的按钮长得不一样"的问题。

4. **Impeller 合作的想象空间**。与 Google Flutter 团队合作引入 Impeller，一旦落地将显著提升移动端和嵌入式场景的 GPU 性能，消除 Skia 的着色器编译卡顿问题。

5. **性能持续突破**。Avalonia 12 在复杂布局场景下实现了最高 1867% 的 FPS 提升（35 万个视觉元素的测试场景），这是延迟合成和脏区域追踪优化的结果。

### 7.2 挑战

1. **移动端仍在追赶**。虽然 Avalonia 12 大幅改善了移动支持，但手势处理、虚拟键盘管理、平台特定行为（分享、推送、应用内购买）等方面仍需要更多手动工作，不如 Flutter 和 React Native 成熟。

2. **社区规模和第三方库**。相比 Flutter 的 pub.dev 和 React Native 的 npm 生态，Avalonia 的专用控件库和社区资源还比较有限。虽然可以使用整个 NuGet / .NET 生态，但 UI 层面的第三方组件选择不多。

3. **Dart vs C# 的市场现实**。移动开发市场上，Dart（Flutter）和 TypeScript（RN/Lynx）的开发者远多于精通 XAML + C# 的开发者。招聘和社区活跃度上 Avalonia 处于劣势。

4. **Web 端体验**。WebAssembly + CanvasKit 的方案意味着首次加载需要下载 Skia 的 WASM 包（数 MB），初始加载体验不如原生 Web 框架。

5. **热重载不如 Flutter**。Avalonia 的 XAML Hot Reload 能力不如 Flutter 的 Stateful Hot Reload 完整，涉及到 C# 逻辑变更时通常需要重新编译。

### 7.3 适用场景

根据以上分析，Avalonia 最适合以下场景：

- **跨桌面平台应用**。需要同时覆盖 Windows、macOS、Linux 的桌面应用，这是 Avalonia 的核心阵地。
- **WPF/WinForms 迁移**。已有大量 .NET 桌面代码需要跨平台化的团队。
- **嵌入式 Linux GUI**。工业控制面板、Kiosk 终端等嵌入式场景，Avalonia 支持 framebuffer 直接渲染。
- **.NET 全栈团队的移动端扩展**。后端和桌面都用 C# 的团队，希望用同一语言覆盖移动端。

不太适合的场景：

- **纯移动端应用**。Flutter 和 React Native 在移动端的生态和成熟度仍然领先。
- **前端团队主导的项目**。JavaScript/TypeScript 技术栈的团队选择 React Native 或 Lynx 更自然。
- **高度依赖平台原生体验的应用**。需要 iOS/Android 原生 look and feel 的应用，React Native 的原生控件映射方式更合适。

### 7.4 前景判断

Avalonia 的发展路径越来越清晰：

1. **桌面端的统治地位已经确立**。在 .NET 生态中，Avalonia 是跨桌面平台的事实标准。JetBrains（Rider、dotPeek）、Autodesk、Devolutions 等企业的采用证明了它的生产可靠性。

2. **移动端从"可用"走向"好用"**。Avalonia 12 是移动端竞争力的一个转折点——重建的 Android 后端、完整的导航系统、改进的手势处理。但要和 Flutter 在移动端正面竞争，还需要 1-2 个大版本的持续投入。

3. **Impeller 是关键变量**。如果 Impeller 集成顺利落地，Avalonia 将获得和 Flutter 同级别的 GPU 渲染性能，这对移动端和嵌入式场景意义重大。目前 Impeller 集成仍处于实验阶段，团队在 v12 发布期间暂停了相关工作。

4. **与 .NET MAUI 的关系**。Avalonia 已经为 .NET MAUI 提供了后端，使 MAUI 应用能够运行在 Linux 和 WebAssembly 上。这种合作关系而非对抗的策略，让 Avalonia 在 .NET 生态中找到了独特的定位。

客观来说，Avalonia 不太可能取代 Flutter 成为移动端的首选跨平台框架，它的核心竞争力在 **桌面 + 嵌入式 + .NET 生态** 这个交叉领域。在这个定位上，它没有真正的竞争对手。随着移动端能力的持续增强和 Impeller 的引入，Avalonia 正在从"最好的 .NET 桌面框架"向"最全面的 .NET 跨平台框架"演进。

## 总结

| 维度 | Avalonia | Flutter | React Native | Lynx |
|------|----------|---------|-------------|------|
| 技术路线 | 自绘引擎 | 自绘引擎 | 原生控件映射 | 双线程原生渲染 |
| 核心优势 | 桌面三端 + .NET 生态 | 移动端 + 自定义 UI | JS 生态 + 原生体验 | 首屏性能 + Web 标准 |
| 平台覆盖 | 6 平台（桌面最强） | 6 平台（移动最强） | 2-4 平台 | 3 平台（含 Web） |
| 适合团队 | .NET / C# / WPF | 全栈移动 | 前端 / JS / TS | 前端 / JS / TS |
| 成熟度 | 桌面成熟，移动成长中 | 全面成熟 | 全面成熟 | 早期 |

每个框架都在用不同的方式回答同一个问题：**如何用一套代码覆盖尽可能多的平台？** Avalonia 的回答是：用 .NET 开发者最熟悉的 XAML + C# + MVVM，加上一个像素级一致的自绘引擎，从桌面出发扩展到所有平台。这条路走得不快，但走得很稳。

## 参考资料

- [Avalonia Architecture — Official Docs](https://docs.avaloniaui.net/docs/fundamentals/architecture)
- [Avalonia 12 Release Blog](https://avaloniaui.net/blog/avalonia-12)
- [Avalonia Rendering Architecture — DeepWiki](https://deepwiki.com/AvaloniaUI/Avalonia/5.1-rendering-architecture-and-scene-graph)
- [Avalonia Platform Implementations — DeepWiki](https://deepwiki.com/AvaloniaUI/Avalonia/3-platform-implementations)
- [Avalonia Partnering with Google's Flutter Team for Impeller](https://avaloniaui.net/blog/avalonia-partners-with-google-s-flutter-t-eam-to-bring-impeller-rendering-to-net)
- [Avalonia Supported Platforms](https://docs.avaloniaui.net/docs/supported-platforms)
- [AvaloniaUI/Avalonia — GitHub](https://github.com/AvaloniaUI/Avalonia)
- [AvaloniaUI/NImpeller — GitHub](https://github.com/avaloniaui/nimpeller)
